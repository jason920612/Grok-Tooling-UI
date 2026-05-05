import { z } from 'zod';
import { config } from './config.js';
import { ChatMessage, completeText } from './xai.js';
import { runTool, toolCatalog, ToolResult } from './tools.js';

const PlannerSchema = z.object({
  answer_directly: z.boolean(),
  needs_freshness_check: z.boolean(),
  user_claims_to_verify: z.array(z.string()).default([]),
  tool_calls: z.array(z.object({
    tool: z.string(),
    input: z.record(z.unknown())
  })).default([]),
  source_policy: z.array(z.string()).default([]),
  answer_constraints: z.array(z.string()).default([])
});

type PlannerOutput = z.infer<typeof PlannerSchema>;

function extractJson(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

async function plan(messages: ChatMessage[]): Promise<PlannerOutput> {
  const system = `You are an epistemic planner for a Grok-powered assistant.
Return JSON only, matching this shape:
{
  "answer_directly": boolean,
  "needs_freshness_check": boolean,
  "user_claims_to_verify": string[],
  "tool_calls": [{"tool": string, "input": object}],
  "source_policy": string[],
  "answer_constraints": string[]
}

Available tools:
${toolCatalog.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}

Rules:
- If the user asks about current facts, model names, prices, laws, news, API behavior, people, companies, or release status, mark needs_freshness_check true.
- Treat user claims as fallible; list any premise that affects the answer.
- X posts, social replies, and prior AI answers are weak evidence.
- Prefer official docs, primary sources, source documents, deterministic computation, and executable checks.
- Keep tool calls minimal and useful.`;

  const raw = await completeText({
    model: config.plannerModel,
    system,
    messages,
    temperature: 0
  });

  return PlannerSchema.parse(JSON.parse(extractJson(raw)));
}

async function synthesize(messages: ChatMessage[], planner: PlannerOutput, toolResults: ToolResult[]) {
  const system = `You are a Grok-like assistant wrapped in a verification layer.
Be direct, sharp, and useful, but do not over-trust social content.
Use the planner constraints and tool results.
When evidence is weak, say so.
Do not claim that a tool verified something unless the tool output supports it.`;

  return completeText({
    model: config.grokModel,
    system,
    messages: [
      ...messages,
      {
        role: 'system',
        content: JSON.stringify({ planner, toolResults }, null, 2)
      }
    ],
    temperature: 0.4
  });
}

async function verify(messages: ChatMessage[], draft: string, planner: PlannerOutput, toolResults: ToolResult[]) {
  const system = `You are a strict verifier. Return a concise critique plus a corrected final answer if needed.
Check:
- Did the answer overstate evidence?
- Did it ignore freshness/user-premise risk?
- Did it cite or imply authority from weak sources?
- Did it fail to use deterministic tool output?
If the draft is acceptable, return it unchanged under "final".`;

  return completeText({
    model: config.verifierModel,
    system,
    messages: [
      ...messages,
      {
        role: 'system',
        content: JSON.stringify({ draft, planner, toolResults }, null, 2)
      }
    ],
    temperature: 0
  });
}

export async function runConversation(messages: ChatMessage[]) {
  const planner = await plan(messages);
  const toolResults: ToolResult[] = [];

  for (const call of planner.tool_calls.slice(0, 4)) {
    try {
      toolResults.push(await runTool(call.tool, call.input));
    } catch (error) {
      toolResults.push({
        tool: call.tool,
        input: call.input,
        output: `Tool error: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const draft = await synthesize(messages, planner, toolResults);
  const final = await verify(messages, draft, planner, toolResults);

  return { planner, toolResults, draft, final };
}
