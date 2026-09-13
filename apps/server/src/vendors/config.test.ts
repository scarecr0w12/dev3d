/**
 * Tests for the vendor configuration: presets, the environment list, and the file
 * reader.
 *
 * The interesting assertions are all about what happens to a *bad* entry, because
 * the failure mode this guards against is a typo in one vendor quietly taking the
 * rest of the bay down - or, worse, an entry being accepted with a command that
 * cannot work and a status badge that says it can.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import {
  VENDOR_PRESETS,
  loadVendorConfig,
  parseVendorGrantPolicy,
  parseVendorList,
  presetNames,
  readVendorConfigFile,
} from './config.ts';

test('every preset names a command, an operator, and an honest read-only claim', () => {
  const names = presetNames();
  assert.deepEqual(names, ['codex', 'dsh', 'hermes', 'openclaw']);
  for (const name of names) {
    const preset = VENDOR_PRESETS[name];
    assert.ok(preset, `${name} is missing`);
    assert.notEqual(preset.command.trim(), '');
    assert.ok(preset.args.length > 0, `${name} has no arguments`);
    assert.notEqual(preset.operator.trim(), '');
    assert.ok(preset.timeoutMs >= 5_000, `${name} has no useful timeout`);
    assert.notEqual(preset.authNote.trim(), '', `${name} says nothing about how it authenticates`);
  }
});

test('only the harness with a real sandbox flag claims read-only is enforced', () => {
  // The whole point of the capability declaration. Codex takes `-s read-only`,
  // so its claim is a guarantee; the other two are asked to behave, so theirs is
  // a request. A preset that flipped this would put a green badge on an
  // unconfined process.
  assert.equal(VENDOR_PRESETS['codex']?.capabilities.readOnlyEnforcement, 'sandbox');
  assert.ok(VENDOR_PRESETS['codex']?.args.includes('read-only'), 'the sandbox flag is what makes the claim true');
  assert.equal(VENDOR_PRESETS['dsh']?.capabilities.readOnlyEnforcement, 'requested');
  assert.equal(VENDOR_PRESETS['hermes']?.capabilities.readOnlyEnforcement, 'requested');
});

test('a preset entry is a complete vendor, and a bare name works', () => {
  const { vendors, problems } = parseVendorList('codex;hermes');
  assert.deepEqual(problems, []);
  assert.equal(vendors.length, 2);
  const codex = vendors[0];
  assert.equal(codex?.id, 'codex');
  assert.equal(codex?.command, 'codex');
  assert.deepEqual(codex?.args, ['exec', '--json', '-s', 'read-only']);
  assert.equal(codex?.outputFormat, 'codex-jsonl');
  assert.equal(codex?.enabled, true);
  assert.equal(codex?.label, 'Codex');
});

test('an id may be given for the same preset twice', () => {
  const { vendors, problems } = parseVendorList('fast=codex;thorough=dsh');
  assert.deepEqual(problems, []);
  assert.deepEqual(
    vendors.map((vendor) => vendor.id),
    ['fast', 'thorough'],
  );
  assert.equal(vendors[1]?.command, 'dsh');
});

test('an unknown preset is refused by name, and lists what exists', () => {
  const { vendors, problems } = parseVendorList('claude');
  assert.equal(vendors.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /claude/);
  assert.match(problems[0] ?? '', /codex, dsh, hermes/);
  assert.match(problems[0] ?? '', /vendors\.json/);
});

test('an id containing an underscore is refused, because it is the name separator', () => {
  // `agent__<id>__delegate` is split back apart on `__`, so an id with one in it
  // would make the published tool name ambiguous.
  const { vendors, problems } = parseVendorList('my_codex=codex');
  assert.equal(vendors.length, 0);
  assert.match(problems[0] ?? '', /no "_"/);
});

test('one bad entry does not take the others down', () => {
  const { vendors, problems } = parseVendorList('codex;nonsense;hermes');
  assert.deepEqual(
    vendors.map((vendor) => vendor.id),
    ['codex', 'hermes'],
  );
  assert.equal(problems.length, 1);
});

test('the file reader accepts a minimal entry and defaults the rest from the preset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(path, JSON.stringify({ vendors: [{ id: 'codex', preset: 'codex' }] }), 'utf8');
    const { vendors, problems } = readVendorConfigFile(path);
    assert.deepEqual(problems, []);
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0]?.command, 'codex');
    assert.equal(vendors[0]?.operator, 'OpenAI');
    assert.deepEqual(vendors[0]?.probeArgs, ['--version']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit command overrides the preset, and declared capabilities win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({
        vendors: [
          {
            id: 'boxed',
            preset: 'codex',
            command: '/opt/boxed/codex',
            args: ['exec', '-s', 'read-only'],
            label: 'Boxed Codex',
            capabilities: { reportsFiles: false, readOnlyEnforcement: 'sandbox' },
          },
        ],
      }),
      'utf8',
    );
    const { vendors, problems } = readVendorConfigFile(path);
    const vendor = vendors[0];
    // A command containing a path separator is resolved against the orchestrator,
    // not left relative — a relative path would resolve against the child's cwd,
    // which is the run's workspace.
    assert.equal(vendor?.command, resolve('/opt/boxed/codex'));
    assert.ok(
      problems.some((p) => p.includes('resolved to')),
      `the resolution must be reported: ${problems.join(' | ')}`,
    );
    assert.deepEqual(vendor?.args, ['exec', '-s', 'read-only']);
    assert.equal(vendor?.label, 'Boxed Codex');
    // Declared: the override wins.
    assert.equal(vendor?.capabilities.reportsFiles, false);
    // Explicitly declared here, so it stands: the operator asserted it.
    assert.equal(vendor?.capabilities.readOnlyEnforcement, 'sandbox');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an override that does not declare sandbox loses the preset\u2019s sandbox claim', () => {
  // `readOnlyEnforcement: 'sandbox'` means "the harness confines itself" and is
  // derived from the preset's own command line (Codex's `-s read-only`). An entry
  // that swaps the command is running something else, so inheriting the claim
  // would present an arbitrary program to the model as "pinned to a read-only
  // sandbox, so it cannot change any file" while the approval gate keyed off the
  // same field stayed open.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({
        vendors: [{ id: 'sneaky', preset: 'codex', command: 'my-thing' }],
      }),
      'utf8',
    );
    const { vendors, problems } = readVendorConfigFile(path);
    assert.equal(vendors[0]?.capabilities.readOnlyEnforcement, 'requested');
    assert.ok(
      problems.some((p) => p.includes('demoted')),
      `the demotion must be reported, not silent: ${problems.join(' | ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeping the preset command line keeps its sandbox claim', () => {
  // The ordinary case must be unaffected: an operator who only renames a preset
  // entry is still running the preset's sandboxed invocation.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({ vendors: [{ id: 'boxed', preset: 'codex', label: 'Just renamed' }] }),
      'utf8',
    );
    const { vendors, problems } = readVendorConfigFile(path);
    assert.equal(vendors[0]?.capabilities.readOnlyEnforcement, 'sandbox');
    assert.deepEqual(problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vendor with no preset and no command is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(path, JSON.stringify({ vendors: [{ id: 'mystery' }] }), 'utf8');
    const { vendors, problems } = readVendorConfigFile(path);
    assert.equal(vendors.length, 0);
    assert.match(problems[0] ?? '', /neither a "preset" nor a non-empty "command"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty probeArgs array is an opt-out, not an absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(path, JSON.stringify({ vendors: [{ id: 'boxed', preset: 'dsh', probeArgs: [] }] }), 'utf8');
    const { vendors } = readVendorConfigFile(path);
    // Distinguished from "absent", which would have defaulted to --version. A
    // harness with no cheap liveness command must be able to say so rather than
    // being reported unreachable while working perfectly.
    assert.deepEqual(vendors[0]?.probeArgs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a colour that is not a hex triple is dropped rather than passed to a shader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({
        vendors: [
          { id: 'plain', preset: 'codex', color: 'red' },
          { id: 'branded', preset: 'dsh', color: '#10a37f' },
        ],
      }),
      'utf8',
    );
    const { vendors } = readVendorConfigFile(path);
    assert.equal(vendors[0]?.color, undefined);
    assert.equal(vendors[1]?.color, '#10a37f');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate id keeps the first and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({ vendors: [{ id: 'first', preset: 'codex' }, { id: 'first', preset: 'dsh' }] }),
      'utf8',
    );
    const { vendors, problems } = readVendorConfigFile(path);
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0]?.command, 'codex');
    assert.match(problems[0] ?? '', /duplicate vendor id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed file is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(path, '{ not json', 'utf8');
    const { vendors, problems } = readVendorConfigFile(path);
    assert.equal(vendors.length, 0);
    assert.match(problems[0] ?? '', /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment list and the file are merged, and the file wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const path = join(dir, 'vendors.json');
    writeFileSync(
      path,
      JSON.stringify({ vendors: [{ id: 'codex', preset: 'codex', label: 'From the file' }] }),
      'utf8',
    );
    const env = { DEV3D_VENDORS: 'codex;hermes', DEV3D_VENDORS_CONFIG: path } as NodeJS.ProcessEnv;
    const { vendors, file, problems } = loadVendorConfig(env, dir);
    assert.deepEqual(problems, []);
    assert.equal(file, path);
    assert.deepEqual(
      vendors.map((vendor) => vendor.id),
      ['codex', 'hermes'],
    );
    // The file is the richer source, so it wins on a collision.
    assert.equal(vendors.find((vendor) => vendor.id === 'codex')?.label, 'From the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicitly named config file that is missing is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-vendors-'));
  try {
    const env = { DEV3D_VENDORS_CONFIG: join(dir, 'nope.json') } as NodeJS.ProcessEnv;
    const { problems } = loadVendorConfig(env, dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty DEV3D_VENDORS_CONFIG disables the file without complaining', () => {
  const env = { DEV3D_VENDORS_CONFIG: '', DEV3D_VENDORS: 'codex' } as NodeJS.ProcessEnv;
  const { vendors, file, problems } = loadVendorConfig(env, process.cwd());
  assert.deepEqual(problems, []);
  assert.equal(file, null);
  assert.equal(vendors.length, 1);
});

test('the shipped example file is valid and loads cleanly', () => {
  // A documented format whose own example does not parse is worse than no
  // example: the first thing an operator does is copy it. This pins that
  // `vendors.json.example` is real JSON the real reader accepts.
  const path = resolve(REPO_ROOT, 'vendors.json.example');
  assert.ok(existsSync(path), `vendors.json.example is missing at ${path}`);

  const { vendors, problems } = readVendorConfigFile(path);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    vendors.map((vendor) => vendor.id),
    ['codex', 'dsh', 'hermes', 'openclaw', 'local-agent'],
  );
  // Each preset keeps its documented enforcement level, because that is the claim
  // the panel repeats to an operator and the one most likely to be over-egged.
  assert.equal(vendors[0]?.capabilities.readOnlyEnforcement, 'sandbox');
  assert.equal(vendors[1]?.capabilities.readOnlyEnforcement, 'requested');
  assert.equal(vendors[3]?.capabilities.readOnlyEnforcement, 'client');
  assert.equal(vendors[3]?.transport, 'acp');
  assert.equal(vendors[4]?.enabled, false, 'the custom example must be off, or copying the file starts a process');
});

test('the grant policy defaults to delegate-roles, and both gates are on', () => {
  const policy = parseVendorGrantPolicy({} as NodeJS.ProcessEnv);
  assert.deepEqual(policy.grantRoles, ['delegate-roles']);
  assert.equal(policy.grantToDelegateRoles, true);
  assert.equal(policy.requireCanDelegate, true);
});

test('the grant policy understands every documented form', () => {
  const wildcard = parseVendorGrantPolicy({ DEV3D_VENDOR_GRANT_ROLES: '*' } as NodeJS.ProcessEnv);
  assert.deepEqual(wildcard.grantRoles, ['*']);
  assert.equal(wildcard.grantToDelegateRoles, false);

  const none = parseVendorGrantPolicy({ DEV3D_VENDOR_GRANT_ROLES: 'none' } as NodeJS.ProcessEnv);
  assert.deepEqual(none.grantRoles, []);

  const named = parseVendorGrantPolicy({ DEV3D_VENDOR_GRANT_ROLES: 'cto, dev-lead' } as NodeJS.ProcessEnv);
  assert.deepEqual(named.grantRoles, ['cto', 'dev-lead']);

  const relaxed = parseVendorGrantPolicy({
    DEV3D_VENDOR_GRANT_ROLES: '*',
    DEV3D_VENDOR_REQUIRE_CAN_DELEGATE: 'false',
  } as NodeJS.ProcessEnv);
  assert.equal(relaxed.requireCanDelegate, false);
});
