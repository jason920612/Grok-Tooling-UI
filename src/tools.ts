import { Parser } from 'expr-eval';

export type ToolResult = {
  tool: string;
  input: unknown;
  output: string;
};

const parser = new Parser();

export async function runTool(name: string, input: unknown): Promise<ToolResult> {
  if (name === 'calculator') {
    const expression = String((input as { expression?: unknown }).expression ?? '');
    const value = parser.evaluate(expression);
    return { tool: name, input, output: String(value) };
  }

  if (name === 'time') {
    return { tool: name, input, output: new Date().toISOString() };
  }

  if (name === 'url_fetch') {
    const url = String((input as { url?: unknown }).url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('url_fetch requires an http(s) URL');
    const response = await fetch(url, { headers: { 'user-agent': 'grok-tooling-ui/0.1' } });
    const text = await response.text();
    return { tool: name, input, output: text.slice(0, 8000) };
  }

  if (name === 'web_search') {
    const query = String((input as { query?: unknown }).query ?? '');
    return {
      tool: name,
      input,
      output: `Search adapter not configured yet. Query requested: ${query}`
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

export const toolCatalog = [
  {
    name: 'calculator',
    description: 'Evaluate deterministic arithmetic expressions. Use for any calculation that affects the answer.'
  },
  {
    name: 'time',
    description: 'Return current ISO timestamp. Use when freshness or current date matters.'
  },
  {
    name: 'url_fetch',
    description: 'Fetch a user-provided public URL and return a trimmed text body.'
  },
  {
    name: 'web_search',
    description: 'Placeholder adapter for external search. Replace this with Tavily, Brave, SerpAPI, or your own search backend.'
  }
] as const;
