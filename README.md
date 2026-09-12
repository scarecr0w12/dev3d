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
| Model layer: providers, adapters, catalog, router | Complete — 14 tests |
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

## Model routing

Every role carries a `ModelPolicy`: a default tier, per-task-class overrides,
hard min/max bounds, and an escalation threshold. The router combines that with
the global posture (`cheap` | `balanced` | `quality`), a complexity estimate for
the specific turn, and the remaining budget, then picks the cheapest capable
model and returns ordered fallbacks plus the reasoning for every model it
rejected.

The complexity estimate is a deterministic function of observable things: the
stage kind, how much text the turn must digest, whether it touches files, how
many revision passes have already failed to settle it, and whether the text
names a known-hard problem (concurrency, migration, security, protocol,
idempotency…). It is a heuristic and meant to be one — it only has to be ordered
correctly.

Prices in `llm/catalog.ts` are **estimates for routing and display, not billing
truth**. They only need to be ordered plausibly.

**Correcting one does not need a code change.** Settings → Models can override a
model's tier and its per-million prices for the whole installation: the registry
reads the overrides on every use, so a correction changes routing and cost
reporting on the next turn. An override is a patch, so the fields it does not
mention keep the catalog's values, and it is validated against the live catalog —
a tier that is not a tier is refused, and an entry for a model that no longer
exists is dropped and logged rather than left behind in the settings document.

This matters more than it sounds: a tier decides where a model sits in the routing
walk and a price decides what a turn costs and which model wins a tie. Hard-coding
both meant a stale price could only be answered by editing source and redeploying.

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

| Module | Size | Doorways | Seats |
|---|---|---|---|
| `pod4` | 8 × 6 m | west, east | 4 |
| `office2` | 8 × 6 m | west | 2 |
| `meeting6` | 8 × 6 m | west | 6 |
| `lounge3` | 8 × 6 m | west, east | 3 |
| `junction` | 6 × 6 m | all four | 0 |
| `corridor` | 8 × 3 m | west, east, north | 0 |
| `portal` | 1.9 × 0.5 m | none | 0 |

Two 8 m modules tile each of the core's 16 m side walls exactly. A **junction** is
what lets the building turn a corner instead of growing in one straight line, and
a **corridor** — thin, no desks, doorways at both ends and along one side — is what
gives a floor routes between rooms rather than a chain of them: a room with one
doorway is a dead end, so without one the building stops growing the moment it runs
out of through-rooms. A **portal** is the glazed doorway that connects a module to
the core; it has no doorways of its own, so the placement search can never mistake
it for a room.

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
# server: 119 tests — 118 pass, 1 skipped, 0 fail (47 cover plugins, 13 the block layout)
cd apps/server && node --test --test-isolation=none "src/**/*.test.ts"

# live protocol: drives a RUNNING server as a real client — 202 checks
node scripts/smoke-ws.mjs

# the office store's reducer, driven with one frame per event variant — 104 checks
node apps/web/.verify/smoke.ts

# the degradation promises: no database, a malformed skill file, an empty skills dir
node scripts/check-failure-paths.mjs

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

- **Server: 118 pass, 1 skipped, 0 fail.** The engine tests drive real runs — real
  pipelines, real router, real tool loop — against the scripted provider and a
  scratch workspace, proving files land on disk, budget halts, cancellation is
  safe, debates produce verdicts, the review loop sends work back to the
  builders, the spend gate asks exactly once, and a run in one organisation
  leaves another floor's directory untouched. The runtime tests cover the
  workspace rules and the migration directly, because a folder name that escapes
  the workspaces root would hand thirteen agents the whole disk.
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
```

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
