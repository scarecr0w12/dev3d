# dev3d — full-system verification campaign

A prompt to hand to a capable coding agent (Claude Code, Codex, DSH, or similar)
with shell access to this checkout. It is written to **find out whether the
system actually works**, not to confirm that it does. Every phase states what to
run, what a pass looks like, and how to record a failure.

Copy everything from **THE PROMPT** to the end.

---

## Before you start: cost, and the two things that will bite you

- **A live run spends real money.** This checkout is configured `llmMode: live`
  with DeepSeek and OpenRouter keys. Phases 1–4 are free (no model calls).
  Phase 5 onward costs money. Check `/api/health` for the mode first, and run the
  expensive phases against `DEV3D_LLM_MODE=mock` first if you want a free
  rehearsal. A full end-to-end `product-build` run on frontier models is dollars,
  not cents.
- **`pnpm run <script>` fails with `spawn EPERM` under a DSH-confined shell.**
  pnpm pipes child stdio over a named pipe, which the sandbox forbids. This is
  not a bug in the project — invoke the underlying tools directly:
  - typecheck: `cd <pkg>; node ../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  - tests: `cd <pkg>; node --test --test-isolation=none "src/**/*.test.ts"`

---

## THE PROMPT

> **Note for whoever runs this:** `docs/review-core.md` contains a prior static
> review of this same tree, with fifteen specific suspected defects (missing LLM
> timeouts, estimated token accounting, turns that end empty at the tool-round-trip
> ceiling, run history not reloading after a restart, per-token event-log writes,
> and others). Do **not** show that document to the agent — it would anchor the
> verification and turn an investigation into a confirmation exercise. Keep it
> aside, and compare its findings against the agent's independent report
> afterwards. Agreement between the two is the evidence that matters.

You are verifying **dev3d** — a 3D office where a hierarchy of LLM agents does
real work — at `E:\Development\dev3d`. A brief goes in, a CEO agent turns it into
an objective, specialists research and argue, a CTO writes a file-level plan,
developer agents write **real files** into a workspace, QA tries to break them,
and the CEO reports back. Every agent is a separate model call with its own role,
tools and model.

Your job is to determine, with evidence, **which parts of this system actually
work and which parts only appear to.** Be adversarial. A phase that "looks fine"
because you did not try to break it is a phase you have not run.

Work through the phases in order. After each phase, print a verdict line:
`PHASE <n> — PASS | FAIL | PARTIAL — <one line>`.

### Rules of engagement

1. **Never modify application source** except to add tests you were asked to add
   in Phase 10. You are a verifier, not a developer.
2. **Do not start a second orchestrator.** One is already listening on
   `127.0.0.1:8787`. Check first; use `pnpm restart:server` if you need a fresh
   one (it finds the listener by port and is safe to re-run).
3. **Do not run a destructive command against the real repo.** The `git` tool's
   write operations are approval-gated; when you test them, do it in a scratch
   workspace, never in `E:\Development\dev3d`.
4. **Record raw evidence** — exact command, exact output, exit code. "It worked"
   is not evidence. Where a phase tells you to capture output to a file, do it.
5. **Report failures as findings, not as obstacles.** A phase that fails is a
   successful verification.
6. If something is ambiguous, state the ambiguity and continue with the reading
   you chose.

---

## Phase 0 — Establish ground truth

Record, before touching anything:

```bash
node --version                      # must be >= 24 (node:sqlite + native TS stripping)
pnpm --version
git -C . log --oneline -5
git -C . status --short
```

Then capture the live baseline:

```bash
curl -s localhost:8787/api/health
curl -s localhost:8787/api/providers
curl -s localhost:8787/api/workspaces
curl -s localhost:8787/api/runs
```

Answer explicitly:
- What is `llmMode`, and what is `llmModeReason`?
- Which providers are `configured: true`, and which are `ok: false`? For each
  `ok: false`, is `local: true`?
- How many models does each provider contribute?
- Is `configStale` false?
- How many runs does `/api/runs` report — and how many rows are in the `runs`
  table of `data/dev3d.sqlite`? **If those two numbers disagree, that is a
  finding.** (Read the DB read-only with `node:sqlite`; do not write to it.)

**Pass:** server answers, mode is stated with a reason, and you can account for
every provider in the list.

---

## Phase 1 — Static integrity (free)

```bash
# typecheck every package
cd packages/core && node ../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
cd ../../apps/server && node ../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
cd ../web && node ../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# tests
cd ../../packages/core && node --test --test-isolation=none "src/**/*.test.ts"
cd ../../apps/server && node --test --test-isolation=none "src/**/*.test.ts"

