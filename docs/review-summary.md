# dev3d — technical review, consolidated verdict

Four parallel reviews of one tree, plus independent verification of the most
consequential claims. Detail lives in the companion documents:

| Document | Scope |
|---|---|
| [`review-core.md`](./review-core.md) | LLM adapters, provider registry, discovery, routing/scoring, run engine, turn/tool loop, persistence, event log |
| [`review-tools-sandbox.md`](./review-tools-sandbox.md) | The 15 built-in tools, path confinement, shell, git, approvals, SSRF |
| [`review-extensions.md`](./review-extensions.md) | Plugin host and manifests, MCP client, vendor harnesses |
| [`review-web.md`](./review-web.md) | The React/three.js console and 3D office |
| [`verification-prompt.md`](./verification-prompt.md) | The runnable campaign that tests all of the above against a live system |

---

## Verdict

**This is a genuinely well-engineered system with a security boundary that does
not hold, and a cost/observability layer that reports estimates as facts.**

The engineering quality is high and unusually honest — 557 server tests and 14
core tests pass, typecheck is clean on all three packages, the code comments
explain *why* rather than *what*, and the README's "Known gaps" section
volunteers weaknesses most projects would not. The LLM integration genuinely
works end-to-end against real providers, with working failover across two
vendors.

But three classes of problem recur, and none of them are in the "Known gaps"
list:

1. **A declared guarantee that nothing enforces.** The README's headline claim
   that every tool is "confined to the run's workspace root" is a *lexical*
   string check that a directory junction defeats — verified by execution, not
   by reading. `permissions` on a plugin is consent theatre with no runtime gate.
   `git`'s "read-only verbs cannot write" invariant is false. This is the same
   bug family the project's own last commit (`d214f16`, "enforce the controls
   that were only declared") set out to fix; the class is not exhausted.
2. **Unbounded waiting.** LLM HTTP calls have no timeout; git/shell subprocesses
   can fail to settle when a grandchild holds the pipe; MCP request bodies are
   read without a size cap. Every one of these turns a transient upstream problem
   into a permanently wedged agent that only a restart clears.
3. **Numbers that look authoritative and are not.** Every turn's token counts are
   a `chars/4` estimate because the streaming path never requests usage. A plugin
   can set a negative price and *refund* the budget that is supposed to be the
   hard stop.

### Severity roll-up

Across the four reviews: **4 CRITICAL, 28 HIGH, 55 MEDIUM**, and a long tail — 118
findings in total.

| Area | CRITICAL | HIGH | MEDIUM | LOW | INFO | total |
|---|---|---|---|---|---|---|
| Core (LLM, engine, routing, persistence) | 0 | 4 | 6 | 4 | 2 | 16 |
| Tools, sandbox, approvals | **2** | 3 | 5 | 7 | 2 | 19 |
| Plugins, MCP, vendors | 0 | 5 | 16 | 6 | 5 | 32 |
| Web application | **2** | 16 | 28 | 3 | 2 | 51 |
| **Total** | **4** | **28** | **55** | **20** | **11** | **118** |

Every count in that table was recomputed from the finding headings in the four
documents rather than taken from the subsystem digests, which is why the totals
differ slightly from the numbers quoted in those digests.

The distribution is itself the finding: **the highest-severity problems are not
in the code that is hardest to write.** They are in the seams — a string check
where a filesystem check was needed, a heartbeat that shipped a snapshot, a
declared permission nobody read, an approval list with no way to resync. The
hard parts (the run engine, the router's scoring, the MCP lifecycle, the 3D
scene graph) are largely sound.

---

## The seven things to fix first

Ordered by (severity × ease), not by count.

### 1. Make path confinement resolve the filesystem, not the string
`tools/paths.ts:11,26-48` imports only `relative, resolve` and compares
lower-cased strings. **Verified by execution:** with a junction inside a scratch
workspace pointing outside it, `resolveInWorkspace` returned the junction path,
`readFileSync` returned the outside file's contents, and a write created a file
outside the root. `..`, absolute paths, UNC, `\\?\`, `C:foo`, 8.3 names and
`file://` are all correctly blocked — but links are not, and links are ordinary
in a pnpm `node_modules` (229 reparse points exist in this checkout).

