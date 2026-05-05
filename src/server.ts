import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertConfig, config } from './config.js';
import { runConversation } from './orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

assertConfig();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().min(1)
  })).min(1)
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: config.grokModel });
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const body = ChatRequestSchema.parse(req.body);
    const result = await runConversation(body.messages);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`Grok Tooling UI listening on http://localhost:${config.port}`);
});
