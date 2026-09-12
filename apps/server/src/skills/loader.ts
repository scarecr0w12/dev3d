/**
 * Skill loading and selection.
 *
 * Skills live on disk as markdown files with YAML-ish frontmatter. The loader
 * parses that frontmatter with a hand-written parser (no yaml dependency),
 * builds an index of (id, name, description), and - when a turn looks like it
 * needs help - selects and renders the full bodies into the employee's prompt.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Skill, SkillFrontmatter, SkillSelection } from '@dev3d/core';

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

type FrontmatterValue = string | number | boolean | string[];

function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseValue(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => unquote(part));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  const quoted = unquote(v);
  if (quoted !== v) return quoted; // was quoted string
  const num = Number(v);
  if (v !== '' && Number.isFinite(num)) return num;
  return v;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') return [v];
  return [];
}

function parseFrontmatter(lines: string[], out: Record<string, unknown>): void {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);
    out[key] = parseValue(rawValue);
  }
}

/**
 * Parse a skill markdown document into a `Skill`. Throws a clear error that
 * names the file when required frontmatter keys are missing - the loader must
 * fail loudly at boot rather than silently drop a skill.
 */
export function parseSkillMarkdown(raw: string, sourcePath: string): Skill {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  let bodyStart = 0;
  const parsed: Record<string, unknown> = {};
  if (lines[0]?.trim() === '---') {
    let close = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') {
        close = i;
        break;
      }
    }
    if (close !== -1) {
      parseFrontmatter(lines.slice(1, close), parsed);
      bodyStart = close + 1;
    }
  }

  const id = asString(parsed['id']);
  if (!id) {
    throw new Error(`Skill file ${sourcePath} is missing the required frontmatter key "id".`);
  }
  const name = asString(parsed['name']);
  if (!name) {
    throw new Error(`Skill file ${sourcePath} is missing the required frontmatter key "name".`);
  }
  const description = asString(parsed['description']);
  if (!description) {
    throw new Error(`Skill file ${sourcePath} is missing the required frontmatter key "description".`);
  }

  const taskClassesRaw = parsed['taskClasses'];
  const requiresToolsRaw = parsed['requiresTools'];
  const estimatedTokensRaw = parsed['estimatedTokens'];
  const versionRaw = parsed['version'];

  const frontmatter: SkillFrontmatter = {
    id,
    name,
    description,
    tags: asStringArray(parsed['tags']),
  };
  if (taskClassesRaw !== undefined) frontmatter.taskClasses = asStringArray(taskClassesRaw);
  if (requiresToolsRaw !== undefined) frontmatter.requiresTools = asStringArray(requiresToolsRaw);
  if (estimatedTokensRaw !== undefined) {
    const n = Number(estimatedTokensRaw);
    if (Number.isFinite(n)) frontmatter.estimatedTokens = n;
  }
  if (versionRaw !== undefined) {
    const v = asString(versionRaw);
    if (v) frontmatter.version = v;
  }

  const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '').trim();

  return { ...frontmatter, body, sourcePath };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load every `*.md` file in `dir`. Creates the directory if it is absent and
 * returns `[]` (so a fresh checkout boots cleanly). Sets `estimatedTokens`
 * from body length (~chars/4) when the frontmatter did not supply one, and
 * returns the skills sorted by id.
 */
export async function loadSkills(dir: string): Promise<Skill[]> {
  const { skills } = await loadSkillsWithReport(dir);
  return skills;
}

/**
 * The loader, with a report of what it had to skip.
 *
 * A skill file is something a person writes by hand, so one of them being wrong
 * is ordinary - a missing `id`, a frontmatter fence that does not close. That
 * must cost you *that skill*, not the whole catalogue and not the boot: this is
 * called from `main()` before the server listens, so throwing here is the
 * difference between a typo in a markdown file and an office that will not start.
 */
