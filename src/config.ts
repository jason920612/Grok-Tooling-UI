import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  xaiApiKey: process.env.XAI_API_KEY ?? '',
  xaiBaseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
  grokModel: process.env.GROK_MODEL ?? 'grok-4.3',
  plannerModel: process.env.PLANNER_MODEL ?? 'grok-4.20-0309-non-reasoning',
  verifierModel: process.env.VERIFIER_MODEL ?? 'grok-4.20-0309-non-reasoning'
};

export function assertConfig() {
  if (!config.xaiApiKey) {
    throw new Error('Missing XAI_API_KEY. Copy .env.example to .env and set your key.');
  }
}
