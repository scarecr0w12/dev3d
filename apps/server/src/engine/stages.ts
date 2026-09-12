/**
 * Stage executors: the four ways a stage can schedule its people.
 *
 *   single       one employee, one turn (or a short internal loop)
 *   parallel     every listed employee works independently at the same time
 *   debate       positions, then rebuttals over N rounds, then the facilitator
 *                rules on it and records the decision
 *   review-loop  reviewers critique what was built; if they object, the people
 *                who actually wrote the files revise, up to a hard iteration cap
 *
 * One interpretation is worth stating plainly, because it is a deliberate
 * deviation from a literal reading of `StageSpec`'s doc comment. That comment
 * says the FIRST role id in a `review-loop` is the *producer*. In the shipped
 * pipelines it is not: `product-build`'s review stage is
 * `['backend-lead', 'frontend-lead', 'qa-lead']` - three reviewers, none of whom
 * built anything. Treating `backend-lead` as the producer would have it revise
 * its own review. So here the first id is the **review chair** (it synthesises
 * the verdict), and the real producers are derived from what the run actually
 * wrote - which is the only source of truth for "who built this".
 */

import type {
  Artifact,
  ArtifactKind,
  Role,
  Run,
  StageKind,
  StageRun,
  TurnRecord,
} from '@dev3d/core';
import { runTurn } from './turn.ts';
import type { EngineDeps, RunKnowledge, StageUtterance } from './types.ts';

export interface StageContext {
  run: Run;
  stage: StageRun;
  knowledge: RunKnowledge;
  /** Run-scoped set of workspace-relative paths written so far. */
  writtenPaths: Set<string>;
  signal: AbortSignal;
  companyName: string;
  companyMission: string;
  /** Returns a human-readable reason the run must stop, or null to continue. */
  abortReason: () => string | null;
}

export interface StageOutcome {
  summary: string;
  turns: TurnRecord[];
  artifacts: Artifact[];
}

