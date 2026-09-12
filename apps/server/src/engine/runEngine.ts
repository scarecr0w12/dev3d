/**
 * The run engine: one brief in, one finished piece of work out.
 *
 * It walks the pipeline stage by stage, threads the accumulated knowledge
 * forward, enforces the budget, honours cancellation, and keeps the run's own
 * record - status, timings, stage summaries, spend - truthful at every step.
 * Every state change is emitted as an event *before* the next thing happens, so
 * a browser watching the socket sees the run happen rather than hearing about it
 * afterwards.
 *
 * Failure policy, stated explicitly because it is a real product decision:
 *  - a stage that produces nothing halts the run unless the stage is `optional`;
 *  - an optional stage that fails is recorded as failed and the run continues;
 *  - exceeding the budget always halts the run, whatever stage it is in.
 */

import { randomUUID } from 'node:crypto';
import type {
  Artifact,
  ChatMessage,
  DirectMessage,
  ModelPolicy,
  Pipeline,
  Run,
  ServerEvent,
  StageRun,
} from '@dev3d/core';
import { routeModel } from '../router/modelRouter.ts';
import { executeStage, type StageContext } from './stages.ts';
import { emptyKnowledge, type EngineDeps, type RunKnowledge } from './types.ts';

export interface SubmitInput {
  brief: string;
  pipelineId?: string;
  budgetUsd?: number;
  /** The project to work in. Falls back to the default workspace. */
  workspaceId?: string;
  submittedBy?: string | null;
}

/** A turn of an ongoing conversation, as the operator's browser replays it. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlanReply {
  text: string;
  employeeId: string;
  route: DirectMessage['route'];
}

export interface RunEngine {
  submit(input: SubmitInput): Run;
  cancel(runId: string): boolean;
  getRun(runId: string): Run | undefined;
  runs(): Run[];
  activeRunIds(): string[];
  /** Talk to one employee outside any pipeline. Returns the exchange. */
  directMessage(employeeId: string, text: string, workspaceId?: string): Promise<DirectMessage[]>;
  /**
   * Shape a brief before any work is commissioned.
   *
   * The conversation is seeded with the history the browser holds, which is what
   * makes this a *refinement* rather than a sequence of unrelated questions - the
   * difference between a chat window and a plan.
   */
  planMessage(
    employeeId: string,
    text: string,
    history: readonly ChatTurn[],
    workspaceId?: string,
  ): Promise<PlanReply>;
  /** Resolves once a run reaches a terminal state. Used by tests and scripts. */
  whenSettled(runId: string): Promise<Run | undefined>;
}

const TERMINAL: ReadonlySet<Run['status']> = new Set<Run['status']>([
  'done',
  'failed',
  'cancelled',
]);

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/**
 * Choose a pipeline when the operator did not. A question is not a project:
 * sending "what does this error mean?" through a ten-stage build pipeline would
 * waste real money, so short interrogative briefs get the cheap pipeline.
 */
export function pickPipelineId(brief: string, pipelines: Pipeline[]): string {
  const has = (id: string): boolean => pipelines.some((p) => p.id === id);
  const text = brief.trim();
  const lower = text.toLowerCase();
  const questionLike =
    text.length < 240 &&
    (text.endsWith('?') ||
      /^(what|why|how|when|where|who|which|is|are|does|do|can|could|should|explain|tell me)\b/.test(lower));
  if (questionLike && has('quick-answer')) return 'quick-answer';

  const changeLike =
    /\b(fix|bug|refactor|rename|update|change|patch|tweak|adjust|upgrade|move|remove|delete)\b/.test(lower) &&
    text.length < 600;
  if (changeLike && has('code-change')) return 'code-change';

  if (has('product-build')) return 'product-build';
  const first = pipelines[0];
  return first ? first.id : 'product-build';
}

