/**
 * `todo_write`: the working plan an employee keeps while it works.
 *
 * This is the one tool that changes the run rather than the workspace. It writes
 * into `ctx.plan`, which is the run's own array, so the plan survives the turn
 * that created it — and, because the engine emits `run.updated`, the operator
 * watches it change without any new protocol surface.
 *
 * The whole-list contract (every call sends the complete list) is deliberate.
 * An incremental add/complete API invites drift between what the model believes
 * the list is and what it actually is; resending the list makes every call
 * self-consistent and impossible to half-apply.
 */

import type { AgentPlanStep, AgentPlanStepStatus } from '@dev3d/core';
import type { Tool, ToolResult } from './types.ts';

const MAX_STEPS = 50;
const MAX_CONTENT = 240;
const VALID_STATUS: readonly AgentPlanStepStatus[] = ['pending', 'in_progress', 'completed'];

function fail(content: string, preview = 'Error'): ToolResult {
  return { ok: false, content, preview, affectsPaths: [] };
}

/** The plan as the model sees it, so the next call starts from the truth. */
export function renderPlan(plan: readonly AgentPlanStep[]): string {
  if (plan.length === 0) return '(the plan is empty)';
  const marks: Record<AgentPlanStepStatus, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
  };
  return plan.map((step) => `${marks[step.status]} ${step.content}`).join('\n');
}

/**
 * Validate a model-supplied todo list into plan steps.
 *
 * Exported because the engine's own tests need to assert the same rules the
 * tool enforces, rather than restating them.
 */
export function parsePlan(input: unknown): { steps: AgentPlanStep[]; error: string | null } {
  if (!Array.isArray(input)) {
    return { steps: [], error: '"todos" must be an array of { content, status } objects.' };
  }
  if (input.length > MAX_STEPS) {
    return { steps: [], error: `The plan is limited to ${MAX_STEPS} steps; ${input.length} were sent.` };
  }
  const steps: AgentPlanStep[] = [];
  let inProgress = 0;
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { steps: [], error: `Step ${i + 1} is not an object.` };
    }
    const entry = raw as Record<string, unknown>;
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (content === '') {
      return { steps: [], error: `Step ${i + 1} has no non-empty "content".` };
    }
    if (content.length > MAX_CONTENT) {
      return { steps: [], error: `Step ${i + 1} is longer than ${MAX_CONTENT} characters.` };
    }
    const status = entry.status;
    if (typeof status !== 'string' || !(VALID_STATUS as readonly string[]).includes(status)) {
      return {
        steps: [],
        error: `Step ${i + 1} has status ${JSON.stringify(status)}; expected one of ${VALID_STATUS.join(', ')}.`,
      };
    }
    if (status === 'in_progress') inProgress += 1;
    steps.push({ content, status: status as AgentPlanStepStatus });
  }
  if (inProgress > 1) {
    // More than one step in flight means the list is not describing what is
    // actually being worked on, which is the entire value of the field.
    return { steps: [], error: `${inProgress} steps are in_progress; at most one step may be.` };
  }
  return { steps, error: null };
}

const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Record and update your working plan for this run. Send the COMPLETE list every ' +
    'time - it replaces the previous one, so include steps you have finished. Keep at ' +
    'most one step in_progress. Use it to hold your place across a long task; it is ' +
    'visible to your colleagues in later stages and to the operator.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: `The complete plan, up to ${MAX_STEPS} steps.`,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step is, as an instruction.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending | in_progress | completed',
            },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const { steps, error } = parsePlan(args.todos);
    if (error !== null) return fail(`todo_write did not change the plan: ${error}`, 'Invalid plan');

    // Mutate in place: `ctx.plan` is the run's own array, and every later turn
    // holds a reference to it. Replacing the array here would silently detach
    // the plan from the run.
    ctx.plan.length = 0;
    ctx.plan.push(...steps.map((step) => ({ ...step })));
    ctx.onPlanChange?.();

    const done = steps.filter((s) => s.status === 'completed').length;
    const current = steps.find((s) => s.status === 'in_progress');
    ctx.log('debug', `todo_write set ${steps.length} step(s), ${done} completed`);

    return {
      ok: true,
      content: `Plan updated (${done}/${steps.length} complete).\n${renderPlan(steps)}`,
      preview: current
        ? `Plan: ${done}/${steps.length} done, now: ${current.content.slice(0, 60)}`
        : `Plan: ${done}/${steps.length} done`,
      affectsPaths: [],
    };
  },
};

export function createPlanTools(): Tool[] {
  return [todoWriteTool];
}
