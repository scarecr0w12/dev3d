/**
 * Tests for the vendor registry: probing, status, and running a delegation.
 *
 * Everything here goes through the injected `spawnFn`, so no process is started
 * and the suite runs on a machine that forbids piped child stdio.
 *
 * The assertions that matter most are about **status honesty**. A registry that
 * reports a harness as on site before checking, or that leaves a working one
 * marked unreachable forever, produces a console that lies - and a console that
 * lies about whether an external process is installed is worse than one that says
 * nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { VendorRegistry, parseVendorToolName, vendorToolName, withReadOnlyInstruction } from './registry.ts';
import type { VendorConfig } from './config.ts';
import { FakeChild, childThatFails, childThatHangs, childThatSucceeds, spawnEach } from './testing.ts';
import type { SpawnCall } from './testing.ts';

function config(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    id: 'codex',
    label: 'Codex',
    operator: 'OpenAI',
    transport: 'command',
    command: 'codex',
    args: ['exec', '--json'],
    promptTransport: 'argv',
    outputFormat: 'text',
    probeArgs: ['--version'],
    timeoutMs: 5_000,
    enabled: true,
    capabilities: { readOnlyEnforcement: 'sandbox', reportsFiles: false, streams: false, reportsCost: false },
    ...overrides,
  };
}

/**
 * A read-only instruction is prepended by the office, not left to the model.
 *
 * The regression this pins: `config.ts` and the tool description both said a
 * `requested`-enforcement vendor "is asked to work read-only", but nothing on the
 * delegation path ever asked — the prompt was exactly the model-authored task. So
 * the only thing that had asked was the model, and nothing guaranteed it did.
 */
test('a requested vendor is actually told to work read-only', () => {
  const task = 'summarise the routing module';
  const asked = withReadOnlyInstruction(task, 'requested');
  assert.match(asked, /read-only contractor/);
  assert.match(asked, /Do not create, modify, rename or delete/);
  // The instruction is fixed and comes first; the task is appended verbatim.
  assert.ok(asked.indexOf('read-only contractor') < asked.indexOf(task));
  assert.ok(asked.endsWith(task), 'the model-authored task must survive unchanged');

  // A harness with its own enforced sandbox needs no advisory sentence, and one
  // the office mediates itself already refuses writes.
  assert.equal(withReadOnlyInstruction(task, 'sandbox'), task);
  assert.equal(withReadOnlyInstruction(task, 'client'), task);
});

test('the read-only instruction reaches the vendor prompt', async () => {
  const { spawnFn, calls } = spawnEach(() => childThatSucceeds('read it'));
  const registry = new VendorRegistry(
    [
      config({
        id: 'asked',
        command: 'dsh',
        args: [],
        capabilities: {
          readOnlyEnforcement: 'requested',
          reportsFiles: false,
          streams: false,
          reportsCost: false,
        },
      }),
    ],
    { log: recorder().log, spawnFn },
  );
  await registry.start();
  calls.length = 0;
  await registry.delegate('asked', { task: 'read the router', cwd: '/workspace' });

  const spawned = calls[calls.length - 1];
  assert.ok(spawned, 'the vendor was started');
  // `promptTransport: 'argv'` appends the prompt as one argument, so the whole
  // thing must be there — instruction first, task last.
  const prompt = spawned.args[spawned.args.length - 1] ?? '';
  assert.match(prompt, /read-only contractor/, 'the office asks, not the model');
  assert.ok(prompt.endsWith('read the router'), `the task must survive: ${prompt}`);
});

/** A logger that keeps what it was told, so a warning can be asserted on. */
function recorder(): {
  log: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    log: (level, scope, message) => {
      lines.push(`${level} ${scope} ${message}`);
    },
  };
}

test('a vendor is not claimed to be on site before it has been checked', () => {
  // Optimism here would draw a green terminal for a harness that is not
  // installed, and the first delegation would then fail in a way the operator had
  // already been told could not happen.
  const registry = new VendorRegistry([config()], { log: recorder().log });
  const [state] = registry.states();
  assert.equal(state?.status, 'unreachable');
  assert.equal(state?.detail, 'not yet checked');
  assert.equal(registry.isAvailable('codex'), false);
});

test('a successful probe docks the vendor, and keeps the version it reported', async () => {
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatSucceeds('codex-cli 1.2.3\nextra noise')),
  });
  await registry.start();

  const [state] = registry.states();
  assert.equal(state?.status, 'docked');
  // The version line is the one fact that says which build of a fast-moving
  // harness an operator is actually driving.
  assert.equal(state?.detail, 'codex-cli 1.2.3');
  assert.equal(registry.isAvailable('codex'), true);
});

