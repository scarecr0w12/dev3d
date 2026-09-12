/**
 * Shared contracts for the tool-execution layer.
 *
 * A tool is a name, a JSON-Schema-shaped parameter set, and a `run` function.
 * The engine hands each tool a `ToolContext` that confines every file and
 * command operation to a single workspace root and routes risky actions
 * through a human approval callback. Tools must never throw for ordinary bad
 * input; they return `ToolResult` with `ok: false` instead, so the model can
 * read the message and correct course.
 */

import type { AgentPlanStep, ApprovalKind, MemoryFact, ToolSchema } from '@dev3d/core';

export interface ToolApprovalRequest {
  kind: ApprovalKind;
  summary: string;
  detail: string;
}

export interface ToolContext {
  /** Absolute root every path is confined to. */
  workspaceRoot: string;
  /** Workspace-relative paths written so far in this run. */
  writtenPaths: Set<string>;
  /**
   * The run's working plan, shared by every turn of the run.
   *
   * It is a live reference to the run's own array, so a tool that edits it has
   * changed the run: `todo_write` replaces the contents in place rather than
   * assigning a new array, which keeps every later turn looking at the same one.
   */
  plan: AgentPlanStep[];
  /**
   * Announce that the plan changed, so the operator sees it without waiting for
   * the run to end.
   *
   * A callback rather than the tool emitting an event itself: tools do not know
   * about runs or the event sink, and keeping it that way is what lets the whole
   * tool layer be tested with a bare context object.
   */
  onPlanChange?(): void;
  /**
   * Search the office's memory, already confined to what this employee may see.
   *
   * A callback rather than the fact store itself, for the same reason the plan
   * callback is: the tool layer must not know about stores or scopes, and a tool
   * that could name its own scope is a tool that could read another floor's
   * memory. The caller resolves the scope and hands back only permitted facts.
   *
   * Absent when the engine runs without memory, which the `recall` tool reports
   * rather than treating as an empty result.
   */
  recall?(query: string, limit: number): MemoryFact[];
  /** Ask the human. Resolves false when denied or when nobody can answer. */
  requestApproval(req: ToolApprovalRequest): Promise<boolean>;
  /** When true, run_shell skips the approval round trip. */
  autoApproveShell: boolean;
  signal?: AbortSignal;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Short UI-safe one-liner. */
  preview: string;
  /** Workspace-relative paths this call touched. */
  affectsPaths: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  names(): string[];
  get(name: string): Tool | undefined;
  schemas(names: string[]): ToolSchema[];
  register(tool: Tool): void;
  /** Take a tool back out. Used when the plugin that contributed it is disabled. */
  unregister(name: string): boolean;
}
