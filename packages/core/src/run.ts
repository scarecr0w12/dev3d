/**
 * Runs, stages, turns, artifacts: what actually happens when the office works.
 *
 * The shape is deliberately hierarchical so the UI can render the same tree
 * the engine executes:
 *
 *   Run  (one brief from the user)
 *    +- StageRun   (intake, plan, debate, build, review, test, report...)
 *        +- TurnRecord   (one employee, one model call, zero or more tool calls)
 *            +- ToolCallRecord
 *        +- Artifact     (a spec, a decision record, a diff, a report)
 */

import type { RouteDecision, UsageRecord } from './model.ts';
import type { SkillSelection } from './skill.ts';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export type StageStatus = 'pending' | 'running' | 'awaiting-approval' | 'done' | 'failed' | 'skipped';

export type StageKind =
  | 'intake' // turn the raw brief into a structured objective
  | 'plan' // decompose into workstreams and assign owners
  | 'research' // gather external evidence
  | 'debate' // structured argument between specialists
  | 'workshop' // converge a debate into a decision
  | 'design' // produce the design
  | 'architect' // produce the technical plan
  | 'build' // implement in the workspace
  | 'review' // critique what was built
  | 'test' // verify
  | 'integrate' // reconcile parallel workstreams
  | 'report'; // CEO summarises back to the user

export type StageMode =
  | 'single' // one employee, one turn (or a short internal loop)
  | 'parallel' // every listed employee works independently
  | 'debate' // listed employees argue over N rounds, then a facilitator concludes
  | 'review-loop'; // producer revises until reviewers stop objecting

export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One entry of the working plan an employee maintains while it works.
 *
 * This is deliberately run state rather than a scratchpad note. A multi-stage
 * pipeline hands work between people and spans many turns, so a plan that only
 * lived inside one turn's context would be lost exactly when it starts to
 * matter. Keeping it on the run means it survives the handover, is persisted
 * with everything else, and is visible to the operator while the run proceeds.
 */
export interface AgentPlanStep {
  /** What this step is, phrased as an instruction to whoever picks it up. */
  content: string;
  status: AgentPlanStepStatus;
}

export interface StageSpec {
  kind: StageKind;
  name: string;
  /**
   * Participating roles. For 'debate' and 'review-loop' the FIRST entry is the
   * facilitator / producer; the rest are the other side and the reviewers.
   */
  roleIds: string[];
  mode: StageMode;
  /** For 'debate': number of argument rounds. Default 2. */
  rounds?: number;
  /** For 'review-loop': maximum revision cycles before the stage gives up. */
  maxIterations?: number;
  /** Extra instruction appended to every participant's prompt. */
  instruction?: string;
  /** What this stage must produce; injected into prompts and used for scoring. */
  produces?: string;
  /** May the engine skip this when the plan says it is not needed? */
  optional?: boolean;
  /** Only run when the brief touches these tags. Empty/absent = always. */
  whenTags?: string[];
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  stages: StageSpec[];
}

/** A live, per-run instantiation of a StageSpec. */
export interface StageRun {
  id: string;
  runId: string;
  spec: StageSpec;
  status: StageStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Turn ids in execution order. */
  turnIds: string[];
  artifactIds: string[];
  /**
   * Debate/workshop outcome, or the stage's headline result. This is what the
   * next stage receives, so it must be self-contained.
   */
  summary: string | null;
  /** Roles that actually participated (planning may narrow the spec list). */
  participantRoleIds: string[];
  error: string | null;
}

export type ToolCallStatus = 'ok' | 'error' | 'denied' | 'running';

export interface ToolCallRecord {
  id: string;
  turnId: string;
  name: string;
  /** Raw JSON arguments as the model produced them. */
  argumentsJson: string;
  status: ToolCallStatus;
  /** Truncated, UI-safe preview of the result. */
  resultPreview: string;
  durationMs: number;
  /** Files this call created or modified, if any. */
  affectsPaths: string[];
}

export interface TurnRecord {
  id: string;
  runId: string;
  stageId: string;
  employeeId: string;
  roleId: string;
  /** Why this employee was given this turn, e.g. 'rebuttal round 2'. */
  purpose: string;
  /** The routing decision that produced this turn's model. */
  route: RouteDecision;
  /**
   * The model that *actually* answered, which differs from `route` whenever the
   * primary provider failed and a fallback served the turn.
   *
   * Recorded because the two are not the same thing and the difference matters
   * twice over: the console should be able to say a turn ran on a fallback, and
   * anything learning from outcomes would otherwise credit the chosen model for
   * work a different one did.
   */
  servedBy?: { providerId: string; modelId: string };
  /** Routes that were tried and failed before one answered, in order. */
  attemptedRoutes?: string[];
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  usage: UsageRecord;
  /** Final assistant text, with thinking stripped. */
  text: string;
  /** Chain-of-thought / reasoning text, when the model exposes it. */
  reasoning: string | null;
  toolCalls: ToolCallRecord[];
  /** Skills pulled into context, and the reason each was chosen. */
  skills: SkillSelection[];
  /** Workspace-relative paths this turn wrote to. */
  wroteFiles: string[];
  error: string | null;
}

export type ArtifactKind =
  | 'objective'
  | 'plan'
  | 'research'
  | 'decision'
  | 'spec'
  | 'design'
  | 'code'
  | 'review'
  | 'test-report'
  | 'report'
  | 'note'
  | 'transcript';

export interface Artifact {
  id: string;
  runId: string;
  stageId: string | null;
  employeeId: string | null;
  kind: ArtifactKind;
  title: string;
  /** Markdown body. */
  body: string;
  /** Workspace-relative path when the artifact corresponds to a real file. */
  path?: string;
  createdAt: number;
}

export type ApprovalKind =
  | 'shell' // run a command
  | 'write' // write outside the usual scratch area
  | 'network' // reach the network from a tool
  | 'spend' // exceed a soft spend threshold
  | 'risk'; // employee flagged its own action as risky

export interface Approval {
  id: string;
  runId: string;
  turnId: string | null;
  employeeId: string;
  kind: ApprovalKind;
  /** One line the user reads in the office. */
  summary: string;
  /** Full detail: the exact command, patch, or reason. */
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  decidedAt: number | null;
}

export interface Budget {
  limitUsd: number;
  spentUsd: number;
}

export interface Run {
  id: string;
  /** The user's original words, unedited. */
  brief: string;
  pipelineId: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  stages: StageRun[];
  budget: Budget;
  /**
   * The organisation this run worked in. `workspacePath` is resolved at submit
   * time and stored on the run, so a run's record stays truthful even after the
   * workspace is renamed or closed.
   */
  workspaceId: string;
  workspacePath: string;
  /** Structured objective produced by the intake stage. */
  objective: string | null;
  /**
   * The working plan the employee holding the run keeps up to date.
   *
   * Empty until someone calls `todo_write`. It is on the run rather than on a
   * turn so it survives a stage handover, and it is emitted with `run.updated`
   * so the console can show progress without a second protocol surface.
   */
  plan: AgentPlanStep[];
  /** Tags inferred at intake, used to decide which optional stages run. */
  tags: string[];
  /** Final answer shown at the top of the run card. */
  outcome: string | null;
  error: string | null;
  /** Seat the run was submitted from, for office playbook. */
  submittedBy: string | null;
}

/** A held conversation with one employee outside of any pipeline. */
export interface DirectMessage {
  id: string;
  employeeId: string;
  role: 'user' | 'employee';
  text: string;
  at: number;
  route?: RouteDecision;
}
