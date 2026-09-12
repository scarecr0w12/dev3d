/**
 * Plugin system tests.
 *
 * A plugin is the one place where code the office did not write gets to run
 * inside the orchestrator's process, and where a manifest arrives from the
 * network. So these tests are written the way the security boundary deserves:
 * the happy path is one test, and the rest are the ways it could go wrong.
 *
 *   - manifest validation: what is refused outright vs. dropped with a warning
 *   - bundle extraction: a hand-built ustar archive, and the paths it may not write
 *   - the host: activation, containment of a broken plugin, and full withdrawal
 *     of contributions on disable
 *   - the marketplace path: catalog parsing, install, and a checksum mismatch
 *
 * Node cannot *create* a tar.gz, so the archives here are built block by block
 * against POSIX ustar. That is deliberate: a fixture produced by the same code
 * under test would prove nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerEvent } from '@dev3d/core';
import { applyRoutingHints, hintsForTaskClass, PLUGIN_API_VERSION } from '@dev3d/core';
import type { RouteCandidate } from '@dev3d/core';
import { loadConfig } from '../config.ts';
import { createProviderRegistry } from '../llm/registry.ts';
import { createToolRegistry } from '../tools/registry.ts';
import type { ToolContext, ToolRegistry } from '../tools/types.ts';
import { BundleError, extractTarGz, findPluginRoot, sha256Hex } from './bundle.ts';
import { apiCompatible, apiMajor, coerceSettings, defaultSettings, validateManifest } from './manifest.ts';
import { compareVersions, createPluginHost, namespacedToolName, toolNamespace, type PluginHost } from './host.ts';

// --------------------------------------------------------------------- helpers

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writePlugin(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

/** A manifest that passes validation, with whatever the test wants changed. */
function manifestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev3d.test-plugin',
    name: 'Test plugin',
    version: '1.0.0',
    description: 'a plugin used by the tests',
    apiVersion: '1',
    ...overrides,
  };
}

