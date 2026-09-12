/**
 * The scripted provider. With no API keys the whole office runs on this, so it
 * must look alive: it reads the actual brief, picks a register to match the
 * stage (intake, plan, research, debate, implementation, review, test, report),
 * quotes real phrases from the task, and — for implementation turns that have
 * tools — emits a plausible `write_file` call and then reports the file it
 * wrote. It is fully deterministic: the same input always yields the same text.
 */

import type { ChatMessage, ModelSpec, ToolCallRequest, UsageRecord } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider } from './types.ts';
import { computeCost } from './pricing.ts';

type TurnKind =
  | 'intake'
  | 'plan'
  | 'research'
  | 'debate'
  | 'implementation'
  | 'review'
  | 'test'
  | 'report'
  | 'conversation';

/**
 * What a scripted planning turn is being asked for.
 *
 * A conversation is not a stage, so there is no `Stage:` line to declare it
 * with - the prompt's own words are the only signal available, which is why
 * these markers are checked *before* the keyword rules. Without this the
 * scripted office answers "what does done mean?" with a diff.
 */
type PlanIntent = 'draft' | 'converse';

const PLAN_MARKERS = ['shaping a brief', 'reply with the brief itself', 'planning conversation'];
const DRAFT_MARKERS = ['draft the brief', 'the brief itself', 'write the brief'];

const RULES: Array<[TurnKind, string[]]> = [
  ['debate', ['rebut', 'debate', 'argue', 'counterargument', 'counter-argument', 'steelman', 'opposing']],
  ['intake', ['intake', 'structured objective', 'parse the brief', 'triage', 'distill the brief', 'objective:']],
  ['research', ['research', 'investigate', 'survey', 'look into', 'evidence', 'sources', 'gather']],
  ['review', ['review', 'critique', 'audit', 'assess']],
  ['test', ['test report', 'test plan', 'write tests', 'regression', 'coverage', 'test suite', 'run the tests']],
  ['plan', ['decompose', 'workstream', 'roadmap', 'milestone', 'break down', 'execution plan', 'plan the', 'planning']],
  ['implementation', ['implement', 'build', 'write the', 'create the', 'code', 'refactor', 'stub', 'add a', 'fix the', 'edit the', 'scaffold']],
  ['report', ['final report', 'summarize', 'summarise', 'summary', 'wrap up', 'close out', 'outcome', 'report back']],
];

/**
 * The engine labels every turn with the stage it belongs to, and that label is
 * authoritative. Keyword matching alone is not good enough once a real system
 * prompt is in play: the prompt legitimately contains the words "review",
 * "test" and "code" in skill bodies and house rules, so a build turn would get
 * misread as a review. Reading the declared stage first makes the scripted
 * employee behave like the stage it is actually in, and leaves the keyword path
 * as the fallback for callers that do not declare one.
 */
const STAGE_LINE_RE = /^[ \t]*Stage:[ \t]*\*\*[^*]+\*\*[ \t]*\(([a-z]+)/im;

const STAGE_TO_TURN: Record<string, TurnKind> = {
  intake: 'intake',
  plan: 'plan',
  research: 'research',
  debate: 'debate',
  workshop: 'debate',
  design: 'plan',
  architect: 'plan',
  build: 'implementation',
  review: 'review',
  test: 'test',
  integrate: 'implementation',
  report: 'report',
};

/**
 * Is this a planning conversation, and is it asking for the brief itself?
 *
 * Only the latest user message is examined for the draft instruction, because
 * the history carries that sentence forward - once you have asked for a draft,
 * every later turn would otherwise keep producing one.
 */
function detectPlanTurn(messages: ChatMessage[]): PlanIntent | null {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
    .toLowerCase();
  const inPlan = PLAN_MARKERS.some((marker) => system.includes(marker));
  if (!inPlan) return null;

  let lastUser = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      lastUser = m.content.toLowerCase();
      break;
    }
  }
  return DRAFT_MARKERS.some((marker) => lastUser.includes(marker)) ? 'draft' : 'converse';
}

