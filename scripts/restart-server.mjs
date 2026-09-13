#!/usr/bin/env node
/**
 * Restart the dev3d orchestrator.
 *
 * The orchestrator is normally started detached, with no window and its output
 * redirected to logs/, which is what makes it survive the session that started
 * it - and also what makes it hard to find later: it is an orphan with no
 * console, so "which terminal was that in" has no answer. This finds it the only
 * way that always works, by asking the operating system who holds the port, and
 * then starts a fresh one.
 *
 * `node src/index.ts` rather than the `tsx` on the dev script, on purpose. tsx
 * transforms through esbuild, which runs a helper process over a named pipe, and
 * a DSH-confined shell cannot open one - so `--import tsx` dies at startup with
 * `spawn EPERM` before the server ever loads. Node 24 strips types natively, and
 * this source is entirely erasable syntax, so plain node runs the same file with
 * no build step and no helper process.
 *
 * Usage:
 *   node scripts/restart-server.mjs           find, stop, start, verify
 *   node scripts/restart-server.mjs --dry-run report what it would stop
 *   node scripts/restart-server.mjs --port 9000
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Distinct capture files when several probes run in one process. */
let captureSeq = 0;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const ENTRY = join(SERVER_DIR, 'src', 'index.ts');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const portArg = args.indexOf('--port');
const port = portArg === -1 ? 8787 : Number(args[portArg + 1]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Not a usable port: ${args[portArg + 1]}`);
  process.exit(2);
}

const log = (message) => console.log(message);

/** `ss` and `netstat` spell the header differently and neither is guaranteed. */
function parseListeners(stdout, targetPort) {
  const pids = new Set();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!/LISTEN/i.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    // netstat:  TCP 127.0.0.1:8787 0.0.0.0:0 LISTENING <pid>  (pid last)
    // ss -lptn: LISTEN 0 511 127.0.0.1:8787 0.0.0.0:*  users:(("node",pid=1,fd=2))
    const localAddress = columns[1] ?? '';
    if (!localAddress.endsWith(`:${targetPort}`)) continue;
    const users = /pid=(\d+)/.exec(trimmed);
    if (users) {
      pids.add(Number(users[1]));
      continue;
    }
    const last = columns[columns.length - 1];
    if (/^\d+$/.test(last)) pids.add(Number(last));
  }
  return [...pids];
}

function run(command, commandArgs) {
  // The child's output goes to a temporary file rather than a pipe, and that is
  // not a style choice: a sandboxed shell cannot open the named pipe Node uses
  // for `stdio: 'pipe'`, so `execFile` fails with `spawn EPERM` before the tool
  // ever starts. A file descriptor is permitted, and it gets the same bytes.
  const capture = join(tmpdir(), `dev3d-listener-${process.pid}-${captureSeq++}.txt`);
  let fd;
  try {
    fd = openSync(capture, 'w');
  } catch {
    return null;
  }
  try {
    const result = spawnSync(command, commandArgs, { windowsHide: true, stdio: ['ignore', fd, fd] });
    // A tool this platform does not have is not an error, it is a missing answer.
    if (result.error !== undefined && result.error !== null) return null;
    return readFileSync(capture, 'utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
    rmSync(capture, { force: true });
  }
}

/**
 * Who is listening, asked of whichever tool this platform actually has.
 *
 * Nothing here is treated as fatal: a missing tool means "no answer", not "no
 * listener", and the caller gets told which it was.
 */
async function listenersOn(targetPort) {
  const attempts = [
    ['netstat', ['-ano']],
    ['ss', ['-lptn']],
    ['lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN']],
  ];
  for (const [command, commandArgs] of attempts) {
    const stdout = run(command, commandArgs);
    if (stdout === null) continue;
    const pids = parseListeners(stdout, targetPort);
    // lsof prints no PID column in the shape above; fall back to its own field.
    if (pids.length === 0 && command === 'lsof') {
      for (const line of stdout.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length > 1 && /^\d+$/.test(fields[1])) pids.push(Number(fields[1]));
      }
    }
    if (pids.length === 0) continue;
    return { tool: command, pids };
  }
  return { tool: null, pids: [] };
}

async function health(attempts = 1) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return await response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  return null;
}

function stop(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (error) {
    log(`  could not signal pid ${pid}: ${error.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

const before = await health(1);
if (before !== null) {
  log(`orchestrator is up on ${port} (uptime ${Math.round(before.uptimeMs / 1000)}s, configStale=${before.configStale})`);
} else {
  log(`nothing is answering on ${port}`);
}

const found = await listenersOn(port);
if (found.tool === null) {
  log('could not ask this platform who holds the port; if the start fails, a stale listener owns it');
} else if (found.pids.length === 0) {
  log(`no listener on ${port} (via ${found.tool})`);
} else {
  log(`listening on ${port}: pid ${found.pids.join(', ')} (via ${found.tool})`);
}

if (dryRun) {
  log('--dry-run: nothing was stopped or started');
  process.exit(0);
}

for (const pid of found.pids) {
  if (pid === process.pid) continue;
  log(`stopping pid ${pid}`);
  stop(pid);
}

// Wait for the port to actually come free rather than assuming the signal was
// instant. A second listener starting on a port still held is the one failure
// this whole script exists to prevent.
for (let i = 0; i < 20; i += 1) {
  const check = await listenersOn(port);
  if (check.pids.length === 0) break;
  await sleep(250);
}

const logsDir = join(REPO_ROOT, 'logs');
mkdirSync(logsDir, { recursive: true });
const outPath = join(logsDir, 'dev3d-server.out.log');
const errPath = join(logsDir, 'dev3d-server.err.log');
const out = openSync(outPath, 'w');
const err = openSync(errPath, 'w');

const child = spawn(process.execPath, [ENTRY], {
  cwd: SERVER_DIR,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', out, err],
});
closeSync(out);
closeSync(err);
child.unref();

log(`started pid ${child.pid}; waiting for ${port}`);
log(`  stdout: ${outPath}`);
log(`  stderr: ${errPath}`);

const after = await health(30);
if (after === null) {
  console.error(`\nthe server did not answer on ${port} within 15s. Last lines of stderr:`);
  process.exitCode = 1;
} else {
  log(`\nup: mode=${after.llmMode} version=${after.version} configStale=${after.configStale}`);
  if (String(after.configStaleDetail ?? '') !== '') log(`  ${after.configStaleDetail}`);
}
