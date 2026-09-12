# Development

This document is the contributor's companion to `README.md`. It carries the
material a user-facing README should not: how the repository is laid out, how to
run the verification suite and pre-release checks, how the Blender asset pipeline
is ordered, and how the UI is screenshotted in a specific state. If you only want
to run dev3d, read the README instead.

---

## Getting set up for development

**Node 24 or newer, and this is a real requirement rather than a preference.**
Two things need it: `node --test --test-isolation=none`, which the suites use to
run TypeScript directly without a build step, and the unflagged `node:sqlite`
that persistence is built on. On Node 22 the *server* runs but `pnpm test` does
not, which is the worst of both — you would be running an untested tree. CI
checks this: the test suite is executed on a real runner, not just typechecked.

```bash
pnpm install                 # Node >= 24
cp .env.example .env         # optional: add provider keys for live models

pnpm dev:server              # orchestrator on http://127.0.0.1:8787
pnpm dev:web                 # office UI on http://127.0.0.1:5273 (proxies /api and /ws)
```

### Repository layout

```
packages/core      Shared contracts. No network, no filesystem, no React.
                   Both the orchestrator and the UI compile against exactly
                   these types, which is what keeps the wire protocol honest.
                   model.ts, skill.ts, org.ts, run.ts, style.ts, events.ts

apps/server        The orchestrator.
  config.ts        Env-driven configuration; mock/live resolution.
  llm/             Provider adapters (OpenAI-compatible, Anthropic, mock),
                   discovery, the curated catalog, pooled quality, uptime,
                   and the fail-over registry.
  router/          Cost-aware model selection.
  skills/          Skill markdown loader, index, and per-turn selection.
  tools/           The 14 built-in tools, all confined to the workspace root.
  mcp/             MCP client: JSON-RPC, the stdio and HTTP transports, and the
                   manager that publishes remote tools into the registry.
  org/             The shipped company and its pipelines.
  engine/          complexity -> prompt -> turn -> stage -> run.
  store/           SQLite persistence (node:sqlite), with a memory fallback.
  server/          Runtime: org chart, roster, approvals, event fan-out.
  index.ts         HTTP + WebSocket entry point.

apps/web           The office UI (React 18 + three.js): the client store, the
                   office and floor model, the console panels, and the styles.

plugins/           The shipped example plugins, loaded on a fresh boot.
skills/*.md        15 skill documents, loaded from disk at boot.
scripts/           Repository tooling: smoke-ws.mjs, check-css.mjs,
                   check-failure-paths.mjs, inspect-glb.mjs, shoot-state.mjs,
                   screenshot.ps1, blender-preview.mjs.
blender/           The office asset pipeline (blender/scripts), the
                   hand-authored reference asset, and the kit preview output.
```

`packages/core` is deliberately dependency-free: `model.ts`, `skill.ts`,
`org.ts`, `run.ts` and `events.ts` are the vocabulary that the engine, the store
and the browser all speak.

---

## Verification

One command per suite, each covering something the others cannot.

```bash
# core: 14 tests — the style model: preset completeness, sparse-patch resolution,
# and that a corrupt style degrades to its preset instead of into a shader
cd packages/core && node --test --test-isolation=none "src/**/*.test.ts"

# server: 402 tests — 399 pass, 3 skipped, 0 fail (47 cover plugins, 13 the block layout, 5 the floor style)
cd apps/server && node --test --test-isolation=none "src/**/*.test.ts"

# live protocol: drives a RUNNING server as a real client — 202 checks
node scripts/smoke-ws.mjs

# the office store's reducer, driven with one frame per event variant — 129 checks,
# including that every preset dresses every role and every material in both GLBs
# maps to one
node apps/web/.verify/smoke.ts

# the degradation promises: no database, a malformed skill file, an empty skills dir
node scripts/check-failure-paths.mjs

# the office kit: the GLB against its sidecar — sizes, anchors, heights, and that
# no material has escaped the theme's role table
node blender/scripts/verify-blocks-glb.mjs

# typecheck every package
node apps/server/node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node apps/web/node_modules/typescript/bin/tsc    -p apps/web/tsconfig.json --noEmit
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit

# production bundle, then the orchestrator serves it on :8787
node apps/web/node_modules/vite/bin/vite.js build

# every class name in the source exists in the stylesheet, and no rule is dead
node scripts/check-css.mjs

# screenshot a *specific* UI state: click a tab, resize the pane, type into a form
node scripts/shoot-state.mjs --out .screenshots/run-tab.png --script "click:Run"
node scripts/shoot-state.mjs --out .screenshots/wide.png \
  --script "drag:left:260|click:Run"

# the office asset
node scripts/inspect-glb.mjs apps/web/public/office/office.glb
```

