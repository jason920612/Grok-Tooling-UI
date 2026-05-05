import OpenAI from 'openai';
import { config } from './config.js';

export const xai = new OpenAI({
  apiKey: config.xaiApiKey,
  baseURL: config.xaiBaseUrl
});

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export async function completeText(options: {
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
}) {
  const response = await xai.chat.completions.create({
    model: options.model,
    temperature: options.temperature ?? 0.2,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
    messages: [
      { role: 'system', content: options.system },
      ...options.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]
  });

  return response.choices[0]?.message?.content ?? '';
}

function extractResponseText(response: unknown) {
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string') return outputText;

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  return output
    .flatMap((item) => Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [])
    .map((content) => {
      const text = (content as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeResponseOutput(response: unknown) {
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return [];

  return output.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      type: record.type,
      status: record.status,
      name: record.name,
      action: record.action,
      content: Array.isArray(record.content)
        ? record.content.map((content) => {
            const contentRecord = content as Record<string, unknown>;
            return {
              type: contentRecord.type,
              text: typeof contentRecord.text === 'string'
                ? contentRecord.text.slice(0, 1000)
                : undefined,
              annotations: contentRecord.annotations
            };
          })
        : undefined
    };
  });
}

export async function completeTextWithBuiltInSearch(options: {
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}) {
  const response = await xai.responses.create({
    model: options.model,
    instructions: options.system,
    input: options.messages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    temperature: options.temperature ?? 0.2,
    tools: [
      { type: 'web_search' },
      { type: 'x_search' }
    ],
    tool_choice: 'auto'
  } as never);

  return {
    text: extractResponseText(response),
    trace: {
      id: (response as { id?: unknown }).id,
      status: (response as { status?: unknown }).status,
      output: summarizeResponseOutput(response)
    }
  };
}