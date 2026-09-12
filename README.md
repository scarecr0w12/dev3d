# dev3d

A 3D office where a hierarchy of LLM agents actually does the work.

You describe a task to a CEO agent. The CEO turns it into an objective, puts
specialists on it, they research and argue the approach, a CTO writes a
file-level plan, developer agents write real files into a workspace, QA tries to
break it, and the CEO reports back. Every one of those agents is a separate LLM
call with its own role, its own skills, and its own model — a one-line intake
summary costs a nano model while an architecture review costs a frontier one.

The office is a real GLB model in the browser: employees sit at named desks,
change colour by status, and walk to the meeting room to debate.

---

## Status

Everything below is implemented and verified: the engine, transport and
persistence end to end against a running server; the web UI by typecheck, a
runtime reducer harness, and a production bundle that the orchestrator serves.

**Requires Node 24 or newer.** The suites run TypeScript directly via
`node --test --test-isolation=none`, and persistence is built on the unflagged
`node:sqlite`; both mean Node 24. See [Quick start](#quick-start).

| Area | State |
|---|---|
| Shared domain contracts (`packages/core`) | Complete |
| Model layer: providers, adapters, discovery, curated overlay, quality blend, router | Complete — 5 suites |
| Tool layer: 9 restricted tools | Complete — 9 tests |
| Skill layer: markdown loader + per-turn selection | Complete — 8 tests, 15 skills on disk |
| Org chart: 13 roles, 8 departments, 3 pipelines | Complete — 11 runtime tests, per organisation |
| **Organisations**: many independent workspaces | Complete — floor switching covered by the protocol suite |
| **Settings**: installation-wide + per-floor | Complete — General/Models/Skills/Budget/Safety |
| **Run engine**: 4 stage modes, tool loop, budget, cancel | Complete — 17 tests |
| **Server**: HTTP API + WebSocket protocol, SQLite | Complete — 202 protocol checks |
| **Plugins**: providers, models, skills, routing, tools, templates, pipelines, panels, updates, marketplace | Complete — 47 tests, 3 shipped examples |
| **Generated office space**: block kit + growth, drawn per floor | Complete — 13 tests, automatic and manual growth |
| Blender office asset (`office.glb`) | Complete — 21 seats, 7 room anchors |
| **Multi-floor office**: one 3D floor per organisation | Complete — 12 floor checks |
| **Plan page**: idea → conversation → reviewable brief → run | Complete — multi-turn, saved per browser |
| **Inspector**: resizable, master-detail, jump-to-anything | Complete — width remembered |
| Web UI (React + three.js) | Complete — 10 tabbed pages, resizable inspector |
| Docs | `README.md` (this file) |

Test counts here are the ones `node --test` reports per file; the totals are in
[Verification](#verification). They are the first thing to go stale, so if you
change a suite, change its number — or drop the number and say what the suite
covers, which is what a reader actually needs.

---

## Quick start

```bash
pnpm install                 # Node >= 24
cp .env.example .env         # optional: add provider keys for live models

pnpm dev:server              # orchestrator on http://127.0.0.1:8787
pnpm dev:web                 # office UI on http://127.0.0.1:5273 (proxies /api and /ws)
```

**Node 24 or newer, and this is a real requirement rather than a preference.**
Two things need it: `node --test --test-isolation=none`, which the suites use to
run TypeScript directly without a build step, and the unflagged `node:sqlite`
that persistence is built on. On Node 22 the *server* runs but `pnpm test` does
not, which is the worst of both — you would be running an untested tree. CI
checks this: the test suite is executed on a real runner, not just typechecked.

**No API keys are required.** With none configured the server boots in `mock`
mode: the entire pipeline still runs, employees are scripted instead of billed,
and the office is fully demonstrable. `/api/health` reports the active mode, and
the UI badges it so nobody thinks they are spending money.

Set `DEV3D_LLM_MODE=live` to require real providers, or `mock` to force the
scripted ones even when keys are present.

**The mode always comes with its reason.** `/api/health` and `OfficeState` carry
`llmModeReason`, and the badge shows it: *"DEV3D_LLM_MODE=auto, and deepseek,
openrouter are configured"*, or *"DEV3D_LLM_MODE=mock forces scripted employees
even though deepseek, openrouter are configured"*. That last case used to log
**"no provider keys found"**, which was simply false and cost an operator an
afternoon looking for a configuration bug that did not exist — so a mode is never
reported without the reason it resolved the way it did.

**`.env` is read once, at startup** — correct, and completely invisible. So
editing it does nothing to a running server, which looks exactly like a bug. The
health endpoint and the console now detect that: `configStale` is set when `.env`
has been modified since boot, or when a provider key has appeared in the
environment since the mode was resolved, and the console says so with the remedy
(*"restart the orchestrator to apply it"*).

### Driving it without the UI

```bash
curl -s localhost:8787/api/health
curl -s -X POST localhost:8787/api/submit \
  -H 'content-type: application/json' \
  -d '{"brief":"Fix the null dereference in the session lookup and add a regression test"}'
curl -s localhost:8787/api/runs/<runId>
```

---

## Architecture

```
packages/core      Shared contracts. No network, no filesystem, no React.
                   Both the orchestrator and the UI compile against exactly
                   these types, which is what keeps the wire protocol honest.

apps/server        The orchestrator.
  config.ts        Env-driven configuration; mock/live resolution.
  llm/             Provider adapters (OpenAI-compatible, Anthropic, mock),
                   the model catalog with prices, and the fail-over registry.
  router/          Cost-aware model selection.
  skills/          Skill markdown loader, index, and per-turn selection.
  tools/           The 9 tools, all confined to the workspace root.
  org/             The shipped company and its pipelines.
  engine/          complexity -> prompt -> turn -> stage -> run.
  store/           SQLite persistence (node:sqlite), with a memory fallback.
  server/          Runtime: org chart, roster, approvals, event fan-out.
  index.ts         HTTP + WebSocket entry point.

apps/web           The office UI (React 18 + three.js).

blender/scripts    Authoring scripts for the office asset.
skills/*.md        15 skill documents, loaded from disk at boot.
scripts/           inspect-glb.mjs, smoke-ws.mjs
```

`packages/core` is deliberately dependency-free: `model.ts`, `skill.ts`,
`org.ts`, `run.ts` and `events.ts` are the vocabulary that the engine, the store
and the browser all speak.

---

## The web app

React 18 + three.js in `apps/web`. **The 3D office is the application**: the
canvas fills the viewport edge to edge, and every other surface floats over it.

```
┌─ top bar ── brand · Office|Plan|Projects|Org|Runs|Activity|Routing & cost|Skills|Plugins|Settings ─┐
│                                                                              │
│                        the office (full-bleed canvas)                        │
│                                                                              │
│  ┌ info ────┐                                            ┌ inspector ─────┐ │
│  │ company  │                                            │                │ │
│  │ posture  │                                            │  (resizable,   │ │
│  │providers │                                            │  master-detail)│ │
│  │ legend   │                                            │                │ │
│  └──────────┘                                            └────────────────┘ │
│                    ┌─ brief dock (collapsible) ─┐                            │
│                    └───────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar** — brand, the tabbed pages, connection/mode/spend at a glance, a
  **Jump** box (⌘/ctrl-K), and toggles for the two popouts.
- **Stage** — the office canvas, always mounted. Switching tabs never re-creates
  the renderer, so the camera, the avatars and the socket keep their state.
- **Page sheets** — the selected tab's page floats over the office. It is a
  labelled region, not a modal: the office stays live and clickable behind it,
  and Escape returns you to it. A sheet stands the info popout down for room, and
  sizes itself against the inspector's actual width rather than a guess.
- **Info popout** (left) — base information: mission, routing posture (live
  control), providers and their key status, headcount by status, spend, what is
  in flight, the workspace path, the interaction hint, and Resync.
- **Inspector popout** (right) — `Agent` | `Run` | `Chat`, following what you
  clicked but always yours to override. Two things make it a work surface rather
  than a readout: **both inner edges drag** (width is remembered, and the pane
  grows towards the dock instead of into a fixed letterbox), and **each tab owns
  its own scrolling** — `Agent` and `Run` are master-detail, a compact chooser
  above a detail pane that takes the remaining height, so what you selected is
  never below the list you selected it from. It stands down on Plan, which is a
  workspace in its own right.
- **Brief dock** (bottom) — the composer, small by default and expandable to the
  full pipeline stage list. It centres itself in whatever room the popouts leave,
  and lifts clear of a grown inspector instead of hiding under it.
- **Approval callout** — floats top-centre whenever something is waiting, because
  an approval is the one thing that stops the office dead.

### Plan — the conversation before the work

Every other surface is about work that already exists. **Plan** is for the work
that does not yet. A brief is a decision, and a decision made in one shot is
usually a bad one, so this is where an idea is argued out first:

```
┌ plans ────┐  ┌─ the conversation ──────────────┐  ┌ the brief ──────────┐
│ ▸ idea 1  │  │ you: our checkout double-charges│  │ **Objective:** …    │
│ ▸ idea 2  │  │ ceo: what does done look like?  │  │ Done means:         │
│ + New     │  │ you: [Draft the brief]          │  │ – …                 │
└───────────┘  └─────────────────────────────────┘  │ project/pipeline/$  │
                                                    │ [ Submit brief ]    │
                                                    └─────────────────────┘
```

- Three columns, each with its own overflow — the same mistake the inspector made
  is avoided here from the start.
- **The conversation has memory.** The browser replays the whole thread with each
  turn, so a plan is a refinement rather than a series of unrelated questions.
- **Nothing is commissioned until you press Submit.** The conversation costs
  model calls and nothing else; pressing *Draft the brief* puts the model's answer
  in the brief panel, where it is editable before it becomes a run.
- **Sessions are yours.** They live in this browser's `localStorage` and survive a
  refresh, because they are drafts rather than office records. What gets submitted
  becomes a run, and that is the server's.
- The shaper is the **CEO** — the role that owns an objective for a run — falling
  back to the first employee in a building with an unusual org chart.

### Jump to anything

The inspector can only show one thing at a time, which is fine until you know
what you want and not where it is. **⌘/ctrl-K** opens a search over everything the
console already holds — people, runs, artifacts and the event feed — and picking a
result selects it and lands you on the right tab. It is a search over client state
rather than a server query, so jumping is instant and cannot fail on a round trip.

The pages are compositions of the same panels: `Projects` (the building), `Org`
(departments + the org chart), `Runs` (approvals, run list, transcript,
artifacts — two independently scrolling columns), `Activity` (the event feed),
`Routing & cost`, `Skills`, `Plugins` (the installed list, each plugin's generated
settings form, and the marketplace), and `Settings` (General / Models / Skills /
Budget / Safety). The **floor selector** in the top bar switches organisation and
swaps the whole console with it; the brief dock carries the matching floor picker,
and each run shows the path it was confined to.

**The building** (`src/office/floors.ts`, `OfficeCanvas.tsx`). The loaded GLB is
a *template*: every organisation gets a clone of it, raised to its own floor
(`floorOffset`, 4.2 m per storey) inside its own group. Only the floor being
looked at shows its walls — the others keep a thin coloured plate, which is what
makes the stack legible without paying for thousands of hidden wall meshes. Seat
anchors are indexed *per floor group*, so every organisation's employees are
placed against their own floor's anchors in world space; the shadow plane and the
three directional lights climb with the floor, or an upper storey would be lit
from underneath. Switching floor — via the selector or by clicking a run on
another floor — is a visibility change plus a camera move, not a rebuild.

**The office** (`src/office/`) loads `office.glb` with `GLTFLoader` and places
every employee by *looking up the GLB node named in `role.seatId`* — never by
hard-coded coordinates. Avatars are built procedurally from `Role.appearance`
(`bodyColor`, `accentColor`, `height`) and animate per `EmployeeStatus`: idle
bob, a pulse while thinking, typing while working, turning toward the room while
talking. Clicking one raycasts and selects it, adding a pulsing floor ring and
easing the camera in. An employee with an unknown or `null` seat is parked on a
bench row near the dev floor and the viewport names them; a missing anchor is
logged once and never crashes the scene. `prefers-reduced-motion` is honoured.

**The store** (`src/app/store.ts`) implements `ClientOfficeStore` from
`@dev3d/core` and handles every `ServerEvent`; the switch's default branch
asserts `never`, so a future variant fails the typecheck instead of being
silently dropped. Unknown frames at runtime are ignored safely. Subscriptions are
per-slice, so a `turn.delta` frame re-renders only the streaming turn. The
socket reconnects with backoff and jitter and adopts the fresh `hello` wholesale.

**Layout constants worth knowing** (`src/styles.css`, the `stage` section): the
popouts and sheets stop short of the top and bottom of the viewport
(`--popout-top`, `--popout-bottom`) so the 3D view's own HUD strips stay readable
underneath them, and the stage publishes `--inset-left` / `--inset-right` so the
dock and the approval callout centre themselves in the room that is actually
left. Popouts start open only at ≥1500px (`useMediaQuery`); below that they are
collapsed and the user opens them. The inspector is the exception to the fixed
geometry: `--inspector-width` and `--inspector-height` are written from the
console, both inner edges drag (see `usePaneResize`), the width is stored in
`localStorage`, and `--dock-lift` keeps the dock clear of a pane that has grown
tall — because how tall the dock wraps is a measurement, not a guess.

---

## How a run flows

A **pipeline** is the shape of the conversation a brief travels through. Three
ship today: `product-build` (10 stages), `code-change` (7) and `quick-answer`
(3). A pipeline is declarative data, so the org chart editor can build new ones
without touching the engine.

Each stage declares a **mode**, which decides how its people are scheduled:

| Mode | Behaviour |
|---|---|
| `single` | One employee, one turn. |
| `parallel` | Everyone listed works at the same time, bounded by `DEV3D_MAX_CONCURRENCY`. Each gets its own knowledge snapshot; results merge in role order. |
| `debate` | Positions, then rebuttals over N rounds, then the facilitator rules on it and records the decision. Emits `speech` events so the office can show who is talking. |
| `review-loop` | Reviewers critique in parallel; the chair synthesises a verdict. If the verdict objects, the people who **actually wrote the files** revise, up to a hard iteration cap. |

A **turn** is one employee and one model call: select the skills the task needs,
price the work and route it, then let the employee call tools until it stops
asking for them (bounded at 8 round trips). Everything the UI shows — streamed
text, reasoning, ordered tool calls, token and dollar cost, files touched — is
produced there.

Knowledge accumulates across the run: stage summaries, artifacts, written files
and who wrote them are threaded forward, so a reviewer sees the real files and a
report sees the decision the workshop reached.

### Failure policy

- A stage that produces nothing halts the run, unless the stage is `optional`.
- An optional stage that fails is recorded and the run continues.
- Exceeding the budget always halts the run.
- A tool that fails returns `ok: false` with an actionable message instead of
  throwing, so the employee can correct course rather than dying.
- Approval requests always resolve: denied, answered, or timed out as refused.

---

## Models and routing

### Which models exist is the provider's answer, not ours

`apps/server/src/llm/catalog.ts` is a **curated metadata table**, not a roster.
The distinction is the design, because two different questions used to be
answered by one static array:

- **Which models exist?** Only the provider knows, and it changes without a
  commit. This checkout shipped `deepseek-v4-flash-vision-exp` for DeepSeek, and
  the DeepSeek endpoint does not serve it — a routable model that could only ever
  produce a failed turn. That was found by asking, not by reading.
- **What do they cost, and how good are they?** No `/models` endpoint answers
  this. Prices and capability have to be curated, measured, or pooled.

So membership comes from **discovery** and metadata comes from the **overlay**:

```
provider /models   →  membership, plus facts the vendor knows (context, price, tools, vision)
curated table      →  judgement the vendor cannot state (tier, strengths, quality)
learned outcomes   →  what this office observed on its own work
pooled benchmarks  →  what a public aggregator measured
```

A model the provider reports but the table has never heard of is still routable,
flagged `unrated`: its tier is inferred from its published price — a better
signal than its name, which is marketing — and the console says the tier is a
guess. A model the table describes that the provider no longer serves is
**withdrawn** and logged by name, so a retired model becomes visible instead of
silently vanishing.

Discovery runs at boot, behind the listening socket and never awaited: six
providers are six round trips, and boot must not depend on somebody else's
uptime. Results are cached to disk and refreshed on a TTL. The **Routing & cost**
page has a *Fetch model lists* button, per provider and for all of them.

Three outcomes are kept distinct, because they have opposite consequences:

| Situation | Recorded as | Effect on the catalog |
|---|---|---|
| The provider answered | `discovered` | Its list is authoritative |
| The provider answered with nothing | `discovered`, zero models | Emptiness is a fact about the provider |
| We could not ask | `degraded`, with the reason | The curated seed stands in; nothing is emptied |

`mock` mode never discovers, so the keyless office keeps its full demonstrable
catalog. `DEV3D_MODEL_DISCOVERY=false` keeps the office entirely offline.

### How a model is chosen

Every role carries a `ModelPolicy`: a default tier, per-task-class overrides,
hard min/max bounds, an escalation threshold, and optionally a **pin to one
concrete model**. The router combines that with the global posture
(`cheap` | `balanced` | `quality`), a complexity estimate for the specific turn,
and the remaining budget, then ranks candidates on a score:

```
score = 0.45 × fitness for this task class
      + 0.20 × overall quality
      + 0.35 × tier affinity (position in the policy's tier walk)
      − cost pressure × relative cost        (0.30 cheap, 0.12 balanced, 0.03 quality)
```

`fitness` is per `TaskClass`, so a coder-tuned model and a generalist of the same
size are no longer interchangeable — which the flat `strengths` list could never
express on its own. Ranking used to be a tier walk with a cost tiebreak, and
`ModelSpec.strengths` was populated and displayed but **never read by the
router**.

Two properties matter more than the weights:

- **With no quality information this reproduces the old behaviour exactly.** The
  quality terms come from a prior that is the mean of the *rated* population, so
  when nothing is rated they cancel; and cost pressure is switched off entirely,
  so price cannot pull a turn off the tier the policy asked for when nothing is
  known about what that money buys. It is pinned by test, not asserted in a
  comment.
- **A plugin routing rule still cannot move a turn to another tier.** A rule's
  declared tier joins the front of the walk, as it always did, and its
  model/provider preferences apply as score bonuses *confined to that tier* — so
  a rule can reorder candidates without making the router pick something the
  policy did not allow.

A **pin** is honoured inside the policy's own `minTier`/`maxTier` bounds. One that
is missing, excluded, lacks a required capability, or sits outside the bounds is
**named in the routing reason** and normal selection stands, so a pin that is not
in force is visible rather than a silent fallback.

The complexity estimate is a deterministic function of observable things: the
stage kind, how much text the turn must digest, whether it touches files, how
many revision passes have already failed to settle it, and whether the text names
a known-hard problem (concurrency, migration, security, protocol, idempotency…).
It is a heuristic and meant to be one — it only has to be ordered correctly.

### Where quality numbers come from

Three sources, kept as separate opinions rather than averaged into one anonymous
number, because they fail differently:

| Source | What it is | Confidence | Leaves the machine |
|---|---|---|---|
| `curated` | The table in `llm/catalog.ts`: tier-derived, with explicit per-class corrections where a model's character is genuinely known | 0.5–0.7 | No |
| `learned` | Beta-smoothed outcomes from this office's own finished turns | grows with evidence | No |
| `pooled` | Artificial Analysis intelligence / coding / math indices | 0.55 | Yes, opt-in |

The blend is confidence-weighted, and a learned score is **shrunk towards its
prior** rather than reported raw: five observations are needed to move an estimate
halfway, so one bad turn cannot condemn a good model and one success cannot make
an unproven one look proven. An **operator correction** (Settings → Models)
enters as the loudest opinion there is, because a human who has run the model on
their own work outranks a benchmark that measured somebody else's.

The learned layer reads the persisted turn records directly rather than keeping a
second table, so the two cannot disagree. It separates three cases a naive "did it
fail" counter conflates: a cancelled turn is the operator's decision and votes on
nothing; a turn whose `servedBy` differs from its routed model is a **failure for
the routed model** and a success for whatever actually answered — without which a
model that fails every single time would have no observations at all, invisible
exactly where it should be most visible.

### Pooled quality, and what the public data actually contains

With an `OPENROUTER_API_KEY`, `GET /api/v1/benchmarks` (bearer token) returns
three source shapes in one payload:

| Source | Contributes | Maps onto |
|---|---|---|
| `artificial-analysis` | `intelligence_index`, `coding_index`, `agentic_index` | overall quality; coding/review/testing/architecture; ops/planning/workshop |
| `design-arena` | Elo, win rate, timing, per arena and category | `design` — the creative counterpart to a coding index |
| `openrouter` | its own runs (`gpqa_diamond`, …) with accuracy | `research` |

Because it *includes* the Artificial Analysis indices, this makes a separate
`ARTIFICIAL_ANALYSIS_API_KEY` redundant: one credential covers more ground. It is
still supported for anyone who has one and would rather not route through
OpenRouter for it.

**The index scale is calibrated from the data, because a fixed one is wrong.**
The published example shows values around 60–90, which invites `(v - 15) / 65`.
Measured against the live payload:

```
intelligence_index   min  3.8   p50 22.3   max 53.4
coding_index         min  2.7   p50 42.8   max 81.6
agentic_index        min  0.1   p50 17.2   max 58.0
```

That window would place the *median* model at 0.11 and never award a top score to
anything. So every index is converted to a **percentile of the population the
provider actually returned** — self-calibrating as the field moves, no invented
constants, and honest about being a standing among benchmarked models rather than
absolute capability.

**Coverage is partial, and the console reports the real numbers rather than
implying otherwise.** Measured: **118 of OpenRouter's 445 models** match a
benchmark row. The payload uses dated snapshots
(`anthropic/claude-fable-5.1-20260831`) that frequently do not match a current
model id. So for most models the pooled opinion is simply absent — which is
precisely why the learned layer is the one that usually matters: it covers every
model this office actually runs.

**A false match would be worse than a miss**, so matching is two-tier. A
full-slug match (`deepseek/deepseek-chat`, after stripping our own provider
prefix) is unambiguous. A bare-name match is used **only when that name appears
once in the whole payload** — otherwise the key is poisoned, because
`vendorA/llama-3.3-70b` and `vendorB/llama-3.3-70b` both reduce to `llama3370b`
and handing one of them the other's scores would mislead routing while looking
authoritative.

### Uptime: a routing signal that needs no key at all

`GET /api/v1/models/{author}/{slug}/endpoints` is public and lists every upstream
OpenRouter would route a model to. Measured field coverage across 34 endpoints:

| Field | Populated |
|---|---|
| `uptime_last_30m` | **79%** |
| `latency_last_30m` | **0%** |
| `throughput_last_30m` | **0%** |

So this tracks **uptime and nothing else**. Latency and throughput are documented
fields that are simply empty in the live payload; a speed-aware router built on
them would have been built on zeros.

The router scores it as a **penalty, never a filter**: `0.30 × (1 − uptime)`, so
a model at 0% loses about a tier and a half and one at 99% loses 0.003. It is a
demotion rather than an exclusion because uptime is a rolling figure that can be
stale, and hard-excluding on a stale reading would remove a good option — with a
pinned role having no way back. The retry-and-fail-over loop already handles a
genuinely dead provider.

Two rules keep it from doing harm. **Unknown contributes exactly nothing** — the
same rule quality follows — so a model on a provider we cannot ask about is never
penalised for being unmeasured. And lookups are **on demand and never awaited**:
the router asks as it considers a model, a model nobody routes to is never
fetched, and the first turn on a new model routes exactly as it would have before
this existed. The best endpoint wins the aggregate, because that is the one
OpenRouter will actually use; the healthy-endpoint count travels alongside it, so
"the only one of twelve still standing" is visible rather than hidden by an
average.

`/analytics/*` is **not** wired, and cannot be with a normal key: it answers
`403 Only management keys can access analytics`. It is also about your own spend
rather than model capability, so it belongs in a cost dashboard, not in routing.

```
GET    /api/models             → the merged catalog, with provenance
GET    /api/providers          → status, including how each model list was obtained
POST   /api/models/discover    { providerId?, force? }
POST   /api/models/benchmarks  → refresh pooled quality; returns coverage
POST   /api/models/health      { limit? }  → sample endpoint uptime; returns the readings
```

Prices in the curated table are **estimates for routing and display, not billing
truth**. They only need to be ordered plausibly — and where a provider publishes
real ones, discovery overwrites them.

**Correcting a model does not need a code change.** Settings → Models overrides a
model's tier, its per-million prices, and its quality and per-task-class fitness
for the whole installation. The registry reads the overrides on every use, so a
correction changes routing and cost reporting on the next turn. An override is a
patch, so the fields it does not mention keep the catalog's values, and it is
validated against the live catalog — a tier that is not a tier is refused, and an
entry for a model that no longer exists is dropped and logged rather than left
behind in the settings document. A quality correction enters the blend as the
loudest opinion there is.

The **Routing & cost** page reports coverage for every signal — curated, learned,
pooled and uptime — rather than implying that a thin one is a complete one, and
carries the buttons that re-fetch model lists, benchmark scores and endpoint
uptime.

---

## Tools and confinement

Nine tools: `think`, `list_dir`, `read_file`, `search_files`, `write_file`,
`edit_file`, `run_shell`, `web_search`, `web_fetch`.

- Every path funnels through one `resolveInWorkspace` choke point that rejects
  `..`, absolute paths outside the root, and Windows drive-relative tricks like
  `C:foo` (comparison is case-insensitive).
- **The root it resolves against is the workspace of the run being served**, not
  a single global directory. Two projects can be worked on at once and neither
  can see the other's files. See [Projects](#projects).
- `run_shell` is the only tool that goes through a human approval round trip,
  and it is the only tool that can be switched off safety-wise — see
  `DEV3D_AUTO_APPROVE_SHELL`.
- Grants are enforced per employee: the org chart decides who may hold a tool,
  and anything else is refused with a message the model can act on.

---

## Projects, organisations and floors

One office is a **building**. Each **workspace is an independent organisation**
occupying one floor: it owns its own company, departments, roles, enabled skills,
pipelines, budget and directory. Two floors share nothing but the building they
sit in — the portal team and the payments team have different people, different
skills and different money, and neither can see the other's files.

The distinction between the two layers is the whole design:

| Layer | What it holds | Where it is edited |
|---|---|---|
| **Installation** (one per office) | providers, model catalog, concurrency, approval policy, where new floors are created | Settings → General, Models, Safety |
| **Organisation** (one per floor) | company, departments, roles, skills, pipelines, budget, directory | Settings → Skills, Budget; Org tab; Projects tab |

A run belongs to exactly one organisation. `Run.workspaceId` and
`Run.workspacePath` are resolved at submit time and frozen onto the run, so its
record stays truthful after the floor is renamed or closed.

Create a floor from the **Projects** tab, or the floor selector in the top bar
switches which organisation you are looking at — that swaps the entire console
context, not just a filter.

```
POST   /api/workspaces          { name, description?, color?, folder?, path?, skillIds? }
PUT    /api/workspaces/:id      { skillIds?, budget?, name?, description?, color? }
DELETE /api/workspaces/:id
GET    /api/workspaces          → one summary per floor
GET    /api/settings            PUT /api/settings   { …OfficeSettings }
```

A new floor opens **fully staffed** — a copy of the shipped company, every skill
enabled, the installation's default budget — because firing three roles is
quicker than hiring thirteen. The rules that keep the building safe:

- The directory a workspace names becomes fully readable and writable to *that
  organisation's* employees, and to nobody else's.
- A folder name may not contain separators or `..`, may not escape the
  workspaces root, and two floors may not share a directory.
- Absolute paths outside the root are accepted only while
  `DEV3D_ALLOW_EXTERNAL_WORKSPACES` is true; the default floor cannot be closed.
- Switching a skill off for a floor also trims it from every role holding it, so
  a role can never reference a skill its organisation has disabled.

---

## Plugins

A plugin is how the office gains a model, a skill, a routing rule, a tool, a role
template, a pipeline or a console panel **without anyone editing this repository**.
The system exists in its current shape for one reason: to be the backend a
marketplace website talks to later.

Two kinds, and the distinction is the point:

| | Declarative | Code |
|---|---|---|
| Ships | `plugin.json` only | `plugin.json` + an `entry` module |
| Can contribute | models, skills, role templates, pipelines, routing rules, UI panels | all of that, **plus tools** and event subscriptions |
| What it costs you | nothing — it is data | it runs in the orchestrator's process with the orchestrator's authority |

The console shows which one you are looking at before you enable it, and says so
in words rather than a colour.

**What a plugin can actually change.** Being precise about this matters more
than the feature list, because a contribution the host publishes but nothing
reads is indistinguishable from one that works. Everything below is wired:

| Contribution | What it reaches |
|---|---|
| `providers` | **Live.** A whole provider: adapter kind, base URL, and the *name of the environment variable* holding the key. The registry rebuilds on every plugin change, so it appears without a restart. https only, or keyless http on the loopback address. |
| `models` | **Live.** Merged into the provider registry's catalog, so the router can pick it and the Models tab shows it. |
| `skills` | **Live.** Merged into the office skill catalog, and a floor can enable one like any other skill. |
| `routingRules` | **Live.** Applied by the router to reorder candidates, scoped by `taskClass`. |
| `toolNames` (code) | **Live.** Registered, namespaced, and grantable per role from the Org tab. |
| `roleTemplates` | **Live.** Offered in the hire form alongside the floor's own roles. |
| `pipelines` | **Live.** Offered to every floor — a plugin cannot know which organisations exist, so "enable per floor" would mean editing thirteen floors to turn one on. |
| `uiPanels` | **Live.** Rendered in the placement the manifest declares. |
| `settings` | **Live.** Rendered as a form; values are coerced against the manifest on every write. |

### Panels: data, never code

A panel is how a plugin gets a surface in the console without the console having
to trust it. It declares either a fixed `body` of widgets, or a `source` URL that
**the server** fetches and validates:

```jsonc
{
  "id": "local-model-status", "title": "Local model",
  "placement": "settings",              // inspector | runs | settings | office-overlay
  "summary": "what this plugin registered",
  "body": [
    { "kind": "keyValue", "label": "Registered provider",
      "rows": [{ "key": "endpoint", "value": "http://127.0.0.1:1234/v1" }] },
    { "kind": "note", "text": "This panel is data, not code." }
  ]
}
// or: "source": { "url": "https://plugin.example/panel.json", "refreshMs": 30000 }
//     → { "widgets": [ …the same closed set… ] }
```

`PanelWidget` is a closed set — `metric`, `keyValue`, `table`, `list`, `bars`,
`note` — so the renderer can index cells positionally and a hostile manifest
cannot render an unbounded structure. Bodies are capped (24 widgets, 60 rows,
500 characters) and truncated rather than rejected. A `source` is fetched
server-side with a 10 s timeout, cached for at least 5 s, coalesced so concurrent
consoles share one request, capped at 12 live panels, and refused unless it is
http(s). **The browser never learns the plugin's URL**, so a panel endpoint cannot
be aimed at the operator's machine, and a dead one costs a panel rather than the
console.

### What a plugin still cannot do

- **Reach the browser.** No panel ships JavaScript. That is the trade: panels are
  less expressive than an iframe, and a marketplace plugin cannot touch the page,
  the socket or the session.
- **Shadow a built-in provider.** The first declaration of a provider id wins and
  the `DEV3D_*` ones are always first, so `.env` stays authoritative over a
  manifest.
- **Ship a credential.** A manifest names an environment variable; the server
  reads it. A marketplace bundle never carries a secret.
- **Be routed to when it is unreachable.** A model belonging to a provider with
  no key is catalogued so the UI can show it, but excluded from the routing pool
  in live mode. Otherwise a plugin that declared a provider and forgot the key
  would send every turn aimed at it into a guaranteed failure.

### What a manifest looks like

```jsonc
{
  "id": "dev3d.cost-guard",          // lowercase, reverse-dns, must have a dot
  "name": "Cost guard",
  "version": "1.0.0",
  "description": "…",
  "apiVersion": "1",                 // major must match the host's; '2' is refused
  "permissions": ["models", "routing", "skills", "settings"],
  "entry": "index.mjs",              // optional; its presence means code
  "settings": [
    { "key": "aggressiveness", "label": "How hard to push down-tier",
      "type": "select", "default": "balanced", "options": ["gentle", "balanced", "aggressive"] }
  ],
  "contributes": {
    "models":       [{ "id": "local/x", "providerId": "local", "tier": "small", "costPerMTokIn": 0 }],
    "skills":       [{ "id": "be-cheap", "name": "Be cheap", "description": "…", "body": "# …" }],
    "routingRules": [{ "id": "cheap-intake", "taskClass": "intake", "tier": "nano", "preferProviderIds": ["local"] }],
    "toolNames":    ["echo"]
  }
}
```

Two shipped examples live in `plugins/`, and both are loaded on a fresh boot:

- **`dev3d.cost-guard`** (declarative) — adds a small local model, a
  cost-aware-delegation skill, and two routing rules scoped to `intake` and
  `summarize`.
- **`dev3d.office-echo`** (code) — registers an `echo` tool and logs run
  lifecycles. It exists to prove the code path and to be copied.

### The rules the host enforces

- **A bad plugin is contained.** A manifest that will not validate, a module that
  throws on import, or one that fails halfway through `activate()` becomes a row
  with `status: "error"` and the message. It never stops the office booting and
  never stops the other plugins loading.
- **Problems reject; warnings drop one thing.** A missing `id` or an
  incompatible `apiVersion` means the host does not know what it would be
  running, so it refuses. A typo in one model entry costs you that entry and is
  reported — not the whole plugin.
- **Contributions are recomputed, never patched.** Disabling a plugin withdraws
  its models from the catalog, its skill from every floor that had it enabled,
  its tools from the registry and its routing hints from the router, because
  every one of those lists is derived from the currently loaded set.
- **Tool names are namespaced.** `dev3d.office-echo` registering `echo` becomes
  `dev3d_office_echo_echo`, so two plugins cannot collide with each other or
  with the built-in tools.
- **A tool the plugin registered cannot escape the workspace.** It is adapted
  into an ordinary `Tool` and receives the same `workspaceRoot` every other tool
  gets.
- **Routing rules are preferences, not overrides.** A rule can reorder the
  candidates the router already considers; it can never make it pick a model that
  cannot do the job. A rule scoped to one `taskClass` does not touch any other
  stage.
- **Unloading is best effort, and says so.** Node cannot unload an ES module, so
  disabling a code plugin drops its contributions and calls `deactivate()`, but
  the module stays in memory until restart. That is a documented limit, not a
  pretence.

### Installing from a marketplace

Any static host that serves this JSON is a marketplace:

```jsonc
{
  "version": 1,
  "name": "Example market",
  "plugins": [
    { "manifest": { /* a full plugin manifest */ },
      "downloadUrl": "bundles/cost-guard.tar.gz",   // absolute or relative to the catalog URL
      "sha256": "…64 hex chars…",                   // the host refuses a mismatch
      "tags": ["cost"], "sizeBytes": 4096, "readme": "…" }
  ]
}
```

A bundle is a `.tar.gz` of a plugin directory, with `plugin.json` either at the
root or inside one wrapping directory. There is no zip library here — the reader
is written against POSIX ustar and treats the archive as attacker-controlled
data: absolute paths, `..`, links, device nodes, GNU long names, base-256 sizes
and truncated entries are all refused, with hard caps of 32 MB and 2048 files.
Bundle extraction is staged and then moved into place, so a failed install
leaves nothing behind.

`DEV3D_ALLOW_PLUGIN_INSTALL` is **false by default**. Installing runs someone
else's code inside the orchestrator, so the Marketplace tab's Install button
explains that it is switched off rather than silently failing.

```
GET    /api/plugins                      → PluginSystemState
POST   /api/plugins/refresh              → rescan both plugin directories
POST   /api/plugins/:id/enable           { enabled }   → retries an errored plugin too
PUT    /api/plugins/:id/settings         { settings }  → whole object, coerced against the manifest
DELETE /api/plugins/:id                  → installed plugins only; the shipped set is refused
GET    /api/plugins/sources              POST /api/plugins/sources { label, url }
DELETE /api/plugins/sources/:id
GET    /api/plugins/catalog?url=…        → browse without installing
POST   /api/plugins/install              { catalogUrl, pluginId }
```

Every change broadcasts `plugins.updated` with the whole `PluginSystemState`, so
a console never has to guess what an action did — it reads the server's answer.

### Updating

Installing is not the end of a plugin's life. `POST /api/plugins/updates` asks
every registered marketplace what it is offering, and an update shows up on the
card as `1.0.0 → 2.0.0` with a button. Three rules keep it honest:

- **"Newer" is a version comparison, not a string one.** `10.0.0` is newer than
  `9.0.0`, which as strings it is not. A pre-release is older than the release it
  leads up to.
- **A dead marketplace is reported, not read as "nothing newer".** The reachable
  sources are still checked, the unreachable one is named in the response, and
  `lastCheckedAt` on the state is what lets a console tell "up to date" apart from
  "never asked".
- **An upgrade only moves forward, and never over a bundled plugin.** Replacing
  something that ships with the office would leave the checkout and the loaded set
  disagreeing about what version ships here, so it is refused with that reason.
  The old plugin is unloaded before the swap, because its tools and event
  subscriptions belong to the code being deleted.

---

## Generated office space

A floor is not one room. It is the **core office** plus a jigsaw of **room
modules** attached to it, and it grows itself when it runs out of desks.

The intent is that a team which outgrows its floor gets more floor, rather than
hot-desking forever or silently failing to hire.

### The kit

`blender/scripts/02_office_blocks.py` builds the modules and, in the same pass,
writes the sidecar that describes them — so `blocks.json` cannot describe a block
that does not exist, and the geometry and the metadata cannot drift.

Twenty-four modules, grouped by what they are for. Sizes are all whole metres so
two modules always tile the core's 16 m side walls exactly:

| Category | Modules | Sizes | Seats |
|---|---|---|---|
| work | `pod4` `studio4` `studio6` `open8` `duo2` | 4–16 × 4–6 m | 2, 4, 6, 8 |
| meet | `hoot4` `meeting6` `board12` `forum16` | 6–12 × 6–8 m | 4, 6, 12 |
| quiet | `phone1` `focus4` `focus6` `library4` | 4–12 × 4–6 m | 1, 4, 6 |
| support | `workshop4` `server4` `break6` `locker6` `lounge3` `gallery6` | 6–10 × 4–6 m | 0–4 |
| circulation | `junction` `junction4` `corridor` `passage4` | 4–8 × 3–6 m | 0 |
| fitting | `portal` | 1.9 × 0.5 m | 0 |

Three things make a module more than a box with a doorway:

- **A fit-out** (`furniture`): `desks`, `meeting`, `boardroom`, `booths`,
  `library`, `workshop`, `racks`, `breakout`, `lounge`, `gallery`, `phone` or
  `none`. A 6 × 6 m room can be a huddle room, a reading room or a rack room, so
  the layout inside is named separately from the size.
- **Props** (`props`): plants, whiteboards, shelving, a coffee station, lockers,
  pendants, rugs, art. These are what stop two rooms of the same size reading as
  the same room, and the list travels to `blocks.json` so the console can
  describe a room without loading the GLB.
- **A threshold**: a lit stroke on every edge that has a doorway, so an opening
  reads as a way through rather than as a gap somebody forgot to fill.

A **junction** is what lets the building turn a corner instead of growing in one
straight line, and a **corridor** — thin, no desks, doorways at both ends and
along one side — is what gives a floor routes between rooms rather than a chain
of them: a room with one doorway is a dead end, so without one the building stops
growing the moment it runs out of through-rooms. A **portal** is the glazed
doorway that connects a module to the core; it has no doorways of its own, so the
placement search can never mistake it for a room.

The script **refuses to export a kit that breaks its own contract**, which is
cheaper than noticing it in a viewport. It checks, per module: that the size is
whole metres, that every doorway fits its wall, that the fit-out fits the room
(measured, not assumed — this is what caught three under-sized rooms and a
phantom seventh chair at a six-seat table), that every declared seat was actually
built, that every seat has a `Desk_*` anchor and every anchor a seat, that no
mesh wears a reserved prefix, and that no prop sits outside the module.

To look at it:

```bash
pnpm check:blocks      # the GLB against its sidecar: sizes, anchors, heights, material roles
pnpm preview:blocks    # a rendered contact sheet of all 24 modules
```

`02_office_blocks.py` builds one primitive mesh per distinct *size and surface*
and shares it across every part that uses it. That is not premature optimisation:
built one-mesh-per-part it exported a 2.4 MB GLB of 1 468 identical cubes, and
sharing them brought it to 438 KB with the same geometry.

### Making a floor look like somewhere

Shape is only half of "custom". The other half is what the rooms are made of, and
that is a per-floor **style**.

A style is a sparse patch over a **preset** — `studio` (the default, and the
palette the office shipped with), `nordic`, `industrial`, `glasshouse`,
`neonlab`, `noir`, `paper`, `atelier`. `{ preset: 'nordic' }` already means
something complete, so a floor that has never been styled renders as its preset
rather than as a hole, and `resolveStyle` is pure, so the server and the browser
cannot disagree about what a floor looks like.

The two halves that make it work:

- **Roles, not material names.** Nothing in a style mentions `M_Wall_Paint` or
  `W_Wall`. A style talks about fourteen *roles* — wall, accent wall, glass,
  floor finish, rug, metalwork, desking, upholstery, planting, fixtures, screens
  — and each renderer maps its own materials onto them. The core office is a
  hand-authored asset from before the kit existed and shares no material name
  with it; a role table in `apps/web/src/office/theme.ts` is what lets one style
  dress both. `pnpm check:blocks` fails if either asset gains a material the table
  has never heard of, because the symptom is a single grey wall nobody notices.
- **Materials are cloned per floor.** The GLB's materials are shared by every
  clone, so a floor that repainted them in place would repaint the whole
  building. Each floor owns its material set and releases it when it closes.

Beyond colour, a style carries roughness and a **surface pattern** (grid, planks,
hex, weave, speckle) — generated as a small deterministic texture, not sampled
from a file, so a floor looks the same on the first frame as on the hundredth and
nothing has to be awaited. It carries a **light rig** (key, fill, rim, ambient,
exposure, shadows), a scene **environment** (background, fog, ground shadow, grid)
and a palette for the screens and fixtures, which is what makes `neonlab` read as
a late-night lab and `paper` as a diagram.

The editor lives in the 3D view's top bar, under the floor's name: **Look ·
\<preset\>**. Presets are one click, eight surfaces have a colour, a roughness and
a pattern, the rig has five sliders, and every control can be returned to the
preset. A change is sent whole and paced, so dragging a colour slider is one round
trip rather than sixty — and the style is saved with the floor, so it is there
when you come back.

Styling never touches the plan: growth, capacity and seat ids are decided by the
layout alone, so a restyle can never move anybody's desk.

### The office asset is generated, not curated

The whole asset pipeline is scripted, in this order:

```
01_office_shell.py       the shell, with real doorway openings in the side walls
03_office_furniture.py   desks, chairs, the meeting table, and every anchor
99_export_glb.py         writes apps/web/public/office/office.glb
02_office_blocks.py      the block kit, a separate pass and a separate file
```

This is a repair. The furniture used to be unscripted — authored in interactive
Blender sessions that were never written back — which cost a recovery: running the
shell script and re-exporting replaced the furnished office with a bare 25-mesh
room and destroyed all 21 seat anchors. It survived only because a build artifact
still held a copy.

The furniture script **asserts the anchor contract** rather than trusting it: 21
`Seat_*` empties, 13 `Desk_*` empties, 7 `Anchor_Room_*` empties, and no mesh
carrying a reserved prefix. That last rule is not pedantry — the loader finds
anchors by prefix, so a chair part named `Seat_Meeting_01_Seat` becomes somewhere
to put an employee, and a desk whose parts were all suffixed with `Desk_` is a
desk that `deskNameForSeat` can never find. Both mistakes were made while writing
it, and both now fail the build instead of quietly moving where somebody sits.

The hand-authored asset it replaced is kept at
`blender/reference/office.hand-authored.glb`. Nothing was lost, but the
reconstruction is rougher than what a person made — that is stated plainly in
Known gaps.

### The rule the whole jigsaw rests on

A module attaches through a **port**: a doorway on a wall, with an outward normal.
The module must have a doorway facing *back* at the wall it is joining, and the
two edges are then flush. That is the entire algorithm:

1. Take the next unused port, in a fixed order — the core's first, then whatever
   each new module offers.
2. For each kind of module in kit order, work out the rotation that puts a doorway
   against that port. Cheapest rotation first, so modules land axis-aligned with
   the building whenever their doorways allow it.
3. Reject the placement if the footprint overlaps the core or any module already
   placed. A port that would collide is **spent, not squeezed**.
4. Keep going until the floor can seat everyone.

Three properties are guaranteed, and all three are covered by tests rather than
by looking at the viewport: **nothing overlaps**, **nothing ends up inside the
core**, and **the result is deterministic** — the same floor with the same kit
always grows the same way, so a 3D view can be reloaded without the building
moving. The rotation conventions are pinned by unit test for the same reason: a
quarter-turn error produces rooms hanging off the corner of the office, which is
obvious in a render and invisible in a type signature.

Growth **replans rather than patches**. An incremental build would have to
remember, for every module, which of its doorways was spent on the one it attached
through, and get that right across restarts and removals. Because the generation
is deterministic, replanning to N+1 produces the same building as growing to N+1
did, with a stable prefix — so extending a floor never reshuffles the rooms that
were already there, and removing one always removes the newest.

### Seat names

The core keeps its seat names exactly as they are (`Seat_Dev_01`), because the
shipped org chart already points at them and a floor that never grows should need
no migration. A generated seat is namespaced by instance:

```
Seat_Dev_01            the core, unchanged
B1::Seat_POD4_02       the second desk of the first module placed
```

Without the instance prefix two pods would claim the same seat, since the kit has
one `Seat_POD4_02` per pod-type module.

### Growth

**It grows by itself.** After every hire, and again at boot, a floor is reconciled
with its roster: if there are more employees than desks, it builds until there are
enough. A floor whose team grew while the office was down catches up on the next
start. The growth is idempotent, because the plan is deterministic — reconciling a
floor that already fits produces exactly the building it already had.

There are two controls as well, on the **Projects** page under *Floor space*:
**Build a room** for a meeting room or lounge nobody is hired into, and **Remove
the newest room**, which refuses whenever the floor could no longer seat everyone
without it. A spare room comes out; one with desks in use does not.

A new hire with no seat is placed at the first free desk, including one in a
module the floor just built — otherwise a floor that grew four desks for four new
people would leave them empty. Both the seat and the room are named, so the console
says the employee is in the pod rather than guessing at the bench.

### Reading it in the 3D view

Every floor composes the core clone plus one clone per placed module, and the
floor's plate is resized to the extent it has become — a floor that grew has to
*look* like it did, or the stack lies about the building. The camera pulls back
with the building for the same reason: framing a 38 m floor at the distance that
suited a 22 m room crops the new half off the screen.

A module's nodes are namespaced on clone, so the anchor index sees `B1::Seat_POD4_02`
rather than a second `Seat_POD4_02` that would collide with the first pod's. Seat,
desk and room lookup all understand the prefix, which is what lets an employee be
placed at a generated desk and described as being in a generated room.

---

## The wire protocol

One WebSocket at `/ws`, typed end to end in `packages/core/src/events.ts`.

- On connect the server sends `hello` with the whole `OfficeState`.
- The client sends `ClientCommand` (14 of them); the server pushes `ServerEvent`
  (24 of them). Commands cover submitting and cancelling runs, direct messages,
  planning turns, approvals, and editing the org chart live.
- Two conversation-shaped commands, and the difference is the point. `chat` is a
  direct message to one employee and comes back *broadcast* as `direct.message`,
  because an office where someone is being talked to is office business. `plan`
  shapes a brief that has not been commissioned, so its answer is `plan.reply`,
  *pushed to the asking socket only* — a half-finished idea appearing in every
  other console's feed would be noise at best. A plan carries its own `history`
  and is otherwise stateless on the server: nothing is commissioned, so there is
  nothing to persist.
- `loadRun` replays a run's persisted events to that client, which is how a
  browser rebuilds a transcript it never watched — no extra protocol surface.

Alongside it, a small read API: `/api/health`, `/api/state`, `/api/runs`,
`/api/runs/:id` (with persisted turns and artifacts), `/api/skills`,
`/api/models`, `/api/providers`, and `POST /api/submit` / `POST /api/chat` /
`POST /api/plan`.

Nothing here authenticates. Bind it to localhost.

---

## Persistence

`node:sqlite` is built into Node 24, so dev3d has a real database with zero
dependencies: the org chart, every run, turn, artifact and approval, plus an
append-only event log. An event is persisted *before* it is broadcast, so a
reconnecting client replaying from the log sees a superset of what it had, never
a gap.

If the database cannot be opened the office still boots and runs — it just
forgets everything on exit, and says so at boot. Losing history is bad; refusing
to start is worse.

---

## Verification

```bash
# core: 14 tests — the style model: preset completeness, sparse-patch resolution,
# and that a corrupt style degrades to its preset instead of into a shader
cd packages/core && node --test --test-isolation=none "src/**/*.test.ts"