function classify(messages: ChatMessage[], planIntent: PlanIntent | null): TurnKind {  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  let lastUser = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      lastUser = m.content;
      break;
    }
  }

  const declared = STAGE_LINE_RE.exec(lastUser) ?? STAGE_LINE_RE.exec(system);
  const declaredKind = declared?.[1]?.toLowerCase();
  if (declaredKind !== undefined) {
    const mapped = STAGE_TO_TURN[declaredKind];
    if (mapped !== undefined) return mapped;
  }

  if (planIntent !== null) return 'conversation';

  const hay = `${system}\n${lastUser}`.toLowerCase();
  for (const [kind, keywords] of RULES) {
    if (keywords.some((kw) => hay.includes(kw))) return kind;
  }
  return 'report';
}

/**
 * The operator's actual words, lifted out of the turn's user message.
 *
 * A real engine prompt is structured markdown, so the first line is usually a
 * section heading and the second is a label like "The operator asked for:".
 * Quoting either of those back as the task makes the scripted office look
 * broken, so skip furniture and take the first substantive line.
 */
function briefExcerpt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || !m.content.trim()) continue;
    for (const rawLine of m.content.trim().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      if (line.startsWith('#')) continue; // markdown heading
      if (line.startsWith('---')) continue; // horizontal rule
      if (/^\*\*[^*]+\*\*:?$/.test(line)) continue; // bold-only label
      if (line.length < 80 && (line.endsWith(':') || line.endsWith(':**'))) continue; // "The operator asked for:"
      if (/^[A-Z][A-Za-z ]{0,24}:/.test(line)) continue; // "Stage: **Build** …"
      return line.slice(0, 160);
    }
  }
  return 'the current task';
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'feature';
}

function camelize(slug: string): string {
  const parts = slug.split('-').filter((p) => p.length > 0);
  const joined = parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
  const ident = /^[a-zA-Z_$]/.test(joined) ? joined : `fn${joined}`;
  return ident || 'run';
}

function inferTags(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  const map: Array<[string, string]> = [
    ['typescript', 'typescript'],
    ['model', 'model-routing'],
    ['router', 'routing'],
    ['llm', 'llm'],
    ['provider', 'providers'],
    ['test', 'testing'],
    ['ui', 'frontend'],
    ['react', 'frontend'],
    ['3d', '3d-office'],
    ['office', '3d-office'],
    ['api', 'api'],
    ['agent', 'agents'],
    ['cost', 'cost'],
  ];
  for (const [kw, tag] of map) {
    if (t.includes(kw) && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) tags.push('feature', 'dev3d');
  return tags.slice(0, 4);
}

interface FailureMode {
  label: string;
  body: string;
  consequence: string;
}

function failureMode(excerpt: string): FailureMode {
  const t = excerpt.toLowerCase();
  const table: Array<{ kw: string; mode: FailureMode }> = [
    {
      kw: 'fallback',
      mode: {
        label: 'fallback storms',
        body: 'Every provider failure fans out across the whole fallback list, multiplying spend and latency on a single turn.',
        consequence: 'a short outage becomes a cost spike that exhausts the run budget.',
      },
    },
    {
      kw: 'stream',
      mode: {
        label: 'unbounded streaming',
        body: 'There is no backpressure on deltas, so a chatty model can emit faster than the UI drains it.',
        consequence: 'the office UI stalls and the turn cannot be cancelled cleanly.',
      },
    },
    {
      kw: 'cache',
      mode: {
        label: 'cache invalidation',
        body: 'Cached model decisions go stale the moment the catalog or a provider key changes, and nothing re-validates them.',
        consequence: 'the router keeps routing to a provider that is already down.',
      },
    },
    {
      kw: 'concurrent',
      mode: {
        label: 'a race condition',
        body: 'Concurrent turns share mutable routing state with no ordering guarantee.',
        consequence: 'two employees can route the same work and double-spend.',
      },
    },
    {
      kw: 'budget',
      mode: {
        label: 'cost blowout',
        body: 'Escalation is decoupled from remaining budget, so a hard turn still escalates to a frontier model.',
        consequence: 'a single turn spends the whole run budget before review.',
      },
    },
  ];
  for (const { kw, mode } of table) {
    if (t.includes(kw)) return mode;
  }
  return {
    label: 'token blowup',
    body: 'The objective is not bounded, so a loose brief becomes an unbounded generation.',
    consequence: 'the deliverable costs far more than the task was worth.',
  };
}

/**
 * The idea the operator actually brought, ignoring the plumbing.
 *
 * On the turn that asks for a brief, the latest user message *is* the
 * instruction ("draft the brief now…"). Quoting that back as the objective
 * would make the brief about the request for a brief, so the real idea is taken
 * from the earlier turn instead.
 */
function operatorIdea(messages: ChatMessage[]): string {
  let seenInstruction = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    if (!seenInstruction && DRAFT_MARKERS.some((marker) => text.toLowerCase().includes(marker))) {
      seenInstruction = true;
      continue;
    }
    return text.length > 300 ? `${text.slice(0, 299)}…` : text;
  }
  return 'the task';
}

