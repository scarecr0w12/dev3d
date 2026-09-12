/**
 * How hard is this turn?
 *
 * The router takes a `complexity` in 0..1 and escalates a role past its policy
 * threshold when the number is high enough. That number has to come from
 * somewhere honest, so it is a deterministic function of things the engine can
 * actually observe: what kind of stage this is, how much text the turn has to
 * digest, whether the work touches real files, how many revision cycles have
 * already failed to settle it, and whether the task text names a known-hard
 * problem.
 *
 * It is a heuristic, and it is meant to be one: it only has to be *ordered*
 * correctly, so that "add a button" does not burn a frontier model and
 * "untangle this concurrency bug" does not get a nano one.
 */

import type { Role, StageKind, TaskClass } from '@dev3d/core';

/** Baseline difficulty of each stage kind, before any text is read. */
const STAGE_BASE: Record<StageKind, number> = {
  intake: 0.15,
  plan: 0.4,
  research: 0.35,
  debate: 0.5,
  workshop: 0.55,
  design: 0.45,
  architect: 0.6,
  build: 0.5,
  review: 0.4,
  test: 0.4,
  integrate: 0.6,
  report: 0.2,
};

/**
 * Words that reliably mark a turn as genuinely harder than its stage suggests.
 * Kept deliberately small and specific - a long list would just add noise.
 */
const HARD_SIGNALS = [
  'concurren',
  'race condition',
  'deadlock',
  'migrat',
  'refactor',
  'backward compat',
  'breaking change',
  'distributed',
  'atomic',
  'idempot',
  'security',
  'vulnerab',
  'performance',
  'optimi',
  'architecture',
  'protocol',
  'schema',
  'rollback',
  'transaction',
  'cache invalidation',
];

const EASY_SIGNALS = ['typo', 'rename', 'copy change', 'label', 'comment', 'format', 'lint'];

export interface ComplexityInput {
  stageKind: StageKind;
  taskClass: TaskClass;
  /** The text this turn must act on: brief + purpose + upstream summaries. */
  text: string;
  role: Role;
  /** Turns already taken inside this stage; late revisions are harder. */
  turnIndex: number;
  /** Unique files the run has already written. */
  fileCount: number;
  /** True when this turn is expected to read or write files to do its job. */
  involvesFiles: boolean;
}

export function estimateComplexity(input: ComplexityInput): number {
  const hay = input.text.toLowerCase();
  let score = STAGE_BASE[input.stageKind];

  // A long brief genuinely carries more surface area, but the effect has to
  // saturate - a 12k-token spec is not four times harder than a 3k one.
  const len = input.text.length;
  score += Math.min(0.15, Math.max(0, Math.log2(1 + len / 400) * 0.045));

  // Named hard problems move the needle more than raw length.
  let hard = 0;
  for (const signal of HARD_SIGNALS) {
    if (hay.includes(signal)) hard += 1;
  }
  score += Math.min(0.22, hard * 0.055);

  // Explicitly trivial work should pull the estimate down, even in a build stage.
  let easy = 0;
  for (const signal of EASY_SIGNALS) {
    if (hay.includes(signal)) easy += 1;
  }
  if (easy > 0 && hard === 0) score -= Math.min(0.15, easy * 0.06);

  // A stage that needs a second and third pass is telling us the first pass was
  // not enough, which is real evidence of difficulty.
  score += Math.min(0.12, input.turnIndex * 0.04);

  // Acting on the filesystem is harder than talking about it.
  if (input.involvesFiles) score += 0.08;
  score += Math.min(0.1, input.fileCount * 0.01);

  // A junior doing the same work is not the same risk as an executive doing it:
  // the role's own policy bounds are the last word, but seniority shifts the
  // estimate slightly so escalation happens for the people who need it.
  const seniorityShift: Record<Role['seniority'], number> = {
    executive: 0.03,
    lead: 0.02,
    senior: 0.01,
    mid: 0,
    junior: 0.01,
  };
  score += seniorityShift[input.role.seniority];

  const clamped = Math.max(0, Math.min(1, score));
  // Two decimals keeps the routing `reason` string stable and readable.
  return Math.round(clamped * 100) / 100;
}

/** Human-readable summary of why a complexity number came out as it did. */
export function explainComplexity(input: ComplexityInput, value: number): string {
  const bits = [`stage '${input.stageKind}' baseline`];
  if (input.involvesFiles) bits.push('touches files');
  if (input.turnIndex > 0) bits.push(`revision pass ${input.turnIndex + 1}`);
  bits.push(`${input.text.length} chars of context`);
  return `${value} (${bits.join(', ')})`;
}