# server: 305 tests — 304 pass, 1 skipped, 0 fail (47 cover plugins, 13 the block layout, 5 the floor style)
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

- **Server: 304 pass, 1 skipped, 0 fail.** The engine tests drive real runs — real
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
- **Web harness: 104 checks.** A typecheck cannot prove a reducer correct, so
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
  catalogue down. That last one was a real bug until this script existed —
  `loadSkills` runs in `main()` before the server listens, so a single typo in a
  markdown file the README invites you to write stopped the office booting.
- **Build: 86 modules, clean.** The bundle is served from `apps/web/dist` by the
  orchestrator's static handler, alongside `office.glb`. Rebuilding is picked up
  on refresh; the server does not need restarting.

### Sandbox notes

Three things do not work inside a confined sandbox that blocks child processes
with piped stdio (`spawn EPERM`):

- `pnpm` anything (including `pnpm exec tsc` and `pnpm test`) — it spawns
  children for dependency checks and dependency build scripts.
- `tsx` / `node --test` with isolation — `tsx` runs esbuild's service worker, and
  isolated test mode spawns a child per file.
- `vite` — both `vite dev` and `vite build` die at config load because esbuild
  spawns a service worker. Building needs a wider sandbox mode.

**Headless Chrome needs `danger-full-access` too**, for a documented reason:
Chrome's Mojo IPC creates a named pipe and needs write access to its client end,
and DSH's `dsh-sandbox-windows-acl` README states that *"piped stdio capture is
impossible for confined grandchildren — libuv's pipe stdio uses named pipes,
whose client-end open requests write access no restricting SID is granted"*. The
sandbox token is `WRITE_RESTRICTED`, so Chrome dies with:

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108  Check failed: . : Access is denied. (0x5)
```

It is not a Windows permission problem — the token is Medium integrity, a normal
token; it is the restricting SID. Approve the escalation (or run it from a
terminal outside DSH) and Chrome renders normally.

Use `scripts/screenshot.ps1` for this. Two traps it exists to avoid:

- **Do not pipe a native command's output** (`& chrome … > file`): here that
  yields no output at all and an empty exit code, which looks exactly like a
  silent failure. The script uses `Start-Process -RedirectStandardOutput`.
- **Use a fresh `--user-data-dir` every run**, or Chrome may hand the request to
  an already-running browser and exit without doing any work.

```powershell
.\scripts\screenshot.ps1                                   # http://127.0.0.1:8787/
.\scripts\screenshot.ps1 -Out .\f2.png -DumpDom            # also dump the DOM
```

Working equivalents for everything else, which is why they are in `package.json`:

```bash
node apps/server/node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node --test --test-isolation=none "src/**/*.test.ts"
node src/index.ts            # instead of tsx watch
node apps/web/.verify/smoke.ts   # instead of compiling to CJS first

