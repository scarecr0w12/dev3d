# Core, LLM layer and run engine — technical review

Scope: the orchestration core — LLM adapters and the provider registry, model
discovery, routing and scoring, the run engine and turn/tool loop, persistence
and the event log, and the live behaviour of the running office.

Method: full read of `apps/server/src/{llm,router,engine,store}/**` and
`packages/core/src/{model,run,events}.ts`; `tsc --noEmit` on all three
packages; the full server (557 passing / 4 skipped) and core (14 passing) test
suites; the project's own `check-failure-paths.mjs` (10/10) and `check-css.mjs`;
a read-only audit of the live `data/dev3d.sqlite`; and direct inspection of the
live orchestrator on `127.0.0.1:8787` including its boot log and the one real
run it has already performed.

Baseline: **typecheck clean on all three packages, all tests pass.** The
findings below are things the existing suites do not cover.

---

## Findings

### [HIGH] LLM HTTP calls have no timeout, so a hung provider wedges an employee slot forever

`apps/server/src/llm/openaiCompat.ts:293-298` and
`apps/server/src/llm/anthropic.ts:302-307` pass `signal: req.signal` to `fetch`,
where `req.signal` is the run's cancellation signal
(`apps/server/src/engine/turn.ts:472`). It is aborted only when an operator
presses Cancel. There is no `AbortSignal.timeout`, no per-request deadline, and
— confirmed by grep — no retry or backoff anywhere in `apps/server/src/llm/`.

`registry.chat()` (`llm/registry.ts:387-419`) fails over to the next candidate
only when a call *throws*. A provider that accepts the TCP connection and then
never sends a first byte, or that stalls mid-stream after headers, does not
throw: `parseStream` awaits `reader.read()` (`openaiCompat.ts:176-186`) with no
deadline.

Consequences: the turn never settles, the employee stays `thinking`/`working`,
the run never reaches a terminal state, and `run.budget.spentUsd` is never
charged — while the operator's only remedy is Cancel. On a run with several
parallel branches (`engine/stages.ts:320-350`) each branch can be stuck at once.
Every other outbound call in the codebase *is* bounded (`mcp/http.ts:99`,
`tools/web.ts:101`, `plugins/panels.ts:100`, `plugins/host.ts:739`), which makes
the LLM path the odd one out rather than a deliberate policy.

Fix: wrap each adapter's `fetch` in a request deadline derived from the model's
expected latency, and add a separate idle deadline to the streaming read loop —
a stream that has produced no bytes for N seconds is dead. Compose with
`req.signal` via `AbortSignal.any`.

### [HIGH] The streaming path makes every turn's token accounting an estimate

`apps/server/src/engine/turn.ts:466-471` always supplies `onDelta`, so **every**
turn takes the streaming branch: `openaiCompat.ts:291` sets `body.stream = true`
and `:305` routes to `parseStream`. `parseStream` ends with
`buildUsage(undefined, ...)` (`openaiCompat.ts:193`), i.e. the `chars/4`
fallback, because the OpenAI-compatible SSE protocol only reports `usage` when
the request sets `stream_options: { include_usage: true }` — and this code never
sends it (confirmed: no match for `stream_options` or `include_usage` in the
tree).

So for the provider this office actually runs on, `tokensIn`/`tokensOut` and
therefore `costUsd` are estimates, not the vendor's numbers, for every turn.
This propagates into `run.budget.spentUsd`, the `budget.updated` event, the
per-employee usage tallies, and the console's spend figures. `/api/health`
advertises a billing mode; it is not billing-grade. (The Anthropic adapter is
unaffected: its `message_start`/`message_delta` events carry real usage and are
parsed at `anthropic.ts:177-180, 211-216`.)

Fix: send `stream_options: { include_usage: true }` on the streaming request and
prefer the reported `usage` when the final chunk carries it. Keep the estimator
as the documented fallback for local runtimes that omit usage.

