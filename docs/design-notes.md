# Design notes

This document explains *why* dev3d is built the way it is: the model layer and how
a model gets chosen, the per-floor style model, tool confinement, the plugin host,
the generated office space, and persistence. It is written for people changing
those subsystems, so each section states the design decision and the reasoning
behind it — including the measured numbers that justify it — rather than
restating what the code does line by line. It is not a setup guide: the README
covers running the office, `development.md` covers the suite, and
`wire-protocol.md` covers the socket.

---

## Model layer and routing

### Which models exist is the provider's answer, not ours

`apps/server/src/llm/catalog.ts` is a **curated metadata table**, not a roster.
The distinction is the design, because two different questions cannot be answered
by one static array:

- **Which models exist?** Only the provider knows, and it changes without a
  commit. A checkout can name a model for a provider whose endpoint does not
  serve it — a routable model that could only ever produce a failed turn. The
  only way to know is to ask.
- **What do they cost, and how good are they?** No `/models` endpoint answers
  this. Prices and capability have to be curated, measured, or pooled.

So membership comes from **discovery** and metadata comes from the **overlay**:

```
provider /models   →  membership, plus facts the vendor knows (context, price, tools, vision)
curated table      →  judgement the vendor cannot state (tier, strengths, quality)
learned outcomes   →  what this office observed on its own work
pooled benchmarks  →  what a public aggregator measured
```

- A model the provider reports but the table has never heard of is still
  **routable**, flagged `unrated`. Its tier is inferred from its published price
  — a better signal than its name, which is marketing — and the console says the
  tier is a guess.
- A model the table describes that the provider no longer serves is
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
| The provider could not be asked | `degraded`, with the reason | The curated seed stands in; nothing is emptied |

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
size are not interchangeable; a flat `strengths` list cannot express that on its
own.

Two properties matter more than the weights:

- **With no quality information the score reduces to the policy's tier walk, and
  nothing else.** The quality terms come from a prior that is the mean of the
  *rated* population, so when nothing is rated they cancel; and cost pressure is
  switched off entirely, so price cannot pull a turn off the tier the policy
  asked for when nothing is known about what that money buys. The invariant is
  enforced by test rather than asserted in a comment.
- **A plugin routing rule still cannot move a turn to another tier.** A rule's
  declared tier joins the front of the walk, and its model/provider preferences
  apply as score bonuses *confined to that tier* — so a rule can reorder
  candidates without making the router pick something the policy did not allow.

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