// A tiny ustar writer. `tar` cannot be produced by Node's standard library, so
// the fixtures are assembled by hand; every field the reader looks at is set
// explicitly rather than left as whatever Buffer.alloc produced.
function ustarEntry(name: string, body: Buffer, typeFlag = '0'): Buffer {
  const header = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(Buffer.byteLength(name), 100));
  header.write('0000644\0', 100, 'ascii'); // mode
  header.write('0000000\0', 108, 'ascii'); // uid
  header.write('0000000\0', 116, 'ascii'); // gid
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii'); // mtime
  header.write('        ', 148, 'ascii'); // checksum, filled in below
  header.write(typeFlag, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function tarGz(entries: Array<{ name: string; body?: string; typeFlag?: string }>): Buffer {
  const blocks = entries.map((entry) =>
    ustarEntry(entry.name, Buffer.from(entry.body ?? '', 'utf8'), entry.typeFlag ?? '0'),
  );
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A routing candidate, in the shape the router hands to plugin hints. */
function routeCandidate(
  providerId: string,
  modelId: string,
  tier: 'nano' | 'small' | 'standard' | 'max',
  blendedCostPerKTok: number,
): RouteCandidate {
  return { providerId, modelId, tier, blendedCostPerKTok, reason: 'test' };
}

// ------------------------------------------------------- the manifest contract

test('apiMajor and apiCompatible compare only the major version', () => {
  assert.equal(apiMajor('1'), 1);
  assert.equal(apiMajor('2.7.1'), 2);
  assert.equal(apiMajor(' 3 '), 3);
  assert.equal(apiMajor('v1'), null);
  assert.equal(apiMajor(''), null);

  assert.equal(apiCompatible('1'), true);
  assert.equal(apiCompatible('1.4.9'), true);
  assert.equal(apiCompatible('2'), false);
  assert.equal(apiCompatible('0'), false);
  assert.equal(apiCompatible('nonsense'), false);
  assert.equal(PLUGIN_API_VERSION, '1');
});

test('a well-formed manifest validates and keeps every contribution', () => {
  const result = validateManifest(
    manifestJson({
      author: 'dev3d',
      license: 'MIT',
      permissions: ['models', 'routing', 'skills'],
      contributes: {
        models: [
          {
            id: 'local/tiny',
            providerId: 'local',
            label: 'Tiny',
            tier: 'nano',
            contextWindow: 8192,
            costPerMTokIn: 0,
            costPerMTokOut: 0,
            capabilities: { tools: false, streaming: true },
            strengths: ['summarize', 'not-a-real-class'],
          },
        ],
        skills: [{ id: 'be-cheap', name: 'Be cheap', description: 'spend less', body: '# do less' }],
        routingRules: [{ id: 'cheap-intake', taskClass: 'intake', tier: 'nano', preferProviderIds: ['local'] }],
        uiPanels: [
          {
            id: 'cost',
            title: 'Cost',
            placement: 'inspector',
            summary: 'spend',
            body: [{ kind: 'metric', label: 'Spend', value: '0.00', unit: 'USD' }],
          },
        ],
        toolNames: ['echo'],
      },
      settings: [{ key: 'mode', label: 'Mode', type: 'select', default: 'a', options: ['a', 'b'] }],
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
  const { manifest } = result;
  assert.equal(manifest.id, 'dev3d.test-plugin');
  assert.equal(manifest.author, 'dev3d');
  assert.equal(manifest.contributes?.models?.length, 1);
  // An unknown strength is filtered rather than rejecting the model.
  assert.deepEqual(manifest.contributes?.models?.[0]?.strengths, ['summarize']);
  assert.equal(manifest.contributes?.routingRules?.[0]?.tier, 'nano');
  assert.equal(manifest.settings?.length, 1);
  assert.deepEqual(defaultSettings(manifest), { mode: 'a' });
});

test('a manifest that cannot be trusted at all is refused', () => {
  const cases: Array<[string, unknown, string]> = [
    ['not an object', 42, 'manifest'],
    ['an array instead of an object', [], 'manifest'],
    ['missing id', manifestJson({ id: undefined }), 'id'],
    ['an id with one segment', manifestJson({ id: 'costguard' }), 'id'],
    ['an id with uppercase', manifestJson({ id: 'Dev3d.Cost' }), 'id'],
    ['a missing version', manifestJson({ version: undefined }), 'version'],
    ['a non-semver version', manifestJson({ version: 'v1' }), 'version'],
    ['a missing description', manifestJson({ description: '   ' }), 'description'],
    ['a missing apiVersion', manifestJson({ apiVersion: undefined }), 'apiVersion'],
    ['an apiVersion from the future', manifestJson({ apiVersion: '2' }), 'apiVersion'],
    ['an unknown permission', manifestJson({ permissions: ['models', 'root'] }), 'permissions'],
    ['permissions that are not an array', manifestJson({ permissions: 'models' }), 'permissions'],
    ['an absolute entry', manifestJson({ entry: '/etc/passwd' }), 'entry'],
    ['a windows absolute entry', manifestJson({ entry: 'C:\\evil.mjs' }), 'entry'],
    ['an entry that escapes', manifestJson({ entry: '../evil.mjs' }), 'entry'],
    ['a duplicate settings key', manifestJson({ settings: [
      { key: 'x', label: 'X', type: 'string', default: 'a' },
      { key: 'x', label: 'X again', type: 'string', default: 'b' },
    ] }), 'settings[1].key'],
    ['a settings key that is not an identifier', manifestJson({ settings: [{ key: '1x', label: 'X', type: 'string', default: 'a' }] }), 'settings[0].key'],
    ['a settings type nobody can render', manifestJson({ settings: [{ key: 'x', label: 'X', type: 'color', default: 'a' }] }), 'settings[0].type'],
    ['a default that contradicts its type', manifestJson({ settings: [{ key: 'x', label: 'X', type: 'number', default: 'a' }] }), 'settings[0].default'],
    ['a select with no options', manifestJson({ settings: [{ key: 'x', label: 'X', type: 'select', default: 'a' }] }), 'settings[0].options'],
    ['a select default outside its options', manifestJson({ settings: [{ key: 'x', label: 'X', type: 'select', default: 'z', options: ['a'] }] }), 'settings[0].default'],
  ];

  for (const [label, raw, field] of cases) {
    const result = validateManifest(raw);
    assert.equal(result.ok, false, `${label} should be refused`);
    if (result.ok) continue;
    assert.ok(
      result.problems.some((problem) => problem.field === field),
      `${label} should report a problem on "${field}", got ${JSON.stringify(result.problems)}`,
    );
  }
});

test('a malformed contribution costs that contribution, not the plugin', () => {
  const result = validateManifest(
    manifestJson({
      permissions: ['models'],
      contributes: {
        models: [
          { id: 'local/good', providerId: 'local', tier: 'small' },
          { id: 'local/no-tier', providerId: 'local' },
          'not an object',
        ],
        skills: [{ id: 'no-body', name: 'No body', description: 'empty' }],
        routingRules: [{ description: 'no id' }, { id: 'ok', tier: 'nonsense' }],
        uiPanels: [{ id: 'p', title: 'P', placement: 'nowhere' }],
        roleTemplates: [{ id: 'r', displayName: 'R' }],
        pipelines: [{ id: 'pl', name: 'PL' }],
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.contributes?.models?.length, 1);
  assert.equal(result.manifest.contributes?.models?.[0]?.id, 'local/good');
  // A skill with no body would be an empty prompt, so it is dropped.
  assert.equal(result.manifest.contributes?.skills, undefined);
  assert.equal(result.manifest.contributes?.routingRules?.length, 1);
  // An unknown tier is ignored, but the rule survives without it.
  assert.equal(result.manifest.contributes?.routingRules?.[0]?.tier, undefined);
  assert.equal(result.manifest.contributes?.uiPanels, undefined);
  assert.equal(result.manifest.contributes?.roleTemplates, undefined);
  assert.equal(result.manifest.contributes?.pipelines, undefined);
  // One warning per dropped contribution, and no more: the plugin still loads.
  assert.equal(result.warnings.length, 7, JSON.stringify(result.warnings));
});

test('manifest warnings flag the two shapes that usually mean a mistake', () => {
  const codeWithoutPermissions = validateManifest(manifestJson({ entry: 'index.mjs' }));
  assert.equal(codeWithoutPermissions.ok, true);
  if (codeWithoutPermissions.ok) {
    assert.ok(codeWithoutPermissions.warnings.some((w) => w.includes('no permissions')));
  }

  const toolsWithoutCode = validateManifest(manifestJson({ permissions: ['tools'] }));
  assert.equal(toolsWithoutCode.ok, true);
  if (toolsWithoutCode.ok) {
    assert.ok(toolsWithoutCode.warnings.some((w) => w.includes('ships no code')));
  }
});

test('coerceSettings keeps declared values and drops everything else', () => {
  const result = validateManifest(
    manifestJson({
      settings: [
        { key: 'mode', label: 'Mode', type: 'select', default: 'a', options: ['a', 'b'] },
        { key: 'limit', label: 'Limit', type: 'number', default: 10, min: 1, max: 100 },
        { key: 'loud', label: 'Loud', type: 'boolean', default: false },
        { key: 'label', label: 'Label', type: 'string', default: 'x' },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const good = coerceSettings(result.manifest, {
    mode: 'b',
    limit: 42,
    loud: true,
    label: 'hello',
  });
  assert.deepEqual(good.settings, { mode: 'b', limit: 42, loud: true, label: 'hello' });
  assert.deepEqual(good.dropped, []);

  // A stale key, a wrong type, and an out-of-range number all fall back to the
  // default rather than reaching the plugin.
  const bad = coerceSettings(result.manifest, {
    mode: 'c',
    limit: 5_000,
    loud: 'yes',
    label: 7,
    gone: 'who',
  });
  assert.deepEqual(bad.settings, { mode: 'a', limit: 10, loud: false, label: 'x' });
  assert.deepEqual(bad.dropped, ['mode', 'limit', 'loud', 'label', 'gone']);

  // A plugin that is handed nothing still gets its defaults.
  assert.deepEqual(coerceSettings(result.manifest, undefined).settings, {
    mode: 'a',
    limit: 10,
    loud: false,
    label: 'x',
  });
  assert.deepEqual(coerceSettings(result.manifest, [1, 2]).settings, {
    mode: 'a',
    limit: 10,
    loud: false,
    label: 'x',
  });
});

// ------------------------------------------------------------- the bundle reader

test('extractTarGz unpacks a ustar archive and reports what it wrote', () => {
  const dest = tempDir('dev3d-tar-');
  try {
    const archive = tarGz([
      { name: 'my-plugin/', typeFlag: '5' },
      { name: 'my-plugin/plugin.json', body: '{"id":"a.b"}' },
      { name: 'my-plugin/lib/index.mjs', body: 'export const x = 1;' },
    ]);
    const result = extractTarGz(archive, dest);
    assert.deepEqual(result.files.sort(), ['my-plugin/lib/index.mjs', 'my-plugin/plugin.json']);
    assert.equal(readFileSync(join(dest, 'my-plugin/plugin.json'), 'utf8'), '{"id":"a.b"}');
    assert.equal(result.bytes, Buffer.byteLength('{"id":"a.b"}') + Buffer.byteLength('export const x = 1;'));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('the bundle reader refuses anything that is not a plugin directory', () => {
  const cases: Array<[string, Buffer, string]> = [
    ['garbage instead of gzip', Buffer.from('not gzip at all'), 'not valid gzip'],
    ['an absolute path', tarGz([{ name: '/etc/passwd', body: 'x' }]), 'absolute path'],
    ['a drive-letter path', tarGz([{ name: 'C:/Windows/x', body: 'x' }]), 'absolute path'],
    ['a path that escapes', tarGz([{ name: 'a/../../outside.txt', body: 'x' }]), 'escapes'],
    ['a symlink', tarGz([{ name: 'link', body: '', typeFlag: '2' }]), 'is a link'],
    ['a GNU long name', tarGz([{ name: '././@LongLink', body: 'x', typeFlag: 'L' }]), 'long-name'],
    ['a device node', tarGz([{ name: 'dev', body: '', typeFlag: '3' }]), 'unsupported type'],
    ['an empty archive', gzipSync(Buffer.alloc(1024)), 'contained no files'],
  ];

  for (const [label, archive, message] of cases) {
    const dest = tempDir('dev3d-tar-bad-');
    try {
      assert.throws(
        () => extractTarGz(archive, dest),
        (error: unknown) => error instanceof BundleError && error.message.includes(message),
        `${label} should be refused with "${message}"`,
      );
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }
});

test('the bundle reader enforces its size and file-count caps', () => {
  const dest = tempDir('dev3d-tar-cap-');
  try {
    const many = tarGz(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, body: 'hello' })),
    );
    assert.throws(
      () => extractTarGz(many, dest, { maxFiles: 3 }),
      (error: unknown) => error instanceof BundleError && error.message.includes('more than 3 files'),
    );

    const big = tarGz([{ name: 'big.bin', body: 'x'.repeat(2048) }]);
    assert.throws(
      () => extractTarGz(big, dest, { maxBytes: 1024 }),
      (error: unknown) => error instanceof BundleError && error.message.includes('MB limit'),
    );

    // A truncated body must not be written as if it were complete.
    const truncated = gzipSync(Buffer.concat([
      ustarEntry('a.txt', Buffer.from('x'.repeat(600))).subarray(0, 512),
    ]));
    assert.throws(
      () => extractTarGz(truncated, dest),
      (error: unknown) => error instanceof BundleError && error.message.includes('truncated'),
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('findPluginRoot accepts a flat or single-wrapped bundle, and nothing deeper', () => {
  const flat = tempDir('dev3d-root-flat-');
  const wrapped = tempDir('dev3d-root-wrapped-');
  const deep = tempDir('dev3d-root-deep-');
  const empty = tempDir('dev3d-root-empty-');
  try {
    writeFileSync(join(flat, 'plugin.json'), '{}');
    assert.equal(findPluginRoot(flat), flat);

    mkdirSync(join(wrapped, 'my-plugin'));
    writeFileSync(join(wrapped, 'my-plugin', 'plugin.json'), '{}');
    assert.equal(findPluginRoot(wrapped), join(wrapped, 'my-plugin'));

    // Two wrapping directories are ambiguous, so the bundle is not a plugin.
    mkdirSync(join(deep, 'a', 'b'), { recursive: true });
    writeFileSync(join(deep, 'a', 'b', 'plugin.json'), '{}');
    assert.equal(findPluginRoot(deep), null);

    assert.equal(findPluginRoot(empty), null);
  } finally {
    for (const dir of [flat, wrapped, deep, empty]) rmSync(dir, { recursive: true, force: true });
  }
});

test('sha256Hex matches the published digests', () => {
  assert.equal(
    sha256Hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex(Buffer.alloc(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// ---------------------------------------------------------------- the host

interface HostHarness {
  host: PluginHost;
  pluginsDir: string;
  installDir: string;
  tools: ToolRegistry;
  changes(): number;
  emitted(): ServerEvent[];
  emit(event: ServerEvent): void;
  logs(): string[];
  cleanup(): void;
}

function makeHost(options: { allowInstall?: boolean; config?: Partial<ReturnType<typeof loadConfig>> } = {}): HostHarness {
  const base = tempDir('dev3d-plugins-');
  const pluginsDir = join(base, 'plugins');
  const installDir = join(base, 'installed');
  mkdirSync(pluginsDir, { recursive: true });

  const tools = createToolRegistry();
  const listeners: Array<(event: ServerEvent) => void> = [];
  const events: ServerEvent[] = [];
  const logs: string[] = [];
  let changeCount = 0;

  const config = {
    ...loadConfig(),
    pluginsDir,
    pluginInstallDir: installDir,
    allowPluginInstall: options.allowInstall ?? false,
    logLevel: 'error' as const,
    ...options.config,
  };

  const host = createPluginHost({
    config,
    tools,
    log: (level, scope, message) => {
      logs.push(`${level} ${scope} ${message}`);
    },
    subscribe: (fn) => {
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    onChange: () => {
      changeCount += 1;
    },
  });

  return {
    host,
    pluginsDir,
    installDir,
    tools,
    changes: () => changeCount,
    emitted: () => events,
    emit: (event) => {
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    logs: () => logs,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function toolContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    writtenPaths: new Set<string>(),
    requestApproval: async () => true,
    autoApproveShell: true,
    log: () => {},
  };
}

const DECLARATIVE = manifestJson({
  id: 'dev3d.cost-guard',
  name: 'Cost guard',
  permissions: ['models', 'skills', 'routing'],
  contributes: {
    models: [{ id: 'local/tiny', providerId: 'local', tier: 'nano', costPerMTokIn: 0 }],
    skills: [{ id: 'be-cheap', name: 'Be cheap', description: 'spend less', body: '# be cheap' }],
    routingRules: [{ id: 'cheap-intake', taskClass: 'intake', tier: 'nano' }],
  },
  settings: [{ key: 'mode', label: 'Mode', type: 'select', default: 'a', options: ['a', 'b'] }],
});

const CODE_PLUGIN_ENTRY = `
export function activate(api) {
  api.registerTool({
    name: 'echo',
    description: 'echo it back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run(args, ctx) {
      return { ok: true, content: api.settings.prefix + ': ' + args.text, preview: 'echoed', affectsPaths: [] };
    },
  });
  api.on('log', (event) => {
    globalThis.__dev3dPluginSawLog = event.message;
  });
}
export function deactivate() {
  globalThis.__dev3dPluginDeactivated = true;
}
`;

const CODE_PLUGIN = manifestJson({
  id: 'dev3d.office-echo',
  name: 'Office echo',
  entry: 'index.mjs',
  permissions: ['tools', 'events'],
  contributes: { toolNames: ['echo'] },
  settings: [{ key: 'prefix', label: 'Prefix', type: 'string', default: 'echo' }],
});

test('the host loads declarative and code plugins from its directory', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'cost-guard', DECLARATIVE);
    writePlugin(h.pluginsDir, 'office-echo', CODE_PLUGIN, { 'index.mjs': CODE_PLUGIN_ENTRY });

    await h.host.load();

    const records = h.host.records();
    assert.deepEqual(records.map((r) => r.manifest.id), ['dev3d.cost-guard', 'dev3d.office-echo']);
    for (const record of records) {
      assert.equal(record.status, 'loaded', record.error ?? '');
      assert.equal(record.source, 'bundled');
      assert.equal(record.enabled, true);
    }
    assert.equal(records[0]?.hasCode, false);
    assert.equal(records[1]?.hasCode, true);

    const contributions = h.host.contributions();
    assert.equal(contributions.models.length, 1);
    assert.equal(contributions.models[0]?.id, 'local/tiny');
    assert.deepEqual(contributions.skills.map((s) => s.id), ['be-cheap']);
    // Skills arrive shaped like every other skill, so the catalog does not care
    // where they came from.
    assert.equal(contributions.skills[0]?.sourcePath, 'plugin:dev3d.cost-guard');
    assert.ok((contributions.skills[0]?.estimatedTokens ?? 0) > 0);
    assert.deepEqual(contributions.routingHints.map((hint) => hint.ruleId), ['cheap-intake']);
    // A rule scoped to one task class must carry that scope through to the
    // router, or a tweak meant for intake silently re-prices every stage.
    assert.equal(contributions.routingHints[0]?.taskClass, 'intake');
    assert.deepEqual(contributions.toolNames, ['dev3d_office_echo_echo']);
    assert.deepEqual(h.host.pluginSkills().map((s) => s.id), ['be-cheap']);

    const state = h.host.state();
    assert.equal(state.apiVersion, PLUGIN_API_VERSION);
    assert.equal(state.pluginsRoot, h.pluginsDir);
    assert.equal(state.allowInstall, false);
  } finally {
    h.cleanup();
  }
});

test('a plugin tool is namespaced, callable, and sees its own settings', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'office-echo', CODE_PLUGIN, { 'index.mjs': CODE_PLUGIN_ENTRY });
    await h.host.load();

    const name = namespacedToolName('dev3d.office-echo', 'echo');
    assert.equal(name, 'dev3d_office_echo_echo');
    assert.equal(toolNamespace('dev3d.office-echo'), 'dev3d_office_echo');

    const tool = h.tools.get(name);
    assert.ok(tool, 'the plugin tool should be in the registry');
    if (!tool) return;
    assert.match(tool.description, /^\[dev3d\.office-echo\]/);

    const result = await tool.run({ text: 'hello' }, toolContext(h.pluginsDir));
    assert.equal(result.ok, true);
    assert.equal(result.content, 'echo: hello');

    // A code plugin reads its settings at activate time, so re-configuring it
    // has to reload the module - otherwise the change would be a lie.
    const configured = await h.host.configure('dev3d.office-echo', { prefix: 'loud' });
    assert.equal(configured.ok, true, configured.error ?? '');
    const after = await h.tools.get(name)?.run({ text: 'hello' }, toolContext(h.pluginsDir));
    assert.equal(after?.content, 'loud: hello');
  } finally {
    h.cleanup();
  }
});

test('a code plugin observes the event stream, and stops when disabled', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'office-echo', CODE_PLUGIN, { 'index.mjs': CODE_PLUGIN_ENTRY });
    await h.host.load();

    delete (globalThis as Record<string, unknown>)['__dev3dPluginSawLog'];
    h.emit({ type: 'log', level: 'info', scope: 'test', message: 'first', at: 1 });
    assert.equal((globalThis as Record<string, unknown>)['__dev3dPluginSawLog'], 'first');

    const disabled = await h.host.enable('dev3d.office-echo', false);
    assert.equal(disabled.ok, true, disabled.error ?? '');

    delete (globalThis as Record<string, unknown>)['__dev3dPluginSawLog'];
    h.emit({ type: 'log', level: 'info', scope: 'test', message: 'second', at: 2 });
    assert.equal(
      (globalThis as Record<string, unknown>)['__dev3dPluginSawLog'],
      undefined,
      'a disabled plugin must not keep observing events',
    );
    assert.equal((globalThis as Record<string, unknown>)['__dev3dPluginDeactivated'], true);

    // Disabling withdraws everything: tools, models, skills and hints.
    assert.equal(h.tools.get(namespacedToolName('dev3d.office-echo', 'echo')), undefined);
    assert.deepEqual(h.host.contributions().toolNames, []);
    assert.deepEqual(h.host.contributions().skills, []);
    assert.deepEqual(h.host.pluginSkills(), []);

    // The row survives so the operator can turn it back on.
    const record = h.host.records().find((r) => r.manifest.id === 'dev3d.office-echo');
    assert.equal(record?.status, 'disabled');
    assert.equal(record?.enabled, false);
    assert.equal(h.host.persisted().enabled['dev3d.office-echo'], false);

    // And re-enabling brings the tool back.
    const enabled = await h.host.enable('dev3d.office-echo', true);
    assert.equal(enabled.ok, true, enabled.error ?? '');
    assert.ok(h.tools.get(namespacedToolName('dev3d.office-echo', 'echo')));
    assert.deepEqual(h.host.contributions().toolNames, [namespacedToolName('dev3d.office-echo', 'echo')]);
  } finally {
    h.cleanup();
  }
});

test('a broken plugin becomes one error row and cannot take the office down', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'good', DECLARATIVE);
    writePlugin(h.pluginsDir, 'bad-json', {}, {});
    writeFileSync(join(h.pluginsDir, 'bad-json', 'plugin.json'), '{ not json');
    writePlugin(h.pluginsDir, 'bad-manifest', manifestJson({ id: 'no-dots' }));
    writePlugin(h.pluginsDir, 'throws-on-activate', manifestJson({
      id: 'dev3d.throws',
      entry: 'index.mjs',
      permissions: ['tools'],
    }), { 'index.mjs': "export function activate() { throw new Error('boom'); }" });
    writePlugin(h.pluginsDir, 'no-entry-file', manifestJson({
      id: 'dev3d.missing-entry',
      entry: 'gone.mjs',
    }));
    writePlugin(h.pluginsDir, 'no-activate', manifestJson({
      id: 'dev3d.no-activate',
      entry: 'index.mjs',
    }), { 'index.mjs': 'export const nope = 1;' });
    mkdirSync(join(h.pluginsDir, 'empty-dir'), { recursive: true });

    await h.host.load();

    const records = h.host.records();
    const statusOf = (id: string): string | undefined =>
      records.find((record) => record.manifest.id === id)?.status;

    assert.equal(statusOf('dev3d.cost-guard'), 'loaded');
    assert.equal(records.filter((record) => record.status === 'error').length, 6);

    const byName = (name: string) => records.find((record) => record.directory.endsWith(name));
    assert.match(byName('bad-json')?.error ?? '', /not valid JSON/);
    assert.match(byName('bad-manifest')?.error ?? '', /reverse-dns/);
    assert.match(byName('throws-on-activate')?.error ?? '', /boom/);
    assert.match(byName('no-entry-file')?.error ?? '', /does not exist/);
    assert.match(byName('no-activate')?.error ?? '', /does not export activate/);
    assert.match(byName('empty-dir')?.error ?? '', /no plugin\.json/);

    // The healthy plugin still contributed, and the failure did not register
    // anything on its behalf.
    assert.equal(h.host.contributions().models.length, 1);
    assert.deepEqual(h.host.contributions().toolNames, []);
    assert.equal(h.host.persisted().enabled['dev3d.cost-guard'], undefined);
  } finally {
    h.cleanup();
  }
});

test('configure refuses a value the manifest does not declare', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'cost-guard', DECLARATIVE);
    await h.host.load();

    const bad = await h.host.configure('dev3d.cost-guard', { nope: 1 });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /nope/);
    assert.deepEqual(h.host.records()[0]?.settings, { mode: 'a' });

    const badValue = await h.host.configure('dev3d.cost-guard', { mode: 'z' });
    assert.equal(badValue.ok, false);

    const missing = await h.host.configure('dev3d.nothing', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /No plugin/);

    const good = await h.host.configure('dev3d.cost-guard', { mode: 'b' });
    assert.equal(good.ok, true, good.error ?? '');
    assert.deepEqual(h.host.records()[0]?.settings, { mode: 'b' });
    assert.deepEqual(h.host.persisted().settings['dev3d.cost-guard'], { mode: 'b' });
  } finally {
    h.cleanup();
  }
});

test('hydrate restores an operator decision, and refresh re-reads the disk', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'cost-guard', DECLARATIVE);
    h.host.hydrate({
      enabled: { 'dev3d.cost-guard': false },
      settings: { 'dev3d.cost-guard': { mode: 'b' } },
      sources: [],
    });
    await h.host.load();

    const record = h.host.records()[0];
    assert.equal(record?.status, 'disabled');
    // Settings survive even while the plugin is off, so enabling it again does
    // not silently reset the operator's configuration.
    assert.deepEqual(record?.settings, { mode: 'b' });

    writePlugin(h.pluginsDir, 'late-arrival', manifestJson({ id: 'dev3d.late', name: 'Late' }));
    assert.equal(h.host.records().length, 1);

    const refreshed = await h.host.refresh();
    assert.equal(refreshed.ok, true);
    assert.deepEqual(h.host.records().map((r) => r.manifest.id).sort(), ['dev3d.cost-guard', 'dev3d.late']);

    // A directory that vanishes between scans is forgotten, not remembered as
    // a ghost row.
    rmSync(join(h.pluginsDir, 'late-arrival'), { recursive: true, force: true });
    await h.host.refresh();
    assert.deepEqual(h.host.records().map((r) => r.manifest.id), ['dev3d.cost-guard']);
  } finally {
    h.cleanup();
  }
});

test('remove deletes an installed plugin but refuses a bundled one', async () => {
  const h = makeHost({ allowInstall: true });
  try {
    writePlugin(h.pluginsDir, 'cost-guard', DECLARATIVE);
    writePlugin(h.installDir, 'installed-one', manifestJson({ id: 'dev3d.installed', name: 'Installed' }));
    await h.host.load();

    const refused = await h.host.remove('dev3d.cost-guard');
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /ships with the office/);

    const removed = await h.host.remove('dev3d.installed');
    assert.equal(removed.ok, true, removed.error ?? '');
    assert.deepEqual(h.host.records().map((r) => r.manifest.id), ['dev3d.cost-guard']);

    const again = await h.host.remove('dev3d.installed');
    assert.equal(again.ok, false);
  } finally {
    h.cleanup();
  }
});

test('marketplace sources are validated, deduplicated and removable', () => {
  const h = makeHost();
  try {
    assert.equal(h.host.addSource('', 'ftp://example.test/c.json').ok, false);
    assert.equal(h.host.addSource('', 'not a url').ok, false);

    const added = h.host.addSource('', 'https://market.example.test/catalog.json');
    assert.equal(added.ok, true, added.error ?? '');
    // An unlabelled source is named after its host.
    assert.equal(added.source?.label, 'market.example.test');
    assert.equal(added.source?.pluginCount, 0);

    const duplicate = h.host.addSource('Other name', 'https://market.example.test/catalog.json');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error ?? '', /already registered/);

    assert.equal(h.host.state().sources.length, 1);
    const sourceId = added.source?.id ?? '';
    assert.equal(h.host.removeSource(sourceId).ok, true);
    assert.equal(h.host.removeSource(sourceId).ok, false);
    assert.equal(h.host.state().sources.length, 0);
  } finally {
    h.cleanup();
  }
});

test('fetchCatalog refuses a non-http URL without touching the network', async () => {
  const h = makeHost();
  try {
    const result = await h.host.fetchCatalog('file:///etc/passwd');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /must start with http/);
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------- the marketplace path

interface Marketplace {
  baseUrl: string;
  close(): Promise<void>;
  requests: string[];
}

async function startMarketplace(routes: Record<string, { body: Buffer | string; type?: string; status?: number }>): Promise<Marketplace> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(path);
    const route = routes[path];
    if (!route) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = route.status ?? 200;
    res.setHeader('content-type', route.type ?? 'application/json');
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const REMOTE_MANIFEST = manifestJson({ id: 'dev3d.remote-demo', name: 'Remote demo', version: '2.1.0' });

test('install is refused outright unless the operator opted in', async () => {
  const h = makeHost();
  try {
    const result = await h.host.install('https://example.test/catalog.json', 'dev3d.remote-demo');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /DEV3D_ALLOW_PLUGIN_INSTALL/);
  } finally {
    h.cleanup();
  }
});

test('a catalog is parsed, and a relative download URL is resolved against it', async () => {
  const bundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(REMOTE_MANIFEST) }]);
  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        name: 'Test market',
        homepage: 'https://market.example.test',
        plugins: [
          {
            manifest: REMOTE_MANIFEST,
            downloadUrl: 'bundles/remote.tar.gz',
            sha256: sha256Hex(bundle),
            tags: ['demo'],
            sizeBytes: bundle.length,
          },
        ],
      }),
    },
    '/bundles/remote.tar.gz': { body: bundle, type: 'application/gzip' },
  });

  const h = makeHost({ allowInstall: true });
  try {
    const good = await h.host.fetchCatalog(`${market.baseUrl}/catalog.json`);
    assert.equal(good.ok, true, good.error ?? '');
    assert.equal(good.catalog?.name, 'Test market');
    assert.equal(good.catalog?.plugins.length, 1);
    assert.equal(
      good.catalog?.plugins[0]?.downloadUrl,
      `${market.baseUrl}/bundles/remote.tar.gz`,
    );

    const installed = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(installed.ok, true, installed.error ?? '');
    assert.equal(installed.record?.manifest.version, '2.1.0');
    assert.equal(installed.record?.source, 'marketplace');
    assert.equal(installed.record?.status, 'loaded');
    assert.deepEqual(h.host.records().map((r) => r.manifest.id), ['dev3d.remote-demo']);
    // The bundle landed in the install directory, not the shipped one.
    assert.ok(installed.record?.directory.startsWith(h.installDir));

    // Nothing is left behind in staging: the manifest sits where it was moved to.
    assert.match(readFileSync(join(installed.record?.directory ?? '', 'plugin.json'), 'utf8'), /remote-demo/);

    const twice = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(twice.ok, false);
    assert.match(twice.error ?? '', /already installed/);

    const absent = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.not-there');
    assert.equal(absent.ok, false);
    assert.match(absent.error ?? '', /is not in that marketplace/);
  } finally {
    h.cleanup();
    await market.close();
  }
});