function render(kind: TurnKind, messages: ChatMessage[], planIntent: PlanIntent | null = null): string {
  const excerpt = briefExcerpt(messages);
  const slug = slugify(excerpt);

  switch (kind) {
    case 'conversation': {
      // A plan that asks for the brief gets a brief; a plan that is still
      // thinking asks the operator the question that is actually outstanding.
      if (planIntent !== 'draft') {
        return [
          `Before this goes anywhere: what does *done* look like for “${excerpt}”?`,
          '',
          '1. What has to be true for you to call this finished — a test passing, a number moving, something a person can no longer do?',
          '2. Is there a constraint I should treat as fixed (a deadline, a system we cannot change, a cost ceiling)?',
          '',
          'Answer those and I will draft the brief.',
        ].join('\n');
      }
      const idea = operatorIdea(messages);
      return [
        `**Objective:** ${idea} — delivered so that the behaviour is correct under the conditions that broke it, and provably so.`,
        '',
        'Done means:',
        `- The failure mode behind “${idea}” is reproduced by a test that fails before the change.`,
        '- The fix holds under the concurrent and retry paths, not only the happy one.',
        '- The existing behaviour for callers that were already correct is unchanged.',
      ].join('\n');
    }
    case 'intake': {
      const tags = inferTags(excerpt)
        .map((t) => `\`${t}\``)
        .join(', ');
      return [
        `**Objective:** Turn “${excerpt}” into a concrete, reviewable deliverable with explicit acceptance criteria and a definition of done.`,
        '',
        `TAGS: ${tags}`,
      ].join('\n');
    }
    case 'debate': {
      const failure = failureMode(excerpt);
      return [
        '## Rebuttal',
        '',
        `The proposal (“${excerpt}”) is sound in outline but fails on one concrete point: **${failure.label}**. ${failure.body}`,
        '',
        `If “${excerpt}” is taken literally, ${failure.consequence}`,
      ].join('\n');
    }
    case 'plan':
      return [
        '## Plan',
        '',
        `To deliver “${excerpt}”:`,
        '',
        `1. **Scope** — pin the exact surface of \`${slug}\` and what “done” means.`,
        '2. **Contract** — write the types and interfaces first so the team shares one vocabulary.',
        '3. **Implement** — build the smallest working slice, then iterate.',
        '4. **Verify** — run `pnpm exec tsc --noEmit` and the test suite.',
      ].join('\n');
    case 'research':
      return [
        '## Research',
        '',
        `- **What we need** — evidence to decide “${excerpt}”.`,
        '- **Approach** — check the repo, docs, and prior art before asserting anything.',
        '- **Open question** — which tradeoff (cost vs. quality vs. latency) dominates here?',
        '',
        '_Next: consolidate findings into a decision-ready summary._',
      ].join('\n');
    case 'implementation':
      return [
        '## Changes',
        '',
        `- \`src/${slug}.ts\` — implements “${excerpt}”.`,
        '- `apps/server/src/llm/` — wired into the existing registry and router.',
        '',
        '**Verify:** `pnpm exec tsc -p apps/server/tsconfig.json --noEmit`',
      ].join('\n');
    case 'review':
      return [
        '## Review',
        '',
        `- **👍 Sound** — “${excerpt}” is scoped clearly enough to act on.`,
        '- **⚠️ Risk** — edge cases (empty catalog, missing keys) must not crash the caller.',
        '- **Suggestion** — add a fallback so a single provider outage degrades instead of failing.',
      ].join('\n');
    case 'test':
      return [
        '## Test report',
        '',
        `- **Covered** — \`${slug}\` happy path plus empty-input guards.`,
        '- **Result** — local `node --test` run green (mock provider, no network).',
        '- **Note** — deterministic assertions only; no flaky timing.',
      ].join('\n');
    case 'report':
    default:
      return [
        '## Summary',
        '',
        `“${excerpt}” is complete. The deliverable is typed, tested, and routed through the cheapest capable model.`,
        '',
        '_Outcome ready for the next stage._',
      ].join('\n');
  }
}