# the project's own invariant checkers
cd ../.. && node scripts/check-failure-paths.mjs
node scripts/check-css.mjs
```

Record: pass/fail counts per package, and the exit code of each checker.

**Pass:** three clean typechecks, zero test failures, both checkers green.
**Also worth doing:** confirm the *number* of tests, and whether any are skipped.
A skipped test that covers a claim made in the README is a finding.

---

## Phase 2 — The claims audit (free, the most important phase)

`README.md` makes a large number of specific, falsifiable claims. **Verify at
least these twelve against the code**, and report any that are false, unverifiable
or misleading:

| # | Claim (README) | How to falsify |
|---|---|---|
| 1 | "15 built-in tools" | Count the registered tool definitions in `apps/server/src/tools/`. Note what `/api/health`'s boot log says the count is. |
| 2 | "every one confined to the run's workspace root" | Read `tools/paths.ts`. Then **attempt** to escape: `..` traversal, an absolute path outside the root, `C:foo` drive-relative, a UNC path, a symlink/junction inside the workspace pointing out, an NTFS alternate data stream (`file.txt:stream`), a reserved device name. Try each through `resolveInWorkspace` directly. |
| 3 | "bounded at 8 round trips" | Confirm the constant in `engine/turn.ts`, then check what actually happens when a turn hits it: does it produce a final answer, or nothing? |
| 4 | "Every event is persisted *before* it is broadcast, so a reconnecting client ... never [sees] a gap" | Read `server/runtime.ts` `emit`. Confirm ordering. **Then** check which event types are persisted per-token during streaming and measure the row count for one run. |
| 5 | "Exceeding the budget always halts the run" | Read the budget checks in `engine/runEngine.ts`. Is it checked before *and* after a stage? Can a single turn overshoot the limit? |
| 6 | "A review that ends with its objections unresolved fails its stage" | Find the objection detector (`engine/stages.ts`). Feed it text that *approves* while containing a word like "reject" or "objection" in a negated or irrelevant sense, and text that objects without any trigger word. Report the false-positive and false-negative rate. |
| 7 | "with no quality information the score reproduces the previous behaviour exactly" | Read `router/score.ts` and the test that pins it. Verify the test actually exercises the property. |
| 8 | "A plugin routing rule can reorder candidates within a tier but never move a turn to another tier" | Read `router/modelRouter.ts` `hintBonuses` and `walkOrder`. Is a hint that declares an explicit `tier` able to pull that tier to the front of the walk? Is that consistent with the claim? |
| 9 | "an unknown model contributes exactly nothing [to the reliability penalty]" | Verify in `router/score.ts`. |
| 10 | "Nothing on the wire authenticates, by design ... **Bind it to `localhost`**" | Check the actual bind address in `apps/server/src/index.ts`. Does it default to loopback, or to all interfaces? What happens with `HOST=0.0.0.0`? Is any API key ever serialisable into a client frame or a settings document? |
| 11 | "Provider API keys are never exposed to the browser" | Grep the wire types (`packages/core/src/events.ts`) and every JSON response for the key value and for the key *name*. Confirm the client learns presence, never value. |
| 12 | "`activate()` is not sandboxed ... The permission list is a consent record ... not a runtime gate" | Confirm this is stated (it is) and that nothing else in the docs contradicts it. Flag if a plugin can reach the filesystem or network beyond what its manifest declares. |

**Pass:** every claim either holds under an attempt to break it, or you have a
precise counterexample. Vague agreement does not count.

---

## Phase 3 — The protocol and persistence contract (free)

1. Read `docs/wire-protocol.md` and `packages/core/src/events.ts`.
2. Enumerate the `ServerEvent` union and the `ClientCommand` union. **Count them**
   and compare with the numbers the doc states (24 and 14).
3. For each documented HTTP route in the doc's tables, call it and record the
   status code. Include one deliberately malformed body per write route — the doc
   claims a malformed body is `400` "never a `500`".
4. Connect a WebSocket to `/ws` and capture the `hello` frame. Record its byte
   size and top-level keys.
5. **Restart the server.** Then re-check `/api/runs` and the `hello` frame.
   Compare against Phase 0's database row count.

**Pass:** the counts match, every route answers, malformed bodies are 400s, and a
restart does not lose history that is on disk.

---

## Phase 4 — Routing and cost, without spending (free)

The routing decision is pure except for the catalog it reads.

1. Read `router/modelRouter.ts` and `router/score.ts` in full.
2. Using `/api/models` output as input, **hand-compute** the score for three
   models under a `balanced` posture for the `coding` task class, and compare
   with what the router would choose. You may drive `routeModel` directly in a
   scratch script under `scripts/` (delete it afterwards).
3. Prove or disprove: **with the whole quality overlay removed, does the router
   pick the cheapest model in the policy's target tier?**
4. Prove or disprove: **can a `cheap` posture select a model above the policy's
   `minTier`?** Can `quality` select above `maxTier`? (Read the clamp.)
5. Check the `preferredModelId` pin: a pin that is missing, excluded, lacks a
   required capability, or sits outside `minTier`/`maxTier` must be **named in the
   routing reason** and normal selection must stand. Test all four cases.
6. Verify the cost arithmetic: `computeCost` against a hand calculation, using a
   real model's published per-Mtok rates from `/api/models`.

**Pass:** your hand-computed winner matches the router; the two properties hold
or you have a counterexample; a pin that is not in force is visible.

---

## Phase 5 — A real run, cheaply (spends money)

Submit the smallest thing that exercises the whole spine. Use `quick-answer`
first (3 stages) so a failure is cheap to diagnose:

```bash
curl -s -X POST localhost:8787/api/submit \
  -H 'content-type: application/json' \
  -d '{"brief":"Explain, with a concrete example, what the `cheap` routing posture changes about model selection in this codebase. Cite the file and line."}'

