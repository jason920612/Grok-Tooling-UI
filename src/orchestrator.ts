import { z } from 'zod';
import { config } from './config.js';
import { ChatMessage, completeText, completeTextWithBuiltInSearch } from './xai.js';
import { runTool, toolCatalog, ToolResult } from './tools.js';

const thinkingSkills = [
  {
    name: 'First Principles Thinking',
    description: 'Break the problem down to basic constraints, mechanisms, and assumptions.'
  },
  {
    name: 'Bayesian Reasoning',
    description: 'Start from priors, update based on evidence, and track uncertainty.'
  },
  {
    name: 'Musk Five-Step Algorithm',
    description: 'Make requirements less dumb, delete parts, simplify/optimize, accelerate cycle time, then automate.'
  },
  {
    name: 'Source Hierarchy Evaluation',
    description: 'Rank evidence by authority: primary sources, official docs, raw data, reputable reporting, social posts, AI-generated replies.'
  },
  {
    name: 'Adversarial / Red-Team Thinking',
    description: 'Ask how the answer, system, tool, or claim could fail or be abused.'
  },
  {
    name: 'Systems Thinking',
    description: 'Analyze feedback loops, incentives, dependencies, and second-order effects.'
  },
  {
    name: 'Causal Reasoning',
    description: 'Distinguish correlation, mechanism, intervention, and outcome.'
  },
  {
    name: 'Decision Matrix Thinking',
    description: 'Compare options against explicit criteria, weights, tradeoffs, and constraints.'
  },
  {
    name: 'Counterfactual Reasoning',
    description: 'Ask what would change if a premise were false or an alternative condition held.'
  },
  {
    name: 'Implementation-Oriented Decomposition',
    description: 'Convert a vague goal into modules, interfaces, data flow, risks, and incremental milestones.'
  }
] as const;