function findWrittenPath(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.name !== 'write_file') continue;
      try {
        const args = JSON.parse(tc.argumentsJson) as { path?: unknown };
        if (typeof args.path === 'string') return args.path;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'tool' && m.toolCallId !== undefined);
}

function buildWriteCall(excerpt: string): ToolCallRequest {
  const slug = slugify(excerpt);
  const path = `src/${slug}.ts`;
  const fn = camelize(slug);
  const content = [
    `/**`,
    ` * ${excerpt}`,
    ` * Generated by the dev3d office (mock provider).`,
    ` */`,
    `export function ${fn}(): void {`,
    `  // TODO: implement against the agreed contract.`,
    `}`,
    ``,
  ].join('\n');
  return {
    id: 'call_mock_write_1',
    name: 'write_file',
    argumentsJson: JSON.stringify({ path, content }),
  };
}

function mockUsage(
  req: ChatRequest,
  text: string,
  toolCalls: ToolCallRequest[],
): UsageRecord {
  let inChars = 0;
  for (const m of req.messages) {
    inChars += m.content.length;
    if (m.name !== undefined) inChars += m.name.length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) inChars += tc.name.length + tc.argumentsJson.length;
    }
  }
  const tokensIn = Math.max(1, Math.round(inChars / 4));
  let outChars = text.length;
  for (const tc of toolCalls) outChars += tc.name.length + tc.argumentsJson.length;
  const tokensOut = Math.max(1, Math.round(outChars / 4));
  return { tokensIn, tokensOut, costUsd: computeCost(req.model, tokensIn, tokensOut) };
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emit(text: string, onDelta: (t: string) => void, signal?: AbortSignal): Promise<void> {
  const CHUNK = 12;
  if (text.length === 0) return;
  const chunks = Math.ceil(text.length / CHUNK);
  const sleepMs = Math.max(1, Math.min(6, Math.floor(100 / chunks)));
  for (let i = 0; i < text.length; i += CHUNK) {
    if (signal?.aborted) throw abortError();
    onDelta(text.slice(i, i + CHUNK));
    await sleep(sleepMs);
  }
}

async function mockChat(req: ChatRequest): Promise<ChatResult> {
  if (req.signal?.aborted) throw abortError();

  const planIntent = detectPlanTurn(req.messages);
  const kind = classify(req.messages, planIntent);
  const excerpt = briefExcerpt(req.messages);
  const wantsTools = (req.tools?.length ?? 0) > 0;

  let text: string;
  let toolCalls: ToolCallRequest[];
  let finishReason: ChatResult['finishReason'];

  if (kind === 'implementation' && wantsTools && !hasToolResult(req.messages)) {
    toolCalls = [buildWriteCall(excerpt)];
    text = '';
    finishReason = 'tool_calls';
  } else if (kind === 'implementation' && hasToolResult(req.messages)) {
    const path = findWrittenPath(req.messages) ?? `src/${slugify(excerpt)}.ts`;
    text = [
      '## Changes',
      '',
      `- \`${path}\` — implemented “${excerpt}”.`,
      '',
      '**Verify:** `pnpm exec tsc -p apps/server/tsconfig.json --noEmit`',
    ].join('\n');
    toolCalls = [];
    finishReason = 'stop';
  } else {
    text = render(kind, req.messages, planIntent);
    toolCalls = [];
    finishReason = 'stop';
  }

  if (req.onDelta) await emit(text, req.onDelta, req.signal);

  return {
    text,
    reasoning: null,
    toolCalls,
    usage: mockUsage(req, text, toolCalls),
    finishReason,
  };
}

export function createMockProvider(cfg: ProviderConfig, models?: ModelSpec[]): LlmProvider {
  const provider: LlmProvider = {
    id: cfg.id,
    label: cfg.label,
    models: models ?? [],
    isConfigured: () => true,
    chat: mockChat,
  };
  return provider;
}