### What the suites actually prove

- **Core: 14 tests** — the style model: preset completeness, sparse-patch
  resolution, and that a corrupt style degrades to its preset instead of into a
  shader.
- **Server: 399 pass, 3 skipped, 0 fail.** The engine tests drive real runs — real
  pipelines, real router, real tool loop — against the scripted provider and a
  scratch workspace, proving files land on disk, budget halts, cancellation is
  safe, debates produce verdicts, the review loop sends work back to the
  builders, the spend gate asks exactly once, and a run in one organisation
  leaves another floor's directory untouched. The runtime tests cover the
  workspace rules and the migration directly, because a folder name that escapes
  the workspaces root would hand thirteen agents the whole disk — and the floor
  style, because a value that reaches a shader is a value that has to be refused
  at the boundary rather than rendered.
- **The model layer is five suites, and the interesting ones are about failure.**
  `modelList.test.ts` parses real captured payloads — DeepSeek's two-field answer,
  OpenRouter's 445-entry one, Anthropic's `display_name` spelling — and asserts
  that an unrecognisable body *throws* while a recognised-but-empty list returns
  `[]`, because "I could not read this" and "the vendor serves nothing" have
  opposite consequences for routing. `discovery.test.ts` covers the cache
  round-trip, a corrupt or foreign cache being ignored, a failure after a success
  *withdrawing* the discovered set, and a provider answering with nothing being a
  success rather than a failure. `quality.test.ts` pins that confidence gates
  influence, that smoothing survives one bad turn out of twenty, that a cancelled
  turn votes on nothing, and that a fallback-served turn is recorded as a failure
  for the model that did not answer. `score.test.ts` opens with the
  backward-compatibility invariant and `modelRouter.test.ts` covers the pin
  refusals and hint scoping. `benchmarks.test.ts` pins the percentile calibration
  against the measured distribution, and that an ambiguous bare model name is
  refused rather than guessed — a false match would hand one vendor's scores to
  another's model while looking authoritative. `health.test.ts` pins that a
  lookup never blocks a turn, never fails one, and that a model with no endpoints
  is not mistaken for a model with a broken one.
- **`smoke-ws.mjs`: 202 checks.** It drives a *running* server as a real client
  over the socket: office state on connect, two full runs (question + build),
  streaming deltas reconstructing the final text, replay from the persisted log,
  direct messages, planning turns (including that a plan is answered to the
  asking socket and never lands in a direct-message thread), hire/setSeat/
  setModelPolicy/fire, opening and closing floors with every refusal, per-floor
  skills and budget staying independent, switching floors swapping the whole
  context (and switching back), installation settings being changed and
  validated, a malformed body being a 400 rather than a 500, and post-run
  invariants. It clears anything a previous run left behind, so it is idempotent.
- **Web harness: 129 checks.** A typecheck cannot prove a reducer correct, so
  `apps/web/.verify/smoke.ts` drives the real store with one synthetic frame per
  `ServerEvent` variant, including that an `org.updated` for another floor is
  ignored rather than applied to the one on screen, and that a `plan.reply` is
  *queued* rather than appended to a thread (only the page holding that
  conversation knows which session it belongs to) and is consumed exactly once.
  It also pins the optimistic-echo rule for direct messages, which is subtler
  than it looks: an echo and the server's copy of it carry different ids by
  construction, so merging by id alone leaves the operator's own message in the
  thread twice. It also covers the building's arithmetic — floor heights, the
  lowest-floor fallback, and which floor shows walls — because those are the
  rules that decide whether the office reads as a building at all, and they are
  wrong in ways a typecheck cannot see.
- **`check-css.mjs`: clean.** A typecheck cannot tell you that
  `className="poput-left"` is a typo, and after the stage layout landed the
  stylesheet still carried the whole retired three-column grid. This compares the
  class names the source uses against the selectors the stylesheet defines, in
  both directions.
- **`check-failure-paths.mjs`: 10 checks.** Every degradation the README promises,
  asserted rather than assumed: an unusable database path still yields a working
  non-persistent store, a missing skills directory yields an empty catalogue, and
  one malformed skill file is skipped with its reason instead of taking the whole
  catalogue down. That last one is why the check exists: `loadSkills` runs in
  `main()` before the server listens, so an unhandled error in a single markdown
  file the README invites you to write would stop the office booting at all.
- **Build: 89 modules, clean.** The bundle is served from `apps/web/dist` by the
  orchestrator's static handler, alongside `office.glb`. Rebuilding is picked up
  on refresh; the server does not need restarting.