const OBJECTION_RE =
  /(objection|must fix|must be fixed|blocking|blocks release|reject|not acceptable|does not work|doesn't work|❌|⚠)/i;
const APPROVAL_RE = /(approv|sign[- ]off|ship it|looks good|lgtm|good enough)/i;
/**
 * Phrases that *deny* an objection. "No objections" is an approval, and a
 * heuristic that cannot tell the difference would send every clean review back
 * for another revision round.
 */
const NEGATED_OBJECTION_RE = /\b(no|zero|without)\s+(objections?|blockers?|concerns?|issues?)\b/gi;

/**
 * Did a review actually raise something? Deliberately conservative: a mixed
 * verdict counts as an objection, because the cost of one extra revision round
 * is far lower than the cost of shipping past a warning.
 */
export function reviewRaisedObjections(text: string): boolean {
  return OBJECTION_RE.test(text.replace(NEGATED_OBJECTION_RE, ' '));
}

export function reviewApproved(text: string): boolean {
  return APPROVAL_RE.test(text) && !OBJECTION_RE.test(text);
}

function artifactKindForStage(kind: StageKind): ArtifactKind {
  switch (kind) {
    case 'intake':
      return 'objective';
    case 'plan':
      return 'plan';
    case 'research':
      return 'research';
    case 'debate':
      return 'transcript';
    case 'workshop':
      return 'decision';
    case 'design':
      return 'design';
    case 'architect':
      return 'spec';
    case 'build':
      return 'code';
    case 'review':
      return 'review';
    case 'test':
      return 'test-report';
    case 'integrate':
      return 'note';
    case 'report':
    default:
      return 'report';
  }
}

/** Run `fn` over items with a hard concurrency ceiling, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… [truncated]`;
}

function resolveRoles(deps: EngineDeps, ids: string[], workspaceId: string): Role[] {
  const out: Role[] = [];
  for (const id of ids) {
    const role = deps.org.role(id, workspaceId);
    if (role) out.push(role);
    else {
      deps.sink.emit({
        type: 'log',
        level: 'warn',
        scope: 'engine/stages',
        message: `Stage references role "${id}", which is not in the org chart. Skipping it.`,
        at: Date.now(),
      });
    }
  }
  return out;
}

function participantsOf(roles: Role[]): Array<{ roleId: string; displayName: string; title: string }> {
  return roles.map((r) => ({ roleId: r.id, displayName: r.displayName, title: r.title }));
}

/** Fold a finished turn into the run's accumulated knowledge. */
function absorb(knowledge: RunKnowledge, turn: TurnRecord, speaker: string): void {
  for (const p of turn.wroteFiles) {
    if (!knowledge.filesWritten.includes(p)) knowledge.filesWritten.push(p);
  }
  if (turn.wroteFiles.length > 0 && !knowledge.producers.includes(turn.roleId)) {
    knowledge.producers.push(turn.roleId);
  }
  void speaker;
}

async function runOneTurn(
  deps: EngineDeps,
  ctx: StageContext,
  role: Role,
  purpose: string,
  purposeIndex: number,
  transcript: StageUtterance[],
  roles: Role[],
  knowledge: RunKnowledge = ctx.knowledge,
  writtenPaths: Set<string> = ctx.writtenPaths,
): Promise<TurnRecord> {
  const turn = await runTurn(deps, {
    run: ctx.run,
    stage: ctx.stage,
    role,
    purpose,
    knowledge,
    stageTranscript: transcript,
    participants: participantsOf(roles),
    companyName: ctx.companyName,
    companyMission: ctx.companyMission,
    departmentName:
      deps.org.chart(ctx.run.workspaceId).departments.find((d) => d.id === role.departmentId)?.name ?? role.departmentId,
    writtenPaths,
    turnIndex: purposeIndex,
    signal: ctx.signal,
  });
  ctx.stage.turnIds.push(turn.id);
  absorb(knowledge, turn, role.displayName);
  return turn;
}

function utterance(role: Role, purpose: string, text: string): StageUtterance {
  return { speaker: `${role.displayName} (${role.title})`, purpose, text };
}

/** Speaker label for a turn whose role may have been fired mid-run. */
function speakerFor(deps: EngineDeps, roleId: string, workspaceId: string): string {
  const role = deps.org.role(roleId, workspaceId);
  if (!role) return roleId;
  return `${role.displayName} (${role.title})`;
}

function summarizeTurns(turns: TurnRecord[], max = 6_000): string {
  const parts: string[] = [];
  for (const t of turns) {
    const body = t.text.trim();
    if (body === '') continue;
    parts.push(`### ${t.employeeId} — ${t.purpose}\n\n${body}`);
  }
  return clip(parts.join('\n\n'), max);
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

async function runSingle(deps: EngineDeps, ctx: StageContext, roles: Role[]): Promise<StageOutcome> {
  const owner = roles[0];
  if (!owner) return { summary: '', turns: [], artifacts: [] };
  const turn = await runOneTurn(deps, ctx, owner, `Carry out "${ctx.stage.spec.name}".`, 0, [], roles);
  return { summary: clip(turn.text, 6_000) || `(no output) ${turn.error ?? ''}`, turns: [turn], artifacts: [] };
}

async function runParallel(deps: EngineDeps, ctx: StageContext, roles: Role[]): Promise<StageOutcome> {
  // Each branch gets its own knowledge snapshot so two builders cannot interleave
  // writes into one shared list; the results are merged afterwards in role order.
  const snapshots = roles.map(() => structuredClone(ctx.knowledge) as RunKnowledge);
  const turns = await mapWithConcurrency(roles, deps.config.maxConcurrency, async (role, i) =>
    runOneTurn(
      deps,
      ctx,
      role,
      `Work your slice of "${ctx.stage.spec.name}".`,
      0,
      [],
      roles,
      snapshots[i] ?? ctx.knowledge,
      ctx.writtenPaths,
    ),
  );
  const kept: TurnRecord[] = [];
  for (const turn of turns) {
    if (!turn) continue;
    kept.push(turn);
    absorb(ctx.knowledge, turn, turn.roleId);
  }
  return { summary: summarizeTurns(kept), turns: kept, artifacts: [] };
}

async function runDebate(deps: EngineDeps, ctx: StageContext, roles: Role[]): Promise<StageOutcome> {
  const rounds = Math.max(1, ctx.stage.spec.rounds ?? 2);
  const facilitator = roles[0];
  const turns: TurnRecord[] = [];
  const transcript: StageUtterance[] = [];

  for (let round = 1; round <= rounds; round += 1) {
    for (const role of roles) {
      if (ctx.signal.aborted) break;
      const halted = ctx.abortReason();
      if (halted !== null) break;
      const purpose =
        round === 1
          ? `Open your position (round 1 of ${rounds}).`
          : `Rebut what you have heard (round ${round} of ${rounds}).`;
      const turn = await runOneTurn(
        deps,
        ctx,
        role,
        purpose,
        round - 1,
        transcript.slice(),
        roles,
      );
      turns.push(turn);
      transcript.push(utterance(role, purpose, turn.text));
      deps.sink.emit({
        type: 'speech',
        runId: ctx.run.id,
        stageId: ctx.stage.id,
        fromEmployeeId: role.id,
        toEmployeeIds: roles.filter((r) => r.id !== role.id).map((r) => r.id),
        text: clip(turn.text, 1_200),
        kind: 'debate',
        at: Date.now(),
      });
    }
  }

  // The facilitator rules on it. This is the stage's actual product, so it is
  // the summary the next stage receives.
  if (facilitator && !ctx.signal.aborted && ctx.abortReason() === null) {
    const purpose =
      ctx.stage.spec.kind === 'workshop'
        ? 'Converge the discussion into the decision record this stage must produce.'
        : 'Rule on the disagreement: decide, record the alternatives rejected and why.';
    const verdict = await runOneTurn(deps, ctx, facilitator, purpose, rounds, transcript.slice(), roles);
    turns.push(verdict);
    transcript.push(utterance(facilitator, purpose, verdict.text));
    deps.sink.emit({
      type: 'speech',
      runId: ctx.run.id,
      stageId: ctx.stage.id,
      fromEmployeeId: facilitator.id,
      toEmployeeIds: roles.filter((r) => r.id !== facilitator.id).map((r) => r.id),
      text: clip(verdict.text, 2_000),
      kind: 'report',
      at: Date.now(),
    });
    return { summary: clip(verdict.text, 6_000), turns, artifacts: [] };
  }

  return { summary: summarizeTurns(turns), turns, artifacts: [] };
}

async function runReviewLoop(deps: EngineDeps, ctx: StageContext, roles: Role[]): Promise<StageOutcome> {
  const maxIterations = Math.max(1, ctx.stage.spec.maxIterations ?? 2);
  const chair = roles[0];
  const reviewers = roles.slice(1);
  const turns: TurnRecord[] = [];
  let verdictText = '';

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (ctx.signal.aborted || ctx.abortReason() !== null) break;
    const transcript: StageUtterance[] = [];

    // Reviewers critique in parallel, then the chair reads all of it.
    const reviews = await mapWithConcurrency(reviewers, deps.config.maxConcurrency, async (role) => {
      const purpose = `Review pass ${iteration} of ${maxIterations}: judge the files this run actually produced.`;
      const before = ctx.knowledge.filesWritten.length;
      const turn = await runOneTurn(deps, ctx, role, purpose, iteration - 1, [], roles);
      return { turn, before };
    });

    for (const review of reviews) {
      if (!review) continue;
      turns.push(review.turn);
      transcript.push({
        speaker: speakerFor(deps, review.turn.roleId, ctx.run.workspaceId),
        purpose: review.turn.purpose,
        text: review.turn.text,
      });
    }

    if (chair && !ctx.signal.aborted) {
      const purpose = `Synthesise review pass ${iteration}: state plainly whether this is approved, or list what must change.`;
      verdictText = '';
      const verdict = await runOneTurn(deps, ctx, chair, purpose, iteration - 1, transcript.slice(), roles);
      turns.push(verdict);
      verdictText = verdict.text;

      if (reviewApproved(verdictText) || !reviewRaisedObjections(verdictText)) {
        break;
      }
    }

    // Someone objected. Send it back to the people who actually wrote the files.
    const producers = resolveRoles(deps, ctx.knowledge.producers, ctx.run.workspaceId).filter(
      (r) => !roles.some((x) => x.id === r.id),
    );
    if (producers.length === 0 || iteration === maxIterations) break;

    const revisionTranscript = transcript.slice();
    const revisions = await mapWithConcurrency(producers, deps.config.maxConcurrency, async (role) => {
      const purpose = `Revise your work to answer review pass ${iteration}. Change the files, do not just agree.`;
      return runOneTurn(deps, ctx, role, purpose, iteration, revisionTranscript, roles);
    });
    for (const revision of revisions) {
      if (!revision) continue;
      turns.push(revision);
    }
  }

  return {
    summary: clip(verdictText, 6_000) || summarizeTurns(turns),
    turns,
    artifacts: [],
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Execute one stage. Always resolves: a stage that fails leaves its turns
 * recorded with their errors, and the run engine decides what that means.
 */
export async function executeStage(deps: EngineDeps, ctx: StageContext): Promise<StageOutcome> {
  const roles = resolveRoles(deps, ctx.stage.spec.roleIds, ctx.run.workspaceId);

  if (roles.length === 0) {
    const message = `Stage "${ctx.stage.spec.name}" has no resolvable participants.`;
    deps.sink.emit({ type: 'log', level: 'error', scope: 'engine/stages', message, at: Date.now() });
    return { summary: '', turns: [], artifacts: [] };
  }

  let outcome: StageOutcome;
  switch (ctx.stage.spec.mode) {
    case 'parallel':
      outcome = await runParallel(deps, ctx, roles);
      break;
    case 'debate':
      outcome = await runDebate(deps, ctx, roles);
      break;
    case 'review-loop':
      outcome = await runReviewLoop(deps, ctx, roles);
      break;
    case 'single':
    default:
      outcome = await runSingle(deps, ctx, roles);
      break;
  }

  // The stage's headline result is what the next stage receives, so it must be
  // self-contained. One artifact per stage, plus one per file the stage wrote.
  const artifacts: Artifact[] = [];
  const stageArtifact: Artifact = {
    id: `art_${ctx.stage.id}`,
    runId: ctx.run.id,
    stageId: ctx.stage.id,
    employeeId: roles[0]?.id ?? null,
    kind: artifactKindForStage(ctx.stage.spec.kind),
    title: ctx.stage.spec.name,
    body: outcome.summary,
    createdAt: Date.now(),
  };
  artifacts.push(stageArtifact);

  const stageFiles = new Set<string>();
  for (const turn of outcome.turns) {
    for (const p of turn.wroteFiles) stageFiles.add(p);
  }
  for (const path of stageFiles) {
    artifacts.push({
      id: `art_${ctx.stage.id}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      runId: ctx.run.id,
      stageId: ctx.stage.id,
      employeeId: null,
      kind: 'code',
      title: path,
      body: `Created or modified during "${ctx.stage.spec.name}".`,
      path,
      createdAt: Date.now(),
    });
  }

  ctx.stage.endedAt = Date.now();
  return { summary: outcome.summary, turns: outcome.turns, artifacts };
}