test('a probe that fails marks the vendor unreachable, with the reason', async () => {
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatFails('bash: codex: command not found', 127)),
  });
  await registry.start();

  const [state] = registry.states();
  assert.equal(state?.status, 'unreachable');
  assert.match(state?.detail ?? '', /command not found/);
});

test('a vendor with no liveness command is docked without running anything', async () => {
  const calls: unknown[] = [];
  const registry = new VendorRegistry([config({ probeArgs: [] })], {
    log: recorder().log,
    spawnFn: (command, args, opts) => {
      calls.push([command, args, opts]);
      return childThatSucceeds('');
    },
  });
  await registry.start();

  const [state] = registry.states();
  assert.equal(state?.status, 'docked');
  assert.match(state?.detail ?? '', /not probed/);
  // Nothing was spawned: an empty probe list is an opt-out, not a default.
  assert.equal(calls.length, 0);
});

test('a switched-off vendor is off site and is never probed', async () => {
  const calls: unknown[] = [];
  const registry = new VendorRegistry([config({ enabled: false })], {
    log: recorder().log,
    spawnFn: (command, args, opts) => {
      calls.push([command, args, opts]);
      return childThatSucceeds('');
    },
  });
  await registry.start();

  const [state] = registry.states();
  assert.equal(state?.status, 'offsite');
  assert.equal(state?.detail, 'switched off by the operator');
  assert.equal(calls.length, 0);
});

test('a delegation returns the answer and counts itself', async () => {
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatSucceeds('the session lookup derefs null at session.ts:41')),
  });
  await registry.start();

  const before = registry.states()[0];
  assert.equal(before?.engagements, 0);

  const result = await registry.delegate('codex', { task: 'find the bug', cwd: '/workspace' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'the session lookup derefs null at session.ts:41');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.parsed, false);

  const after = registry.states()[0];
  assert.equal(after?.engagements, 1);
  assert.equal(after?.activity, null, 'a vendor that has finished is not still doing something');
  assert.equal(after?.status, 'docked');
});

test('the vendor runs in the workspace it was given, not in the office', async () => {
  const { spawnFn, calls } = spawnEach(() => childThatSucceeds('ok'));
  const registry = new VendorRegistry([config()], { log: recorder().log, spawnFn });
  await registry.start();

  await registry.delegate('codex', { task: 'look around', cwd: '/srv/projects/portal' });
  // The last call is the delegation; the first was the probe.
  assert.equal(calls.at(-1)?.options['cwd'], '/srv/projects/portal');
  assert.equal(calls.at(-1)?.args.at(-1), 'look around');
});

test('a failing delegation is reported, recorded, and leaves a reason on the vendor', async () => {
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatFails('error: not authenticated', 2)),
  });
  await registry.start();

  const result = await registry.delegate('codex', { task: 'find the bug', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.match(result.text, /not authenticated/);

  const [state] = registry.states();
  assert.equal(state?.status, 'errored');
  assert.match(state?.lastError ?? '', /not authenticated/);
  // A failed attempt is not an engagement: counting it would inflate the tally
  // an operator reads as "what this vendor has actually done for us".
  assert.equal(state?.engagements, 0);
});

test('a vendor that exits cleanly with nothing to say is a failure, not an empty answer', async () => {
  // A wrong argument list does exactly this, and reporting it as a successful
  // empty result would send the model looking for an answer that was never made.
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatSucceeds('')),
  });
  await registry.start();

  const result = await registry.delegate('codex', { task: 'anything', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.match(result.text, /produced no output/);
});

