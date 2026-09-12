/**
 * A minimal dev3d code plugin.
 *
 * It exists to prove the code path: a plugin module receives an `api`, registers
 * a tool that employees can actually call, and subscribes to the event stream.
 * Copy it as the starting point for a real one.
 *
 * The module must export `activate(api)`, and may export `deactivate()`.
 * It must not `import` anything outside its own directory unless it ships it -
 * the host does not install a plugin's dependencies.
 */

/** @param {import('@dev3d/core').PluginApi} api */
export function activate(api) {
  const prefix = typeof api.settings.prefix === 'string' ? api.settings.prefix : 'echo';

  api.registerTool({
    name: 'echo',
    description:
      'Repeat a short string back to you. Use it to check what you actually sent before ' +
      'committing to a longer plan.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to echo back.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const text = typeof args.text === 'string' ? args.text : '';
      if (text === '') {
        return { ok: false, content: 'echo needs a non-empty "text" argument.' };
      }
      if (ctx.settings.announceRuns === true) {
        ctx.log('debug', `echo was called with ${text.length} characters in ${ctx.workspaceRoot}`);
      }
      return {
        ok: true,
        content: `${prefix}: ${text}`,
        preview: `${prefix}: ${text.slice(0, 60)}`,
        affectsPaths: [],
      };
    },
  });

  if (api.settings.announceRuns === true) {
    api.on('run.created', (event) => {
      api.log('info', `a run started: ${event.run.id} on "${event.run.pipelineId}"`);
    });
  }
}

export function deactivate() {
  // Nothing to release: the host unregisters this plugin's tools and drops its
  // event subscriptions for us.
}