curl -s localhost:8787/api/runs/<runId>
```

Then answer, from the persisted record (not from the console's optimism):

- Which **pipeline** was chosen, and why? (Read `pickPipelineId`.)
- How many stages ran, and what was each stage's `status`?
- For each turn: which model **actually served** it (`servedBy`) and was it the
  routed model (`route.modelId`) or a fallback (`attemptedRoutes`)?
- What are `usage.tokensIn`, `tokensOut`, `costUsd` per turn — and is the sum
  consistent with `run.budget.spentUsd`?
- **Is the vendor's real token count used, or an estimate?** Compare the recorded
  numbers against the provider's own reported usage if you can obtain it. State
  which path was taken (streaming vs not) and why.
- Did any turn end with an empty `text`? If so, what was its `error`?
- Did the run's `outcome` actually answer the brief, or is it an error string?

**Pass:** the run reaches a terminal state, at least one turn produced a real
answer, costs are attributed to the model that served each turn, and `outcome`
answers the question that was asked.

**Known-suspicious, so test it deliberately:** submit a brief that requires
several rounds of tool use (a research question). Does the turn produce an answer,
or does it die at the tool-round-trip ceiling with an empty `text`? Capture the
turn JSON either way.

---

## Phase 6 — Tools, for real (cheap; some money)

Drive these through a run whose brief asks for them, then verify the effects
**on disk**:

1. `write_file` → does the file exist with the exact bytes?
2. `edit_file` → does one exact literal get replaced, and does a non-matching
   literal fail cleanly?
3. `apply_patch` → several exact-text edits, applied atomically. **Does a partial
   failure roll back?** Construct a patch where the second edit cannot apply.
4. `glob` / `grep` / `search_files` → do include/exclude filters and `filesOnly`
   behave as documented?
5. `read_file` paging → does a window of lines come back correctly, and is the
   line numbering honest?
6. **Confinement, live:** ask an agent to read `../../../Windows/win.ini` (or any
   path outside the workspace). It must be **refused**, and the refusal must reach
   the model as an actionable message. Try a symlink inside the workspace pointing
   outside, and an absolute path. Record the exact refusal text.
7. `run_shell` → send a command. Does it trip the approval gate? What happens on
   **timeout**, and on **rejection**? Does a command that spawns a
   grandchild process get killed completely?
8. `git` in a **scratch** workspace: confirm read-only verbs never ask, and that
   `--hard`, `--force`, `--no-verify` and `clean` are refused outright.
9. `recall` → record a memory fact, then confirm a later turn can recall it.
10. `todo_write` → confirm the plan survives the turn that created it and is
    visible to a later stage, and that sending a partial list does not
    half-apply.

**Pass:** every tool does what its description says, confinement refusals are
real, and nothing outside the workspace root was touched.

---

## Phase 7 — Failure modes (free to cheap, the highest-value phase)

The engineering value of this system is in how it fails. **Break it on purpose:**

1. **Kill a provider mid-run.** Point `DEV3D_DEEPSEEK_BASE_URL` at a black hole
   (`http://127.0.0.1:9/` — a port nothing listens on) and start a run.
   Does it fail over to a fallback and complete? Is `servedBy` honest about it?
   **Then point it at a host that accepts the TCP connection and never answers**
   (e.g. a `nc`-style listener that accepts and stalls). Does the turn ever
   settle? How long does it hang? Is there a timeout?
2. **Exhaust the budget.** Submit with a tiny `budgetUsd`. Does the run halt at
   the boundary rather than overshooting? Is the error message truthful?
3. **Cancel a run mid-flight.** Does it stop in bounded time? Do employees return
   to `idle`? Does the run reach `cancelled` rather than `done`? Does a direct
   message sent afterwards still work?