test('a delegation that times out is a failure with the ceiling in the message', async () => {
  const registry = new VendorRegistry([config({ timeoutMs: 30 })], {
    log: recorder().log,
    // Short, so the probe that also hangs does not hold the suite for its default
    // ten seconds.
    probeTimeoutMs: 30,
    ...spawnEach(() => childThatHangs()),
  });
  await registry.start();

  // The probe hangs too, so the office never claims it is up - which is correct,
  // and is not what this test is about. Delegating still tries, deliberately.
  const result = await registry.delegate('codex', { task: 'anything', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'timeout');
  assert.match(result.text, /did not finish within/);
});

test('a caller may lower the ceiling but never raise it', async () => {
  const { spawnFn } = spawnEach(() => childThatHangs());
  const registry = new VendorRegistry([config({ timeoutMs: 40 })], {
    log: recorder().log,
    spawnFn,
    probeTimeoutMs: 30,
  });
  await registry.start();

  // Asking for an hour against a 40 ms vendor: the vendor's own ceiling is what
  // an operator decided this harness may consume, and a model choosing its
  // timeout must not be able to raise it.
  const result = await registry.delegate('codex', {
    task: 'anything',
    cwd: '/workspace',
    timeoutMs: 3_600_000,
  });
  assert.equal(result.outcome, 'timeout');
  assert.match(result.text, /within 40ms/);
});

test('a second delegation to the same vendor is refused while the first is running', async () => {
  // A harness is a subscription with a rate limit and one machine behind it, and
  // two concurrent runs would share its session store and its quota.
  const child = childThatHangs();
  const registry = new VendorRegistry([config()], { log: recorder().log, ...spawnEach(() => child) });
  // Not probed: `start` would hang on the same fake, so the vendor is left in its
  // initial state and the delegation is what this exercises.
  const first = registry.delegate('codex', { task: 'long job', cwd: '/workspace', timeoutMs: 5 });

  const second = await registry.delegate('codex', { task: 'another job', cwd: '/workspace' });
  assert.equal(second.ok, false);
  assert.match(second.text, /already working on something/);

  await first;
});

test('a delegation to a vendor that is not configured is refused by name', async () => {
  const registry = new VendorRegistry([config()], { log: recorder().log });
  const result = await registry.delegate('hermes', { task: 'anything', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.match(result.text, /no vendor named "hermes"/);
});

test('a delegation to a switched-off vendor is refused, and says it is a decision', async () => {
  const registry = new VendorRegistry([config({ enabled: false })], { log: recorder().log });
  const result = await registry.delegate('codex', { task: 'anything', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.match(result.text, /switched off/);
});

test('a delegation with no task text is refused rather than sent', async () => {
  const registry = new VendorRegistry([config()], { log: recorder().log });
  const result = await registry.delegate('codex', { task: '   \n ', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.match(result.text, /no task text/);
});

test('a successful delegation clears an earlier failure', async () => {
  // The self-healing half of the design: a vendor marked unreachable at boot
  // becomes docked the moment a real run succeeds, without anybody re-checking.
  let child: FakeChild = childThatFails('not installed', 127);
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    spawnFn: () => child,
  });
  await registry.start();
  assert.equal(registry.states()[0]?.status, 'unreachable');

  child = childThatSucceeds('it works after all');
  const result = await registry.delegate('codex', { task: 'anything', cwd: '/workspace' });

  assert.equal(result.ok, true);
  const [state] = registry.states();
  assert.equal(state?.status, 'docked');
  assert.equal(state?.lastError, null);
});

test('the published tool name round-trips, and refuses anything else', () => {
  assert.equal(vendorToolName('codex'), 'agent__codex__delegate');
  assert.deepEqual(parseVendorToolName('agent__codex__delegate'), { vendorId: 'codex' });
  assert.deepEqual(parseVendorToolName('agent__my-codex__delegate'), { vendorId: 'my-codex' });

  // Not a vendor tool, or not a vendor tool we publish.
  assert.equal(parseVendorToolName('mcp__fs__read_file'), null);
  assert.equal(parseVendorToolName('agent__codex__something-else'), null);
  assert.equal(parseVendorToolName('agent__delegate'), null);
  assert.equal(parseVendorToolName('agent____delegate'), null);
  assert.equal(parseVendorToolName('read_file'), null);
});

test('the console is told the command, with a placeholder rather than a past task', async () => {
  const registry = new VendorRegistry([config()], {
    log: recorder().log,
    ...spawnEach(() => childThatSucceeds('ok')),
  });
  await registry.start();
  await registry.delegate('codex', { task: 'a secret task nobody else should read', cwd: '/workspace' });

  const shown = registry.states()[0]?.command ?? '';
  assert.match(shown, /^codex exec --json "<task>"$/);
  assert.doesNotMatch(shown, /secret task/);
});

test('all three enforcement levels travel, and are kept distinct', () => {
  // The distinction the whole feature rests on. Three levels rather than two,
  // because "dev3d refuses the write path" is neither "the harness sandboxes
  // itself" nor "nothing enforces it" - and collapsing the middle case into
  // either neighbour would misdescribe what an operator is trusting.
  const registry = new VendorRegistry(
    [
      config({ id: 'boxed', capabilities: { readOnlyEnforcement: 'sandbox', reportsFiles: true, streams: true, reportsCost: false } }),
      config({ id: 'protocol', capabilities: { readOnlyEnforcement: 'client', reportsFiles: true, streams: true, reportsCost: false } }),
      config({ id: 'asked', capabilities: { readOnlyEnforcement: 'requested', reportsFiles: false, streams: false, reportsCost: false } }),
    ],
    { log: recorder().log },
  );

  const levels = registry.states().map((vendor) => vendor.capabilities.readOnlyEnforcement);
  assert.deepEqual(levels, ['sandbox', 'client', 'requested']);
  // All three differ. A field that could not tell two of these apart would be
  // unable to say which one an operator actually has.
  assert.equal(new Set(levels).size, 3);
});

test('toolNames offers one grantable name per vendor, and only those', () => {
  const registry = new VendorRegistry([config({ id: 'codex' }), config({ id: 'hermes' })], {
    log: recorder().log,
  });
  assert.deepEqual(registry.toolNames(), ['agent__codex__delegate', 'agent__hermes__delegate']);
  assert.deepEqual(registry.ids(), ['codex', 'hermes']);
});

/**
 * A fake child that answers Agent Client Protocol requests on its stdout.
 *
 * This is what makes the registry→ACP *dispatch* testable rather than only the
 * protocol logic: it exercises the real path — registry, `runAcpTurn`,
 * `StdioTransport`, newline framing on the child's pipes — so a wiring mistake
 * (the wrong argument list, a transport kind read from the wrong field) cannot
 * hide behind a hand-injected wire.
 */
function acpChild(): FakeChild {
  const child = new FakeChild({ stdin: true });
  const send = (message: unknown): void => {
    queueMicrotask(() => child.stdout?.emit('data', `${JSON.stringify(message)}\n`));
  };
  child.stdin!.onWrite = (chunk) => {
    for (const line of chunk.split('\n')) {
      const text = line.trim();
      if (text === '' || text[0] !== '{') continue;
      const message = JSON.parse(text) as { id?: unknown; method?: string };
      if (message.id === undefined) continue;
      const id = message.id as number;
      if (message.method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      else if (message.method === 'session/new') send({ jsonrpc: '2.0', id, result: { sessionId: 'sess_1' } });
      else if (message.method === 'session/prompt') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess_1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answered over the wire' } },
          },
        });
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }
    }
  };
  return child;
}

test('an ACP vendor is delegated over the protocol, not run as a one-shot command', async () => {
  const calls: SpawnCall[] = [];
  const registry = new VendorRegistry(
    // `probeArgs: []` is the documented opt-out, and it is the honest one here: an
    // ACP bridge has no meaningful `--version` answer, and probing it would spend
    // ten seconds learning nothing.
    [config({ id: 'openclaw', transport: 'acp', args: ['acp'], probeArgs: [] })],
    { log: recorder().log, ...spawnEach(() => acpChild(), calls) },
  );
  await registry.start();

  const result = await registry.delegate('openclaw', { task: 'find the bug', cwd: '/workspace' });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.text, 'answered over the wire');
  assert.equal(result.outcome, 'ok');
  // Parsed, because the answer came out of a protocol rather than off stdout.
  assert.equal(result.parsed, true);
  // The probe is one spawn and the delegation is another; the second is the turn.
  assert.equal(calls.at(-1)?.args.at(-1), 'acp', 'the configured command line reaches the child unchanged');
});

test('an ACP vendor that cannot be started is reported, and the tally stays honest', async () => {
  const registry = new VendorRegistry([config({ id: 'openclaw', transport: 'acp' })], {
    log: recorder().log,
    probeTimeoutMs: 30,
    // The failure is raised *at spawn time*, not at construction: the transport
    // attaches its listeners synchronously after this returns, so an error
    // emitted any earlier would be dropped and the start would time out instead.
    spawnFn: () => {
      const child = new FakeChild({ stdin: true });
      child.failToStart('ENOENT', 'spawn openclaw ENOENT');
      return child;
    },
  });
  await registry.start();

  const result = await registry.delegate('openclaw', { task: 'anything', cwd: '/workspace' });
  assert.equal(result.ok, false);
  assert.match(result.text, /ENOENT/);

  const [state] = registry.states();
  assert.equal(state?.status, 'errored');
  assert.equal(state?.engagements, 0, 'a failed turn is not an engagement');
});

test('a command vendor and an ACP vendor can sit in the same bay', async () => {
  // The dispatch is per vendor, not global: mixing transports must not make one
  // of them read the other's config.
  const spawn = spawnEach(() => {
    // One factory per vendored kind, chosen by the arguments the registry passes.
    return childThatSucceeds('command answer');
  });
  const registry = new VendorRegistry(
    [
      config({ id: 'codex', transport: 'command' }),
      config({ id: 'openclaw', transport: 'acp' }),
    ],
    { log: recorder().log, ...spawn },
  );

  // The command vendor runs fine; the ACP one is handed a child that speaks no
  // protocol and cannot start, which must surface as that vendor's problem only.
  const commandResult = await registry.delegate('codex', { task: 'task', cwd: '/workspace' });
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.text, 'command answer');
  assert.equal(commandResult.parsed, false, 'a command vendor reads stdout, not a protocol');
});
