# Grok Tooling UI

A Node.js + TypeScript web app that wraps xAI/Grok models with an explicit planner, tool layer, source ranking, and verifier pass.

## Goals

- Grok-like chat interface in the browser
- Node.js backend written in TypeScript
- Planner model for freshness and user-claim checks
- Tool execution layer for search, URL fetch, calculation, and time
- Final verification pass before answering

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Then open http://localhost:3000.

## Environment

Set `XAI_API_KEY` in `.env`. Optional model settings are available in `.env.example`.
