/**
 * Mode resolution, and the reason given for it.
 *
 * The reason is not decoration. The office used to log "no provider keys found"
 * whenever it was in mock mode, including when mock had been *forced* while keys
 * were plainly present - which sent an operator looking for a configuration bug
 * that did not exist. These tests exist so that message can never regress into a
 * guess again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from './config.ts';
import { detectConfigDrift, loadConfig } from './config.ts';

/** Run `loadConfig` with the environment it cares about, and restore after. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const keys = ['DEV3D_LLM_MODE', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'DEV3D_LOCAL_BASE_URL', 'DEV3D_LOCAL_API_KEY'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --------------------------------------------------------------- resolution

test('auto with a key resolves to live and names the provider', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'auto', DEEPSEEK_API_KEY: 'sk-x' }, loadConfig);
  assert.equal(config.llmMode, 'live');
  assert.match(config.llmModeReason, /auto/);
  assert.match(config.llmModeReason, /deepseek/);
  assert.deepEqual(config.configuredProviderIds, ['deepseek']);
});

test('auto with several keys names all of them, with the right verb', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'auto', DEEPSEEK_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }, loadConfig);
  assert.equal(config.llmMode, 'live');
  assert.match(config.llmModeReason, /deepseek, openrouter are configured/);
});

test('auto with no key at all resolves to mock and says so truthfully', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'auto' }, loadConfig);
  assert.equal(config.llmMode, 'mock');
  assert.match(config.llmModeReason, /no provider key or keyless base URL was found/);
  assert.deepEqual(config.configuredProviderIds, []);
});

test('an unset mode behaves as auto', () => {
  const config = withEnv({ DEV3D_LLM_MODE: undefined, DEEPSEEK_API_KEY: 'sk-x' }, loadConfig);
  assert.equal(config.llmModeSetting, 'auto');
  assert.equal(config.llmMode, 'live');
});

// ------------------------------------------ the message that used to be false

test('mock forced with keys present says so, and does not claim no keys were found', () => {
  // The exact regression this guards: the office reported "no provider keys
  // found" while `/api/providers` showed the provider as configured.
  const config = withEnv({ DEV3D_LLM_MODE: 'mock', DEEPSEEK_API_KEY: 'sk-x', OPENROUTER_API_KEY: 'sk-y' }, loadConfig);
  assert.equal(config.llmMode, 'mock');
  assert.match(config.llmModeReason, /forces scripted employees/);
  assert.match(config.llmModeReason, /even though deepseek, openrouter are configured/);
  assert.doesNotMatch(
    config.llmModeReason,
    /no provider key/i,
    'the reason must never claim no keys were found when keys were found',
  );
});

test('mock forced with no keys says only that it was forced', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'mock' }, loadConfig);
  assert.equal(config.llmMode, 'mock');
  assert.match(config.llmModeReason, /forces scripted employees/);
  assert.doesNotMatch(config.llmModeReason, /even though/);
});

test('live forced with no provider warns that every turn will fail', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'live' }, loadConfig);
  assert.equal(config.llmMode, 'live');
  assert.match(config.llmModeReason, /no provider is configured/);
  assert.match(config.llmModeReason, /every turn will fail/);
});

test('an unrecognised mode falls back to auto rather than guessing', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'AUTO', DEEPSEEK_API_KEY: 'sk-x' }, loadConfig);
  assert.equal(config.llmModeSetting, 'auto');
  assert.equal(config.llmMode, 'live');
});

test('a keyless local base URL counts as configured, so auto goes live', () => {
  const config = withEnv({ DEV3D_LLM_MODE: 'auto', DEV3D_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1' }, loadConfig);
  assert.equal(config.llmMode, 'live');
  assert.match(config.llmModeReason, /local/);
});

// -------------------------------------------------------------------- drift
//
// Every drift check runs *inside* the `withEnv` scope that built the config.
// Constructing the config under one environment and checking it under another
// makes `withEnv`'s restore look exactly like a key appearing, which is a
// realistic enough situation that the detector reports it - so the harness has
// to keep both halves in the same world.

test('a freshly read environment is not stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-cfg-'));
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'DEV3D_LLM_MODE=auto\n', 'utf8');
    const drift = withEnv({}, () => {
      const config: ServerConfig = { ...loadConfig(), envFilePath: path, envFileMtimeMs: statSync(path).mtimeMs };
      return detectConfigDrift(config);
    });
    assert.equal(drift.stale, false);
    assert.equal(drift.detail, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a .env modified after startup is reported as stale, with the remedy', () => {
  // This is precisely the situation that looked like a bug: the file is read
  // once, so editing it does nothing and nothing says so.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-cfg-'));
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'DEV3D_LLM_MODE=auto\n', 'utf8');
    // Backdate the file so its real mtime is clearly past the recorded value.
    const past = new Date(Date.now() - 60_000);
    utimesSync(path, past, past);

    const drift = withEnv({}, () => {
      const config: ServerConfig = { ...loadConfig(), envFilePath: path, envFileMtimeMs: 1_000_000 };
      return detectConfigDrift(config);
    });
    assert.equal(drift.stale, true);
    assert.match(drift.detail ?? '', /\.env has been modified since this process started/);
    assert.match(drift.detail ?? '', /restart the orchestrator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key that appeared since startup is reported, for a shell export', () => {
  // The other way to change the answer: a key exported in a shell rather than
  // written to .env, which the file mtime cannot see.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-cfg-'));
  try {
    const drift = withEnv({ OPENROUTER_API_KEY: 'sk-appeared' }, () => {
      // Recorded as unconfigured at boot, with no .env to watch.
      const base = loadConfig();
      const config: ServerConfig = {
        ...base,
        configuredProviderIds: [],
        envFilePath: join(dir, 'missing.env'),
        envFileMtimeMs: null,
      };
      return detectConfigDrift(config);
    });
    assert.equal(drift.stale, true);
    assert.match(drift.detail ?? '', /OPENROUTER_API_KEY is now set for 'openrouter'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider that was already configured is not reported as drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-cfg-'));
  try {
    const drift = withEnv({ DEV3D_LLM_MODE: 'auto', DEEPSEEK_API_KEY: 'sk-x' }, () => {
      const config: ServerConfig = {
        ...loadConfig(),
        envFilePath: join(dir, 'missing.env'),
        envFileMtimeMs: null,
      };
      return detectConfigDrift(config);
    });
    assert.equal(drift.stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing .env is not itself treated as drift', () => {
  // A keyless install with no .env at all is a normal, supported state.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-cfg-'));
  try {
    const drift = withEnv({}, () => {
      const config: ServerConfig = {
        ...loadConfig(),
        envFilePath: join(dir, 'nope.env'),
        envFileMtimeMs: null,
      };
      return detectConfigDrift(config);
    });
    assert.equal(drift.stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
