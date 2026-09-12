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
import { selectSkills } from '../skills/loader.ts';
import type { ToolContext, ToolResult } from '../tools/types.ts';
import { estimateComplexity } from './complexity.ts';
import { buildTurnMessages, taskClassForStage } from './prompt.ts';
import type { EngineDeps, RunKnowledge, StageUtterance } from './types.ts';

/** Hard ceiling on model<->tool round trips inside a single turn. */
const MAX_TOOL_ITERATIONS = 8;
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
    autoApproveShell: deps.config.autoApproveShell,
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
    cap(result.preview, 300),
    cap(result.content, MAX_TOOL_RESULT_CHARS),
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
    taskClass,
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
  });

  const usage: UsageRecord = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const turnWrites = new Set<string>();
  let assistantText = '';
  let reasoningText: string | null = null;
  let status: TurnRecord['status'] = 'done';
  /** The model that actually answered, once one has. */
  let servedBy: { providerId: string; modelId: string } | null = null;
  /** Routes that failed before one answered. */
  const attemptedRoutes: string[] = [];
  let error: string | null = null;

  const appendText = (chunk: string): void => {
    assistantText = assistantText === '' ? chunk : `${assistantText}\n\n${chunk}`;
  };

  try {
    if (route.modelId === '') {
      throw new Error(route.reason !== '' ? route.reason : 'No model could be routed for this turn.');
    }

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      if (req.signal.aborted) {
        status = 'cancelled';
        error = 'Cancelled by the operator.';
        break;
      }

      const { result, used, attempted } = await deps.registry.chat(
        { providerId: route.providerId, modelId: route.modelId },
        route.fallbacks.map((f) => ({ providerId: f.providerId, modelId: f.modelId })),
        {
          messages,
          ...(schemas.length > 0 ? { tools: schemas } : {}),
          ...(role.modelPolicy.maxOutputTokens !== undefined
            ? { maxOutputTokens: role.modelPolicy.maxOutputTokens }
            : {}),
          onDelta: (text) => {
            deps.sink.emit({ type: 'turn.delta', runId: run.id, turnId, text, at: Date.now() });
          },
          onReasoning: (text) => {
            deps.sink.emit({ type: 'turn.reasoning', runId: run.id, turnId, text, at: Date.now() });
          },
          signal: req.signal,
        },
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

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        error = `Stopped after ${MAX_TOOL_ITERATIONS} tool round trips without a final answer.`;
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

  // --- settle --------------------------------------------------------------
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
