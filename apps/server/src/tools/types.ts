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

import type { ApprovalKind, ToolSchema } from '@dev3d/core';

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