/** Pull the `TAGS: ...` line the intake stage is instructed to emit. */
export function parseTags(text: string): string[] {
  const match = /^[ \t>*-]*TAGS:[ \t]*(.+)$/im.exec(text);
  if (!match || !match[1]) return [];
  return match[1]
    .replace(/[`"']/g, '')
    .split(/[,\u2022|]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '' && t.length <= 32)
    .slice(0, 8);
}

export function createRunEngine(deps: EngineDeps): RunEngine {
  const runsById = new Map<string, Run>();
  const controllers = new Map<string, AbortController>();
  const settleWaiters = new Map<string, Array<(run: Run | undefined) => void>>();
  /** Runs that have already cleared the soft-spend approval gate, once each. */
  const spendApproved = new Set<string>();

  const emit = (event: ServerEvent): void => deps.sink.emit(event);

  /**
   * The route for a conversation turn - a direct message or a planning exchange.
   *
   * A conversation is not a classified task, so it routes on the role's own
   * default tier and ignores any per-task-class override: a developer talks to
   * you as a developer, not as whatever `summarize` would have been priced at.
   */
  function conversationRoute(workspaceId: string, modelPolicy: ModelPolicy) {
    const policy: ModelPolicy = { ...modelPolicy };
    delete policy.byTaskClass;
    const posture = deps.org.chart(workspaceId).routingPosture;
    return routeModel(
      { taskClass: 'summarize', complexity: 0.3, policy, posture },
      { models: deps.registry.routableModels(), posture },
    );
  }

  /** Deep copy so a listener can never mutate engine state through an event. */
  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function settle(run: Run): void {
    controllers.delete(run.id);
    const waiters = settleWaiters.get(run.id);
    if (waiters) {
      settleWaiters.delete(run.id);
      for (const w of waiters) w(clone(run));
    }
  }

  function touch(run: Run): void {
    run.updatedAt = Date.now();
    emit({ type: 'run.updated', run: clone(run), at: Date.now() });
  }

  function finishStage(run: Run, stage: StageRun, status: StageRun['status'], error: string | null): void {
    stage.status = status;
    stage.error = error;
    if (stage.endedAt === null) stage.endedAt = Date.now();
    emit({ type: 'stage.finished', runId: run.id, stage: clone(stage), at: Date.now() });
  }

  async function executeRun(run: Run, pipeline: Pipeline, signal: AbortSignal): Promise<void> {
    const knowledge: RunKnowledge = emptyKnowledge(run.brief);
    const writtenPaths = new Set<string>();
    /** Whoever owns the first stage takes the credit - or the blame - for it. */
    const intakeOwner = pipeline.stages[0]?.roleIds[0] ?? 'ceo';

    run.status = 'running';
    touch(run);

    for (const stage of run.stages) {
      if (signal.aborted) break;

      // Tags are only known after intake, so tag-gated stages are decided here.
      if (stage.spec.whenTags && stage.spec.whenTags.length > 0) {
        const wanted = stage.spec.whenTags.some((t) => run.tags.includes(t));
        if (!wanted) {
          stage.status = 'skipped';
          stage.startedAt = null;
          stage.endedAt = Date.now();
          emit({ type: 'stage.finished', runId: run.id, stage: clone(stage), at: Date.now() });
          continue;
        }
      }

      // Budget is checked before the stage, not just after: it is the only way
      // to stop a run from spending money it does not have.
      if (run.budget.spentUsd >= run.budget.limitUsd) {
        run.status = 'failed';
        run.error = `Run budget of $${run.budget.limitUsd.toFixed(2)} was exhausted before stage "${stage.spec.name}".`;
        run.endedAt = Date.now();
        emit({ type: 'error', message: run.error, runId: run.id, at: Date.now() });
        touch(run);
        settle(run);
        return;
      }

      // Soft-spend gate: crossing the configured threshold asks the human once.
      if (
        deps.config.softSpendApprovalUsd > 0 &&
        run.budget.spentUsd >= deps.config.softSpendApprovalUsd &&
        !spendApproved.has(run.id)
      ) {
        spendApproved.add(run.id);
        const ok = await deps.approvals.request({
          runId: run.id,
          turnId: null,
          employeeId: intakeOwner,
          kind: 'spend',
          summary: `Spend $${run.budget.spentUsd.toFixed(2)} of the $${run.budget.limitUsd.toFixed(2)} budget and continue?`,
          detail:
            `The run has spent $${run.budget.spentUsd.toFixed(2)} so far. ` +
            `Remaining: $${Math.max(0, run.budget.limitUsd - run.budget.spentUsd).toFixed(2)}. ` +
            `The next stage is "${stage.spec.name}" (${stage.spec.kind}).`,
        });
        if (!ok) {
          run.status = 'cancelled';
          run.error = 'The operator declined to continue spending on this run.';
          run.endedAt = Date.now();
          touch(run);
          settle(run);
          return;
        }
      }

      stage.status = 'running';
      stage.startedAt = Date.now();
      stage.participantRoleIds = [...stage.spec.roleIds];
      emit({ type: 'stage.started', runId: run.id, stage: clone(stage), at: Date.now() });

      const ctx: StageContext = {
        run,
        stage,
        knowledge,
        writtenPaths,
        signal,
        companyName: deps.org.chart(run.workspaceId).company.name,
        companyMission: deps.org.chart(run.workspaceId).company.mission,
        abortReason: () => {
          if (signal.aborted) return 'The operator cancelled this run.';
          if (run.budget.spentUsd >= run.budget.limitUsd) {
            return `Run budget of $${run.budget.limitUsd.toFixed(2)} has been exhausted.`;
          }
          return null;
        },
      };

      let summary = '';
      let artifacts: Artifact[] = [];
      try {
        const outcome = await executeStage(deps, ctx);
        summary = outcome.summary;
        artifacts = outcome.artifacts;
      } catch (e) {
        stage.error = e instanceof Error ? e.message : String(e);
        emit({
          type: 'log',
          level: 'error',
          scope: 'engine/run',
          message: `Stage "${stage.spec.name}" threw: ${stage.error}`,
          at: Date.now(),
        });
      }

      stage.summary = summary === '' ? null : summary;
      for (const artifact of artifacts) {
        knowledge.artifacts.push(artifact);
        stage.artifactIds.push(artifact.id);
        emit({ type: 'artifact.created', artifact, at: Date.now() });
      }

      if (summary !== '') {
        knowledge.stageSummaries.push({
          stage: stage.spec.name,
          kind: stage.spec.kind,
          summary,
        });
      }

      // Intake is special: its output defines the objective and the run's tags.
      if (stage.spec.kind === 'intake' && summary !== '') {
        run.objective = summary;
        run.tags = parseTags(summary);
        if (run.tags.length === 0) {
          run.tags = ['feature'];
        }
      }
      if (stage.spec.kind === 'report' && summary !== '') {
        run.outcome = summary;
      }

      // A cancelled stage is not a finished one. The unwind path below owns the
      // terminal transition, so record the interruption rather than letting an
      // interrupted stage claim it completed.
      if (signal.aborted) {
        finishStage(run, stage, 'skipped', 'The operator cancelled the run.');
        break;
      }

      const failed = stage.error !== null;
      const empty = stage.turnIds.length === 0;
      if (failed || empty) {
        finishStage(run, stage, 'failed', stage.error ?? 'The stage produced no turns.');
        if (stage.spec.optional !== true) {
          run.status = 'failed';
          run.error = `Stage "${stage.spec.name}" failed; the run stopped there.`;
          run.endedAt = Date.now();
          emit({ type: 'error', message: run.error, runId: run.id, at: Date.now() });
          touch(run);
          settle(run);
          return;
        }
        touch(run);
        continue;
      }

      finishStage(run, stage, 'done', null);
      touch(run);
    }

    if (signal.aborted) {
      run.status = 'cancelled';
      run.error = run.error ?? 'Cancelled by the operator.';
      for (const stage of run.stages) {
        if (stage.status === 'running' || stage.status === 'pending') {
          stage.status = 'skipped';
          stage.endedAt = Date.now();
        }
      }
    } else if (run.status === 'running') {
      run.status = 'done';
    }

    run.endedAt = Date.now();
    if (run.outcome === null && run.stages.length > 0) {
      const last = run.stages[run.stages.length - 1];
      run.outcome = last?.summary ?? null;
    }
    emit({ type: 'run.updated', run: clone(run), at: Date.now() });
    settle(run);
  }

  function launch(run: Run, pipeline: Pipeline, controller: AbortController): void {
    void executeRun(run, pipeline, controller.signal).catch((e: unknown) => {
      run.status = 'failed';
      run.error = `Engine crashed: ${e instanceof Error ? e.message : String(e)}`;
      run.endedAt = Date.now();
      emit({ type: 'error', message: run.error, runId: run.id, at: Date.now() });
      touch(run);
      settle(run);
    });
  }

  return {
    submit(input) {
      // Resolve the organisation first: its pipelines, its money and its
      // directory all come from the workspace, not from the installation.
      const all = deps.org.workspaces();
      const requested = input.workspaceId;
      let project = requested !== undefined ? all.find((w) => w.id === requested) : undefined;
      if (requested !== undefined && project === undefined) {
        throw new Error(`There is no workspace "${requested}" in this office.`);
      }
      project = project ?? all.find((w) => w.isDefault === true) ?? all[0];
      if (!project) throw new Error('This office has no workspaces to work in.');

      const pipelines = deps.pipelines(project.id);
      const pipelineId =
        input.pipelineId !== undefined && pipelines.some((p) => p.id === input.pipelineId)
          ? input.pipelineId
          : pickPipelineId(input.brief, pipelines);
      const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
      if (!pipeline) throw new Error(`"${project.name}" has no pipelines configured.`);

      /*
       * A pipeline can name roles the floor does not have - most easily a plugin's
       * pipeline naming a role from the same plugin's templates, which nobody has
       * hired yet. Without this check the run starts, the stage produces no turns,
       * and the operator is told "the stage produced no turns", which is true and
       * useless. So say which role is missing, and where it comes from.
       */
      const chart = deps.org.chart(project.id);
      const present = new Set(chart.roles.map((role) => role.id));
      const missing = [
        ...new Set(pipeline.stages.flatMap((spec) => spec.roleIds).filter((id) => !present.has(id))),
      ];
      if (missing.length > 0) {
        throw new Error(
          `Pipeline "${pipeline.name}" needs ${missing.length === 1 ? 'a role' : 'roles'} this floor does not have: ` +
            `${missing.join(', ')}. Hire ${missing.length === 1 ? 'it' : 'them'} first — a plugin offering this ` +
            'pipeline usually offers the role template to go with it.',
        );
      }

      const runId = newId('run');
      const run: Run = {
        id: runId,
        brief: input.brief,
        pipelineId: pipeline.id,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: null,
        stages: pipeline.stages.map((spec) => ({
          id: newId('stage'),
          runId,
          spec,
          status: 'pending',
          startedAt: null,
          endedAt: null,
          turnIds: [],
          artifactIds: [],
          summary: null,
          participantRoleIds: [...spec.roleIds],
          error: null,
        })),
        budget: {
          limitUsd: input.budgetUsd ?? project.budget.defaultRunUsd,
          spentUsd: 0,
        },
        workspaceId: project.id,
        workspacePath: project.path,
        objective: null,
        plan: [],
        tags: [],
        outcome: null,
        error: null,
        submittedBy: input.submittedBy ?? null,
      };

      runsById.set(runId, run);
      const controller = new AbortController();
      controllers.set(runId, controller);
      emit({ type: 'run.created', run: clone(run), at: Date.now() });
      const firstOwner = pipeline.stages[0]?.roleIds[0];
      if (firstOwner !== undefined) {
        deps.employees.update(project.id, firstOwner, { status: 'thinking', activity: 'reading the brief' });
      }
      launch(run, pipeline, controller);
      return clone(run);
    },

    cancel(runId) {
      const controller = controllers.get(runId);
      if (!controller) return false;
      // Abort only. The terminal transition belongs to the execution loop, which
      // is the one place that knows when the last turn has actually stopped -
      // marking the run cancelled here would report a finished run while
      // employees were still unwinding, and would make `whenSettled` lie.
      controller.abort();
      emit({
        type: 'log',
        level: 'info',
        scope: 'engine/run',
        message: `Cancellation requested for ${runId}; stopping after the current turn.`,
        at: Date.now(),
      });
      return true;
    },

    getRun: (runId) => {
      const run = runsById.get(runId);
      return run ? clone(run) : undefined;
    },
    runs: () => [...runsById.values()].map((r) => clone(r)),
    activeRunIds: () => [...controllers.keys()],

    async directMessage(employeeId, text, workspaceId) {
      const all = deps.org.workspaces();
      const workspace =
        (workspaceId !== undefined ? all.find((w) => w.id === workspaceId) : undefined) ??
        all.find((w) => w.isDefault === true) ??
        all[0];
      if (!workspace) throw new Error('This office has no workspaces.');
      const role = deps.org.role(employeeId, workspace.id);
      if (!role) throw new Error(`There is no employee "${employeeId}" in "${workspace.name}".`);

      // A direct message is a conversation, not a classified task, so it routes
      // on the role's own default tier rather than on any per-task-class
      // override - a developer talks to you as a developer.
      const route = conversationRoute(workspace.id, role.modelPolicy);

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            `You are ${role.displayName}, ${role.title} at ${deps.org.chart(workspace.id).company.name}.`,
            `Your mission: ${role.mission}`,
            `How you speak: ${role.persona.voice}`,
            `You are working in ${workspace.path}.`,
            '',
            'The operator is talking to you directly, outside any pipeline. Answer as yourself, in your own voice.',
            'You have no tools in a direct conversation: do not claim to have read, run, or written anything.',
            'Be concise. If the request is really a piece of work, say which pipeline stage should own it.',
          ].join('\n'),
        },
        { role: 'user', content: text },
      ];

      const { result } = await deps.registry.chat(
        { providerId: route.providerId, modelId: route.modelId },
        route.fallbacks.map((f) => ({ providerId: f.providerId, modelId: f.modelId })),
        { messages },
      );

      deps.employees.addUsage(workspace.id, role.id, result.usage);
      const at = Date.now();
      return [
        { id: newId('dm'), employeeId, role: 'user', text, at },
        { id: newId('dm'), employeeId, role: 'employee', text: result.text, at, route },
      ];
    },

    async planMessage(employeeId, text, history, workspaceId) {
      const all = deps.org.workspaces();
      const workspace =
        (workspaceId !== undefined ? all.find((w) => w.id === workspaceId) : undefined) ??
        all.find((w) => w.isDefault === true) ??
        all[0];
      if (!workspace) throw new Error('This office has no workspaces.');
      const role = deps.org.role(employeeId, workspace.id);
      if (!role) throw new Error(`There is no employee "${employeeId}" in "${workspace.name}".`);

      const route = conversationRoute(workspace.id, role.modelPolicy);

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            `You are ${role.displayName}, ${role.title} at ${deps.org.chart(workspace.id).company.name}.`,
            `Your mission: ${role.mission}`,
            `How you speak: ${role.persona.voice}`,
            `The work will happen in ${workspace.path}.`,
            '',
            'The operator is shaping a brief with you before any work starts. Nothing has been',
            'commissioned yet, and you have no tools: do not claim to have read, run or written anything.',
            '',
            'Your job in this conversation, in order of importance:',
            '1. Find out what "done" actually means. Ask about the outcome, not the implementation.',
            '2. Surface the one or two decisions that would be expensive to get wrong.',
            '3. Say plainly when the request is ambiguous, and what you would assume otherwise.',
            '',
            'Ask at most two or three questions at a time, and ask them as questions rather than as a',
            'list of everything you might need. When the operator says the plan is settled, or asks you',
            'to draft the brief, reply with the brief itself: a single paragraph stating the objective,',
            'then a short bulleted list of what must be true for the work to count as finished. No',
            'preamble, no restating the conversation.',
          ].join('\n'),
        },
        // The history is the point: without it this is a series of unrelated
        // questions rather than a plan being developed.
        ...history.map((turn) => ({ role: turn.role, content: turn.text }) as ChatMessage),
        { role: 'user', content: text },
      ];

      const { result } = await deps.registry.chat(
        { providerId: route.providerId, modelId: route.modelId },
        route.fallbacks.map((f) => ({ providerId: f.providerId, modelId: f.modelId })),
        { messages },
      );

      deps.employees.addUsage(workspace.id, role.id, result.usage);
      return { text: result.text, employeeId: role.id, route };
    },

    whenSettled(runId) {
      const run = runsById.get(runId);
      if (!run) return Promise.resolve(undefined);
      if (TERMINAL.has(run.status)) return Promise.resolve(clone(run));
      return new Promise<Run | undefined>((resolve) => {
        const list = settleWaiters.get(runId) ?? [];
        list.push(resolve);
        settleWaiters.set(runId, list);
      });
    },
  };
}
