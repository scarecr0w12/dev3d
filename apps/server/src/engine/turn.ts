/**
 * One employee, one turn.
 *
 * A turn is: pick the skills the task actually needs, price the work and route
 * it to a model, tell the employee who it is and what has already happened, then
 * let it call tools until it stops asking for them. Everything the UI shows -
 * the ordered tool calls, the streamed text, the reasoning, the token and dollar
 * cost, the files touched - is produced here.
 *
 * The loop is bounded on purpose. A model that keeps calling tools without
 * converging is a real failure mode, and it must end the turn with an honest
 * error rather than run the bill up forever.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  MemoryFact,
  Role,
  Run,
  Skill,
  SkillSelection,
  StageRun,
  ToolCallRecord,
  ToolCallRequest,
  TurnRecord,
  UsageRecord,
} from '@dev3d/core';
import { routeModel } from '../router/modelRouter.ts';
import { fenceUntrusted, stripControlSequences } from '../security/text.ts';
import { selectSkills } from '../skills/loader.ts';
import type { ToolContext, ToolResult } from '../tools/types.ts';
import { estimateComplexity } from './complexity.ts';
import { buildTurnMessages, MEMORY_PROMPT_LIMIT, taskClassForStage } from './prompt.ts';
import type { EngineDeps, RunKnowledge, RunPolicy, StageUtterance } from './types.ts';

/** Hard ceiling on model<->tool round trips inside a single turn. */
export const MAX_TOOL_ITERATIONS = 8;
/**
 * Round trips allowed for stages that are open-ended by nature.
 *
 * `research` gathers evidence, and gathering evidence is unbounded work: the
 * live office's first real run spent all eight round trips on searches and
 * fetches, and both research-flavoured turns came back with nothing. `debate` and
 * `integrate` reconcile several inputs rather than one, so they get headroom
 * too. Everything else keeps the tight budget, because converging on a bounded
 * task should not take many round trips and an unbounded loop is a real failure
 * mode with a real bill.
 */
export const OPEN_ENDED_TOOL_ITERATIONS = 16;

