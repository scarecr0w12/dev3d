/**
 * Miscellaneous tools with no side effects.
 */

import type { Tool } from './types.ts';

const thinkTool: Tool = {
  name: 'think',
  description:
    'Record a private scratchpad note to organise your own reasoning. This is ' +
    'scratchpad space, not a plan and not a deliverable: it writes no files, has no ' +
    'side effects, and does not move the run forward. Use it to keep a running ' +
    'commentary while working through a hard problem.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The private note to record.' },
    },
    required: ['note'],
    additionalProperties: false,
  },
  run: async () => {
    return { ok: true, content: 'Noted.', preview: 'Noted.', affectsPaths: [] };
  },
};

export function createMiscTools(): Tool[] {
  return [thinkTool];
}
