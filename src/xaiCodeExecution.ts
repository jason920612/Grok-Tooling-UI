import OpenAI from 'openai';
import { config } from './config.js';

const xai = new OpenAI({
  apiKey: config.xaiApiKey,
  baseURL: config.xaiBaseUrl
});

export type ExecutionArtifact = {
  name: string;
  size: number;
  mime: string;
  previewable: boolean;
  content_base64: string;
};

function extractText(response: unknown) {
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

function detectMime(filename: string, fallback = 'application/octet-stream') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html;charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain;charset=utf-8';
  if (lower.endsWith('.md')) return 'text/markdown;charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json;charset=utf-8';
  if (lower.endsWith('.csv')) return 'text/csv;charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return fallback;
}

function isPreviewable(mime: string) {
  return mime.startsWith('text/')
    || mime.startsWith('image/')
    || mime.startsWith('application/json')
    || mime.startsWith('application/pdf');
}

function collectFiles(value: unknown, found = new Map<string, string>()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, found);
    return found;
  }

  const record = value as Record<string, unknown>;
  const fileId = typeof record.file_id === 'string'
    ? record.file_id
    : typeof record.fileId === 'string'
      ? record.fileId
      : '';
  const filename = typeof record.filename === 'string'
    ? record.filename
    : typeof record.path === 'string'
      ? record.path.split('/').pop() || record.path
      : '';

  if (fileId && (filename || String(record.type || '').includes('file'))) {
    found.set(fileId, filename || `${fileId}.bin`);
  }

  for (const item of Object.values(record)) collectFiles(item, found);
  return found;
}

async function downloadArtifacts(response: unknown): Promise<ExecutionArtifact[]> {
  const artifacts: ExecutionArtifact[] = [];

  for (const [fileId, filename] of collectFiles(response)) {
    const url = `${config.xaiBaseUrl.replace(/\/v1\/?$/, '')}/v1/files/${encodeURIComponent(fileId)}/content`;
    const fileResponse = await fetch(url, {
      headers: { authorization: `Bearer ${config.xaiApiKey}` }
    });
    if (!fileResponse.ok) continue;

    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    if (buffer.byteLength > 60 * 1024 * 1024) continue;

    const mime = detectMime(filename, fileResponse.headers.get('content-type') || undefined);
    artifacts.push({
      name: filename,
      size: buffer.byteLength,
      mime,
      previewable: isPreviewable(mime),
      content_base64: buffer.toString('base64')
    });
  }

  return artifacts;
}

export async function runXaiCodeExecution(input: unknown) {
  const task = String((input as { task?: unknown }).task ?? '');
  const code = String((input as { code?: unknown }).code ?? '');
  const prompt = [
    'Run code only if useful. This environment has no external network access.',
    'If you create files, make them useful for preview/download and mention them in the answer.',
    task ? `Task:\n${task}` : '',
    code ? `Code:\n${code}` : ''
  ].filter(Boolean).join('\n\n');

  const response = await xai.responses.create({
    model: config.grokModel,
    input: [{ role: 'user', content: prompt }],
    tools: [{ type: 'code_interpreter' }],
    tool_choice: 'auto'
  } as never);

  return {
    text: extractText(response),
    artifacts: await downloadArtifacts(response)
  };
}