### [HIGH] A turn that exhausts the tool-round-trip budget produces nothing at all

`engine/turn.ts:36-37` caps a turn at `MAX_TOOL_ITERATIONS = 8` model↔tool round
trips. When the cap is reached (`turn.ts:514-516`) the loop simply exits: the
model is never given a final call, so `turn.text` stays `''`, and the turn is
then reclassified as failed at `turn.ts:538` ("Stopped after 8 tool round trips
without a final answer").

This is not hypothetical — it is what happened in this office's own most recent
real run (`run_3d4d82eae5`, pipeline `quick-answer`, status `done`, $0.169):

| turn | role | model | round trips | `text` length | error |
|---|---|---|---|---|---|
| `turn_bddf67979b` | ceo | openrouter/openai/gpt-5.6-sol-pro | 2 | 1519 | — |
| `turn_f7cb8f7b1d` | researcher | openrouter/openai/gpt-5.6-sol | 8 (30 calls) | **0** | Stopped after 8 tool round trips |
| `turn_54d742f5b7` | ceo | deepseek/deepseek-flash | 8 (15 calls) | **0** | Stopped after 8 tool round trips |

Two of three turns produced no answer, and the run's `outcome` is literally
`"(no output) Stopped after 8 tool round trips without a final answer."` The
money was spent and no work product came back. The cap counts *iterations*
(round trips), which is the right unit since one iteration can batch many calls —
but 8 is calibrated for focused coding work and is too tight for the `research`
stage, which is open-ended by nature and burned its whole budget on searches.

Fix: when the cap is hit, make one final call **with tools withheld** so the
model must answer from what it gathered, and raise the ceiling for
research-flavoured stages. A turn that dies with an empty `text` should also
carry the partial findings forward rather than nothing.

### [MEDIUM] `web_fetch` feeds HTTP error bodies into the model as content

`tools/web.ts:108-113` returns the response body as `content` for *any* status,
with `ok: res.ok`. `engine/turn.ts:256-261` records the non-ok status but caps
`result.content` at 8,000 characters and pushes it into `messages` as the tool
result regardless (`turn.ts:511`). So a 401 or 429 error page — GitHub's JSON
error, a rate-limit interstitial — is handed to the model as though it were
fetched material, with only a `Status: 401` line above it to say otherwise.

Observed in the live run: `web_fetch` on `api.github.com/search/code` returned
`Status 401` and `grep.app/api/search` returned `Status 429`, both recorded as
`error` yet both contributing a body to context. The model is left to infer that
the body is not the content it asked for; a small model will not.

Fix: for a non-2xx response, either return a short diagnostic instead of the body
or wrap the body in an explicit "this is an error response, not the requested
content" envelope.

### [MEDIUM] A keyless provider that is not running stays in the routing pool

`registry.routableModels()` (`llm/registry.ts:329-337`) excludes only providers
failing `isProviderConfigured`, which returns true for any `keyless` provider on
the strength of its base URL (`config.ts:402-407`). The `dev3d.local-coder`
plugin's `lmstudio` provider is keyless, so it is "configured",
`/api/providers` reports `configured: true`, and its
`lmstudio/qwen2.5-coder-14b` (tier `small`, **$0/Mtok both ways**, strengths
`intake`,`summarize`) is a live routing candidate — while discovery for it is
`degraded` (`"fetch failed"`, LM Studio not running) and every call to it will
fail.

Any turn routed to it pays a failed round trip and falls back. Because it is
listed as free, it is also exactly what a `cheap` posture or a cost-tolerant
score will prefer.

Fix: treat a provider whose discovery has definitively failed (as opposed to
never having been asked) as unroutable, or require a successful probe before a
keyless provider joins the pool.

### [MEDIUM] Discovery is unbounded and sequential, so one hanging provider delays boot

`llm/discovery.ts:229-241` walks configured providers strictly sequentially
("a burst of parallel requests at boot is the fastest way to get rate-limited")
and awaits `provider.listModels()` at `:182` with no timeout — `listModels` in
both adapters is a bare `fetch` with no signal (`openaiCompat.ts:223-226`,
`anthropic.ts:270-273`). A provider that accepts the connection and never
answers therefore blocks every subsequent provider's discovery, and the boot
call at `index.ts:1687-1691` awaits `discoverAll` in full.

Fix: give each provider's discovery its own deadline and run providers with
bounded concurrency rather than strictly end-to-end.

### [MEDIUM] Streaming `turn.delta` / `turn.reasoning` events are persisted one row per token

`server/runtime.ts:922-929` appends **every** event to SQLite before broadcast,
and the engine emits one event per streamed chunk
(`engine/turn.ts:466-471` → adapters call `onDelta` per SSE delta). Measured on
the live database:

- 3,483 `turn.reasoning` rows in a single run — one per token (payloads of
  107–154 bytes, average 110), against exactly **1** `turn.delta` row;
- `turn.reasoning` is 3,483 of 3,628 total events (96%) and 386 KB of the
  1.64 MB of event payload;
- the database is 2.0 MB with a **4.1 MB uncheckpointed `-wal`** after three
  turns.

Two problems. Performance: one synchronous `INSERT` per token, per concurrent
branch, contending with the same event loop that is driving the stream. Design:
the office's durable record is dominated by *deliberation* while the actual
answer text is written once, so the event log's signal-to-noise ratio is
inverted, and the store grows in proportion to verbosity rather than to work
done. Full chain-of-thought is now durably retained for every run with no
retention policy.

Fix: coalesce deltas on a short interval (or buffer and flush at
`turn.finished`), and make per-token events broadcast-only while persisting the
assembled `turn.reasoning`.

### [LOW] Persisted runs are never listed again after a restart

`store.recentRuns()` exists (`store/store.ts:61, 659`) and has **no call sites**
anywhere in the tree. `engine.runs()` reads only the in-memory `runsById` map,
which `createRunEngine` populates solely in `submit()`
(`engine/runEngine.ts:468`). Both consumers of the run list use it:
`index.ts:471` (the `hello` frame's `runs`) and `index.ts:878` (`GET /api/runs`).

Consequence, verified live: the database holds `run_3d4d82eae5`, the server was
restarted afterwards, and `GET /api/runs` returned `[]` while
`GET /api/runs/run_3d4d82eae5` returns the run correctly (`index.ts:885` falls
back to `store.loadRun`). The web console renders its Runs page from
`office.runs` (`apps/web/src/console/RunList.tsx:56`, `RunTranscript.tsx:120`,
`Telemetry.tsx:257`), so after any restart the UI reports zero runs and the
lifetime-spend figure resets to $0 — even though the runs, their turns and their
artifacts are all on disk and individually retrievable.

Fix: seed the run list from `store.recentRuns(n)` when the in-memory map is cold,
or union the two in `engine.runs()`.

### [LOW] Model-id-keyed maps in the scorer can collide across providers

`router/score.ts:149-171` keys `normalizedCosts` by bare `model.id`, and
`router/modelRouter.ts:145-166` keys `hintBonus` the same way, while the routing
pool spans every provider (`modelRouter.ts:268` ranks the whole pool). Two
providers serving the same model id would collide: the cost map silently keeps
one value (`Map.set` overwrite) and the other candidate is scored with a
different model's cost, and a hint bonus aimed at one provider's model applies
to both.

This is **latent, not live**: all 455 catalog entries have unique ids today
(verified over `/api/models`; OpenRouter ids are namespaced `openrouter/…`), and
`modelsFor` de-duplicates per provider (`registry.ts:285-289`). It becomes real
the moment a plugin declares a provider serving a model id that a built-in
provider also serves.

Fix: key both maps by `` `${providerId}/${modelId}` ``, as `toCandidate`'s
callers already do.

### [LOW] No retry or backoff; a transient failure burns a fallback instead

`registry.chat()` (`llm/registry.ts:387-419`) advances to the next candidate on
the first error. A transient 429, a TLS hiccup or a dropped connection is
therefore never retried against a provider that would have succeeded; the turn
silently downgrades to a weaker fallback model, which also mis-attributes the
work in `turn.servedBy` and in any learned quality signal. Combined with the
missing timeout above, a slow-motion failure has no bounded answer.

Fix: one bounded retry with jittered backoff for retryable statuses (429, 5xx,
network) before moving down the fallback chain.

### [MEDIUM] A plugin can bill negative money, which refunds the run budget instead of tripping it

`plugins/manifest.ts:134-135` accepts `costPerMTokIn` / `costPerMTokOut` from a
plugin manifest through `num(...)` with **no sign check**:

```ts
costPerMTokIn: num(entry['costPerMTokIn']) ?? 0,
costPerMTokOut: num(entry['costPerMTokOut']) ?? 0,
```

`llm/pricing.ts:13` then multiplies it by the token count, so a negative rate
produces a negative cost:

```
computeCost({costPerMTokIn: -5, costPerMTokOut: -5}, 10_000, 1_000) === -0.055
```

(verified by calling the real function). That flows through
`engine/turn.ts:482-484, 552` into `run.budget.spentUsd`, and the run engine's
only guard is an upper bound (`runEngine.ts:203`,
`if (run.budget.spentUsd >= run.budget.limitUsd)`) — nothing checks for a
negative. A plugin model with a negative price therefore *adds* budget headroom
with every turn, and the run can never be stopped by the spend ceiling that the
README calls the control that "always halts the run". The same negative figure
reaches the console's spend display and the floor's recorded lifetime spend
(`server/runtime.ts:945`).

Fix: reject non-finite or negative rates in the manifest validator (and/or clamp
at the point of cost, where `pricing.ts` is the single choke point).

### [MEDIUM] The read API is cross-origin-readable, and state-changing routes are unauthenticated

`apps/server/src/index.ts:844` sets `access-control-allow-origin: *` on every
response, with `allow-methods` including `DELETE, PUT, PATCH` (`:846`). The README
documents "no authentication ... intended for localhost, **bind it to
localhost**", and the default bind is indeed `127.0.0.1` (`config.ts:457`), so
this is not remote exposure on its own. The gap is that the wildcard origin means
**any web page the operator visits** can read the API, and — because preflight is
answered and no `Origin` is ever checked — can also drive the state-changing
routes:

- `DELETE /api/plugins/:id` → `pluginHost.remove` (`index.ts:1445-1453`) → `rmSync`
- `PUT /api/settings`, `POST /api/submit`, workspace create/edit/close

Combined with a DNS-rebinding page (attacker origin re-resolving to `127.0.0.1`),
this is a real escalation from "localhost-only" to "reachable by any page the
operator has open". Fix: validate `Origin`/`Host` against a localhost allowlist on
state-changing methods (or require a per-session token that the served UI embeds),
and do not send `allow-origin: *` on `/api/plugins`, `/api/settings` or
`/api/submit`.

### [LOW] The complexity estimator's seniority term is non-monotonic and its `taskClass` argument is unused

`engine/complexity.ts:112-119` adds a seniority bonus documented as "seniority
shifts the estimate slightly so escalation happens for the people who need it":

```ts
executive: 0.03, lead: 0.02, senior: 0.01, mid: 0, junior: 0.01,
```

Ordered junior→executive that is `0.01, 0, 0.01, 0.02, 0.03`: a **mid**-level
employee is rated *easier* than a **junior** one, which is the opposite of what
the comment describes (and of `Role.seniority`'s own ordering). The effect is
small — 0.01, against an escalation threshold that typically sits well above it —
but it is a transcription error in a term whose whole purpose is to be ordered
correctly, and the module's own doc comment says the heuristic "only has to be
*ordered* correctly".

Separately, `ComplexityInput.taskClass` (`:66`) is accepted, documented as part
of the input, and never read by `estimateComplexity` — so a caller passing a task
class that should influence difficulty gets no effect. Either use it or drop it
from the interface, but leaving it implies a signal that is not there.

### [HIGH] The client heartbeat is answered with a full office snapshot, 2,400×/day per console

`index.ts:785-788` handles the client's `{ type: 'ping' }` by pushing a **full
`runtime.state()`** as an `office.updated` event:

```ts
case 'ping': {
  push(ws, { type: 'office.updated', state: runtime.state(), at: Date.now() });
  return;
}
```

The client sends that ping every 25 seconds (`apps/web/src/app/ws.ts:182-187`,
`PING_INTERVAL_MS`), and `ServerEvent` has no `ping`/`pong` variant
(`packages/core/src/events.ts`), so there is no lighter reply available. Because
the payload is the same 293 KB `OfficeState` measured above (240 KB of it the
model catalog), one open console pulls ~293 KB every 25 s — **~42 MB per hour,
~1 GB per day, per tab** — and `runtime.state()` is rebuilt and re-serialised on
each one.

It is worse than bandwidth. The client treats `office.updated` as a snapshot
replacement, so each ping adopts the whole state and appends a lifecycle row:
`apps/web/src/app/store.ts:650-653` writes *"office state replaced by a full
server snapshot"* into the activity feed, and `adoptState` re-renders every
`useOffice()` subscriber — including the 3D canvas, whose sync effect is keyed on
freshly cloned arrays. The office therefore re-renders itself and fills its own
activity feed with noise every 25 seconds, for as long as a browser is open.

Fix: answer `ping` with a minimal `pong` (or an empty frame). The heartbeat
exists to keep the socket alive and should carry nothing else.

### [LOW] The full model catalog dominates every `hello` frame

`OfficeState.models` carries all 455 `ModelSpec` entries including their blended
quality opinions. Measured against the live server, the `/api/state` payload
breaks down as:

| key | bytes |
|---|---|
| `models` | **240,157** |
| `roles` | 17,038 |
| `floor` | 9,462 |
| `pipelines` | 8,176 |
| `plugins` | 8,072 |
| `employees` | 4,987 |
| *(25 other keys combined)* | ~5,300 |
| **total** | **293,193** |

So 82% of the initial state frame is the model catalog. It is sent on **every**
WebSocket connection (`docs/wire-protocol.md`: "A client needs no second request
to render") and served on every `GET /api/state`. The console needs tier, label,
price and provenance to render the Routing & cost page; the full per-model
opinion array is detail that only one page reads. Worth a projection, or a
separate lazy endpoint, especially since a 445-model OpenRouter catalog is the
normal case rather than the ceiling.

### [INFO] Event log has no index on `(run_id, id)` and no retention

`events` grows without bound and `eventsForRun` orders by `id`
(`store/store.ts:629-634`). Growth is dominated by the per-token rows above.
There is no pruning, vacuum or retention setting.

### [INFO] Reasoning tokens are billed but the estimator cannot distinguish them

`openaiCompat.ts:99-103` folds `reasoning_content` length into the `chars/4`
output estimate. Reasoning tokens are billed at the output rate, so this is
directionally right, but it compounds the estimate-accuracy problem above.

---

## Verified healthy

These were checked against the code and, where possible, against live behaviour.

- **Typecheck is clean** on `packages/core`, `apps/server` and `apps/web`
  (three separate `tsc --noEmit` runs, exit 0).
- **`pnpm test`**: server 557 passed / 0 failed / 4 skipped, 41.7 s; core 14
  passed / 0 failed.
- **Project checkers**: `check-failure-paths.mjs` 10/10 (unusable DB path still
  yields a non-persistent store that says why; missing/malformed skills do not
  throw); `check-css.mjs` reports no unknown classes and no dead CSS across 537
  classes and 54 source files.
- **Live boot is clean** (`logs/dev3d-server.out.log`): store ready, 3 plugins,
  block kit v2 with 24 modules / 21 core seats / 4 growth ports, 1 organisation,
  13 roles, 8 departments, 15 skills, 16 tools, 455 models, 55 `.env` values,
  discovery `deepseek: 2 model(s)`, `openrouter: 445 model(s)`, benchmarks 144 of
  238. No warnings, empty stderr.
- **The live API answers** on every documented read route: `/api/health`,
  `/api/state` (452 KB), `/api/providers`, `/api/models` (342 KB),
  `/api/workspaces`, `/api/runs`, `/api/skills`.
- **The wire-protocol contract holds** for the run shape: run statuses, stage
  records, per-turn `usage`, `servedBy`, `toolCalls`, `wroteFiles` and
  `attemptedRoutes` all persist and reload correctly;
  `GET /api/runs/:id` reconstructs a run with its turns and artifacts intact.
- **The LLM integration genuinely works end-to-end against real providers.**
  The persisted run proves routing, tool calling, streaming and failover all
  function: three turns on three *different* models across two providers, real
  token counts, real cost, tool calls executed and recorded with durations.
- **`web_search` is functional.** It failed 8/8 times inside the recorded run,
  but a direct call of the identical code path right now returns HTTP 200 with 10
  parsed anchors and 10 snippets. The failure was transient/blocking, not a
  parser regression — worth knowing before anyone "fixes" it.
- **`restart-server.mjs` correctly detects the listener.** `node
  scripts/restart-server.mjs --dry-run` reports `listening on 8787: pid 52152
  (via netstat)` and changes nothing. The `columns[1]` parse is right because
  real `netstat` output is indented, so the first header word does not occupy a
  column.
- **Cost arithmetic is exact.** `computeCost` reproduces the recorded
  `deepseek-flash` turn to the cent
  (`0.14 × 51,184 + 0.28 × 3,338 = $0.008100` against a recorded `$0.0081004`).
- **Memory scope isolation is enforced in SQL, not by convention.**
  `memory.search` takes `scopes` as a *required* argument with no default
  (`server/memory.ts:107`), and `store.searchMemoryFacts`
  (`store/store.ts:796-806`) builds the filter from parameter placeholders
  (`(f.scope = ? AND f.scope_id IS ?)`) rather than interpolation — so a scope id
  cannot be read as SQL, and `IS ?` (not `= ?`) is the correct null-safe form for
  the installation scope's `scopeId: null`. The activity filter is applied to the
  row, not the query (`:811`), so no ranking can surface a superseded fact as
  current belief. An empty scope list is answered before the query rather than by
  an `IN ()` that would be indistinguishable from "no facts".
- **`discovery.loadCache` validates before trusting**: version-checked, and a
  malformed entry is skipped rather than poisoning the catalog
  (`llm/discovery.ts:254-286`).
- **`modelList.ts` treats vendor responses as untrusted data** and is careful
  about it: bounded integers, capped model count, both per-token and per-million
  price conventions, "unrecognised ⇒ throw" kept distinct from "recognised but
  empty ⇒ []", and duplicate ids collapsed.

## Coverage gaps

- No live MCP server or vendor harness is configured in this checkout
  (`mcp.json` and `vendors.json` both ship with empty `servers`/`vendors`
  arrays), so those paths are exercised only by their unit tests here.
- The memory subsystem's semantic-search path and the pooled-benchmark /
  endpoint-health services were read but not exercised against live endpoints.
- No load or soak testing: concurrency ceilings, long-run memory behaviour and
  SQLite growth under sustained parallel runs are unmeasured.
- The web application, the plugin host, and the tools/sandbox confinement layer
  are reviewed separately.