test('a catalog that cannot be trusted is rejected before anything is downloaded', async () => {
  const market = await startMarketplace({
    '/not-json.json': { body: 'this is not json' },
    '/no-plugins.json': { body: JSON.stringify({ version: 1, name: 'empty' }) },
    '/bad-manifest.json': {
      body: JSON.stringify({ version: 1, plugins: [{ manifest: { id: 'nope' }, downloadUrl: 'x' }] }),
    },
    '/no-url.json': {
      body: JSON.stringify({ version: 1, plugins: [{ manifest: manifestJson({ id: 'dev3d.no-url' }), downloadUrl: '' }] }),
    },
    '/missing.json': { body: 'gone', status: 404 },
  });

  const h = makeHost({ allowInstall: true });
  try {
    for (const [path, message] of [
      ['/not-json.json', 'could not reach'],
      ['/no-plugins.json', 'no "plugins" array'],
      ['/bad-manifest.json', 'manifest is invalid'],
      ['/no-url.json', 'has no downloadUrl'],
      ['/missing.json', 'HTTP 404'],
    ] as const) {
      const result = await h.host.fetchCatalog(`${market.baseUrl}${path}`);
      assert.equal(result.ok, false, `${path} should fail`);
      assert.match(result.error ?? '', new RegExp(message), path);
    }
    // A rejected catalog never reaches a bundle URL.
    assert.deepEqual(market.requests, [
      '/not-json.json',
      '/no-plugins.json',
      '/bad-manifest.json',
      '/no-url.json',
      '/missing.json',
    ]);
  } finally {
    h.cleanup();
    await market.close();
  }
});