Scope note, in fairness: the *default* workspace (`./workspace`) is currently an
empty leaf with no reparse point inside it, so there is no pre-existing link to
exploit here today — the escape needs one created (an approved `run_shell`, or an
MCP/plugin tool). It becomes immediately exploitable the moment anyone points
`DEV3D_WORKSPACE` at the repo root, which `.env` permits
(`DEV3D_ALLOW_EXTERNAL_WORKSPACES=true`).

Fix: resolve with `realpathSync.native` and re-check containment after
resolution, refusing any component that is a reparse point unless its target is
inside the root.

### 2. Give every LLM call a deadline
`llm/openaiCompat.ts:293-298`, `llm/anthropic.ts:302-307` pass only the
operator-cancel signal to `fetch`; there is no `AbortSignal.timeout`, no retry,
no backoff anywhere in `llm/`. A provider that accepts the connection and stalls
never settles the turn, and the employee stays locked. Every other outbound call
in the codebase *is* bounded, so this is an oversight rather than a policy.

### 3. Stop the streaming path from discarding real usage
`engine/turn.ts:466-471` always supplies `onDelta`, so every turn streams, and
`openaiCompat.ts:193` then falls back to `chars/4` because the request never sets
`stream_options: {include_usage: true}`. Send it and prefer the reported usage.

### 4. Reject negative prices, and let a turn finish
Two one-liners with outsized effect: sign-check `costPerMTokIn/Out` in
`plugins/manifest.ts:134-135` (a negative rate *adds* budget — verified:
`computeCost(-5, -5, 10k, 1k) === -0.055`), and make one final tools-withheld
call when a turn hits `MAX_TOOL_ITERATIONS` so it returns an answer instead of
nothing.

### 5. Answer the CORS/Origin question
**Verified live:** the server returns `access-control-allow-origin: *` on every
method including `DELETE`, and answers preflight. With no auth, any page the
operator visits can therefore `DELETE /api/plugins/:id` (`index.ts:1445` →
`rmSync`), rewrite settings or start runs; a DNS-rebinding page can also read
`/api/state`. Validate `Origin`/`Host` on state-changing routes.

### 6. Make the heartbeat a heartbeat
`index.ts:785-788` answers the client's 25-second `{type:'ping'}`
(`apps/web/src/app/ws.ts:182-187`) with `office.updated` carrying a **full
`runtime.state()`** — the 293 KB payload whose `models` array alone is 240 KB.
There is no `ping`/`pong` in `ServerEvent`. **Verified from source:** the client
treats `office.updated` as a full snapshot replacement, adopting the state *and*
appending "office state replaced by a full server snapshot" to the activity feed
(`apps/web/src/app/store.ts:650-653`). So every open console, every 25 seconds,
forever: pulls ~293 KB, re-renders every `useOffice()` subscriber including the
3D canvas, and writes a junk lifecycle row into the feed. A trivial fix with a
large payoff — answer with a `pong`, or drop the state from the reply.

### 7. Give pending approvals a way back
`approvalList` is written **only** by the two live events
(`apps/web/src/app/store.ts:708-713`). `OfficeState` has no approvals field
(`packages/core/src/events.ts:102-218`), the `hello` frame carries none, and
there is no `/api/approvals` route — the server's `runtime.pendingApprovals()`
(`server/runtime.ts:1628`) is reached only for its *count*, in `/api/health`
(`index.ts:867`). So after a refresh, a reconnect or in a second tab, a blocking
approval is invisible and `ApprovalCallout` renders nothing — while the run waits
and the engine's approval timeout counts down. This is the one finding where the
data already exists server-side and only the transport is missing.

---

## What genuinely works

Stated plainly, because a review that only lists defects is as misleading as one
that only lists praise. Verified by execution or by reading with evidence:

- **The LLM pipeline is real.** The office's own persisted run routed three
  turns across three different models on two providers, executed tool calls with
  recorded durations, streamed, and failed over. Cost arithmetic is exact to the
  cent (`0.14 × 51,184 + 0.28 × 3,338 = $0.008100` against a recorded
  `$0.0081004`).
- **The lexical half of confinement is thorough.** `..`, absolute, UNC, `\\?\`,
  `C:foo` drive-relative, 8.3 short names, trailing dot/space and `file://` are
  all genuinely refused — as is `apply_patch` partial-failure rollback, which is
  atomic.
- **The approval flow is well built.** It fails closed on timeout, cannot be
  self-approved by a built-in, is correctly bound per git subcommand, and ACP
  vendor permissions default to refuse.