**A false match is worse than a miss**, so matching is two-tier. A full-slug match
(`deepseek/deepseek-chat`, after stripping the office's own provider prefix) is
unambiguous. A bare-name match is used **only when that name appears once in the
whole payload** — otherwise the key is poisoned, because `vendorA/llama-3.3-70b`
and `vendorB/llama-3.3-70b` both reduce to `llama3370b` and handing one of them
the other's scores would mislead routing while looking authoritative.

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

The router scores it as a **penalty, never a filter**: `0.30 × (1 − uptime)`, so a
model at 0% loses about a tier and a half and one at 99% loses 0.003. It is a
demotion rather than an exclusion because uptime is a rolling figure that can be
stale, and hard-excluding on a stale reading would remove a good option — with a
pinned role having no way back. The retry-and-fail-over loop already handles a
genuinely dead provider.

Two rules keep it from doing harm. **Unknown contributes exactly nothing** — the
same rule quality follows — so a model on a provider the office cannot ask about is never
penalised for being unmeasured. And lookups are **on demand and never awaited**:
the router asks as it considers a model, a model nobody routes to is never
fetched, and the first turn on a new model routes exactly as it would have before
this signal existed. The best endpoint wins the aggregate, because that is the one
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

### Fail-over and the registry

`apps/server/src/llm/` holds the provider adapters (OpenAI-compatible, Anthropic,
mock), the model catalog with prices, and the fail-over registry. A turn that
fails is retried and failed over, so a genuinely dead provider is handled by that
loop rather than by routing; the turn record names the model that actually
answered (`servedBy`), which is also what the learned quality layer reads. The
registry rebuilds on every plugin change, so a provider contributed by a plugin
appears without a restart.

### Overrides and price provenance

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

## The style model

A floor's appearance is **data**, not code and not a hand-authored asset. A style
is a sparse patch over a **preset** — `studio` (the default, and the palette the
office shipped with), `nordic`, `industrial`, `glasshouse`, `neonlab`, `noir`,
`paper`, `atelier`. `{ preset: 'nordic' }` already means something complete, so a
floor that has never been styled renders as its preset rather than as a hole.

Resolution is **pure and total**: `resolveStyle` takes the preset plus whatever
the floor has patched and returns a complete description, so the server and the
browser cannot disagree about what a floor looks like. A corrupt style degrades to
its preset rather than reaching a shader — a value that reaches a shader is a
value that has to be refused at the boundary instead of rendered.

### Roles, not material names

Nothing in a style mentions `M_Wall_Paint` or `W_Wall`. A style talks about
fourteen *roles* — wall, accent wall, glass, floor finish, rug, metalwork,
desking, upholstery, planting, fixtures, screens — and each renderer maps its own
materials onto them. The core office is a hand-authored asset from before the kit
existed and shares no material name with it; a role table in
`apps/web/src/office/theme.ts` is what lets one style dress both.

The mapping is a rule rather than a convention: **no mesh may escape the role
table — every material in either asset maps to exactly one role.** A check fails
if either asset gains a material the table has never heard of, because the
symptom is a single grey wall nobody notices.

### Materials are cloned per floor

The GLB's materials are shared by every clone, so a floor that repainted them in
place would repaint the whole building. Each floor therefore owns its own material
set and releases it when the floor closes.

### What a style carries

Beyond colour, a style carries roughness and a **surface pattern** (grid, planks,
hex, weave, speckle) — generated as a small deterministic texture, not sampled
from a file, so a floor looks the same on the first frame as on the hundredth and
nothing has to be awaited. It carries a **light rig** (key, fill, rim, ambient,
exposure, shadows), a scene **environment** (background, fog, ground shadow, grid)
and a palette for the screens and fixtures, which is what makes `neonlab` read as
a late-night lab and `paper` as a diagram.

### What the StylePanel edits

The editor is `StylePanel`, in the 3D view's top bar under the floor's name:
**Look · \<preset\>**. Presets are one click; eight surfaces have a colour, a
roughness and a pattern; the rig has five sliders; and every control can be
returned to the preset.

A change is sent whole and paced, so dragging a colour slider is one round trip
rather than sixty, and the style is saved with the floor, so it is there when you
come back.

Styling never touches the plan: growth, capacity and seat ids are decided by the
layout alone, so a restyle can never move anybody's desk.

---

## Tools and confinement

Nine tools: `think`, `list_dir`, `read_file`, `search_files`, `write_file`,
`edit_file`, `run_shell`, `web_search`, `web_fetch`.

- Every path funnels through one `resolveInWorkspace` choke point that rejects
  `..`, absolute paths outside the root, and Windows drive-relative tricks like
  `C:foo` (comparison is case-insensitive).
- **The root it resolves against is the workspace of the run being served**, not
  a single global directory. Two projects can be worked on at once and neither can
  see the other's files.
- Grants are enforced per employee: the org chart decides who may hold a tool, and
  anything else is refused with a message the model can act on.
- A tool contributed by a plugin is adapted into an ordinary `Tool` and receives
  the same `workspaceRoot` every other tool gets, so it is confined identically.

### The shell approval gate

`run_shell` is the only tool that goes through a human approval round trip, and it
is the only tool that can be switched off safety-wise — see
`DEV3D_AUTO_APPROVE_SHELL`. Approvals always resolve — denied, answered, or timed
out as refused — so a run can never wait forever on an operator
(`DEV3D_APPROVAL_TIMEOUT_MS`).

### Workspace-escape rules

The directory a workspace names becomes fully readable and writable to *that
organisation's* employees, and to nobody else's. The rules that keep the building
safe:

- A folder name may not contain separators or `..`, may not escape the workspaces
  root, and two floors may not share a directory.
- Absolute paths outside the root are accepted only while
  `DEV3D_ALLOW_EXTERNAL_WORKSPACES` is true; the default floor cannot be closed.
- Switching a skill off for a floor also trims it from every role holding it, so
  a role can never reference a skill its organisation has disabled.
- Two floors share nothing but the building they sit in — different people,
  different skills, different money, and no visibility of each other's files.
- `Run.workspaceId` and `Run.workspacePath` are resolved at submit time and frozen
  onto the run, so its record stays truthful after the floor is renamed or closed.

---

## Plugins

A plugin is how the office gains a model, a skill, a routing rule, a tool, a role
template, a pipeline or a console panel **without anyone editing the repository**.
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

### What a plugin can contribute

Being precise about this matters more than the feature list, because a
contribution the host publishes but nothing reads is indistinguishable from one
that works. Everything below is wired:

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

A manifest is validated before any of it is loaded, and carries the identity and
the consent record:

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

Three examples ship with the office and are loaded on a fresh boot:

- **`dev3d.cost-guard`** (declarative) adds a small local model, a
  cost-aware-delegation skill, and two routing rules scoped to `intake` and
  `summarize`.
- **`dev3d.local-coder`** (declarative) registers a whole provider — a keyless
  loopback OpenAI-compatible endpoint and the model it serves — and renders a panel
  in Settings describing what it registered. It is the reference for the
  `providers` and `uiPanels` contribution points.
- **`dev3d.office-echo`** (code) registers an `echo` tool and logs run lifecycles.
  It exists to exercise the code path and to be copied.

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
- **Be routed to when it is unreachable.** A model belonging to a provider with no
  key is catalogued so the UI can show it, but excluded from the routing pool in
  live mode. Otherwise a plugin that declared a provider and forgot the key would
  send every turn aimed at it into a guaranteed failure.

### The rules the host enforces

- **A bad plugin is contained.** A manifest that will not validate, a module that
  throws on import, or one that fails halfway through `activate()` becomes a row
  with `status: "error"` and the message. It never stops the office booting and
  never stops the other plugins loading.
- **Problems reject; warnings drop one thing.** A missing `id` or an incompatible
  `apiVersion` means the host does not know what it would be running, so it
  refuses. A typo in one model entry costs you that entry and is reported — not
  the whole plugin.
- **Contributions are recomputed, never patched.** Disabling a plugin withdraws
  its models from the catalog, its skill from every floor that had it enabled, its
  tools from the registry and its routing hints from the router, because every one
  of those lists is derived from the currently loaded set.
- **Tool names are namespaced.** `dev3d.office-echo` registering `echo` becomes
  `dev3d_office_echo_echo`, so two plugins cannot collide with each other or with
  the built-in tools.
- **A tool the plugin registered cannot escape the workspace.** It is adapted into
  an ordinary `Tool` and receives the same `workspaceRoot` every other tool gets.
- **Routing rules are preferences, not overrides.** A rule can reorder the
  candidates the router already considers; it can never make it pick a model that
  cannot do the job. A rule scoped to one `taskClass` does not touch any other
  stage.
- **Unloading is best effort, and says so.** Node cannot unload an ES module, so
  disabling a code plugin drops its contributions and calls `deactivate()`, but
  the module stays in memory until restart. That is a documented limit, not a
  pretence.

### Trust, authority and what an operator is trusting

There is no isolation around `activate()`. **A code plugin runs in the
orchestrator's process with the orchestrator's full authority**, so the
`permissions` list is a **consent record shown to the operator, not a runtime
gate** — it is displayed, and nothing enforces it. A code plugin also cannot be
unloaded from memory: disabling it withdraws its contributions and calls
`deactivate()`, but the module stays resident until restart.

The consequence is the reason the install gate is closed by default:
**installing runs someone else's code inside the orchestrator.**
`DEV3D_ALLOW_PLUGIN_INSTALL` is **false by default**, and the Marketplace tab's
Install button explains that it is switched off rather than silently failing.
Only install a plugin from somewhere you trust.

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
root or inside one wrapping directory. There is no zip library: the reader is
written against POSIX ustar and treats the archive as attacker-controlled data —
absolute paths, `..`, links, device nodes, GNU long names, base-256 sizes and
truncated entries are all refused, with hard caps of 32 MB and 2048 files. Bundle
extraction is staged and then moved into place, so a failed install leaves nothing
behind.

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

Every change broadcasts `plugins.updated` with the whole `PluginSystemState`, so a
console never has to guess what an action did — it reads the server's answer.

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

Updates are found, not pushed: nothing polls a marketplace on its own, the
operator asks. There is also no downgrade and no pinning to a version, so a
marketplace that publishes a bad release can only be answered by disabling the
plugin.

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
  the same room, and the list travels to `blocks.json` so the console can describe
  a room without loading the GLB.
- **A threshold**: a lit stroke on every edge that has a doorway, so an opening
  reads as a way through rather than as a gap somebody forgot to fill.

A **junction** is what lets the building turn a corner instead of growing in one
straight line, and a **corridor** — thin, no desks, doorways at both ends and
along one side — is what gives a floor routes between rooms rather than a chain of
them: a room with one doorway is a dead end, so without one the building stops
growing the moment it runs out of through-rooms. A **portal** is the glazed
doorway that connects a module to the core; it has no doorways of its own, so the
placement search can never mistake it for a room.

The script **refuses to export a kit that breaks its own contract**, which is
cheaper than noticing it in a viewport. It checks, per module: that the size is
whole metres, that every doorway fits its wall, that the fit-out fits the room
(measured, not assumed), that every declared seat was actually built, that every
seat has a `Desk_*` anchor and every anchor a seat, that no mesh wears a reserved
prefix, and that no prop sits outside the module.

`02_office_blocks.py` builds one primitive mesh per distinct *size and surface*
and shares it across every part that uses it. That is not premature optimisation:
built one-mesh-per-part it exports a 2.4 MB GLB of 1 468 identical cubes, where
sharing them produces 438 KB with the same geometry.

### The asset is generated

The whole asset pipeline is scripted, in this order:

Scripting the furniture rather than authoring it in interactive Blender sessions
is what makes the asset reproducible: an unscripted edit is not written back, so
re-running the shell script and re-exporting would replace the furnished office
with a bare shell rather than re-export what is there. See
[development.md](development.md#the-blender-asset-pipeline) for the run order.

The furniture script **asserts the anchor contract** rather than trusting it: 21
`Seat_*` empties, 13 `Desk_*` empties, 7 `Anchor_Room_*` empties, and no mesh
carrying a reserved prefix. That last rule is not pedantry — the loader finds
anchors by prefix, so a chair part named `Seat_Meeting_01_Seat` becomes somewhere
to put an employee, and a desk whose parts were all suffixed with `Desk_` is a
desk that `deskNameForSeat` can never find. Both are build failures rather than
somebody quietly sitting somewhere else.

The hand-authored asset the script replaced is kept at
`blender/reference/office.hand-authored.glb`. Nothing was lost, but the
reconstruction is rougher than what a person made.

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

Three properties are guaranteed, and all three are enforced rather than judged by
eye: **nothing overlaps**, **nothing ends up inside the core**, and **the result
is deterministic** — the same floor with the same kit
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

### Growth and planning

**It grows by itself.** After every hire, and again at boot, a floor is reconciled
with its roster: if there are more employees than desks, it builds until there are
enough. A floor whose team grew while the office was down catches up on the next
start. The growth is idempotent, because the plan is deterministic — reconciling a
floor that already fits produces exactly the building it already had.

Modules are tried **least-used-first**, so a floor gets a pod, an office, a meeting
room and a lounge rather than nine pods.

There are two controls as well, on the **Projects** page under *Floor space*:
**Build a room** for a meeting room or lounge nobody is hired into, and **Remove
the newest room**, which refuses whenever the floor could no longer seat everyone
without it. A spare room comes out; one with desks in use does not.

A new hire with no seat is placed at the first free desk, including one in a
module the floor just built — otherwise a floor that grew four desks for four new
people would leave them empty. Both the seat and the room are named, so the
console says the employee is in the pod rather than guessing at the bench.

### Reading it in the 3D view

Every floor composes the core clone plus one clone per placed module, and the
floor's plate is resized to the extent it has become — a floor that grew has to
*look* like it did, or the stack lies about the building. The camera pulls back
with the building for the same reason: framing a 38 m floor at the distance that
suited a 22 m room crops the new half off the screen.

A module's nodes are namespaced on clone, so the anchor index sees
`B1::Seat_POD4_02` rather than a second `Seat_POD4_02` that would collide with the
first pod's. Seat, desk and room lookup all understand the prefix, which is what
lets an employee be placed at a generated desk and described as being in a
generated room.

---

## Persistence

`node:sqlite` is built into Node 24, so dev3d has a real database with zero
dependencies: the org chart, every run, turn, artifact and approval, plus an
append-only event log. An event is persisted *before* it is broadcast, so a
reconnecting client replaying from the log sees a superset of what it had, never a
gap.

If the database cannot be opened the office still boots and runs — it just forgets
everything on exit, and says so at boot. The trade is deliberate: **losing history
is bad; refusing to start is worse.**

For the operator that means two distinct states, and the boot message is how you
tell them apart. With a working database, floors, runs, transcripts and approvals
survive a restart, and a browser that was closed while a run proceeded can rebuild
the transcript by replaying the persisted log. Without one, the office is fully
usable in every other respect for as long as the process lives, and everything it
did is gone when it exits. `DEV3D_DB` names the SQLite file; it stays
environment-only because it has to be known before the database can be opened.