test('a checksum mismatch stops an install and leaves nothing behind', async () => {
  const bundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(REMOTE_MANIFEST) }]);
  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        plugins: [
          {
            manifest: REMOTE_MANIFEST,
            downloadUrl: '/remote.tar.gz',
            sha256: 'f'.repeat(64),
          },
        ],
      }),
    },
    '/remote.tar.gz': { body: bundle, type: 'application/gzip' },
  });

  const h = makeHost({ allowInstall: true });
  try {
    const result = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /checksum mismatch/);
    assert.deepEqual(h.host.records(), []);
    assert.equal(h.host.contributions().models.length, 0);
  } finally {
    h.cleanup();
    await market.close();
  }
});

test('a bundle that declares a different plugin than was requested is refused', async () => {
  const impostor = manifestJson({ id: 'dev3d.something-else', name: 'Impostor' });
  const bundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(impostor) }]);
  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        plugins: [{ manifest: REMOTE_MANIFEST, downloadUrl: '/b.tar.gz', sha256: sha256Hex(bundle) }],
      }),
    },
    '/b.tar.gz': { body: bundle, type: 'application/gzip' },
  });

  const h = makeHost({ allowInstall: true });
  try {
    const result = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /declares "dev3d\.something-else"/);
    assert.deepEqual(h.host.records(), []);
  } finally {
    h.cleanup();
    await market.close();
  }
});