- **Extension hardening is real where it exists:** the tar/bundle parser, panel
  widget caps (24 widgets / 60 rows / 500 chars), default-deny MCP grants, ACP
  write refusal, provider-shadowing prevention, and preset honesty in
  `vendors/config.ts` (only the harness with a genuine sandbox flag claims
  read-only is enforced).
- **Memory isolation is enforced in SQL**, with a required (not defaulted) scope
  argument, parameter placeholders, and null-safe `IS ?`.
- **`modelList.ts` treats vendor responses as hostile input** and is careful
  about it: bounded integers, capped counts, both price conventions, and
  "unrecognised ⇒ throw" kept distinct from "empty ⇒ []".
- **The project's own checkers are meaningful** — `check-failure-paths.mjs` does
  real work (unusable DB path, malformed skills) rather than asserting trivia.

---

## How the findings were established

Claims marked **verified by execution** were reproduced during this review, not
inferred:

| Claim | How |
|---|---|
| Junction escapes `resolveInWorkspace` | Created a real junction in a scratch workspace; `resolveInWorkspace` allowed it, `readFileSync` returned the outside file, a write landed outside |
| Negative price refunds budget | Called the real `computeCost` with negative rates → `-0.055` |
| CORS exposes state-changing routes | Live `OPTIONS`/`GET` against `127.0.0.1:8787` with a foreign `Origin` |
| `store.recentRuns` is dead code | Zero call sites; `/api/runs` returned `[]` with a run on disk |
| Token accounting is estimated | No `stream_options`/`include_usage` anywhere; `onDelta` always supplied |
| Per-token event writes | 3,483 `turn.reasoning` rows of 110 bytes each in one run, 96% of the log |
| `models` dominates the `hello` frame | 240 KB of a 293 KB `/api/state` payload |
| Seniority term is non-monotonic | `junior=0.01, mid=0, senior=0.01` |
| Heartbeat returns a full snapshot | `index.ts:785-788` + `ws.ts:182-187` + `store.ts:650-653` read together; no `ping`/`pong` in `ServerEvent` |
| Approvals cannot be resynced | No `approvals` field on `OfficeState`, no `/api/approvals` route; `pendingApprovals()` reached only for its count in `/api/health` |

Claims that could **not** be reproduced in this sandbox and rest on source
reading alone: the `git --output=`/`--contents=` bypass (child-process stdio is
`EPERM` here, so `git` could not be executed) — though the `Set.has` exact-match
is plainly visible at `git.ts:268`, and `blame` has no write gate; the vendor
grandchild-holds-the-pipe hang, which needs a real process tree; and the entire
web-application review, which was not executed in a browser (`pnpm` is blocked
and no server was started for it), so its two CRITICAL findings rest on careful
code reading — both of which I independently confirmed against the source above,
but neither of which has been observed in a live console.

---

## Coverage gaps

- **Nothing dangerous is switched on in this checkout.** `.env` has
  `DEV3D_ALLOW_PLUGIN_INSTALL=false`, no MCP servers, no vendors; `mcp.json` and
  `vendors.json` both ship with empty arrays. So the plugin-code, MCP and vendor
  findings are static or fixture-tested, not exercised against a live extension.
- **No load or soak testing.** Concurrency ceilings, SQLite growth and
  long-session memory behaviour are unmeasured.
- **Semantic memory search, pooled benchmarks and endpoint health** were read but
  not exercised against live endpoints.
- **The 3D asset pipeline** (Blender scripts, GLB regeneration) was not
  regenerated or visually judged; the README flags this as unjudged by eye.
- **The web application was never run in a browser.** Its 51 findings come from
  code reading plus the project's own smoke harness (192/192 checks passing),
  and the two CRITICAL ones are worth five minutes of live confirmation: capture
  the `/ws` traffic to see the heartbeat snapshot, and refresh the console with
  an approval pending.
- **`mcp/http.ts` has zero tests**, and the review found two defects in it
  (session-DELETE, CRLF-SSE) — an untested growth surface.

---

## Note on method

The three subsystem reviews were run as independent agents that did **not** see
the core review, precisely so their findings would be independent rather than
confirmatory. Where they overlap with the core review, that agreement is
evidence. The most consequential claims from each were then re-verified by
execution here rather than accepted on report — which is how the
`resolveInWorkspace` junction escape, the negative-price refund and the CORS
exposure were confirmed, and how the severity of the junction escape was
*scoped down* (no pre-existing link in the default workspace) rather than
reported at face value.