---

## Pre-release checklist

Run these in order. Each one is cheap, and each one catches a class of mistake
the others cannot.

1. **Typecheck every package**

   ```bash
   node apps/server/node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
   node apps/web/node_modules/typescript/bin/tsc    -p apps/web/tsconfig.json --noEmit
   node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
   ```

2. **Core tests** — the style model: preset completeness, sparse-patch
   resolution, and that a corrupt style degrades to its preset instead of into a
   shader.

   ```bash
   cd packages/core && node --test --test-isolation=none "src/**/*.test.ts"
   ```

3. **Server tests** — 402 tests, 399 pass, 3 skipped, 0 fail (47 cover plugins,
   13 the block layout, 5 the floor style).

   ```bash
   cd apps/server && node --test --test-isolation=none "src/**/*.test.ts"
   ```

4. **Live protocol** — drives a *running* server as a real client; 202 checks.

   ```bash
   node scripts/smoke-ws.mjs
   ```

5. **Web reducer harness** — one frame per event variant; 129 checks, including
   that every preset dresses every role and every material in both GLBs maps to
   one.

   ```bash
   node apps/web/.verify/smoke.ts
   ```

6. **Failure paths** — the degradation promises: no database, a malformed skill
   file, an empty skills dir.

   ```bash
   node scripts/check-failure-paths.mjs
   ```

7. **Production bundle** — the orchestrator then serves it on :8787.

   ```bash
   node apps/web/node_modules/vite/bin/vite.js build
   ```

8. **CSS audit** — every class name in the source exists in the stylesheet, and
   no rule is dead.

   ```bash
   node scripts/check-css.mjs
   ```

9. **Office kit** — the GLB against its sidecar: sizes, anchors, heights, and
   that no material has escaped the theme's role table.

   ```bash
   node blender/scripts/verify-blocks-glb.mjs
   ```

10. **Office asset** — inspect the exported GLB.

    ```bash
    node scripts/inspect-glb.mjs apps/web/public/office/office.glb
    ```

---

## The Blender asset pipeline

Each script resets the scene, so the order below is the only one that works. The
office asset is built first:

```
01_office_shell.py       the shell, with doorway openings in the side walls
03_office_furniture.py   desks, chairs, the meeting table, and every anchor
99_export_glb.py         writes apps/web/public/office/office.glb
```

The block kit is a separate pass producing a separate file:

```
02_office_blocks.py      writes blocks.glb alongside blocks.json
04_preview_blocks.py     renders a contact sheet of the kit, for review
```

The furniture is scripted rather than authored by hand in an interactive Blender
session, because a script can be re-run and a hand-built scene cannot. That is what
`03_office_furniture.py` is for, and why `99_export_glb.py` refuses to export a
scene with no `Seat_*` anchors in it: running `01` and then `99` would replace the
furnished office with a bare shell rather than re-export what is there.

The furniture script **asserts the anchor contract** rather than trusting it: 21
`Seat_*` empties, 13 `Desk_*` empties, 7 `Anchor_Room_*` empties, and no mesh
carrying a reserved prefix. That last rule is not pedantry — the loader finds
anchors by prefix, so a chair part named `Seat_Meeting_01_Seat` becomes somewhere
to put an employee, and a desk whose parts were all suffixed with `Desk_` is a
desk that `deskNameForSeat` can never find.

The hand-authored original is kept at
`blender/reference/office.hand-authored.glb`. The reconstruction is deliberately
simpler than what a person made: fewer meshes, simpler forms, no bespoke detail.

### Running it

Blender is resolved by the repository rather than pinned to one machine, so
previewing and checking the kit are package scripts:

```bash
pnpm preview:blocks    # a rendered contact sheet of all 24 modules
pnpm check:blocks      # the GLB against its sidecar: sizes, anchors, heights, material roles
```

`scripts/blender-preview.mjs` finds the binary in this order:

1. `DEV3D_BLENDER` — full path to the executable.
2. `DEV3D_BLENDER_DIR` — the directory holding it.
3. `blender` on `PATH` — the normal case on macOS and Linux, and on Windows when
   the installer's optional `PATH` entry was taken.
4. Default install locations only, newest release first.

For example:

```powershell
$env:DEV3D_BLENDER = "D:\Blender\blender.exe"                # PowerShell
export DEV3D_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
```

It runs Blender as `--background --factory-startup --python
blender/scripts/04_preview_blocks.py --`, and anything after the bare `--` is
passed through to the render script, so `pnpm preview:blocks -- --only
pod4,lounge3` draws just those modules. Blender's output is left visible rather
than captured, because it is chatty and worth seeing.

