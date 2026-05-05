import { z } from 'zod';
import { config } from './config.js';
import { ChatMessage, completeText, completeTextWithBuiltInSearch } from './xai.js';
import { runTool, toolCatalog, ToolResult } from './tools.js';
import { formatSelectedSkillSops, formatSkillIndexForPlanner, hydrateSelectedSkills } from './skillCatalog.js';

const PlannerSchema = z.object({
  task_type: z.string().default('general'),
  reasoning_mode: z.enum(['normal', 'heavy']).default('normal'),
  reasoning_work_plan: z.array(z.object({
    step: z.string(),
    status: z.enum(['pending', 'checked']).default('pending'),
    note: z.string().optional()
  })).default([]),
  selected_skills: z.array(z.object({
    id: z.string().optional(),
    name: z.string(),
    reason: z.string(),
    summary: z.string().optional(),
    sop: z.string().optional(),
    trace_note: z.string().optional()
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
type ReasoningWorkPlanItem = PlannerOutput['reasoning_work_plan'][number];

export type ClientContext = {
  timezone?: string;
  locale?: string;
  local_time?: string;
  local_time_display?: string;
  utc_offset_minutes?: number;
};

function formatClientContext(clientContext?: ClientContext) {
  if (!clientContext) {
    return 'Client context was not provided. Use server-side absolute dates when needed.';
  }

  return [
    `timezone=${clientContext.timezone || 'unknown'}`,
    `locale=${clientContext.locale || 'unknown'}`,
    `local_time=${clientContext.local_time || 'unknown'}`,
    `local_time_display=${clientContext.local_time_display || 'unknown'}`,
    `utc_offset_minutes=${typeof clientContext.utc_offset_minutes === 'number' ? clientContext.utc_offset_minutes : 'unknown'}`
  ].join('\n');
}

function classifyReasoningMode(lastUserMessage: string, asksForCurrentInfo: boolean, asksForImplementation: boolean) {
  const looksComplex = /比較|分析|架構|方案|部署|部屬|審查|review|verify|驗證|trace|tool|source|policy|issue|pr|github|ci|architecture|compare|debug|investigate/i.test(lastUserMessage);
  return asksForCurrentInfo || asksForImplementation || looksComplex ? 'heavy' : 'normal';
}

function defaultWorkPlan(mode: 'normal' | 'heavy', taskType: string, needsFreshnessCheck: boolean): ReasoningWorkPlanItem[] {
  if (mode === 'normal') {
    return [
      {
        step: 'Check the user request and answer constraints.',
        status: 'pending'
      },
      {
        step: 'Answer with concise caveats when needed.',
        status: 'pending'
      }
    ];
  }

  const steps: ReasoningWorkPlanItem[] = [
    {
      step: 'Clarify the task, user claims, and risk level.',
      status: 'pending'
    },
    {
      step: 'Select the relevant Markdown-backed skill SOPs.',
      status: 'pending'
    }
  ];

  if (needsFreshnessCheck) {
    steps.push({
      step: 'Run or request fresh source checks before relying on current facts.',
      status: 'pending'
    });
  }

  if (taskType === 'implementation') {
    steps.push({
      step: 'Inspect affected code paths and implement the minimal scoped change.',
      status: 'pending'
    });
    steps.push({
      step: 'Run deterministic validation and summarize any remaining risk.',
      status: 'pending'
    });
  } else {
    steps.push({
      step: 'Compare evidence strength and identify uncertainty.',
      status: 'pending'
    });
    steps.push({
      step: 'Synthesize the final answer from checked evidence and notes.',
      status: 'pending'
    });
  }

  return steps;
}

function completeWorkPlan(planner: PlannerOutput, toolResults: ToolResult[], finalAnswer?: string): PlannerOutput {
  const workPlan = planner.reasoning_work_plan.length
    ? planner.reasoning_work_plan
    : defaultWorkPlan(planner.reasoning_mode, planner.task_type, planner.needs_freshness_check);

  const checkedPlan = workPlan.map((item, index) => {
    const existingNote = item.note?.trim();
    let note = existingNote;

    if (!note) {
      if (/fresh|source|tool|web|x_search|current/i.test(item.step)) {
        note = toolResults.length
          ? `Checked ${toolResults.map((result) => result.tool).join(', ')} output before answering.`
          : 'No external tool output was available for this step.';
      } else if (/skill|SOP/i.test(item.step)) {
        note = planner.selected_skills.length
          ? `Loaded ${planner.selected_skills.length} selected skill SOP(s) from Markdown.`
          : 'No specific skill SOP was selected.';
      } else if (index === workPlan.length - 1) {
        note = finalAnswer
          ? `Final answer generated from planner constraints, tool results, and checked notes.`
          : 'Prepared final answer constraints.';
      } else {
        note = 'Checked and summarized for the final response.';
      }
    }

    return {
      ...item,
      status: 'checked' as const,
      note
    };
  });

  return {
    ...planner,
    reasoning_work_plan: checkedPlan
  };
}

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
  const taskType = asksForCurrentInfo ? 'current_fact_check' : asksForImplementation ? 'implementation' : 'general';
  const reasoningMode = classifyReasoningMode(lastUserMessage, asksForCurrentInfo, asksForImplementation);
  const selectedSkills = asksForCurrentInfo
    ? [
        {
          id: 'source_hierarchy',
          name: 'Source Hierarchy Evaluation',
          reason: 'The answer depends on separating official or primary evidence from social/public discourse.'
        },
        {
          id: 'bayesian_reasoning',
          name: 'Bayesian Reasoning',
          reason: 'The claim may be uncertain or time-sensitive, so confidence should update with available evidence.'
        }
      ]
    : asksForImplementation
      ? [
          {
            id: 'implementation_decomposition',
            name: 'Implementation-Oriented Decomposition',
            reason: 'The request needs to be broken into modules, data flow, risks, and validation steps.'
          },
          {
            id: 'adversarial_red_team',
            name: 'Adversarial / Red-Team Thinking',
            reason: 'Implementation changes should consider failure modes and regressions.'
          }
        ]
      : [
          {
            id: 'first_principles',
            name: 'First Principles Thinking',
            reason: 'The request can be answered by grounding it in basic constraints and assumptions.'
          }
        ];

  return {
    task_type: taskType,
    reasoning_mode: reasoningMode,
    reasoning_work_plan: defaultWorkPlan(reasoningMode, taskType, asksForCurrentInfo),
    selected_skills: hydrateSelectedSkills(selectedSkills),
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

async function plan(messages: ChatMessage[], clientContext?: ClientContext): Promise<PlannerOutput> {
  const system = `You are an epistemic planner for a Grok-powered assistant.
Return JSON only, matching this shape:
{
  "task_type": string,
  "reasoning_mode": "normal" | "heavy",
  "reasoning_work_plan": [{"step": string, "status": "pending", "note": string}],
  "selected_skills": [{"id": string, "name": string, "reason": string}],
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

Client context to pass into every model step:
${formatClientContext(clientContext)}

Thinking skill catalog:
${formatSkillIndexForPlanner()}

Rules:
- Use client context when interpreting today, yesterday, tomorrow, deadlines, and current local dates.
- Set reasoning_mode to "heavy" for multi-step implementation, PR/GitHub work, high uncertainty, current facts, source verification, or complex comparisons. Use "normal" for simple direct answers.
- For heavy mode, create a user-facing todo checklist in reasoning_work_plan. Each item must be a concise observable step with status "pending"; do not include private chain-of-thought.
- For normal mode, keep reasoning_work_plan to one or two concise summary steps.
- If the user asks about current facts, model names, prices, laws, news, API behavior, people, companies, or release status, mark needs_freshness_check true.
- Treat user claims as fallible; list any premise that affects the answer.
- X posts, social replies, and prior AI answers are weak evidence.
- Prefer official docs, primary sources, source documents, deterministic computation, and executable checks.
- Use both web_search and x_search for questions about xAI, Grok, Elon Musk statements, X posts, release timing, current versions, or launch delays.
- Select one to three thinking skills from the catalog by id. Pick skills that fit the actual request; do not use a fixed SOP for every question.
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

    const planner = PlannerSchema.parse(JSON.parse(extractJson(raw)));
    return {
      ...planner,
      selected_skills: hydrateSelectedSkills(planner.selected_skills),
      reasoning_work_plan: planner.reasoning_work_plan.length
        ? planner.reasoning_work_plan
        : defaultWorkPlan(planner.reasoning_mode, planner.task_type, planner.needs_freshness_check)
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackPlan(messages, reason);
  }
}

async function synthesize(messages: ChatMessage[], planner: PlannerOutput, toolResults: ToolResult[], clientContext?: ClientContext) {
  const selectedSkillSops = formatSelectedSkillSops(planner.selected_skills);
  const system = `You are a Grok-like assistant wrapped in a verification layer.
Be direct, sharp, and useful, but do not over-trust social content.
Use the planner constraints and tool results.
When evidence is weak, say so.
Do not claim that a tool verified something unless the tool output supports it.
Use the client context for all relative-date and timezone-sensitive interpretation.
Do not expose private chain-of-thought; use only concise user-facing summaries.

Client context:
${formatClientContext(clientContext)}

Selected skill SOPs:
${selectedSkillSops || 'No detailed skill SOP was selected.'}`;

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

async function synthesizeWithBuiltInSearch(messages: ChatMessage[], planner: PlannerOutput, toolResults: ToolResult[], clientContext?: ClientContext) {
  const selectedSkillSops = formatSelectedSkillSops(planner.selected_skills);
  const system = `You are a Grok-like assistant with xAI built-in web_search and x_search enabled.
Use the built-in tools for current facts, xAI/Grok release status, X posts, and public claims.
Answer in the user's language.
Be direct and source-grounded.
When sources disagree or evidence is weak, say so.
Do not rely on stale model memory for current-version or release-timing claims.
Use the client context for all relative-date and timezone-sensitive interpretation.
Do not expose private chain-of-thought; use only concise user-facing summaries.

Client context:
${formatClientContext(clientContext)}

Selected skill SOPs:
${selectedSkillSops || 'No detailed skill SOP was selected.'}

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

async function verify(messages: ChatMessage[], draft: string, planner: PlannerOutput, toolResults: ToolResult[], clientContext?: ClientContext) {
  const system = `You are a strict verifier. Return a concise critique plus a corrected final answer if needed.
Check:
- Did the answer overstate evidence?
- Did it ignore freshness/user-premise risk?
- Did it cite or imply authority from weak sources?
- Did it fail to use deterministic tool output?
- Did it respect the user's client timezone and local time when relative dates matter?
- For search-backed answers, did it separate official/vendor claims, independent reporting, public discourse, benchmarks, product UX, reliability, and alignment/safety evidence?
- Do not treat reasoning/capability benchmarks as direct proof of post-training quality, alignment quality, safety reliability, or product UX reliability.
If the draft is acceptable, return it unchanged under "final".`;

  return completeText({
    model: config.verifierModel,
    system,
    messages: [
      ...messages,
      {
        role: 'system',
        content: JSON.stringify({ draft, planner, toolResults, clientContext }, null, 2)
      }
    ],
    temperature: 0
  });
}

export async function runConversation(messages: ChatMessage[], clientContext?: ClientContext) {
  let planner = await plan(messages, clientContext);
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
    const searched = await synthesizeWithBuiltInSearch(messages, planner, toolResults, clientContext);
    toolResults.push(searched.toolResult);
    const final = await verify(messages, searched.text, planner, toolResults, clientContext);
    planner = completeWorkPlan(planner, toolResults, final);
    return { planner, clientContext, toolResults, draft: searched.text, final };
  }

  const draft = await synthesize(messages, planner, toolResults, clientContext);
  const final = await verify(messages, draft, planner, toolResults, clientContext);
  planner = completeWorkPlan(planner, toolResults, final);

  return { planner, clientContext, toolResults, draft, final };
}