const PlannerSchema = z.object({
  task_type: z.string().default('general'),
  selected_skills: z.array(z.object({
    name: z.string(),
    reason: z.string()
  })).default([]),
  reasoning_trace: z.object({
    summary: z.string(),
    evidence_policy: z.string(),
    tools_considered: z.array(z.string()).default([]),
    source_types: z.array(z.string()).default([]),
    uncertainty: z.string()
  }).default({
    summary: 'Use the planner constraints and available tools before answering.',
    evidence_policy: 'Prefer primary and deterministic evidence when available.',
    tools_considered: [],
    source_types: [],
    uncertainty: 'Uncertainty was not explicitly classified.'
  }),
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

function fallbackPlan(messages: ChatMessage[], reason: string): PlannerOutput {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const asksForCurrentInfo = /最新|目前|現在|跳票|延期|發布|發佈|上市|進度|何時|today|current|latest|version|release|launch|delay|delayed|roadmap|build|grok|xai|elon|musk|fsd/i.test(lastUserMessage);
  const asksForImplementation = /code|coding|implement|build|github|issue|pr|bug|fix|refactor|程式|實作|修正|開發/i.test(lastUserMessage);
  const selectedSkills = asksForCurrentInfo
    ? [
        {
          name: 'Source Hierarchy Evaluation',
          reason: 'The answer depends on separating official or primary evidence from social/public discourse.'
        },
        {
          name: 'Bayesian Reasoning',
          reason: 'The claim may be uncertain or time-sensitive, so confidence should update with available evidence.'
        }
      ]
    : asksForImplementation
      ? [
          {
            name: 'Implementation-Oriented Decomposition',
            reason: 'The request needs to be broken into modules, data flow, risks, and validation steps.'
          },
          {
            name: 'Adversarial / Red-Team Thinking',
            reason: 'Implementation changes should consider failure modes and regressions.'
          }
        ]
      : [
          {
            name: 'First Principles Thinking',
            reason: 'The request can be answered by grounding it in basic constraints and assumptions.'
          }
        ];

  return {
    task_type: asksForCurrentInfo ? 'current_fact_check' : asksForImplementation ? 'implementation' : 'general',
    selected_skills: selectedSkills,
    reasoning_trace: {
      summary: asksForCurrentInfo
        ? 'I will verify the premise, compare source authority, and label uncertainty before answering.'
        : asksForImplementation
          ? 'I will decompose the implementation, check affected surfaces, and validate the change.'
          : 'I will identify the core constraints and answer directly with any relevant caveats.',
      evidence_policy: asksForCurrentInfo
        ? 'X is allowed for public statements and discourse, but it is labeled separately from official or primary factual evidence.'
        : 'Use user-provided context and deterministic checks when available.',
      tools_considered: asksForCurrentInfo ? ['web_search', 'x_search', 'url_fetch'] : ['calculator', 'url_fetch'],
      source_types: asksForCurrentInfo ? ['official docs', 'web', 'X/social', 'user input'] : ['user input', 'deterministic tools'],
      uncertainty: asksForCurrentInfo
        ? 'Current claims can change; confidence depends on available primary sources.'
        : 'No special uncertainty classification was requested.'
    },
    answer_directly: !asksForCurrentInfo,
    needs_freshness_check: asksForCurrentInfo,
    user_claims_to_verify: [],
    tool_calls: asksForCurrentInfo
      ? [
          {
            tool: 'web_search',
            input: { query: lastUserMessage }
          },
          {
            tool: 'x_search',
            input: { query: lastUserMessage }
          }
        ]
      : [],
    source_policy: asksForCurrentInfo
      ? ['Use official or primary sources for current-version claims.']
      : [],
    answer_constraints: [
      `Planner fallback used because planner output was not valid JSON: ${reason}`
    ]
  };
}

async function plan(messages: ChatMessage[]): Promise<PlannerOutput> {
  const system = `You are an epistemic planner for a Grok-powered assistant.
Return JSON only, matching this shape:
{
  "task_type": string,
  "selected_skills": [{"name": string, "reason": string}],
  "reasoning_trace": {
    "summary": string,
    "evidence_policy": string,
    "tools_considered": string[],
    "source_types": string[],
    "uncertainty": string
  },
  "answer_directly": boolean,
  "needs_freshness_check": boolean,
  "user_claims_to_verify": string[],
  "tool_calls": [{"tool": string, "input": object}],
  "source_policy": string[],
  "answer_constraints": string[]
}

Available tools:
${toolCatalog.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}

Thinking skill catalog:
${thinkingSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}

Rules:
- If the user asks about current facts, model names, prices, laws, news, API behavior, people, companies, or release status, mark needs_freshness_check true.
- Treat user claims as fallible; list any premise that affects the answer.
- X posts, social replies, and prior AI answers are weak evidence.
- Prefer official docs, primary sources, source documents, deterministic computation, and executable checks.
- Use both web_search and x_search for questions about xAI, Grok, Elon Musk statements, X posts, release timing, current versions, or launch delays.
- Select one to three thinking skills from the catalog. Pick skills that fit the actual request; do not use a fixed SOP for every question.
- reasoning_trace must be concise and user-facing. Do not expose private chain-of-thought.
- Label X access as social / primary statement / public discourse / weak factual evidence depending on context. Do not restrict X access to an allowlist.
- Keep tool calls minimal and useful.`;

  try {
    const raw = await completeText({
      model: config.plannerModel,
      system,
      messages,
      temperature: 0,
      jsonMode: true
    });

    return PlannerSchema.parse(JSON.parse(extractJson(raw)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackPlan(messages, reason);
  }
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

async function synthesizeWithBuiltInSearch(messages: ChatMessage[], planner: PlannerOutput, toolResults: ToolResult[]) {
  const system = `You are a Grok-like assistant with xAI built-in web_search and x_search enabled.
Use the built-in tools for current facts, xAI/Grok release status, X posts, and public claims.
Answer in the user's language.
Be direct and source-grounded.
When sources disagree or evidence is weak, say so.
Do not rely on stale model memory for current-version or release-timing claims.

Planner and local tool context:
${JSON.stringify({ planner, toolResults }, null, 2)}`;

  const result = await completeTextWithBuiltInSearch({
    model: config.grokModel,
    system,
    messages,
    temperature: 0.3
  });

  const searchTrace: ToolResult = {
    tool: 'xai_builtin_search',
    input: {
      tools: ['web_search', 'x_search'],
      model: config.grokModel
    },
    output: JSON.stringify(result.trace, null, 2)
  };

  return { text: result.text, toolResult: searchTrace };
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
  const wantsBuiltInSearch = planner.needs_freshness_check
    || planner.tool_calls.some((call) => call.tool === 'web_search' || call.tool === 'x_search');

  for (const call of planner.tool_calls.slice(0, 4)) {
    if (call.tool === 'web_search' || call.tool === 'x_search') continue;

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

  if (wantsBuiltInSearch) {
    const searched = await synthesizeWithBuiltInSearch(messages, planner, toolResults);
    toolResults.push(searched.toolResult);
    return { planner, toolResults, draft: searched.text, final: searched.text };
  }

  const draft = await synthesize(messages, planner, toolResults);
  const final = await verify(messages, draft, planner, toolResults);

  return { planner, toolResults, draft, final };
}