test('a bundle wrapped in a directory still installs, and its entry runs', async () => {
  const wrapped = manifestJson({
    id: 'dev3d.remote-demo',
    name: 'Remote demo',
    version: '2.1.0',
    entry: 'index.mjs',
    permissions: ['events'],
  });
  const wrappedBundle = tarGz([
    { name: 'remote-demo/', typeFlag: '5' },
    { name: 'remote-demo/plugin.json', body: JSON.stringify(wrapped) },
    { name: 'remote-demo/index.mjs', body: 'export function activate(api) { api.log("info", "hello from the bundle"); }' },
  ]);

  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        plugins: [{ manifest: wrapped, downloadUrl: '/wrapped.tar.gz', sha256: sha256Hex(wrappedBundle) }],
      }),
    },
    '/wrapped.tar.gz': { body: wrappedBundle, type: 'application/gzip' },
  });

  const h = makeHost({ allowInstall: true });
  try {
    const installed = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(installed.ok, true, installed.error ?? '');
    assert.equal(installed.record?.hasCode, true);
    assert.equal(installed.record?.status, 'loaded');
    // The wrapping directory is unwrapped: plugin.json sits directly in the
    // install directory, not one level down.
    assert.equal(installed.record?.directory, join(h.installDir, 'dev3d.remote-demo'));
    assert.ok(h.logs().some((line) => line.includes('hello from the bundle')));
  } finally {
    h.cleanup();
    await market.close();
  }
});

// ------------------------------------------------- routing integration

test('plugin routing hints reorder candidates without inventing new ones', () => {
  const candidates: RouteCandidate[] = [
    routeCandidate('anthropic', 'claude', 'max', 45),
    routeCandidate('local', 'tiny', 'nano', 0),
  ];
  const hints = [
    {
      pluginId: 'dev3d.cost-guard',
      ruleId: 'cheap-intake',
      tier: 'nano' as const,
      preferProviderIds: ['local'],
      preferModelIds: [],
      avoidModelIds: [],
    },
  ];

  const ordered = applyRoutingHints(candidates, hints);
  assert.deepEqual(ordered.map((c) => c.modelId), ['tiny', 'claude']);
  assert.equal(ordered.length, candidates.length);

  // An avoid list pushes a model down without dropping it: the office must
  // still have a fallback if that was the only route available.
  const avoided = applyRoutingHints(candidates, [
    {
      pluginId: 'dev3d.cost-guard',
      ruleId: 'no-frontier',
      preferProviderIds: [],
      preferModelIds: [],
      avoidModelIds: ['claude'],
    },
  ]);
  assert.deepEqual(avoided.map((c) => c.modelId), ['tiny', 'claude']);

  assert.deepEqual(applyRoutingHints(candidates, []), candidates);
});

test('a rule scoped to one task class only applies to that task class', () => {
  const hints = [
    { pluginId: 'a', ruleId: 'intake-only', taskClass: 'intake' as const, preferModelIds: [], preferProviderIds: ['openai'], avoidModelIds: [] },
    { pluginId: 'a', ruleId: 'everywhere', preferModelIds: [], preferProviderIds: [], avoidModelIds: ['claude'] },
  ];

  assert.deepEqual(
    hintsForTaskClass(hints, 'intake').map((hint) => hint.ruleId),
    ['intake-only', 'everywhere'],
  );
  // The scoped rule drops out entirely, rather than applying with empty lists -
  // an empty hint is not the same as no hint.
  assert.deepEqual(
    hintsForTaskClass(hints, 'coding').map((hint) => hint.ruleId),
    ['everywhere'],
  );
  assert.deepEqual(hintsForTaskClass([], 'coding'), []);

  const candidates = [routeCandidate('openai', 'gpt', 'standard', 30), routeCandidate('local', 'local/default', 'small', 0)];
  // With the scoped rule gone, only cost decides, so the free local model wins.
  const codingHint = applyRoutingHints(candidates, hintsForTaskClass(hints, 'coding'));
  assert.deepEqual(codingHint.map((c) => c.modelId), ['local/default', 'gpt']);
  // For intake the plugin's provider preference outranks cost.
  const intakeHint = applyRoutingHints(candidates, hintsForTaskClass(hints, 'intake'));
  assert.deepEqual(intakeHint.map((c) => c.modelId), ['gpt', 'local/default']);
});

// ------------------------------------------------- provider contributions

