import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSkillIndex,
  loadSkills,
  loadSkillsWithReport,
  parseSkillMarkdown,
  renderSkillsForPrompt,
  selectSkills,
} from './loader.ts';
import type { Skill } from '@dev3d/core';
import { SKILL_IDS } from '../org/defaultCompany.ts';

// `<repo>/skills`, reached from `<repo>/apps/server/src/skills/skills.test.ts`.
const skillsDir = fileURLToPath(new URL('../../../../skills', import.meta.url));

function mkSkill(
  id: string,
  name: string,
  description: string,
  tags: string[],
  taskClasses?: string[],
): Skill {
  const skill: Skill = {
    id,
    name,
    description,
    tags,
    body: `# ${name}\n\nbody for ${id}`,
    sourcePath: `skills/${id}.md`,
  };
  if (taskClasses) skill.taskClasses = taskClasses;
  return skill;
}

test('parses frontmatter with inline lists and quoted strings', () => {
  const raw = [
    '---',
    'id: web-research',
    'name: Web Research',
    'description: "Find evidence from the open web"',
    'tags: [research, evidence, "web search"]',
    'taskClasses: [research]',
    'version: "1.0"',
    '---',
    '# Body',
    '',
    'some content',
  ].join('\n');

  const skill = parseSkillMarkdown(raw, 'skills/web-research.md');
  assert.equal(skill.id, 'web-research');
  assert.equal(skill.name, 'Web Research');
  assert.equal(skill.description, 'Find evidence from the open web');
  assert.deepEqual(skill.tags, ['research', 'evidence', 'web search']);
  assert.deepEqual(skill.taskClasses, ['research']);
  assert.equal(skill.version, '1.0');
  assert.equal(skill.body, '# Body\n\nsome content');
});

test('defaults tags to [] when absent', () => {
  const raw = ['---', 'id: x', 'name: X', 'description: x', '---', 'body'].join('\n');
  const skill = parseSkillMarkdown(raw, 'skills/x.md');
  assert.deepEqual(skill.tags, []);
});

test('throws a clear error naming the file when id is missing', () => {
  const raw = ['---', 'name: No Id', 'description: x', '---', 'body'].join('\n');
  assert.throws(() => parseSkillMarkdown(raw, 'skills/broken.md'), /skills\/broken\.md/);
  assert.throws(() => parseSkillMarkdown(raw, 'skills/broken.md'), /"id"/);
});

/**
 * `loadSkills` runs in `main()` before the server listens, so throwing here is
 * the difference between a typo in a markdown file and an office that will not
 * start. `skills/` is a directory the README invites people to edit, which makes
 * one bad file ordinary rather than exceptional.
 */
test('one malformed skill file does not take the catalogue down with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev3d-skills-'));
  try {
    await writeFile(join(dir, 'good.md'), ['---', 'id: good', 'name: Good', 'description: fine', '---', 'body'].join('\n'));
    // Missing `id` - the same mistake the parse test above pins.
    await writeFile(join(dir, 'broken.md'), ['---', 'name: No Id', 'description: x', '---', 'body'].join('\n'));

    const { skills, skipped } = await loadSkillsWithReport(dir);
    assert.deepEqual(skills.map((s) => s.id), ['good']);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0] ?? '', /broken\.md/);

    // The bare loader stays usable and does not throw either.
    const viaLoadSkills = await loadSkills(dir);
    assert.deepEqual(viaLoadSkills.map((s) => s.id), ['good']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing skills directory yields an empty catalogue rather than throwing', async () => {
  const missing = join(tmpdir(), `dev3d-no-skills-${Date.now()}`);
  const skills = await loadSkills(missing);
  assert.deepEqual(skills, []);
});

test('loadSkills loads all 15 skills and matches SKILL_IDS', async () => {  const skills = await loadSkills(skillsDir);
  assert.equal(skills.length, 15);

  const loadedIds = skills.map((s) => s.id).sort();
  const expectedIds = [...SKILL_IDS].sort();
  assert.deepEqual(loadedIds, expectedIds);

  for (const skill of skills) {
    assert.ok(skill.name, `skill ${skill.id} should have a name`);
    assert.ok(skill.description, `skill ${skill.id} should have a description`);
    assert.ok(skill.body.length > 0, `skill ${skill.id} should have a body`);
    assert.ok(
      (skill.estimatedTokens ?? 0) > 0,
      `skill ${skill.id} should have an estimated token count`,
    );
  }
});

test('buildSkillIndex lists only requested candidates and renders bodies under headings', () => {
  const skills = [
    mkSkill('a', 'Alpha', 'does alpha things', ['x']),
    mkSkill('b', 'Beta', 'does beta things', ['y']),
    mkSkill('c', 'Gamma', 'does gamma things', ['z']),
  ];
  const index = buildSkillIndex(skills, ['c', 'a']);
  assert.deepEqual(index.split('\n'), [
    '- a: Alpha — does alpha things',
    '- c: Gamma — does gamma things',
  ]);

  const rendered = renderSkillsForPrompt(skills.slice(0, 2));
  assert.match(rendered, /## Skill: Alpha/);
  assert.match(rendered, /## Skill: Beta/);
});

test('selectSkills returns role defaults first, prefers task-class matches, and is deterministic', () => {
  const skills = [
    mkSkill('a', 'Role Default', 'always on for this role', [], []),
    mkSkill('b', 'Frontend Implementation', 'React components and UI state', ['react', 'frontend']),
    mkSkill('c', 'Backend Implementation', 'APIs, databases, servers', ['api'], ['coding']),
    mkSkill('d', 'System Design', 'architecture and interfaces', [], ['architecture']),
  ];
  const opts = {
    skills,
    candidateIds: ['a', 'b', 'c', 'd'],
    taskText: 'write a React component',
    taskClass: 'coding',
    alwaysIds: ['a'],
    limit: 2,
  };

  const r1 = selectSkills(opts);
  const r2 = selectSkills(opts);
  assert.deepEqual(r1, r2); // deterministic

  assert.equal(r1[0]!.skillId, 'a');
  assert.equal(r1[0]!.via, 'role-default');

  assert.equal(r1[1]!.skillId, 'c');
  assert.equal(r1[1]!.via, 'task-class');

  assert.equal(r1[2]!.skillId, 'b');
  assert.equal(r1[2]!.via, 'keyword');

  assert.equal(r1.length, 3); // 1 default + limit 2
});
