import OpenAI from 'openai';
import { config } from './config.js';

export const xai = new OpenAI({
  apiKey: config.xaiApiKey,
  baseURL: config.xaiBaseUrl
});

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export async function completeText(options: {
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}) {
  const response = await xai.chat.completions.create({
    model: options.model,
    temperature: options.temperature ?? 0.2,
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