# the office asset pipeline, headless. Order matters: 02 leaves the kit in the
# scene, so 01 must run before 99 if you want the office re-exported - and 99
# will refuse, because re-running 01 destroys the furniture. See Known gaps.
D:\Blender\blender.exe --background --factory-startup `
  --python blender\scripts\02_office_blocks.py

# a rendered contact sheet of the whole kit, for looking at a change before it
# reaches the browser. `-- --only pod4,lounge3` draws just those modules.
D:\Blender\blender.exe --background --factory-startup `
  --python blender\scripts\04_preview_blocks.py
```

`02_office_blocks.py` writes `blocks.json` directly when Blender runs it, and
prints the same document as `BLOCKS_JSON=…` when it cannot — the MCP bridge's
safe mode withholds `open`, so the printed copy is the sidecar of record there.

The one test that is skipped asserts that an approved `run_shell` actually
executes a command; it needs a piped child process, so it reports itself as
skipped with that reason rather than failing. It still runs, and still has to
pass, anywhere child processes are allowed.

Outside a sandbox, `pnpm install`, `pnpm dev`, `pnpm test` and `vite build`
behave normally.

---

## Environment

See `.env.example`. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind address. |
| `DEV3D_LLM_MODE` | `auto` | `auto` picks `live` when any key is present, else `mock`. |
| `DEV3D_WORKSPACE` | `./workspace` | The default project: what a run uses when it names none. |
| `DEV3D_WORKSPACES_ROOT` | `./workspaces` | Where the Projects tab creates new project folders. |
| `DEV3D_ALLOW_EXTERNAL_WORKSPACES` | `true` | Allow a floor to point outside the workspaces root. |
| `DEV3D_DB` | `./data/dev3d.sqlite` | SQLite file. |
| `DEV3D_ROUTING` | `balanced` | `cheap` \| `balanced` \| `quality`. |
| `DEV3D_RUN_BUDGET_USD` | `5.00` | Hard ceiling per run. |
| `DEV3D_SOFT_SPEND_APPROVAL_USD` | `1.50` | Ask a human before crossing this. `0` disables. |
| `DEV3D_MAX_CONCURRENCY` | `4` | Parallel employees inside one company. |
| `DEV3D_AUTO_APPROVE_SHELL` | `false` | Skip the shell approval round trip. |
| `DEV3D_APPROVAL_TIMEOUT_MS` | `600000` | How long an approval waits before it counts as refused. |
| `DEV3D_PLUGINS_DIR` | `./plugins` | Where plugins are discovered. Each subdirectory with a `plugin.json` is one plugin. |
| `DEV3D_PLUGIN_INSTALL_DIR` | `./data/plugins` | Where marketplace installs land, kept apart from the shipped set. |
| `DEV3D_ALLOW_PLUGIN_INSTALL` | `false` | Allow installing a plugin bundle from a marketplace URL. Installing runs code in the orchestrator's process. |

**Precedence:** `.env` is the *bootstrap*. On a first boot these values become the
installation settings; from then on the saved settings win and the Settings page
is how they change. Three things stay environment-only: provider API keys, which
are never exposed to the browser, `DEV3D_DB`, which has to be known before the
database can be opened, and the plugin install gate, which decides whether code
from the network may run here at all.

Provider keys: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, and `DEV3D_LOCAL_BASE_URL` for any OpenAI-compatible local
runtime (Ollama, vLLM, LM Studio).

---

## Known gaps

- **The office has been looked at, but only on a synthetic camera path.** Headless
  Chrome renders it (`scripts/screenshot.ps1`), and that is how the multi-floor
  building, the camera framing and the dock's floor picker were all verified and
  three bugs found. What has *not* been exercised is a human eye on the
  composition: lighting balance, storey height (`FLOOR_STEP`, 4.2 m), plate
  opacity and fog are all first guesses.
- **A run cannot be moved between floors.** `workspaceId` is frozen at submit
  time; closing a floor does not migrate its history anywhere.
- **Generated space is drawn, but the camera is a first guess.** Modules instantiate
  per floor, the plate resizes, the camera pulls back with the building, and the
  lights follow the floor's new centre. What has *not* been judged by eye is the
  composition of a large building: at seventeen modules the framing is wide enough
  that an individual desk is small, and there is no room-by-room navigation.
- **The planner builds in one style.** Modules are tried least-used-first, so a
  floor gets a pod, an office, a meeting room and a lounge rather than nine pods —
  but every module chain is still axis-aligned, and the kit has no corner or
  diagonal piece. A building grows in steps and wings, not around a courtyard.
- **The regenerated office is a reconstruction.** `03_office_furniture.py` builds
  the desks, chairs, meeting table and every anchor, and asserts the contract (21
  seats, 13 desks, 7 rooms) — but it is not the asset a person made. It is
  rougher: fewer meshes, simpler forms, no bespoke detail. The hand-authored
  original is kept at `blender/reference/office.hand-authored.glb`, and restoring
  it is a copy — it is prettier, and it has solid side walls, so the block kit
  would attach to a wall rather than through a doorway.
- **No authentication.** Everything is unauthenticated and intended for
  localhost.
- **No avatars in the GLB.** Employees are built procedurally in the browser
  from `Role.appearance` (`bodyColor`, `accentColor`, `height`) and placed at the
  seat anchors. That is a deliberate design, not an omission — but it means the
  avatars are deliberately simple.
- **Direct messages carry no tools.** A conversation outside a pipeline routes on
  the role's default tier and answers from the model alone; it cannot read the
  workspace. The reply says so rather than pretending.
- **A plan is local to one browser.** Plan sessions live in that browser's
  `localStorage`, so they do not follow you to another console and are not in the
  database. That is deliberate — nothing has been commissioned, so nothing
  belongs in the office's records — but it means two consoles cannot collaborate
  on one draft, and clearing site data discards them. Submitting is the point at
  which a plan becomes the server's business.
- **The Plan page has been verified in `mock` mode.** The transport, the
  multi-turn replay, the brief handoff and the submit-to-run path were all driven
  end to end against the scripted provider, plus a unit test on the scripted
  planner's own behaviour. What has not been exercised is a real model's planning
  conversation: the questions a frontier model asks about an ambiguous brief, and
  whether the drafted brief is good enough to submit unedited.
- **A plugin cannot be un-loaded from memory.** Node cannot unload an ES module,
  so disabling a code plugin withdraws its contributions and calls `deactivate()`
  but leaves the module resident until restart. The host says this rather than
  pretending otherwise.
- **A plugin manages everything except UI code.** It can add a provider, models,
  skills, routing rules, tools, role templates, pipelines, settings and panels —
  all as validated data. What it cannot do is ship anything that runs in the
  browser, which is a deliberate limit rather than a missing feature.
- **Updates are found, not pushed.** Nothing polls a marketplace on its own; the
  operator asks. There is also no downgrade and no pinning to a version, so a
  marketplace that publishes a bad release can only be answered by disabling the
  plugin.
- **The marketplace is a contract, not a website.** `PluginCatalog` and the
  `/api/plugins/catalog` + `/install` routes are the whole integration; the
  catalogue site itself does not exist yet.
- **`activate()` is not sandboxed.** A code plugin runs in the orchestrator's
  process with its full authority; the permission list is a consent record shown
  to the operator, not a runtime gate. Only install it from somewhere you trust.
- **A live panel is fetched on demand, not pushed.** Opening a console triggers
  the first read, and the console then polls on the interval the manifest asks
  for. Nothing is fetched while no console is open — deliberate, but it does mean
  a panel's first paint can be a moment behind.

---

## License

**AGPL-3.0-or-later.** See [`LICENSE`](LICENSE).

Chosen deliberately, because of what this project is: it is designed to be
operated as a server. A permissive license would let someone host a modified
dev3d as a service and never publish the changes, which is the one outcome the
project's own architecture (an office that grows a plugin marketplace) makes
likely. The AGPL's network clause closes that gap — if you run a modified version
for other people to use over a network, you offer them its source.

Practically, for the two common cases:

- **Running it for yourself or your team, unmodified** — nothing is asked of you
  beyond keeping the license intact. No obligation to publish anything.
- **Modifying it and letting others use it over a network** — you must offer them
  the Corresponding Source of your version. Section 13 is the clause that says so.

Plugins are separate: a plugin is your own work, and loading one into this
orchestrator does not make it a derivative of the orchestrator. That is the same
line the FSF draws for GPL-covered programs and their plugins, and it is why the
plugin host passes data rather than code across the boundary wherever it can.

If the AGPL does not suit your situation, the copyright holder can license
otherwise — open an issue to ask.