export async function loadSkillsWithReport(
  dir: string,
  log?: (level: 'warn', scope: string, message: string) => void,
): Promise<{ skills: Skill[]; skipped: string[] }> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return { skills: [], skipped: [] };
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { skills: [], skipped: [] };
  }

  const skills: Skill[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const sourcePath = join(dir, entry.name);
    try {
      const raw = await readFile(sourcePath, 'utf8');
      const skill = parseSkillMarkdown(raw, sourcePath);
      if (skill.estimatedTokens === undefined) {
        skill.estimatedTokens = Math.max(1, Math.ceil(skill.body.length / 4));
      }
      skills.push(skill);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push(`${entry.name}: ${reason}`);
      log?.('warn', 'skills', `skipped ${entry.name} — ${reason}`);
    }
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills, skipped };
}

// ---------------------------------------------------------------------------
// Index and rendering
// ---------------------------------------------------------------------------

/**
 * A compact newline list of `- id: name — description` for exactly the
 * requested candidate ids, so a model can see what is available without paying
 * for the full bodies.
 */
export function buildSkillIndex(skills: Skill[], candidateIds: string[]): string {
  const wanted = new Set(candidateIds);
  const lines: string[] = [];
  for (const skill of skills) {
    if (wanted.has(skill.id)) {
      lines.push(`- ${skill.id}: ${skill.name} — ${skill.description}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format full skill bodies under `## Skill: <name>` headings for injection
 * into an employee's prompt.
 */
export function renderSkillsForPrompt(skills: Skill[]): string {
  return skills
    .map((s) => `## Skill: ${s.name}\n\n${s.body.trim()}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  id: string;
  score: number;
  reason: string;
  via: 'keyword' | 'task-class';
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function keywordOverlap(skill: Skill, tokens: string[]): string[] {
  const haystack = [skill.name, skill.description, ...skill.tags].join(' ').toLowerCase();
  const matched: string[] = [];
  for (const token of tokens) {
    if (haystack.includes(token)) matched.push(token);
  }
  return matched;
}

export function selectSkills(opts: {
  skills: Skill[];
  candidateIds: string[];
  taskText: string;
  taskClass?: string;
  alwaysIds?: string[];
  limit?: number;
}): SkillSelection[] {
  const { skills, candidateIds, taskText, taskClass } = opts;
  const alwaysIds = opts.alwaysIds ?? [];
  const limit = opts.limit ?? 4;

  const byId = new Map(skills.map((s) => [s.id, s]));
  const candidates = new Set(candidateIds);
  const included = new Set<string>();
  const selections: SkillSelection[] = [];

  // 1. Role defaults always come first.
  for (const id of alwaysIds) {
    if (included.has(id) || !candidates.has(id)) continue;
    const skill = byId.get(id);
    if (!skill) continue;
    selections.push({
      skillId: id,
      reason: `Assigned to this role by default (${skill.name}).`,
      via: 'role-default',
    });
    included.add(id);
  }

  // 2. Score the remaining candidates.
  const tokens = tokenize(taskText);
  const scored: ScoredCandidate[] = [];
  for (const id of candidateIds) {
    if (included.has(id)) continue;
    const skill = byId.get(id);
    if (!skill) continue;

    const taskClassMatched = Boolean(taskClass && skill.taskClasses?.includes(taskClass));
    const matched = keywordOverlap(skill, tokens);

    if (taskClassMatched) {
      const reason = matched.length > 0
        ? `Task class "${taskClass}" matches skill taskClasses, and keywords ${matched.map((m) => `"${m}"`).join(', ')} overlap the task.`
        : `Task class "${taskClass}" matches skill taskClasses.`;
      scored.push({ id, score: 100 + matched.length, reason, via: 'task-class' });
    } else if (matched.length > 0) {
      scored.push({
        id,
        score: matched.length,
        reason: `Keyword overlap with the task text: ${matched.map((m) => `"${m}"`).join(', ')}.`,
        via: 'keyword',
      });
    }
  }

  // Stable, best-first ordering: higher score first, then id for ties.
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const defaultCount = selections.length;
  for (const candidate of scored) {
    if (selections.length - defaultCount >= limit) break;
    selections.push({
      skillId: candidate.id,
      reason: candidate.reason,
      via: candidate.via,
    });
  }

  return selections;
}