### The ordering constraint

**Every script resets the scene, so the order is not a preference.** `01` clears
whatever is loaded, which means running it over a furnished scene discards the
furniture that `03` built; `99` therefore refuses to export a scene with no
`Seat_*` anchors rather than quietly writing a bare shell to `office.glb`. Pass
`-- --force-empty` to override the refusal, which is only useful when the shell
alone is what you want.

`02_office_blocks.py` is independent of all three: it builds the kit into its own
scene and writes `blocks.glb` and `blocks.json`, leaving the office asset
untouched.

### How `blocks.json` is written

`02_office_blocks.py` writes `blocks.json` directly when Blender runs it, and
prints the same document as `BLOCKS_JSON=…` when it cannot — where the write is
withheld, the printed copy is the sidecar of record.

---

## Screenshotting and driving the UI

Two scripts, for two different jobs. Both drive headless Chrome (or Edge) to
render a *specific* UI state so a layout claim can be checked instead of
asserted.

### `scripts/shoot-state.mjs`

`screenshot.ps1` captures the default view, which is enough for a first look and
useless for the part that matters: the inspector's other tabs, a resized pane, or
an overlay only reachable by a click. This drives headless Chrome over the
DevTools protocol, clicks what it is told to click, and then captures the frame.

It launches its own Chrome rather than attaching to one, because the app
remembers its tab in `localStorage` and a fresh profile is what makes the
starting state deterministic.

```bash
node scripts/shoot-state.mjs --out .screenshots/run-tab.png --script "click:Run"
node scripts/shoot-state.mjs --out .screenshots/wide.png \
  --script "drag:left:260|click:Run"
```

Steps are separated by `|` rather than by repeating `--script`, because a quoted
argument containing a colon loses its quotes on the way through a native Windows
command line, so repetition cannot be distinguished from one step that happens to
have a space in it.

| Step | Effect |
|---|---|
| `click:<label>` | Click the first button whose text matches. |
| `sel:<css selector>` | Click the first element matching a CSS selector. |
| `type:<selector>:<text>` | Set a field's value the way React will notice. |
| `eval:<expression>` | Run an expression in the page. |
| `drag:left:<pixels>` | Drag the inspector's inner edge left by N px. |
| `wait:<milliseconds>` | Pause. |

Options include `--url` (default `http://127.0.0.1:8787/`), `--out`, `--width`
(default 1600), `--height` (default 1000), `--port` (default 9333), `--settle`
(default 12000 ms) and `--step-wait` (default 350 ms). The settle is a fixed
delay rather than a load event, because the inspector's state arrives over a
websocket after the document is already complete.

A screenshot cannot show a console error, and an audit that only looks at pixels
will happily pass a page that threw on the way to rendering, so the script also
reports console errors and uncaught exceptions it saw along the way, and says
`console: clean` when there were none.

### `scripts/screenshot.ps1`

The simpler capture: one shot of one URL, optionally with the DOM dumped
alongside it.

```powershell
.\scripts/screenshot.ps1                                   # http://127.0.0.1:8787/
.\scripts\screenshot.ps1 -Out .\f2.png -DumpDom            # also dump the DOM
```

Parameters: `-Url`, `-Out` (default `.screenshots\office.png`), `-Width`
(default 1600), `-Height` (default 1000), `-VirtualTimeMs` (default 25000) and
`-DumpDom`. It writes the DOM next to the image (`.html`) and Chrome's stderr
beside it (`.err.txt`), reports the exit code and the byte count, and prints the
first lines of stderr and exits non-zero when Chrome failed or produced an empty
file.

Two traps it exists to avoid:

- **Do not pipe a native command's output** (`& chrome … > file`): here that
  yields no output at all and an empty exit code, which looks exactly like a
  silent failure. The script uses `Start-Process -RedirectStandardOutput`.
- **Use a fresh `--user-data-dir` every run**, or Chrome may hand the request to
  an already-running browser and exit without doing any work.

---

## The three skipped tests

The server suite reports three skips, and all three have the same cause: this
environment blocks child processes with piped stdio, which is what capturing a
command's output requires.

- `apps/server/src/tools/tools.test.ts` — an approved `run_shell` actually
  executes a command and writes its file.
- `apps/server/src/tools/plan.test.ts` — two `git` tests that need a real
  repository: one that reads status, log and ls-files back, and one that proves a
  shell metacharacter in an argument is inert.

Each reports itself skipped with that reason rather than failing, and each still
runs, and still has to pass, anywhere child processes are allowed. Nothing else in
the MCP layer is skipped: the protocol, the client, the manager and the
configuration are all tested through injected transports, so they run everywhere.