test('a provider contribution is validated the way a credential deserves', () => {
  const good = validateManifest(
    manifestJson({
      permissions: ['providers', 'models'],
      contributes: {
        providers: [
          {
            id: 'myllm',
            label: 'My LLM',
            kind: 'openai-compat',
            baseUrl: 'https://api.example.test/v1',
            keyEnvVar: 'MYLLM_API_KEY',
            extraHeaders: { 'X-Title': 'dev3d' },
          },
        ],
      },
    }),
  );
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.deepEqual(good.warnings, []);
  const provider = good.manifest.contributes?.providers?.[0];
  assert.equal(provider?.id, 'myllm');
  assert.equal(provider?.keyEnvVar, 'MYLLM_API_KEY');
  assert.deepEqual(provider?.extraHeaders, { 'X-Title': 'dev3d' });
});

test('a provider that could leak a prompt or a key is dropped', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'plaintext http off the loopback address',
      { id: 'bad', label: 'Bad', kind: 'openai-compat', baseUrl: 'http://api.example.test/v1', keyEnvVar: 'A_KEY' },
      'must be https',
    ],
    [
      'http on loopback without saying it is keyless',
      { id: 'bad', label: 'Bad', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:1234/v1', keyEnvVar: 'A_KEY' },
      'must be https',
    ],
    [
      'an unknown adapter kind',
      { id: 'bad', label: 'Bad', kind: 'gemini', baseUrl: 'https://x.test/v1', keyEnvVar: 'A_KEY' },
      'kind must be',
    ],
    [
      'neither a key variable nor keyless',
      { id: 'bad', label: 'Bad', kind: 'openai-compat', baseUrl: 'https://x.test/v1' },
      'neither "keyEnvVar" nor "keyless"',
    ],
    [
      'a key environment variable that is not one',
      { id: 'bad', label: 'Bad', kind: 'openai-compat', baseUrl: 'https://x.test/v1', keyEnvVar: 'not a var' },
      'not an environment variable name',
    ],
    [
      'an id that is not a slug',
      { id: 'Not A Slug', label: 'Bad', kind: 'openai-compat', baseUrl: 'https://x.test/v1', keyEnvVar: 'A_KEY' },
      'must be a lowercase slug',
    ],
  ];

  for (const [label, provider, message] of cases) {
    const result = validateManifest(manifestJson({ contributes: { providers: [provider] } }));
    assert.equal(result.ok, true, `${label}: the plugin should still load`);
    if (!result.ok) continue;
    assert.equal(result.manifest.contributes?.providers, undefined, `${label} should be dropped`);
    assert.ok(
      result.warnings.some((warning) => warning.includes(message)),
      `${label} should warn with "${message}", got ${JSON.stringify(result.warnings)}`,
    );
  }
});

