import { runEphemeralPython } from './pythonExecutor.js';
import { runXaiCodeExecution } from './xaiCodeExecution.js';

export type ToolResult = {
  tool: string;
  input: unknown;
  output: string;
  artifacts?: Array<{
    name: string;
    size: number;
    mime: string;
    previewable: boolean;
    content_base64: string;
  }>;
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' | '^' }
  | { type: 'paren'; value: '(' | ')' };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      const start = index;
      index += 1;
      while (index < expression.length && /[0-9.]/.test(expression[index])) index += 1;
      const raw = expression.slice(start, index);
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) throw new Error(`Invalid number: ${raw}`);
      tokens.push({ type: 'number', value: Number(raw) });
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^') {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unsupported calculator character: ${char}`);
  }

  return tokens;
}

function evaluateArithmetic(expression: string) {
  const tokens = tokenize(expression);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function matchOperator(operator: Token & { type: 'operator' }) {
    if (peek()?.type === 'operator' && peek().value === operator.value) {
      index += 1;
      return true;
    }
    return false;
  }

  function parseExpression(): number {
    let value = parseTerm();
    while (true) {
      if (matchOperator({ type: 'operator', value: '+' })) value += parseTerm();
      else if (matchOperator({ type: 'operator', value: '-' })) value -= parseTerm();
      else return value;
    }
  }

  function parseTerm(): number {
    let value = parsePower();
    while (true) {
      if (matchOperator({ type: 'operator', value: '*' })) value *= parsePower();
      else if (matchOperator({ type: 'operator', value: '/' })) value /= parsePower();
      else return value;
    }
  }

  function parsePower(): number {
    const value = parseUnary();
    if (matchOperator({ type: 'operator', value: '^' })) return value ** parsePower();
    return value;
  }

  function parseUnary(): number {
    if (matchOperator({ type: 'operator', value: '+' })) return parseUnary();
    if (matchOperator({ type: 'operator', value: '-' })) return -parseUnary();
    return parsePrimary();
  }

  function parsePrimary(): number {
    const token = peek();
    if (!token) throw new Error('Unexpected end of expression');

    if (token.type === 'number') {
      index += 1;
      return token.value;
    }

    if (token.type === 'paren' && token.value === '(') {
      index += 1;
      const value = parseExpression();
      if (peek()?.type !== 'paren' || peek().value !== ')') throw new Error('Missing closing parenthesis');
      index += 1;
      return value;
    }

    throw new Error('Expected number or parenthesized expression');
  }

  if (tokens.length === 0) throw new Error('Calculator expression is empty');
  const value = parseExpression();
  if (index !== tokens.length) throw new Error('Unexpected token after expression');
  if (!Number.isFinite(value)) throw new Error('Calculator result is not finite');
  return value;
}

export async function runTool(name: string, input: unknown): Promise<ToolResult> {
  if (name === 'calculator') {
    const expression = String((input as { expression?: unknown }).expression ?? '');
    const value = evaluateArithmetic(expression);
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
      output: `web_search is handled by xAI built-in server-side tools during synthesis. Query requested: ${query}`
    };
  }

  if (name === 'x_search') {
    const query = String((input as { query?: unknown }).query ?? '');
    return {
      tool: name,
      input,
      output: `x_search is handled by xAI built-in server-side tools during synthesis. Query requested: ${query}`
    };
  }

  if (name === 'code_execution') {
    const result = await runXaiCodeExecution(input);
    return {
      tool: name,
      input,
      output: result.text,
      artifacts: result.artifacts
    };
  }

  if (name === 'python_execution') {
    const result = await runEphemeralPython(input);
    const { artifacts, ...summary } = result;
    return {
      tool: name,
      input,
      output: JSON.stringify(summary, null, 2),
      artifacts
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
    description: 'Use xAI built-in web_search server-side tool for current web information and primary sources.'
  },
  {
    name: 'x_search',
    description: 'Use xAI built-in x_search server-side tool for current X posts, xAI/Grok announcements, and public social claims.'
  },
  {
    name: 'code_execution',
    description: 'Use xAI built-in code_interpreter for no-network Python calculations, data analysis, and code verification. This runs server-side at xAI in a stateless isolated environment.'
  },
  {
    name: 'python_execution',
    description: 'Run Python locally only when network or pip packages are required. Input: {code: string, packages?: string[]}. Uses a one-run virtualenv, allows pip install only inside that env, deletes it after execution, limits wall time to 60s, CPU to 30s, memory to 512MB, and output files to 60MB.'
  }
] as const;
