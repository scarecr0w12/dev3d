/**
 * Ending a child process, and the tree it started.
 *
 * `child.kill('SIGKILL')` is a promise about *one* process. On Windows the direct
 * child of `shell: true` is `cmd.exe`, and killing `cmd.exe` leaves whatever it
 * started running: `start /B thing.exe`, a background service, a build watcher.
 * That is the half of the problem this module fixes on Windows with
 * `taskkill /T /F`, which walks and ends the pid tree.
 *
 * The other half cannot be fixed by any kill, and is why callers also need a hard
 * deadline: a surviving grandchild **inherits the parent's stdout and stderr
 * pipes**, so `close` never fires even after the direct child is gone. A tool that
 * waits for `close` to settle therefore waits forever while reporting a timeout it
 * has already decided on.
 *
 * ## On POSIX
 *
 * There is no portable tree kill. `process.kill(-pid)` would signal the *process
 * group*, and a child spawned without `detached: true` shares the orchestrator's
 * own group — so that call would kill the office instead. Doing it properly means
 * spawning detached (which changes who reaps the child and who dies with the
 * parent) or a cgroup/PID namespace, and neither belongs in a tool call. So POSIX
 * gets a direct kill and this paragraph, rather than a fix that pretends.
 */

import { spawn } from 'node:child_process';

/** The slice of a child process this module needs. */
export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export type KillTreeFn = (child: KillableChild) => void;

/**
 * End a child and, on Windows, everything it started. Never throws.
 *
 * Best-effort by design: it is called from a timeout handler and from an abort
 * listener, where throwing would replace a reported failure with an unhandled
 * one. A process that is already gone is the common case and not an error.
 */
export function killProcessTree(child: KillableChild): void {
  const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;

  if (process.platform === 'win32' && pid !== null) {
    try {
      // `stdio: 'ignore'` deliberately, and not only for tidiness: a sandboxed
      // shell cannot open the named pipes a piped child needs, so a version of
      // this that captured taskkill's output would fail with EPERM on exactly the
      // machines where the tree kill matters.
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        /* taskkill missing or refused; the direct kill below is the backstop */
      });
      killer.unref?.();
    } catch {
      /* fall through to the direct kill */
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}
