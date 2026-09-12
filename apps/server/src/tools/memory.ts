/**
 * `recall`: what the office already knows about this project.
 *
 * This is the read half of memory, and it is a *tool* rather than an injected
 * block on purpose. The evidence on always-injected context is that it raises
 * cost substantially without improving task success, because an agent follows
 * every instruction it is handed whether or not it bears on the work; while the
 * evidence on letting the model decide *whether* to search is that it often
 * simply does not, and fails silently when it does not.
 *
 * A tool call threaded through the existing tool loop is the resolution of those
 * two: the model must ask, but the machinery around asking is one the it is
 * already reliable at - calling a granted function with a query. What the prompt
 * carries is a short index, so the employee knows there is something to ask about.
 *
 * Read-only. Nothing here writes: a fact exists because a person wrote it down,
 * and keeping the write path out of the model's reach is what keeps this feature
 * free of the hallucinated-memory failure that dominates the literature.
 */

import type { MemoryFact } from '@dev3d/core';
import type { Tool, ToolResult } from './types.ts';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MAX_QUERY = 300;

function fail(content: string): ToolResult {
  return { ok: false, content, preview: 'Error', affectsPaths: [] };
}

/**
 * Render facts for a model.
 *
 * Scope and kind are printed on every line because they change how a fact should
 * be read: an installation-wide convention binds everyone, a role note is one
 * person's habit, a pitfall is a warning rather than a rule. An earlier `validFrom`
 * is not printed - the timestamp is for the operator auditing the record, and a
 * model reasoning about epoch milliseconds is just one more thing to get wrong.
 */
export function renderFacts(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) return '(nothing on record matches that)';
  return facts
    .map((fact) => {
      const where = fact.scope === 'installation' ? 'everywhere' : `${fact.scope} ${fact.scopeId ?? ''}`.trim();
      const tags = fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
      const source = fact.source === null ? '' : `\n  source: ${fact.source}`;
      return `- (${fact.kind}, ${where})${tags} ${fact.text}${source}`;
    })
    .join('\n');
}

const recallTool: Tool = {
  name: 'recall',
  description:
    'Search what the office has written down about this project: conventions, decisions ' +
    'that were made and why, and traps that have already cost somebody time. Call this ' +
    'before assuming how this project works, and whenever the task touches something a ' +
    'colleague may have hit before. Facts are context, not orders - if one contradicts ' +
    'what you find in the code, say so rather than quietly following it.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to look for - keywords, a file path, a subsystem name, an error message. ' +
          'Leave empty to list the most confident facts on record.',
      },
      limit: {
        type: 'integer',
        description: `How many facts to return, up to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  run: async (args, ctx): Promise<ToolResult> => {
    // Absent when the engine was built without memory, which is a supported
    // configuration. Saying so is better than returning "nothing matches", which
    // would read as "this project has no conventions" - a much worse answer.
    if (ctx.recall === undefined) {
      return fail(
        'This office has no memory configured, so there is nothing to recall. Continue from the code and the brief.',
      );
    }

    const rawQuery = args.query;
    if (rawQuery !== undefined && typeof rawQuery !== 'string') {
      return fail('"query" must be a string.');
    }
    const query = (rawQuery ?? '').trim().slice(0, MAX_QUERY);

    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined && args.limit !== null) {
      const n = Number(args.limit);
      if (!Number.isFinite(n) || n < 1) return fail('"limit" must be a positive integer.');
      limit = Math.min(MAX_LIMIT, Math.floor(n));
    }

    const facts = ctx.recall(query, limit);
    ctx.log('debug', `recall("${query}") returned ${facts.length} fact(s)`);

    if (facts.length === 0) {
      // Deliberately not an error. An empty memory is a real answer, and the
      // employee should go and read the code rather than retry the search.
      return {
        ok: true,
        content:
          query === ''
            ? 'Nothing has been written down for this project yet. Work from the brief and the code.'
            : `Nothing on record matches "${query}". Work from the brief and the code; do not assume a convention exists.`,
        preview: `recall: no match for "${query.slice(0, 40)}"`,
        affectsPaths: [],
      };
    }

    return {
      ok: true,
      content:
        `${facts.length} fact(s) on record:\n${renderFacts(facts)}\n\n` +
        'Use these as context. Verify anything that contradicts the code before relying on it.',
      preview: `recall: ${facts.length} fact(s)${query === '' ? '' : ` for "${query.slice(0, 40)}"`}`,
      affectsPaths: [],
    };
  },
};

export function createMemoryTools(): Tool[] {
  return [recallTool];
}

export { recallTool };
