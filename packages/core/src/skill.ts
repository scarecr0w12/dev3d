/**
 * Skills are the capabilities an employee can reach for.
 *
 * A skill is a markdown document with frontmatter, loaded from disk at boot.
 * Roles do not carry every skill in their system prompt - that would blow the
 * context budget and dilute the instructions. Instead each employee gets an
 * *index* (id + name + description) and pulls the full body in only when a
 * task looks like it needs it. That is the "dynamically selects skills"
 * behaviour: selection happens per turn, against the actual task text.
 */

export interface SkillFrontmatter {
  /** Stable id, e.g. 'web-research'. */
  id: string;
  name: string;
  description: string;
  /** Loose grouping, e.g. 'research' | 'frontend' | 'process'. */
  tags: string[];
  /** Task classes this skill tends to help with. */
  taskClasses?: string[];
  /** Tools this skill expects to be available. */
  requiresTools?: string[];
  /** Rough token cost of the body, for budget-aware selection. */
  estimatedTokens?: number;
  version?: string;
}

export interface Skill extends SkillFrontmatter {
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Source path on disk, for the skill viewer UI. */
  sourcePath: string;
}

/** A skill as it appears in an index handed to a model for selection. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface SkillSelection {
  skillId: string;
  /** Why this skill was pulled in for this turn. */
  reason: string;
  /** How it was chosen. */
  via: 'role-default' | 'keyword' | 'model-choice' | 'task-class';
}

export function toSkillSummary(skill: Skill): SkillSummary {
  return { id: skill.id, name: skill.name, description: skill.description, tags: skill.tags };
}
