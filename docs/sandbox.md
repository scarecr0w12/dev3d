# Running dev3d in a restricted environment

Most of dev3d runs anywhere Node 24 runs. A few tools need to spawn child
processes with piped stdio, and a sandbox that forbids that will stop them —
usually with a bare `spawn EPERM` that says nothing about which tool broke or
why.

This document names the tools that need more room, gives the commands that work
without it, and explains the one case (headless Chrome) where the failure is a
kernel-level restriction rather than a missing permission.

Outside a sandbox, none of this applies: `pnpm install`, `pnpm dev`, `pnpm test`
and `vite build` behave normally.

---

## What needs a wider sandbox

Three tools fail when child processes with piped stdio are blocked:

- **`pnpm`, for anything** — including `pnpm exec tsc` and `pnpm test`. It spawns
  children for dependency checks and for dependency build scripts.
- **`tsx`, and `node --test` in its default isolated mode** — `tsx` runs esbuild's
  service worker, and isolated test mode spawns one child per test file.
- **`vite`** — `vite dev` and `vite build` both die while loading their config,
  because esbuild spawns a service worker to bundle it.

Two runtime features need the same permission, and degrade honestly without it:

- **`run_shell`** reports the command as failed rather than pretending it ran.
- **MCP servers over stdio** cannot be spawned, so they appear in Settings → MCP
  as `failed` with `spawn EPERM`. The office itself is unaffected. A server
  reached over Streamable HTTP is not a child process and does not need this.

## Commands that work without it

Each direct invocation below avoids the child process that the wrappers need.
This is why they are all in `package.json` as scripts.

```bash
# typecheck, instead of `pnpm typecheck`
node apps/server/node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node apps/web/node_modules/typescript/bin/tsc    -p apps/web/tsconfig.json --noEmit
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit

# the suites, instead of `pnpm test`
cd apps/server && node --test --test-isolation=none "src/**/*.test.ts"
cd packages/core && node --test --test-isolation=none "src/**/*.test.ts"

# the server, instead of `tsx watch`
node apps/server/src/index.ts

# the client store reducer, instead of compiling to CommonJS first
node apps/web/.verify/smoke.ts
```

`--test-isolation=none` is also what makes the suites run TypeScript directly,
with no build step, so it is not merely a sandbox workaround.

A production bundle has no equivalent that avoids esbuild: `pnpm build` and
`vite build` both need the wider mode.

## The one skipped test

One server test asserts that an approved `run_shell` actually executes a command.
It needs a piped child process, so under a sandbox that blocks one it reports
itself as **skipped, with that reason**, rather than failing. It still runs, and
still has to pass, anywhere child processes are allowed.

That is why the suite reads `415 tests — 411 pass, 4 skipped`.

## Headless Chrome

Rendering the UI to a screenshot needs `scripts/screenshot.ps1`, and Chrome needs
more room than the other tools — for a different reason. Chrome's Mojo IPC creates
a named pipe and needs write access to its client end. A Windows sandbox that
restricts the process token with a restricting SID denies that open, so Chrome dies
before it paints:

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108  Check failed: . : Access is denied. (0x5)
```

This is **not** a normal Windows permission problem: the token is Medium
integrity — an ordinary token — and the restriction is the added SID. Approving an
escalation, or running it from a terminal outside the sandbox, makes Chrome render
normally.

The same restriction is what blocks piped stdio capture for grandchild
processes, because libuv's pipe stdio is implemented with named pipes.

### Two traps `screenshot.ps1` exists to avoid

- **Do not pipe a native command's output** (`& chrome … > file`). In this
  situation that yields no output at all and an empty exit code, which looks
  exactly like a silent failure. The script uses
  `Start-Process -RedirectStandardOutput` instead.
- **Use a fresh `--user-data-dir` on every run.** Otherwise Chrome may hand the
  request to an already-running browser and exit without doing any work.

```powershell
.\scripts\screenshot.ps1                                   # http://127.0.0.1:8787/
.\scripts\screenshot.ps1 -Out .\shot.png -DumpDom          # also dump the DOM
```

## Blender

The asset scripts are run by Blender itself, headless, and need no network:

```bash
blender --background --factory-startup --python blender/scripts/02_office_blocks.py
```

`pnpm preview:blocks` wraps this and resolves the Blender binary for you; see
[development.md](development.md#the-blender-asset-pipeline) for the pipeline
itself and the ordering constraint between the scripts.

`02_office_blocks.py` writes `blocks.json` directly when Blender runs it, and
prints the same document as `BLOCKS_JSON=…` when it cannot. A bridge that
withholds `open` is the reason for the second path: the printed copy is the
sidecar of record there.
