/**
 * Turning a role, a stage and a run into a model call.
 *
 * The prompt is where the "company" fiction has to become real instructions. An
 * employee is told who it is, what it is accountable for, how it speaks, which
 * skills it may reach for, what the stage must produce, and what everyone before
 * it already established. Everything else - tools, routing, budget - is enforced
 * by code, not by asking the model nicely.
 *
 * Two rules shaped this file:
 *  - The system prompt is stable per turn, and everything that varies lives in
 *    the user message, so a future prompt cache has something to bite on.
 *  - Nothing is silently dropped. Long upstream material is truncated with a
 *    visible marker, because an employee that does not know something was cut
 *    will happily pretend it read all of it.
 */

import type {
  Artifact,
  ChatMessage,
  Role,
  Skill,
  StageKind,
  StageSpec,
  TaskClass,
} from '@dev3d/core';
import type { RunKnowledge, StageUtterance } from './types.ts';

/** Which task class a stage asks the router to price. */
export function taskClassForStage(kind: StageKind): TaskClass {
  switch (kind) {
    case 'intake':
      return 'intake';
    case 'plan':
      return 'planning';
    case 'research':
      return 'research';
    case 'debate':
      return 'debate';
    case 'workshop':
      return 'workshop';
    case 'design':
      return 'design';
    case 'architect':
      return 'architecture';
    case 'build':
      return 'coding';
    case 'review':
      return 'review';
    case 'test':
      return 'testing';
    case 'integrate':
      return 'ops';
    case 'report':
      return 'summarize';
    default:
      return 'summarize';
  }
}

/** Markdown body truncation that admits it truncated. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.length - max;
  return `${trimmed.slice(0, max)}\n\n… [truncated ${cut} characters of upstream material]`;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

/**
 * The house rules. These are not decoration: every one of them exists because
 * an LLM employee without it will either overstep its role, fabricate a result,
 * or claim work is verified when nothing ran.
 */
const HOUSE_RULES = [
  'You are one employee in a company, not a general assistant. Do the work your role owns and nothing else; if a task belongs to another department, say so and hand it back.',
  'Never claim something is done, tested, passing, or verified unless you actually did it this turn and can quote the exact command you ran and its real output.',
  'Every file and shell operation is confined to the workspace root. Never attempt, propose, or reference a path outside it.',
  'If a tool fails or you are refused, say so plainly and report what you tried. Never silently substitute an invented result for a failed action.',
  'Do not invent APIs, file paths, library behaviour, measurements, sources, or test output. If you do not know, say that you do not know and say how you would find out.',
  'Prefer the smallest correct change over a sweeping one. If you must change something unrelated to finish, call that out explicitly.',
  'Do not restate the task back to the reader, and do not pad the answer. Write the work product itself.',
].join('\n');

export interface TurnPromptInput {
  role: Role;
  companyName: string;
  companyMission: string;
  departmentName: string;
  workspace: string;
  stage: StageSpec;
  /** The concrete ask for this specific turn. */
  purpose: string;
  /** The role ids taking part in this stage, for context on who else is here. */
  participants: Array<{ roleId: string; displayName: string; title: string }>;
  knowledge: RunKnowledge;
  /** Prior turns in this same stage, oldest first. */
  stageTranscript: StageUtterance[];
  /** Candidate skills (id + name + description) the employee may reach for. */
  skillIndex: Skill[];
  /** Full bodies of the skills actually selected for this turn. */
  activeSkills: Skill[];
  /** Tool names this employee has been granted. */
  grantedTools: string[];
  /** Set when a previous attempt at this turn failed, so it can correct course. */
  repairNote?: string | null;
}

function identitySection(input: TurnPromptInput): string {
  const { role } = input;
  const lines = [
    `You are ${role.displayName}, ${role.title} in the ${input.departmentName} department at ${input.companyName}.`,
    `Seniority: ${role.seniority}. You report to ${role.reportsTo ?? 'nobody (you run the company)'}.`,
    '',
    `Company mission: ${input.companyMission}`,
    `Your mission: ${role.mission}`,
    '',
    'You are accountable for:',
    bullets(role.responsibilities),
    '',
    `How you speak: ${role.persona.voice}`,
    `What you value: ${role.persona.values.join(', ')}.`,
  ];
  if (role.persona.debateStyle) {
    lines.push(`When you disagree: ${role.persona.debateStyle}`);
  }
  if (role.maxDirectReports > 0) {
    // Deliberately not phrased as "you may delegate". Nothing in the engine can
    // hand work to a report: work assignment is the pipeline's `roleIds` and the
    // producers a run has already recorded, and an employee cannot change either.
    // Telling a model it can delegate produced a promise it had no way to keep,
    // which is the one thing the house rules below forbid it from doing.
    lines.push(
      `Scope: you are responsible for the work ${role.maxDirectReports} people report to you, ` +
        `but the pipeline assigns their stages — you cannot put work on them yourself. ` +
        `Say what you need done and let the plan pick it up.`,
    );
  }
  return lines.join('\n');
}