4. **Let an approval time out.** Does it resolve as refused, and does the run
   continue rather than wedge?
5. **Make the store unwritable** (point `DEV3D_DB` at an unusable path). Does the
   office still boot, on the memory fallback, and say so?
6. **Break a skill file** (malformed front-matter in a scratch skills dir). Does
   one bad skill take the others down?
7. **Corrupt the discovery cache** (`data/model-discovery.json` — back it up
   first). Does it degrade to the curated catalog rather than crashing?
8. **Empty catalog.** Is there any configuration in which the router has zero
   models? What does a run do then — a clear error, or a crash?

**Pass:** every failure is bounded, reported in words, and does not leave the
office wedged. **A hang with no timeout is a FAIL**, and is the single most
valuable thing this phase can find.

---

## Phase 8 — The office UI (free)

Start the web app (`pnpm dev:web` or `cd apps/web && node ../../node_modules/.bin/vite`)
and verify the surfaces the README describes, at `127.0.0.1:5273`:

1. The canvas fills the viewport; every other surface floats over it.
2. Switching tabs **never re-creates the renderer** — the camera and avatars keep
   their state. (Verify by moving the camera, switching tabs, switching back.)
3. The ⌘/ctrl-K Jump box searches people, runs, artifacts and the event feed.
4. Clicking an employee raycasts, selects it, and eases the camera in.
5. Idle employees get up and walk; `working`/`thinking`/`blocked`/`offline`
   bodies never leave their chairs.
6. `prefers-reduced-motion` disables liveliness.
7. The approval callout appears top-centre when something is waiting.
8. Escape returns you from a page sheet to the office.
9. The Plan page: a multi-turn planning conversation, then *Draft the brief*,
   then Submit — and confirm that **nothing is commissioned until Submit**.
10. Open the console with **two** browser windows. Do they agree about the work?
    (The README says they will disagree about idle strolls — that is intended.)

**Pass:** the office is alive and interactive, the renderer is genuinely stable
across tab switches, and no surface is a dead end.

---

## Phase 9 — Extension points (free to cheap)

1. **Plugins.** Three ship in `plugins/`. For each, confirm the manifest
   validates, then read the contribution table in `docs/wire-protocol.md` and
   **check that every declared extension point is actually consumed**. A
   contribution that is declared but never read is a finding.
   Then corrupt a manifest (scratch copy) and confirm one bad plugin does not take
   the others down.
2. **Panels.** Confirm a panel is data, never code, and that a panel `source` URL
   is fetched **server-side** with a timeout, cached, coalesced, and refused
   unless http(s). Confirm the browser never learns the plugin's URL.
3. **MCP.** `mcp.json` ships with an empty `servers` array, so nothing is
   configured. Add a trivial stdio server in a scratch copy and verify: tools are
   published as `mcp__<server>__<tool>`, grants are enforced per role, a server
   that dies mid-call is reported rather than hanging, and every call is
   timeout-bounded.
4. **Vendors.** `vendors.json` is also empty. Configure a dummy command vendor and
   verify the **read-only** claim honestly: does the office claim enforcement it
   cannot deliver? The test suite says "only the harness with a real sandbox flag
   claims read-only is enforced" — confirm that is true of what the UI says.

**Pass:** every extension point either works or is honestly declared as
unimplemented; no contribution is silently ignored.

---

## Phase 10 — Write down what you could not verify

1. List every claim you could **not** falsify or confirm, and why.
2. Add at least one **failing-first** regression test for each real bug you found,
   under the relevant package's `src/**/*.test.ts`, following the existing style
   (they are plain `node:test` files, run with `node --test --test-isolation=none`).
   Run the suite; confirm your new tests fail for the right reason before you fix
   anything, and that you did not break the 557 that already pass.
3. Do **not** fix the bugs. Produce the tests and the findings.

---

## Reporting format

Produce one report with:

- **Verdict per phase**: PASS / FAIL / PARTIAL, one line each, with the evidence
  that decided it.
- **Findings**, severity-tagged (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`), each
  with: what is wrong, exact `file:line`, the command or input that demonstrates
  it, the observed output, why it matters, and a concrete suggested fix.
- **Claim-by-claim table** for Phase 2: claim | verdict | evidence.
- **What genuinely works** — an accurate list, because a report that only lists
  problems is as useless as one that only lists praise.
- **Coverage gaps** — what you could not test and why.
- **Cost report** — total dollars spent by this campaign, from
  `run.budget.spentUsd` summed across the runs you submitted.

Be specific. "The routing logic seems complex" is not a finding. "`score.ts:149`
keys the cost map by `model.id` alone, so two providers serving the same id would
collide; today no two of the 455 catalog entries share an id, so this is latent,
not live" is a finding.