/** How many round trips this turn may use, by what the stage is for. */
export function toolIterationsFor(stage: StageRun): number {
  switch (stage.spec.kind) {
    case 'research':
    case 'debate':
    case 'integrate':
      return OPEN_ENDED_TOOL_ITERATIONS;
    default:
      return MAX_TOOL_ITERATIONS;
  }
}
/** How much of a tool result is handed back to the model. */
const MAX_TOOL_RESULT_CHARS = 8_000;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [result truncated at ${max} characters]`;
}

/** A short, human-readable activity line for the 3D office and the roster. */
function describeActivity(call: ToolCallRequest): string {
  let path: unknown;
  try {
    path = (JSON.parse(call.argumentsJson) as { path?: unknown }).path;
  } catch {
    path = undefined;
  }
  if (typeof path === 'string' && path !== '') return `${call.name} ${path}`;
  if (call.name === 'run_shell') return 'running a command';
  return call.name.replace(/_/g, ' ');
}

export interface TurnRequest {
  run: Run;
  stage: StageRun;
  role: Role;
  /** Short label for why this employee has the floor, e.g. 'rebuttal round 2'. */
  purpose: string;
  knowledge: RunKnowledge;
  /** Prior turns within this stage, oldest first. */
  stageTranscript: StageUtterance[];
  participants: Array<{ roleId: string; displayName: string; title: string }>;
  companyName: string;
  companyMission: string;
  departmentName: string;
  /** Run-scoped set of workspace-relative paths written so far. */
  writtenPaths: Set<string>;
  turnIndex: number;
  signal: AbortSignal;
  /**
   * The facts the prompt index was built from, and the query it was built with.
   *
   * Carried on the request because the tool context is assembled in a different
   * function from the one that resolves memory, and the `recall` tool needs both:
   * the same query is answered from here rather than searched twice, since it is
   * the question a model asks most often and it has already been paid for.
   */
  memoryFacts: MemoryFact[];
  memoryQuery: string;
  /**
   * What this run was authorised to do without asking, fixed when it started.
   *
   * Optional so a caller that does not pin one — a test driving a single turn, an
   * engine whose runs are not tracked — still works; it then falls back to the
   * live config, which is what every turn used to read.
   */
  policy?: RunPolicy;
}

interface ToolCallOutcome {
  record: ToolCallRecord;
  /** The full text handed back to the model as the tool result. */
  content: string;
}

async function executeToolCall(
  deps: EngineDeps,
  req: TurnRequest,
  turnId: string,
  call: ToolCallRequest,
): Promise<ToolCallOutcome> {
  const callId = call.id !== '' ? call.id : newId('call');
  const started = Date.now();
  const base = {
    id: callId,
    turnId,
    name: call.name,
    argumentsJson: call.argumentsJson,
    resultPreview: '',
    durationMs: 0,
    affectsPaths: [] as string[],
  };

  const finish = (
    status: ToolCallRecord['status'],
    resultPreview: string,
    content: string,
    affectsPaths: string[] = [],
  ): ToolCallOutcome => ({
    record: {
      ...base,
      status,
      resultPreview,
      affectsPaths,
      durationMs: Date.now() - started,
    },
    content,
  });

  // Grant enforcement happens here, not in the registry: the registry knows
  // what exists, the org chart decides who may hold it.
  if (!req.role.allowedTools.includes(call.name)) {
    return finish(
      'denied',
      `refused: ${call.name} is not granted to ${req.role.id}`,
      `You were not granted the "${call.name}" tool. Available to you: ${
        req.role.allowedTools.join(', ') || 'none'
      }. Continue without it, or state that you are blocked.`,
    );
  }

  const tool = deps.tools.get(call.name);
  if (!tool) {
    return finish(
      'denied',
      `unknown tool ${call.name}`,
      `There is no tool named "${call.name}". Continue without it.`,
    );
  }

  let parsedArgs: Record<string, unknown>;
  try {
    const raw = JSON.parse(call.argumentsJson) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('arguments must be a JSON object');
    }
    parsedArgs = raw as Record<string, unknown>;
  } catch (e) {
    return finish(
      'error',
      `bad arguments: ${errMsg(e)}`,
      `Your arguments for "${call.name}" were not a valid JSON object (${errMsg(e)}). Call it again with valid JSON.`,
    );
  }

  const ctx: ToolContext = {
    // The run's own project, not the office default: two runs in two projects
    // must not be able to see each other's files.
    workspaceRoot: req.run.workspacePath,
    writtenPaths: req.writtenPaths,
    // The run's own plan array, by reference: a tool that edits it must edit the
    // run, so the next turn - and the operator's console - sees the change.
    plan: req.run.plan,
    onPlanChange: () => {
      // Persisted with the run like any other run state, and pushed to the
      // console on the existing `run.updated` event rather than a new one.
      req.run.updatedAt = Date.now();
      deps.sink.emit({ type: 'run.updated', run: structuredClone(req.run), at: Date.now() });
    },
    // Memory is resolved for this employee, in this workspace, by the runtime -
    // so the tool cannot name a scope of its own and read another floor's facts.
    //
    // The query the prompt index already ran is answered from `indexedFacts`
    // rather than searched again, because that is the question a model asks most
    // often and it has already been paid for. Anything else goes through the
    // synchronous lexical lookup, so the tool needs no async signature and a
    // mid-turn call costs no embedding round trip.
    ...(deps.recall === undefined
      ? {}
      : {
          recall: (query: string, limit: number): MemoryFact[] => {
            if (query.trim() === req.memoryQuery && req.memoryFacts.length > 0) {
              return req.memoryFacts.slice(0, Math.max(0, limit));
            }
            return deps.recallSync !== undefined
              ? deps.recallSync({
                  workspaceId: req.run.workspaceId,
                  roleId: req.role.id,
                  query,
                  limit,
                })
              : req.memoryFacts.slice(0, Math.max(0, limit));
          },
        }),
    // Pinned at run start where the engine pinned one: a settings write that
    // lands while this run is in flight must not change whether these employees
    // are asked for approval.
    autoApproveShell: req.policy?.autoApproveShell ?? deps.config.autoApproveShell,
    signal: req.signal,
    log: (level, message) => {
      deps.sink.emit({ type: 'log', level, scope: `tool:${call.name}`, message, at: Date.now() });
    },
    requestApproval: async (approval) => {
      // While a human is deciding, the employee is genuinely blocked - not
      // thinking, not working - and the run is waiting on a person, not a model.
      deps.employees.update(req.run.workspaceId, req.role.id, {
        status: 'blocked',
        activity: `awaiting approval: ${approval.summary}`,
      });
      req.run.status = 'awaiting-approval';
      deps.sink.emit({ type: 'run.updated', run: structuredClone(req.run), at: Date.now() });
      try {
        return await deps.approvals.request({
          runId: req.run.id,
          turnId,
          employeeId: req.role.id,
          kind: approval.kind,
          summary: approval.summary,
          detail: approval.detail,
        });
      } finally {
        deps.employees.update(req.run.workspaceId, req.role.id, { status: 'working', activity: null });
        if (req.run.status === 'awaiting-approval') {
          req.run.status = 'running';
          deps.sink.emit({ type: 'run.updated', run: structuredClone(req.run), at: Date.now() });
        }
      }
    },
  };

  let result: ToolResult;
  try {
    result = await tool.run(parsedArgs, ctx);
  } catch (e) {
    // Tools are supposed to return ok:false rather than throw; if one does
    // throw, the turn must not die with it.
    return finish(
      'error',
      `${call.name} threw: ${errMsg(e)}`,
      `The tool "${call.name}" crashed: ${errMsg(e)}. Report this rather than working around it.`,
    );
  }

  return finish(
    result.ok ? 'ok' : 'error',
    // The preview is for the console, so it gets the same treatment: a terminal
    // escape in a tool's one-line summary renders in the operator's own console.
    cap(stripControlSequences(result.preview), 300),
    // Tool output is attacker-influenced *by design* — `read_file` of a hostile
    // README, `git show` of a hostile commit message, `web_fetch` of any page on
    // the internet — and it goes straight into the prompt as a `tool` message.
    // Stripping the control sequences stops the invisible half (bidi overrides
    // make text display as something other than what it says; zero-width
    // characters are not visible to a reader checking it) and the fence makes the
    // boundary visible where a model reads it, so "this is data, not an
    // instruction" is said consistently rather than assumed at each call site.
    fenceUntrusted(cap(result.content, MAX_TOOL_RESULT_CHARS), `tool:${call.name}`),
    result.affectsPaths,
  );
}

export async function runTurn(deps: EngineDeps, req: TurnRequest): Promise<TurnRecord> {
  const { role, run, stage } = req;
  /** Every scoped lookup - org, roster, budget - is keyed by the run's organisation. */
  const workspaceId = req.run.workspaceId;
  /** Read once per turn: plugin skills are live, so resolve them now. */
  const allSkills = deps.skills();
  const turnId = (deps.newId ?? newId)('turn');
  const startedAt = Date.now();
  const taskClass = taskClassForStage(stage.spec.kind);

  // --- skills: the role's first few are always on; the rest compete per turn --
  // An organisation may only use the skills it has enabled, and a role may only
  // use a subset of those - the intersection is what is actually available.
  const enabled = new Set(deps.org.workspace(run.workspaceId)?.skillIds ?? []);
  const roleSkills = role.skillIds.filter((id) => enabled.has(id));
  const usableSkillIds = roleSkills.length > 0 ? roleSkills : [...enabled];
  const taskText = `${run.brief}\n\n${req.purpose}\n\n${req.knowledge.objective ?? ''}`;
  const selections: SkillSelection[] = selectSkills({
    skills: allSkills,
    candidateIds: usableSkillIds,
    taskText,
    taskClass,
    alwaysIds: usableSkillIds.slice(0, 2),
    limit: 3,
  });
  const activeSkills: Skill[] = selections
    .map((s) => allSkills.find((k) => k.id === s.skillId))
    .filter((s): s is Skill => s !== undefined);

  // --- tools: only what this role was granted, and only what really exists ---
  const grantedTools = role.allowedTools.filter((name) => deps.tools.get(name) !== undefined);
  const schemas = deps.tools.schemas(grantedTools);

  // --- routing -------------------------------------------------------------
  const chart = deps.org.chart(run.workspaceId);
  const posture = chart.routingPosture ?? deps.config.routingPosture;
  const involvesFiles = grantedTools.some(
    (t) => t === 'read_file' || t === 'write_file' || t === 'edit_file' || t === 'search_files',
  );
  const complexity = estimateComplexity({
    stageKind: stage.spec.kind,
    text: taskText,
    role,
    turnIndex: req.turnIndex,
    fileCount: req.knowledge.filesWritten.length,
    involvesFiles,
  });
  const budgetRemainingUsd = Math.max(0, run.budget.limitUsd - run.budget.spentUsd);
  const route = routeModel(
    {
      taskClass,
      complexity,
      policy: role.modelPolicy,
      requiresTools: schemas.length > 0,
      budgetRemainingUsd,
      posture,
    },
    {
      models: deps.registry.routableModels(),
      posture,
      hints: deps.routingHints?.() ?? [],
      // Upstream uptime, when it is known. Never awaited: an unknown model is
      // queued for a background lookup and routes without it this time.
      reliability: (model) => deps.registry.reliability(model),
    },
  );

  const turn: TurnRecord = {
    id: turnId,
    runId: run.id,
    stageId: stage.id,
    employeeId: role.id,
    roleId: role.id,
    purpose: req.purpose,
    route,
    status: 'running',
    startedAt,
    endedAt: null,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    text: '',
    reasoning: null,
    toolCalls: [],
    skills: selections,
    wroteFiles: [],
    error: null,
  };

  deps.sink.emit({ type: 'routing.decision', runId: run.id, turnId, route, at: Date.now() });
  deps.employees.update(workspaceId, role.id, {
    status: 'thinking',
    activity: req.purpose,
    currentRunId: run.id,
    currentTurnId: turnId,
    activeSkillIds: selections.map((s) => s.skillId),
    lastRoute: {
      modelId: route.modelId,
      providerId: route.providerId,
      tier: route.tier,
      reason: route.reason,
      at: Date.now(),
    },
    lastError: null,
  });


  deps.sink.emit({ type: 'turn.started', turn: { ...turn }, at: Date.now() });

  // --- memory: a short index, so the employee knows there is something to ask --
  //
  // The query is the brief and the purpose rather than the full upstream
  // knowledge: this is orientation, and a query built from everything already in
  // the prompt would just retrieve the prompt back.
  //
  // Resolved once, up front, and awaited - so when semantic memory is configured
  // the query is embedded exactly once per turn rather than on every `recall` the
  // model happens to make. It runs after `turn.started` on purpose: an embedding
  // round trip must not be able to delay the console showing that the employee has
  // picked the work up.
  const indexed =
    deps.recall === undefined
      ? { shown: [] as MemoryFact[], total: 0 }
      : await (async () => {
          const shown = await deps.recall!({
            workspaceId: run.workspaceId,
            roleId: role.id,
            query: req.memoryQuery,
            limit: MEMORY_PROMPT_LIMIT,
          });
          // A second, unfiltered count rather than `shown.length`, because the
          // prompt tells the employee how many facts it is *not* seeing - and a
          // count that only ever equalled the visible ones would silently claim
          // the index is complete.
          const all = await deps.recall!({
            workspaceId: run.workspaceId,
            roleId: role.id,
            query: '',
            limit: Number.MAX_SAFE_INTEGER,
          });
          return { shown, total: all.length };
        })();
  // Handed to the tool layer so `recall` can answer the prompt's own question
  // without searching again.
  req.memoryFacts = indexed.shown;

  // --- the loop ------------------------------------------------------------
  const messages: ChatMessage[] = buildTurnMessages({
    role,
    companyName: req.companyName,
    companyMission: req.companyMission,
    departmentName: req.departmentName,
    workspace: req.run.workspacePath,
    stage: stage.spec,
    purpose: req.purpose,
    participants: req.participants,
    knowledge: req.knowledge,
    stageTranscript: req.stageTranscript,
    skillIndex: usableSkillIds
      .map((id) => allSkills.find((s) => s.id === id))
      .filter((s): s is Skill => s !== undefined),
    activeSkills,
    grantedTools,
    memoryFacts: indexed.shown,
    memoryTotal: indexed.total,
  });

  const usage: UsageRecord = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const turnWrites = new Set<string>();
  let assistantText = '';
  let reasoningText: string | null = null;
  let status: TurnRecord['status'] = 'done';
  /** Round trips this turn may use, widened for open-ended stage kinds. */
  const toolIterations = toolIterationsFor(stage);
  /** True when the loop ran out of round trips rather than converging. */
  let warnedAboutLimit = false;
  /** The model that actually answered, once one has. */
  let servedBy: { providerId: string; modelId: string } | null = null;
  /** Routes that failed before one answered. */
  const attemptedRoutes: string[] = [];
  let error: string | null = null;

  const appendText = (chunk: string): void => {
    assistantText = assistantText === '' ? chunk : `${assistantText}\n\n${chunk}`;
  };

  /**
   * Whether the model has said anything at all.
   *
   * Used at the end of the loop: a turn that never produced text gave the run no
   * work product, whatever else it did, and must say so rather than being
   * recorded as a completed turn with an empty body. The live office's own first
   * real run failed exactly here — two of three turns spent their whole tool
   * budget and returned `''`.
   */
  const saidSomething = (): boolean => assistantText.trim() !== '';

  try {
    if (route.modelId === '') {
      throw new Error(route.reason !== '' ? route.reason : 'No model could be routed for this turn.');
    }

    /**
     * The last round trip is made **with tools withheld**.
     *
     * Without this the loop simply stops when the budget runs out, the model is
     * never asked to summarise what it found, and the turn ends with empty text
     * and an error — money spent, nothing produced. Withholding the tools for one
     * final call is what turns "I ran out of round trips" into "here is what I
     * have", which is the answer the operator actually wanted.
     */
    const lastRound = toolIterations - 1;

    for (let iteration = 0; iteration < toolIterations; iteration += 1) {
      if (req.signal.aborted) {
        status = 'cancelled';
        error = 'Cancelled by the operator.';
        break;
      }

      // `exactOptionalPropertyTypes` is on, so the properties are spread in
      // rather than assigned undefined.
      const turnChatOptions = {
        messages,
        ...(iteration === lastRound || schemas.length === 0 ? {} : { tools: schemas }),
        ...(role.modelPolicy.maxOutputTokens !== undefined
          ? { maxOutputTokens: role.modelPolicy.maxOutputTokens }
          : {}),
        onDelta: (text: string) => {
          deps.sink.emit({ type: 'turn.delta', runId: run.id, turnId, text, at: Date.now() });
        },
        onReasoning: (text: string) => {
          deps.sink.emit({ type: 'turn.reasoning', runId: run.id, turnId, text, at: Date.now() });
        },
        signal: req.signal,
      };

      const { result, used, attempted } = await deps.registry.chat(
        { providerId: route.providerId, modelId: route.modelId },
        route.fallbacks.map((f) => ({ providerId: f.providerId, modelId: f.modelId })),
        turnChatOptions,
      );

      // Which model actually answered, and what was tried before it. Kept on the
      // turn because a fallback serving the work is a fact about that model's
      // health, and crediting the routed model for it would be wrong.
      servedBy = used;
      if (attempted.length > 0) attemptedRoutes.push(...attempted);

      usage.tokensIn += result.usage.tokensIn;
      usage.tokensOut += result.usage.tokensOut;
      usage.costUsd += result.usage.costUsd;
      if (result.text !== '') appendText(result.text);
      if (result.reasoning !== null && result.reasoning !== '') {
        reasoningText = reasoningText === null ? result.reasoning : `${reasoningText}${result.reasoning}`;
      }

      if (result.toolCalls.length === 0) {
        if (result.finishReason === 'length') {
          error = 'The model hit its output limit mid-turn; the reported work product is incomplete.';
        }
        break;
      }

      // The model asked for tools: record the assistant turn, then run them all
      // before asking again, so the next call sees every result.
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      const first = result.toolCalls[0];
      if (first) deps.employees.update(workspaceId, role.id, { status: 'working', activity: describeActivity(first) });

      for (const call of result.toolCalls) {
        const { record, content } = await executeToolCall(deps, req, turnId, call);
        turn.toolCalls.push(record);
        for (const p of record.affectsPaths) {
          turnWrites.add(p);
          req.writtenPaths.add(p);
        }
        deps.sink.emit({ type: 'tool.result', runId: run.id, turnId, call: record, at: Date.now() });
        messages.push({ role: 'tool', content, toolCallId: record.id, name: record.name });
      }

      if (iteration === lastRound) {
        // The tools were withheld for exactly this call, so an answer ought to
        // have arrived. If the model asked for a tool anyway, there is nothing
        // left to withhold and the turn ends without one.
        warnedAboutLimit = true;
      }
    }
  } catch (e) {
    if (req.signal.aborted) {
      status = 'cancelled';
      error = 'Cancelled by the operator.';
    } else {
      status = 'failed';
      error = errMsg(e);
    }
  }

  /**
   * A turn that never produced text produced no work product.
   *
   * This is why the loop above makes one final tools-withheld call: so that
   * "the budget ran out" and "there is no answer" stop being the same outcome.
   * Reaching here with nothing said means the last call *still* asked for a
   * tool, so the turn is recorded as failed with the reason and the caller keeps
   * whatever was gathered — rather than as a completed turn with an empty body,
   * which is how a spent run used to look like a finished one.
   */
  if (status === 'done' && error === null && !saidSomething()) {
    error = warnedAboutLimit
      ? `Stopped after ${toolIterations} tool round trips without ever producing an answer.`
      : 'The model returned no text and asked for no tools.';
  }

  // --- settle --------------------------------------------------------------
  /**
   * A turn that ran out of room is a failure, not a finished one.
   *
   * Both errors below mean the same thing: the employee stopped mid-task and what
   * it produced is incomplete. Leaving those as `done` hid the difference between
   * converging and being cut off — the run engine keys stage failure off
   * `stage.error` and empty turns, never off `turn.error`, so an unconverged turn
   * was invisible everywhere except its own record.
   */
  if (status === 'done' && error !== null) status = 'failed';

  turn.status = status;
  turn.endedAt = Date.now();
  turn.usage = usage;
  turn.text = assistantText;
  turn.reasoning = reasoningText;
  turn.wroteFiles = [...turnWrites];
  turn.error = error;
  if (servedBy !== null) turn.servedBy = servedBy;
  if (attemptedRoutes.length > 0) turn.attemptedRoutes = [...attemptedRoutes];

  // The run's budget is live: a turn that costs money must move it immediately,
  // or the next turn routes as though the run were still free.
  run.budget.spentUsd += usage.costUsd;
  deps.sink.emit({
    type: 'budget.updated',
    runId: run.id,
    limitUsd: run.budget.limitUsd,
    spentUsd: run.budget.spentUsd,
    at: Date.now(),
  });

  deps.employees.addUsage(workspaceId, role.id, usage);
  deps.employees.update(workspaceId, role.id, {
    status: status === 'failed' ? 'error' : 'idle',
    activity: null,
    currentTurnId: null,
    lastError: error,
  });
  deps.sink.emit({ type: 'turn.finished', turn: { ...turn }, at: Date.now() });

  if (status === 'failed' && error !== null) {
    deps.sink.emit({ type: 'error', message: `${role.displayName} failed: ${error}`, runId: run.id, at: Date.now() });
  }

  return turn;
}