function skillsSection(input: TurnPromptInput): string {
  const parts: string[] = [];
  if (input.skillIndex.length > 0) {
    parts.push(
      'Skills assigned to your role (you may pull any of these in when the task needs it):',
      bullets(input.skillIndex.map((s) => `${s.id}: ${s.name} — ${s.description}`)),
    );
  }
  if (input.activeSkills.length > 0) {
    parts.push(
      '',
      'The following skill instructions have been loaded for this turn. Follow them:',
      ...input.activeSkills.map((s) => `## Skill: ${s.name}\n\n${clip(s.body, 3000)}`),
    );
  }
  return parts.join('\n');
}

function situationSection(input: TurnPromptInput): string {
  const k = input.knowledge;
  const parts: string[] = ['## The job', '', `The operator asked for:`, '', clip(k.brief, 4000)];

  if (k.objective) {
    parts.push('', '## Agreed objective', '', clip(k.objective, 2500));
  }
  if (k.tags.length > 0) {
    parts.push('', `Work tags: ${k.tags.join(', ')}.`);
  }

  if (k.stageSummaries.length > 0) {
    parts.push('', '## What earlier stages established', '');
    for (const s of k.stageSummaries) {
      parts.push(`### ${s.stage} (${s.kind})`, '', clip(s.summary, 2500), '');
    }
  }

  if (k.filesWritten.length > 0) {
    parts.push(
      '## Files produced so far in this run',
      '',
      bullets(k.filesWritten),
      '',
      'Read the files you need before you change or judge them. Do not assume their contents.',
    );
  }

  if (k.artifacts.length > 0) {
    parts.push('', '## Artifacts on record', '');
    for (const a of k.artifacts.slice(-6)) {
      parts.push(`- **${a.title}** (${a.kind}${a.path ? `, \`${a.path}\`` : ''})`);
    }
    parts.push('', 'Their full bodies are available to you through the summaries above.');
  }

  return parts.join('\n');
}

function debateSection(input: TurnPromptInput): string {
  if (input.stageTranscript.length === 0) return '';
  const lines = ['## What has been said in this stage so far', ''];
  for (const u of input.stageTranscript) {
    lines.push(`### ${u.speaker} — ${u.purpose}`, '', clip(u.text, 2200), '');
  }
  lines.push(
    'Respond to the substance of what was actually said. Concede a point when you are persuaded; do not simply restate your position.',
  );
  return lines.join('\n');
}

function stageSection(input: TurnPromptInput): string {
  const { stage } = input;
  const parts: string[] = [
    '## This stage',
    '',
    `Stage: **${stage.name}** (${stage.kind}, mode \`${stage.mode}\`).`,
  ];
  if (stage.produces) parts.push('', `This stage must produce: ${stage.produces}`);
  if (stage.instruction) parts.push('', `Stage instruction: ${stage.instruction}`);
  if (input.participants.length > 1) {
    parts.push(
      '',
      `Taking part: ${input.participants.map((p) => `${p.displayName} (${p.title})`).join(', ')}.`,
    );
  }
  return parts.join('\n');
}

function askSection(input: TurnPromptInput): string {
  const parts: string[] = ['## Your turn', '', input.purpose];
  if (input.grantedTools.length > 0) {
    parts.push(
      '',
      `Tools you may call this turn: ${input.grantedTools.map((t) => `\`${t}\``).join(', ')}. ` +
        'Anything else will be refused. Use them rather than describing what you would do.',
    );
  } else {
    parts.push('', 'You have no tools this turn. Produce your work product as text.');
  }
  if (input.repairNote) {
    parts.push('', `**Correction required — your previous attempt failed:** ${input.repairNote}`);
  }
  parts.push(
    '',
    'Answer with your work product only. Do not open with a restatement of the task, and do not close by asking whether to proceed.',
  );
  return parts.join('\n');
}

export function buildTurnMessages(input: TurnPromptInput): ChatMessage[] {
  const system = [
    identitySection(input),
    '',
    '## How you work',
    HOUSE_RULES,
    '',
    `## Where you work`,
    `Workspace root (the only place you may read or write files): ${input.workspace}`,
    'Your shell runs with that directory as its working directory, through the platform shell (cmd.exe semantics on Windows).',
    skillsSection(input),
  ]
    .filter((s) => s !== '')
    .join('\n');

  const user = [
    situationSection(input),
    debateSection(input),
    stageSection(input),
    askSection(input),
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Convenience for the review/test stages, which need the artifacts named. */
export function artifactsOfKind(artifacts: Artifact[], kinds: Artifact['kind'][]): Artifact[] {
  const want = new Set<string>(kinds);
  return artifacts.filter((a) => want.has(a.kind));
}