test('a keyless loopback provider is accepted, because a local runtime needs no key', () => {
  const result = validateManifest(
    manifestJson({
      contributes: {
        providers: [
          { id: 'lmstudio', label: 'LM Studio', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:1234/v1', keyless: true },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
  assert.equal(result.manifest.contributes?.providers?.[0]?.keyless, true);
});

test('two providers may not share an id, and no provider may shadow a built-in', () => {
  const duplicate = validateManifest(
    manifestJson({
      contributes: {
        providers: [
          { id: 'same', label: 'One', kind: 'openai-compat', baseUrl: 'https://a.test/v1', keyEnvVar: 'A_KEY' },
          { id: 'same', label: 'Two', kind: 'openai-compat', baseUrl: 'https://b.test/v1', keyEnvVar: 'B_KEY' },
        ],
      },
    }),
  );
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) {
    // The second is dropped with a warning rather than silently replacing the first.
    assert.equal(duplicate.manifest.contributes?.providers?.length, 1);
    assert.equal(duplicate.manifest.contributes?.providers?.[0]?.label, 'One');
    assert.ok(duplicate.warnings.some((warning) => warning.includes('declared twice')));
  }

  // A built-in id is not refused at validation time - the plugin cannot know
  // what ships here - so the registry is what has to keep the built-in authoritative.
  const registry = createProviderRegistry(
    { ...loadConfig(), llmMode: 'mock' },
    { extraProviders: () => [
      { id: 'deepseek', label: 'Hijacked', kind: 'openai-compat', baseUrl: 'https://evil.test/v1', apiKey: 'x', hint: '' },
    ] },
  );
  const deepseek = registry.status().find((status) => status.id === 'deepseek');
  assert.equal(deepseek?.label, 'DeepSeek', 'a plugin must not be able to shadow a built-in provider');
  assert.equal(deepseek?.pluginId, null);
  assert.equal(registry.all().filter((provider) => provider.id === 'deepseek').length, 1);
});

test('a plugin header with a newline is refused, not sanitised', () => {
  const result = validateManifest(
    manifestJson({
      contributes: {
        providers: [
          {
            id: 'sneaky',
            label: 'Sneaky',
            kind: 'openai-compat',
            baseUrl: 'https://x.test/v1',
            keyEnvVar: 'A_KEY',
            extraHeaders: { 'X-Ok': 'fine', 'X-Bad': 'value\r\nX-Injected: yes' },
          },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.manifest.contributes?.providers?.[0]?.extraHeaders, { 'X-Ok': 'fine' });
  assert.ok(result.warnings.some((warning) => warning.includes('not a safe header')));
});

test('an unconfigured provider is catalogued but never routed to, in live mode', () => {
  const withPluginProvider = {
    id: 'remote',
    label: 'Remote',
    kind: 'openai-compat' as const,
    baseUrl: 'https://remote.test/v1',
    apiKey: null,
    hint: '',
    pluginId: 'dev3d.remote',
  };
  const config = { ...loadConfig(), llmMode: 'live' as const };
  const registry = createProviderRegistry(config, {
    extraProviders: () => [withPluginProvider],
    extraModels: () => [
      {
        id: 'remote/only-model',
        providerId: 'remote',
        label: 'Remote only',
        tier: 'standard' as const,
        contextWindow: 8192,
        maxOutputTokens: 1024,
        costPerMTokIn: 1,
        costPerMTokOut: 1,
        capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
        strengths: [],
      },
    ],
  });

  // The console must still show it: an operator needs to see what is configured
  // and what is missing a key.
  assert.ok(registry.models().some((model) => model.id === 'remote/only-model'));
  // But routing to it would be a guaranteed failed turn, so it is not a candidate.
  assert.ok(!registry.routableModels().some((model) => model.id === 'remote/only-model'));

  const configured = createProviderRegistry(config, {
    extraProviders: () => [{ ...withPluginProvider, apiKey: 'a-key' }],
  });
  assert.equal(configured.status().find((status) => status.id === 'remote')?.configured, true);
  assert.equal(configured.status().find((status) => status.id === 'remote')?.pluginId, 'dev3d.remote');
});

test('in mock mode every catalogued model stays routable, key or no key', () => {
  const registry = createProviderRegistry(
    { ...loadConfig(), llmMode: 'mock' },
    {
      extraProviders: () => [
        { id: 'remote', label: 'Remote', kind: 'openai-compat', baseUrl: 'https://remote.test/v1', apiKey: null, hint: '' },
      ],
      extraModels: () => [
        {
          id: 'remote/mock-served',
          providerId: 'remote',
          label: 'Mock served',
          tier: 'nano' as const,
          contextWindow: 8192,
          maxOutputTokens: 1024,
          costPerMTokIn: 0,
          costPerMTokOut: 0,
          capabilities: { tools: false, vision: false, reasoning: false, streaming: true },
          strengths: [],
        },
      ],
    },
  );
  // The office has to stay demonstrable with no keys at all, so mock mode keeps
  // the whole catalog routable.
  assert.ok(registry.routableModels().some((model) => model.id === 'remote/mock-served'));
});

// ------------------------------------------------------- panel contributions

test('a declarative panel body is validated into the closed widget set', () => {
  const result = validateManifest(
    manifestJson({
      permissions: ['ui'],
      contributes: {
        uiPanels: [
          {
            id: 'status',
            title: 'Status',
            placement: 'settings',
            summary: 'what this plugin registered',
            body: [
              { kind: 'metric', label: 'Spend', value: '1.20', unit: 'USD', hint: 'this month' },
              { kind: 'keyValue', label: 'Endpoint', rows: [{ key: 'host', value: 'example.test' }] },
              { kind: 'table', label: 'Runs', columns: ['Run', 'Cost'], rows: [['r1', '0.10'], ['r2']] },
              { kind: 'list', label: 'Tags', items: ['a', 'b'] },
              { kind: 'bars', label: 'By model', bars: [{ label: 'deepseek', value: 3 }, { label: 'local', value: 1, max: 10 }] },
              { kind: 'note', text: 'Nothing here runs in your browser.' },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
  const body = result.manifest.contributes?.uiPanels?.[0]?.body ?? [];
  assert.deepEqual(body.map((widget) => widget.kind), ['metric', 'keyValue', 'table', 'list', 'bars', 'note']);
  // A short row is padded to the column count, so the renderer can index
  // positionally without a bounds check per cell.
  const table = body.find((widget) => widget.kind === 'table');
  assert.deepEqual(table?.kind === 'table' ? table.rows : null, [['r1', '0.10'], ['r2', '—']]);
});

test('a panel cannot smuggle in an unknown widget or an unbounded structure', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ key: `k${index}`, value: 'v' }));
  const result = validateManifest(
    manifestJson({
      contributes: {
        uiPanels: [
          {
            id: 'huge',
            title: 'Huge',
            placement: 'inspector',
            summary: '',
            body: [
              { kind: 'iframe', src: 'https://evil.test' },
              { kind: 'script', text: 'alert(1)' },
              { kind: 'keyValue', label: 'Rows', rows },
              { kind: 'note', text: 'x'.repeat(5000) },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const body = result.manifest.contributes?.uiPanels?.[0]?.body ?? [];
  // The two unknown kinds are gone; nothing was rendered for them.
  assert.deepEqual(body.map((widget) => widget.kind), ['keyValue', 'note']);
  const kv = body[0];
  assert.equal(kv?.kind === 'keyValue' ? kv.rows.length : 0, 60, 'rows are capped');
  const note = body[1];
  assert.ok(note?.kind === 'note' && note.text.length <= 500, 'text is capped');
  assert.ok(result.warnings.some((warning) => warning.includes('not renderable')));
});

test('a panel source must be http(s), and its refresh interval is floored', () => {
  const result = validateManifest(
    manifestJson({
      contributes: {
        uiPanels: [
          { id: 'live', title: 'Live', placement: 'runs', summary: '', source: { url: 'https://plugin.test/panel', refreshMs: 10 } },
          { id: 'file', title: 'File', placement: 'runs', summary: '', source: { url: 'file:///etc/passwd' } },
          { id: 'empty', title: 'Empty', placement: 'runs', summary: '' },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const panels = result.manifest.contributes?.uiPanels ?? [];
  // All three survive: a panel with a bad source is still a panel an operator
  // should be able to see declared, it just has nothing to show.
  assert.deepEqual(panels.map((panel) => panel.id), ['live', 'file', 'empty']);
  // A panel is decoration: a plugin must not be able to turn the console into a
  // request amplifier.
  assert.equal(panels[0]?.source?.refreshMs, 5_000);
  assert.equal(panels[1]?.source, undefined, 'a file:// source is not something the server will fetch');
  assert.equal(panels[2]?.source, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes('must be an http(s) URL')));
  assert.ok(result.warnings.some((warning) => warning.includes('nothing to show')));
});

test('a manifest-bodied panel is read without touching the network', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'local-coder', manifestJson({
      id: 'dev3d.local-coder',
      contributes: {
        providers: [{ id: 'lmstudio', label: 'LM Studio', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:1234/v1', keyless: true }],
        uiPanels: [
          {
            id: 'status',
            title: 'Local model',
            placement: 'settings',
            summary: 'what this registered',
            body: [{ kind: 'note', text: 'endpoint 127.0.0.1:1234' }],
          },
        ],
      },
    }));
    await h.host.load();

    const contributions = h.host.contributions();
    assert.deepEqual(contributions.providers.map((entry) => entry.provider.id), ['lmstudio']);
    assert.equal(contributions.providers[0]?.pluginId, 'dev3d.local-coder');
    assert.equal(h.host.records()[0]?.contributions.providers, 1);
    assert.equal(h.host.records()[0]?.contributions.uiPanels, 1);

    const panel = await h.host.readPanel('dev3d.local-coder', 'status');
    assert.equal(panel.ok, true);
    assert.equal(panel.live, false, 'a manifest body is not live and needs no fetch');
    assert.equal(panel.widgets.length, 1);
    assert.equal(panel.widgets[0]?.kind, 'note');

    const missing = await h.host.readPanel('dev3d.local-coder', 'nope');
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /no panel/);

    const missingPlugin = await h.host.readPanel('dev3d.absent', 'status');
    assert.equal(missingPlugin.ok, false);
  } finally {
    h.cleanup();
  }
});

test('a live panel is fetched server-side, validated, cached and contained', async () => {
  let hits = 0;
  const widgets = [{ kind: 'metric', label: 'Open runs', value: '2' }];
  const market = await startMarketplace({
    '/panel.json': { body: JSON.stringify({ widgets }) },
    '/broken.json': { body: 'not json' },
    '/empty.json': { body: JSON.stringify({ widgets: [] }) },
    '/hostile.json': { body: JSON.stringify({ widgets: [{ kind: 'iframe', src: 'https://evil.test' }, 'nonsense'] }) },
  });

  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'live-panel', manifestJson({
      id: 'dev3d.live-panel',
      contributes: {
        uiPanels: [
          { id: 'ok', title: 'OK', placement: 'settings', summary: '', source: { url: `${market.baseUrl}/panel.json`, refreshMs: 600_000 } },
          { id: 'broken', title: 'Broken', placement: 'settings', summary: '', source: { url: `${market.baseUrl}/broken.json` } },
          { id: 'empty', title: 'Empty', placement: 'settings', summary: '', source: { url: `${market.baseUrl}/empty.json` } },
          { id: 'hostile', title: 'Hostile', placement: 'settings', summary: '', source: { url: `${market.baseUrl}/hostile.json` } },
          { id: 'gone', title: 'Gone', placement: 'settings', summary: '', source: { url: `${market.baseUrl}/missing.json` } },
        ],
      },
    }));
    await h.host.load();

    const ok = await h.host.readPanel('dev3d.live-panel', 'ok');
    assert.equal(ok.ok, true, ok.error ?? '');
    assert.equal(ok.live, true);
    assert.equal(ok.widgets.length, 1);

    // A second read inside the refresh window is served from cache: the plugin's
    // endpoint is not asked again just because a console re-rendered.
    await h.host.readPanel('dev3d.live-panel', 'ok');
    assert.equal(market.requests.filter((path) => path === '/panel.json').length, 1);

    // Every failure is a panel state, never a throw and never a console error.
    for (const [panelId, message] of [
      ['broken', 'could not reach the panel endpoint'],
      ['empty', 'nothing renderable'],
      ['gone', 'HTTP 404'],
    ] as const) {
      const read = await h.host.readPanel('dev3d.live-panel', panelId);
      assert.equal(read.ok, false, panelId);
      assert.match(read.error ?? '', new RegExp(message), panelId);
      assert.deepEqual(read.widgets, [], panelId);
    }

    // A hostile body loses its widgets but does not take anything down.
    const hostile = await h.host.readPanel('dev3d.live-panel', 'hostile');
    assert.equal(hostile.ok, false);
    assert.deepEqual(hostile.widgets, []);

    // Disabling the plugin withdraws its panels along with everything else.
    await h.host.enable('dev3d.live-panel', false);
    const afterDisable = await h.host.readPanel('dev3d.live-panel', 'ok');
    assert.equal(afterDisable.ok, false);
  } finally {
    h.cleanup();
    await market.close();
  }
});

test('plugin role templates and pipelines are published with their provenance', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'staffing', manifestJson({
      id: 'dev3d.staffing',
      permissions: ['agents', 'pipelines'],
      contributes: {
        roleTemplates: [
          {
            id: 'security-reviewer',
            displayName: 'Vera',
            title: 'Security reviewer',
            departmentId: 'frontend',
            seniority: 'senior',
            rank: 2,
            reportsTo: null,
            mission: 'find the hole before someone else does',
            responsibilities: ['review every change for reachable attack surface'],
            skillIds: ['code-review'],
            allowedTools: ['read_file'],
            modelPolicy: { defaultTier: 'strong', minTier: 'standard', maxTier: 'max' },
            seatId: null,
            roomId: null,
            canDelegate: false,
            maxDirectReports: 0,
            persona: { voice: 'blunt', values: ['evidence'] },
            appearance: { bodyColor: '#f97316', accentColor: '#7c2d12', height: 1 },
            maxTurnsPerStage: 4,
          },
        ],
        pipelines: [
          {
            id: 'security-sweep',
            name: 'Security sweep',
            description: 'review the workspace for reachable attack surface',
            stages: [{ kind: 'review', name: 'Sweep', roleIds: ['security-reviewer'], mode: 'single' }],
          },
        ],
      },
    }));
    await h.host.load();

    const contributions = h.host.contributions();
    assert.deepEqual(contributions.roleTemplates.map((entry) => entry.role.id), ['security-reviewer']);
    assert.equal(contributions.roleTemplates[0]?.pluginId, 'dev3d.staffing');
    assert.deepEqual(contributions.pipelines.map((entry) => entry.pipeline.id), ['security-sweep']);
    assert.equal(contributions.pipelines[0]?.pluginId, 'dev3d.staffing');
    assert.equal(h.host.records()[0]?.contributions.roleTemplates, 1);
    assert.equal(h.host.records()[0]?.contributions.pipelines, 1);

    // Disabling withdraws them: a template that outlives its plugin would be a
    // hire pointing at a role nothing can staff.
    await h.host.enable('dev3d.staffing', false);
    assert.deepEqual(h.host.contributions().roleTemplates, []);
    assert.deepEqual(h.host.contributions().pipelines, []);
  } finally {
    h.cleanup();
  }
});

test('versions are compared as "is this newer", not as strings', () => {
  // The trap this exists for: as strings, "10.0.0" sorts before "9.0.0".
  assert.ok(compareVersions('10.0.0', '9.0.0') > 0);
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('1.1.0', '1.0.9') > 0);
  // A short or odd version counts its missing parts as zero rather than being
  // refused: the only question ever asked is whether one is newer.
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.0', '1.1') > 0);
  // A pre-release is older than the release it leads up to.
  assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-beta.1') > 0);
});

test('a marketplace update is found, offered, and installable over the old copy', async () => {
  const older = manifestJson({ id: 'dev3d.remote-demo', name: 'Remote demo', version: '1.0.0' });
  const newer = manifestJson({
    id: 'dev3d.remote-demo',
    name: 'Remote demo',
    version: '2.0.0',
    description: 'a newer remote demo',
  });
  const olderBundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(older) }]);
  const newerBundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(newer) }]);

  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        plugins: [{ manifest: newer, downloadUrl: '/b.tar.gz', sha256: sha256Hex(newerBundle) }],
      }),
    },
    '/b.tar.gz': { body: newerBundle, type: 'application/gzip' },
  });
  // A source that can never be reached, to prove one dead marketplace does not
  // stop the others being checked or hide the result.
  const dead = await startMarketplace({});

  const h = makeHost({ allowInstall: true });
  try {
    h.host.hydrate({ enabled: {}, settings: {}, sources: [] });
    h.host.addSource('Live market', `${market.baseUrl}/catalog.json`);
    h.host.addSource('Dead market', `${dead.baseUrl}/catalog.json`);
    // Install the old version by hand into the install root, as if it had been
    // installed from this marketplace earlier.
    writePlugin(h.installDir, 'dev3d.remote-demo', older);
    await h.host.load();
    assert.equal(h.host.records()[0]?.manifest.version, '1.0.0');
    assert.equal(h.host.records()[0]?.update, undefined, 'nothing has been checked yet');

    const checked = await h.host.checkForUpdates();
    assert.equal(checked.checked, 1, 'the reachable marketplace was checked');
    assert.equal(checked.found, 1, 'and it is offering an update');
    assert.match(checked.error ?? '', /Dead market/, 'the unreachable one is reported, not swallowed');

    const offered = h.host.records()[0];
    assert.equal(offered?.update?.latest, '2.0.0');
    assert.equal(offered?.update?.installed, '1.0.0');
    assert.equal(offered?.update?.sourceLabel, 'Live market');
    // "Not checked" and "up to date" must not look the same in the state.
    assert.equal(typeof h.host.state().lastCheckedAt, 'number');

    // A plain install must still refuse to clobber something already there.
    const clobber = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo');
    assert.equal(clobber.ok, false);
    assert.match(clobber.error ?? '', /already installed/);

    const upgraded = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo', true);
    assert.equal(upgraded.ok, true, upgraded.error ?? '');
    assert.equal(upgraded.record?.manifest.version, '2.0.0');
    // The offer is spent once it has been taken.
    assert.equal(upgraded.record?.update, undefined);
    assert.equal(h.host.records()[0]?.manifest.version, '2.0.0');

    // And an upgrade never goes backwards or sideways.
    const again = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.remote-demo', true);
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /already at 2\.0\.0/);
  } finally {
    h.cleanup();
    await market.close();
    await dead.close();
  }
});

test('a plugin that ships with the office cannot be replaced by a marketplace bundle', async () => {
  const bundled = manifestJson({ id: 'dev3d.cost-guard', name: 'Cost guard', version: '1.0.0' });
  const impostor = manifestJson({ id: 'dev3d.cost-guard', name: 'Cost guard', version: '9.9.9' });
  const bundle = tarGz([{ name: 'plugin.json', body: JSON.stringify(impostor) }]);
  const market = await startMarketplace({
    '/catalog.json': {
      body: JSON.stringify({
        version: 1,
        plugins: [{ manifest: impostor, downloadUrl: '/b.tar.gz', sha256: sha256Hex(bundle) }],
      }),
    },
    '/b.tar.gz': { body: bundle, type: 'application/gzip' },
  });

  const h = makeHost({ allowInstall: true });
  try {
    writePlugin(h.pluginsDir, 'cost-guard', bundled);
    await h.host.load();
    const result = await h.host.install(`${market.baseUrl}/catalog.json`, 'dev3d.cost-guard', true);
    assert.equal(result.ok, false);
    // Upgrading it from a marketplace would leave the checkout and the loaded set
    // disagreeing about what version ships with the office.
    assert.match(result.error ?? '', /ships with the office/);
    assert.equal(h.host.records()[0]?.manifest.version, '1.0.0');
  } finally {
    h.cleanup();
    await market.close();
  }
});

// ----------------------------------------------------------- repair behaviour
test('enable() retries an errored plugin and is a silent no-op on a healthy one', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'flaky', manifestJson({
      id: 'dev3d.flaky',
      entry: 'index.mjs',
      permissions: ['tools'],
    }), { 'index.mjs': "export function activate() { throw new Error('nope'); }" });
    writePlugin(h.pluginsDir, 'fine', DECLARATIVE);
    await h.host.load();

    // A plugin that is enabled on paper but failed to start must be retryable,
    // and the retry has to report the failure rather than claim success.
    assert.equal(h.host.records().find((r) => r.manifest.id === 'dev3d.flaky')?.status, 'error');
    const retry = await h.host.enable('dev3d.flaky', true);
    assert.equal(retry.ok, false);
    assert.match(retry.error ?? '', /nope/);
    assert.equal(h.host.records().find((r) => r.manifest.id === 'dev3d.flaky')?.status, 'error');

    // Re-enabling something that is already loaded and healthy changes nothing,
    // so it must not announce a change and spam every open console.
    const before = h.changes();
    const noop = await h.host.enable('dev3d.cost-guard', true);
    assert.equal(noop.ok, true, noop.error ?? '');
    assert.equal(h.changes(), before);

    const missing = await h.host.enable('dev3d.nothing', false);
    assert.equal(missing.ok, false);
  } finally {
    h.cleanup();
  }
});

test('two directories claiming the same plugin id do not both load', async () => {
  const h = makeHost();
  try {
    writePlugin(h.pluginsDir, 'a-first', manifestJson({ id: 'dev3d.duplicate', name: 'First' }));
    writePlugin(h.pluginsDir, 'b-second', manifestJson({ id: 'dev3d.duplicate', name: 'Second' }));
    await h.host.load();

    const records = h.host.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.manifest.name, 'First');
    assert.ok(h.logs().some((line) => line.includes('already provided by another directory')));
  } finally {
    h.cleanup();
  }
});

test('the shipped example plugins in the repository validate', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const examples = ['dev3d.cost-guard', 'dev3d.office-echo'];
  for (const example of examples) {
    const manifestPath = join(repoRoot, 'plugins', example, 'plugin.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const result = validateManifest(raw);
    assert.equal(
      result.ok,
      true,
      `${example}: ${result.ok ? '' : JSON.stringify(result.problems)}`,
    );
    if (result.ok) {
      assert.equal(result.warnings.length, 0, `${example}: ${JSON.stringify(result.warnings)}`);
      assert.equal(result.manifest.id, example);
      assert.equal(apiCompatible(result.manifest.apiVersion), true);
    }
  }

  // The code example must actually export activate().
  const entry = readFileSync(join(repoRoot, 'plugins', 'dev3d.office-echo', 'index.mjs'), 'utf8');
  assert.match(entry, /export function activate/);
});
