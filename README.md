# dev3d

**A 3D office where a hierarchy of LLM agents actually does the work.**

You describe a task to a CEO agent. The CEO turns it into an objective, puts
specialists on it, they research and argue the approach, a CTO writes a
file-level plan, developer agents write real files into a workspace, QA tries to
break it, and the CEO reports back.

Every one of those agents is a separate model call with its own role, its own
skills, and its own model — a one-line intake summary runs on a small cheap model
while an architecture review runs on a frontier one. The office is a real GLB
model in the browser: employees sit at named desks, change colour by status, and
walk to the meeting room to debate.

---

## Quick start

**Node 24 or newer is a real requirement, not a preference.** The test suites run
TypeScript directly through `node --test --test-isolation=none`, and persistence
is built on the unflagged `node:sqlite`. Both mean Node 24. On Node 22 the server
runs but the tests do not, so you would be running an untested tree.

```bash
pnpm install                 # Node >= 24
cp .env.example .env         # optional: add provider keys for live models

pnpm dev:server              # orchestrator on http://127.0.0.1:8787
pnpm dev:web                 # office UI on http://127.0.0.1:5273
```

The web app proxies `/api` and `/ws` to the orchestrator, so open
<http://127.0.0.1:5273> and the office is live.

**No API keys are required.** With none configured the server boots in `mock`
mode: the entire pipeline still runs, employees are scripted instead of billed,
and the office is fully demonstrable. `/api/health` reports the active mode and
the reason for it, and the UI badges it so nobody thinks they are spending money.

### Try it without the UI

```bash
curl -s localhost:8787/api/health

curl -s -X POST localhost:8787/api/submit \
  -H 'content-type: application/json' \
  -d '{"brief":"Fix the null dereference in the session lookup and add a regression test"}'

curl -s localhost:8787/api/runs/<runId>
```

---

## What it does

| Area | What you get |
|---|---|
| **Run engine** | Four stage modes — `single`, `parallel`, `debate`, `review-loop` — with a tool loop, spend ceiling and cancellation |
| **Org chart** | 13 roles across 8 departments, 3 shipped pipelines, editable live from the console |
| **Model layer** | Provider discovery, a curated metadata overlay, learned quality from the office's own turns, pooled benchmarks, uptime, and a cost-aware router |
| **Tools** | 14 built-in tools, every one confined to the run's workspace root — plus any tool an MCP server provides |
| **MCP** | Connect Model Context Protocol servers (stdio or Streamable HTTP); their tools are published to employees as `mcp__<server>__<tool>` |
| **Knowledge** | 15 skill documents selected per turn, plus stage summaries and artifacts threaded forward |
| **Plugins** | Providers, models, skills, routing rules, tools, role templates, pipelines and console panels — without editing this repository |
| **The office** | A generated 3D building: one floor per organisation, block-kit growth, per-floor styles |
| **Persistence** | SQLite through `node:sqlite`, with a memory fallback that keeps the office booting |

---

## The office

**The 3D view is the application.** The canvas fills the viewport edge to edge and
every other surface floats over it.

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

- **Top bar** — the brand, the tabbed pages, connection/mode/spend at a glance, a
  **Jump** box (⌘/ctrl-K), and toggles for the two popouts.
- **Stage** — the office canvas, always mounted. Switching tabs never re-creates
  the renderer, so the camera, the avatars and the socket keep their state.
- **Page sheets** — the selected tab's page floats over the office. It is a
  labelled region rather than a modal: the office stays live and clickable behind
  it, and Escape returns you to it.
- **Info popout** (left) — mission, routing posture (live control), providers and
  their key status, headcount by status, spend, what is in flight, the workspace
  path, and Resync.
- **Inspector popout** (right) — `Agent` | `Run` | `Chat`, following what you
  clicked but always yours to override. Both inner edges drag, each tab owns its
  own scrolling, and it stands down on Plan, which is a workspace in its own
  right.
- **Brief dock** (bottom) — the composer, small by default and expandable to the
  full pipeline stage list.
- **Approval callout** — floats top-centre whenever something is waiting, because
  an approval is the one thing that stops the office dead.

Employees are placed by **looking up the GLB node named in the role's `seatId`**,
never by hard-coded coordinates, and avatars are built procedurally from
`Role.appearance` — body colour, accent colour and height. They animate by status:
idle bob, a pulse while thinking, typing while working, turning toward the room
while talking. Clicking one raycasts and selects it, adding a pulsing floor ring
and easing the camera in. `prefers-reduced-motion` is honoured.

### Plan — the conversation before the work

Every other surface is about work that already exists. **Plan** is for the work
that does not yet. A brief is a decision, and a decision made in one shot is
usually a bad one, so this is where an idea is argued out first:

```
┌ plans ────┐  ┌─ the conversation ──────────────┐  ┌ the brief ──────────┐
│ ▸ idea 1  │  │ you: our checkout double-charges│  │ **Objective:** …    │
│ ▸ idea 2  │  │ ceo: what does done look like?  │  │ Done means:         │
│ + New     │  │ you: [Draft the brief]          │  │ project/pipeline/$  │
└───────────┘  └─────────────────────────────────┘  │ [ Submit brief ]    │
                                                    └─────────────────────┘
```

The conversation has memory — the browser replays the whole thread each turn, so a
plan is a refinement rather than a series of unrelated questions. **Nothing is
commissioned until you press Submit:** the conversation costs model calls and
nothing else, and *Draft the brief* puts the model's answer in an editable panel
before it becomes a run. Sessions live in that browser's `localStorage`, because
they are drafts rather than office records.

### Jump to anything

The inspector can only show one thing at a time, which is fine until you know what
you want and not where it is. **⌘/ctrl-K** searches everything the console already
holds — people, runs, artifacts and the event feed — and picking a result selects
it and lands you on the right tab. It searches client state rather than making a
server query, so jumping is instant and cannot fail on a round trip.

The remaining pages are compositions of the same panels: `Projects` (the
building), `Org` (departments and the org chart), `Runs` (approvals, run list,
transcript, artifacts — two independently scrolling columns), `Activity` (the
event feed), `Routing & cost`, `Skills`, `Plugins` (the installed list, each
plugin's generated settings form, and the marketplace), and `Settings` (General /
Models / Skills / Budget / Safety).

---

## How a run flows

A **pipeline** is the shape of the conversation a brief travels through. Three
ship today: `product-build` (10 stages), `code-change` (7) and `quick-answer` (3).
A pipeline is declarative data, so the org chart editor can build new ones without
touching the engine.

Each stage declares a **mode**, which decides how its people are scheduled:

| Mode | Behaviour |
|---|---|
| `single` | One employee, one turn. |
| `parallel` | Everyone listed works at the same time, bounded by `DEV3D_MAX_CONCURRENCY`. Each gets its own knowledge snapshot; results merge in role order. |
| `debate` | Positions, then rebuttals over N rounds, then the facilitator rules on it and records the decision. Emits `speech` events so the office can show who is talking. |
| `review-loop` | Reviewers critique in parallel; the chair synthesises a verdict. If the verdict objects, the people who **actually wrote the files** revise, up to a hard iteration cap. |

A **turn** is one employee and one model call: select the skills the task needs,
price the work and route it, then let the employee call tools until it stops asking
for them (bounded at 8 round trips). Everything the UI shows — streamed text,
reasoning, ordered tool calls, token and dollar cost, files touched — is produced
there.

Knowledge accumulates across the run: stage summaries, artifacts, written files and
who wrote them are threaded forward, so a reviewer sees the real files and a report
sees the decision the workshop reached.

### Failure policy

- A stage that produces nothing halts the run, unless the stage is `optional`.
- An optional stage that fails is recorded and the run continues.
- Exceeding the budget always halts the run.
- A tool that fails returns `ok: false` with an actionable message instead of
  throwing, so the employee can correct course rather than dying.
- Approval requests always resolve: denied, answered, or timed out as refused.

---

## Models and routing

**Which models exist is the provider's answer, not ours.** A `/models` endpoint
knows what a vendor serves today, and it changes without a commit. So membership
comes from **discovery**, and judgement comes from an **overlay**:

```
provider /models   →  membership, plus facts the vendor knows (context, price, tools, vision)
curated table      →  judgement the vendor cannot state (tier, strengths, quality)
learned outcomes   →  what this office observed on its own work
pooled benchmarks  →  what a public aggregator measured
```

A model the provider reports but the table has never described is still routable,
flagged `unrated`, with its tier inferred from its published price. A model the
table describes that the provider no longer serves is **withdrawn and logged by
name**, so a retired model becomes visible instead of silently failing a turn.

Discovery runs at boot behind the listening socket and never blocks it, results are
cached to disk and refreshed on a TTL, and the **Routing & cost** page has a *Fetch
model lists* button. `mock` mode never discovers, so the keyless office keeps a
full catalog; `DEV3D_MODEL_DISCOVERY=false` keeps the office entirely offline.

### How a model is chosen

Every role carries a `ModelPolicy`: a default tier, per-task-class overrides, hard
min/max bounds, an escalation threshold, and optionally a **pin to one concrete
model**. The router combines that with the global posture (`cheap` | `balanced` |
`quality`), a complexity estimate for the turn, and the remaining budget:

```
score = 0.45 × fitness for this task class
      + 0.20 × overall quality
      + 0.35 × tier affinity (position in the policy's tier walk)
      − cost pressure × relative cost        (0.30 cheap, 0.12 balanced, 0.03 quality)
```

`fitness` is per task class, so a coding-tuned model and a generalist of the same
size are not interchangeable. Two properties matter more than the weights: with no
quality information the score reproduces the previous behaviour exactly (so price
cannot pull a turn off the tier the policy asked for when nothing is known about
what that money buys), and a plugin routing rule can **reorder candidates within a
tier but never move a turn to another tier**.

A **pin** is honoured inside the policy's own bounds. One that is missing,
excluded, lacks a required capability or sits outside the bounds is *named in the
routing reason* and normal selection stands — so a pin that is not in force is
visible rather than a silent fallback.

### Where quality numbers come from

Three sources, kept as separate opinions rather than averaged into one anonymous
number, because they fail differently:

| Source | What it is | Confidence | Leaves the machine |
|---|---|---|---|
| `curated` | The table in `llm/catalog.ts`: tier-derived, with per-class corrections where a model's character is known | 0.5–0.7 | No |
| `learned` | Smoothed outcomes from this office's own finished turns | grows with evidence | No |
| `pooled` | Artificial Analysis intelligence / coding / math indices | 0.55 | Yes, opt-in |

The blend is confidence-weighted, and a learned score is shrunk towards its prior
rather than reported raw: five observations are needed to move an estimate halfway,
so one bad turn cannot condemn a good model and one success cannot make an unproven
one look proven. An **operator correction** (Settings → Models) enters as the
loudest opinion there is, because a human who has run the model on their own work
outranks a benchmark that measured somebody else's.

Pooled scores are read as a **percentile of the benchmarked population**, not
mapped through a fixed window. The published example scale sits around 60–90, but
the measured median intelligence index is 22.3, so that window would place the
median model at 0.11 and never award a top score to anything. Coverage is partial
and the console reports the real numbers: of OpenRouter's 445 models, 118 match a
benchmark row. For most models the pooled opinion is simply absent — which is
precisely why the learned layer, built from this office's own turns, is usually the
one that matters.

### Uptime, with no key at all

Uptime comes from OpenRouter's public per-model endpoint list, as a **penalty
rather than a filter**: a model at 0% loses about a tier and a half, one at 99%
loses 0.003. It demotes instead of excluding because uptime is a rolling figure
that can be stale, and hard-excluding on a stale reading would remove a good option
with no way back. An **unknown model contributes exactly nothing**, so nothing is
penalised for being unmeasured, and lookups are on demand and never awaited.

Latency and throughput are deliberately unused: they are documented fields that are
empty in the live payload.

```
GET    /api/models             → the merged catalog, with provenance
GET    /api/providers          → status, including how each model list was obtained
POST   /api/models/discover    { providerId?, force? }
POST   /api/models/benchmarks  → refresh pooled quality; returns coverage
POST   /api/models/health      { limit? }  → sample endpoint uptime
```

Prices in the curated table are **estimates for routing and display, not billing
truth**; where a provider publishes real ones, discovery overwrites them.

---

## Tools and confinement

Fourteen built-in tools:

| Tool | What it is for |
|---|---|
| `think` | A private scratchpad note. Writes nothing, moves nothing forward. |
| `todo_write` | The working plan for the run. Send the whole list each time. |
| `list_dir` | A directory as a small tree. |
| `read_file` | A UTF-8 file with line numbers, paged. |
| `glob` | Find files by path pattern, newest first (`**/*.test.ts`). |
| `grep` | Search file contents by regex, with context lines and include/exclude filters. |
| `search_files` | A one-directory regex search, kept for compatibility with existing skills. |
| `write_file` | Create or overwrite a file, making parent directories. |
| `edit_file` | Replace one exact literal string in a file. |
| `apply_patch` | Several exact-text edits across files, applied atomically. |
| `run_shell` | Run a command in the workspace. The only approval-gated tool. |
| `git` | Read-only repository inspection: status, diff, log, show, blame and more. |
| `web_search` | Search the web. |
| `web_fetch` | Fetch one URL and return its text. |

- Every path funnels through one `resolveInWorkspace` choke point that rejects
  `..`, absolute paths outside the root, and Windows drive-relative tricks like
  `C:foo`.
- The root it resolves against is **the workspace of the run being served**, not a
  single global directory, so two projects can be worked on at once and neither can
  see the other's files.
- `run_shell` is the only tool that goes through a human approval round trip, and
  the only one that can be switched off safety-wise — see
  `DEV3D_AUTO_APPROVE_SHELL`. `git` is deliberately outside that gate because it
  cannot write: its subcommands and arguments are allow-listed, and anything that
  could change the repository is refused by name.
- Grants are enforced per employee: the org chart decides who may hold a tool, and
  anything else is refused with a message the model can act on.

### The working plan, and why it lives on the run

`todo_write` is the only tool that changes the run rather than the workspace. It
writes into the run's own plan, so it survives the turn that created it and is
handed to whoever picks the work up in a later stage — which is exactly when a
plan starts to matter. Every call sends the **complete** list: an incremental
add/complete API invites drift between what the model believes the list is and
what it is, while resending it makes each call self-consistent and impossible to
half-apply. It is emitted with `run.updated`, so the console can show progress
without a new protocol surface.

---

## MCP servers

dev3d is an MCP **client**. Point it at servers and their tools become tools your
employees can hold — with no code change, and without those servers being able to
see anything they were not asked for.

```bash
# one or two servers, inline. Entries are separated by ";" because arguments
# routinely contain spaces.
DEV3D_MCP_SERVERS="fs=npx -y @modelcontextprotocol/server-filesystem /srv"

# or a file, which is the better editor for anything richer
cp mcp.json.example mcp.json
```

```jsonc
// mcp.json
{
  "servers": [
    { "id": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    { "id": "remote", "type": "http", "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "Bearer …" } }
  ]
}
```

Both transports are supported: **stdio** (the server runs as a child process,
which is how nearly every published server is used) and **Streamable HTTP** for
hosted ones. The protocol is implemented directly on Node's built-ins, so this
adds no dependency.

**Names cannot collide.** A remote server names its own tools, so every one is
published as `mcp__<server-id>__<tool-name>`. A server offering `read_file`
therefore cannot shadow the built-in of that name, and two servers may both offer
`search` without interfering.

**Grants are deliberate, and off by default.** A remote server can be a
filesystem, a database or a deployment system — more reach than any built-in
tool. So MCP tools are never inherited from the fact that a server is connected:
`DEV3D_MCP_GRANT_ROLES` names the roles that may call them, and the default is
`shell-roles`, meaning the roles that already hold `run_shell`. Connecting a
server widens nobody's reach beyond what they already had.

**A server that is down is not a failure of the office.** Connections are made in
the background after the HTTP listener is open, a failed server is recorded with
its reason and the last thing it printed on stderr, and the others keep working.
Settings → **MCP** shows every configured server, its state and its tool count.

---

## Projects, organisations and floors

One office is a **building**. Each workspace is an **independent organisation**
occupying one floor: it owns its own company, departments, roles, enabled skills,
pipelines, budget and directory. Two floors share nothing but the building they sit
in — the portal team and the payments team have different people, different skills
and different money, and neither can see the other's files.

| Layer | What it holds | Where it is edited |
|---|---|---|
| **Installation** (one per office) | providers, model catalog, concurrency, approval policy, where new floors are created | Settings → General, Models, Safety |
| **Organisation** (one per floor) | company, departments, roles, skills, pipelines, budget, directory | Settings → Skills, Budget; Org tab; Projects tab |

A run belongs to exactly one organisation. `Run.workspaceId` and
`Run.workspacePath` are resolved at submit time and frozen onto the run, so its
record stays truthful after the floor is renamed or closed.

Create a floor from the **Projects** tab. The floor selector in the top bar
switches which organisation you are looking at, which swaps the entire console
context rather than applying a filter.

```
POST   /api/workspaces          { name, description?, color?, folder?, path?, skillIds? }
PUT    /api/workspaces/:id      { skillIds?, budget?, name?, description?, color? }
DELETE /api/workspaces/:id
GET    /api/workspaces          → one summary per floor
GET    /api/settings            PUT /api/settings   { …OfficeSettings }
```

A new floor opens **fully staffed** — a copy of the shipped company, every skill
enabled, the installation's default budget — because firing three roles is quicker
than hiring thirteen. The rules that keep the building safe:

- The directory a workspace names becomes fully readable and writable to *that
  organisation's* employees, and to nobody else's.
- A folder name may not contain separators or `..`, may not escape the workspaces
  root, and two floors may not share a directory.
- Absolute paths outside the root are accepted only while
  `DEV3D_ALLOW_EXTERNAL_WORKSPACES` is true; the default floor cannot be closed.
- Switching a skill off for a floor also trims it from every role holding it, so a
  role can never reference a skill its organisation has disabled.

### Floor styles

A floor's appearance is **data, not code**. A style is a preset plus sparse
patches, resolved purely and totally, and a corrupt style degrades to its preset
rather than reaching a shader. The StylePanel edits it, and the theme maps every
role and every material in both GLBs — no mesh escapes the role table.

---

## Plugins

A plugin is how the office gains a model, a skill, a routing rule, a tool, a role
template, a pipeline or a console panel **without anyone editing this repository**.

Two kinds, and the distinction is the point:

| | Declarative | Code |
|---|---|---|
| Ships | `plugin.json` only | `plugin.json` + an `entry` module |
| Can contribute | models, skills, role templates, pipelines, routing rules, UI panels | all of that, **plus tools** and event subscriptions |
| What it costs you | nothing — it is data | it runs in the orchestrator's process, with the orchestrator's authority |

The console shows which one you are looking at before you enable it, and says so in
words rather than a colour.

Every contribution point is wired, because a contribution the host publishes but
nothing reads is indistinguishable from one that works:

| Contribution | What it reaches |
|---|---|
| `providers` | A whole provider: adapter kind, base URL, and the *name of the environment variable* holding the key. The registry rebuilds on every plugin change, so it appears without a restart. https only, or keyless http on loopback. |
| `models` | Merged into the provider registry's catalog, so the router can pick it and the Models tab shows it. |
| `skills` | Merged into the office skill catalog; a floor can enable one like any other skill. |
| `routingRules` | Applied by the router to reorder candidates, scoped by task class. |
| `toolNames` (code) | Registered, namespaced, and grantable per role from the Org tab. |
| `roleTemplates` | Offered in the hire form alongside the floor's own roles. |
| `pipelines` | Offered to every floor — a plugin cannot know which organisations exist, so "enable per floor" would mean editing thirteen floors to turn one on. |
| `uiPanels` | Rendered in the placement the manifest declares. |
| `settings` | Rendered as a form; values are coerced against the manifest on every write. |

### Panels: data, never code

A panel gives a plugin a console surface without the console having to trust it. It
declares either a fixed `body` of widgets, or a `source` URL that **the server**
fetches and validates:

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
`note` — so the renderer can index cells positionally and a hostile manifest cannot
render an unbounded structure. Bodies are capped at 24 widgets, 60 rows and 500
characters, and truncated rather than rejected. A `source` is fetched server-side
with a 10 s timeout, cached for at least 5 s, coalesced so concurrent consoles
share one request, capped at 12 live panels, and refused unless it is http(s).
**The browser never learns the plugin's URL**, so a panel endpoint cannot be aimed
at the operator's machine, and a dead one costs a panel rather than the console.

### The rules the host enforces

- **A plugin cannot reach the browser.** No panel ships JavaScript. Panels are less
  expressive than an iframe, and in exchange a marketplace plugin cannot touch the
  page, the socket or the session.
- **A plugin cannot shadow a built-in provider.** The first declaration of a
  provider id wins, and the `DEV3D_*` ones are always first, so `.env` stays
  authoritative over a manifest.
- **`activate()` is not sandboxed.** A code plugin runs with the orchestrator's full
  authority; its permission list is a consent record shown to the operator, not a
  runtime gate. Only install one from somewhere you trust.
- **A plugin cannot be unloaded from memory.** Node cannot unload an ES module, so
  disabling a code plugin withdraws its contributions and calls `deactivate()`, but
  the module stays resident until restart. The host says so rather than pretending
  otherwise.

### Installing and updating

An install is gated behind `DEV3D_ALLOW_PLUGIN_INSTALL`, because installing runs
code in the orchestrator's process. Updates are **found, not pushed**: nothing
polls a marketplace on its own, the operator asks. There is no downgrade and no
version pinning, so a marketplace publishing a bad release can only be answered by
disabling the plugin. The marketplace itself is a contract rather than a website —
`PluginCatalog` and the `/api/plugins/catalog` and `/install` routes are the whole
integration.

---

## Environment

See `.env.example`, which documents each variable with the measurement behind it.
The ones that matter most:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind address. |
| `DEV3D_LLM_MODE` | `auto` | `auto` picks `live` when any key is present, else `mock`. |
| `DEV3D_WORKSPACE` | `./workspace` | The default project: what a run uses when it names none. |
| `DEV3D_WORKSPACES_ROOT` | `./workspaces` | Where the Projects tab creates new project folders. |
| `DEV3D_ALLOW_EXTERNAL_WORKSPACES` | `true` | Allow a floor to point outside the workspaces root. |
| `DEV3D_DB` | `./data/dev3d.sqlite` | SQLite file. |
| `DEV3D_ROUTING` | `balanced` | `cheap` \| `balanced` \| `quality`. |
| `DEV3D_MODEL_DISCOVERY` | `true` | Ask providers what they serve. `false` keeps the office fully offline. |
| `DEV3D_BENCHMARKS` | `true` | Pooled quality through OpenRouter's benchmark API. Needs `OPENROUTER_API_KEY`. |
| `DEV3D_ENDPOINT_HEALTH` | `true` | Upstream uptime, which needs no key. |
| `DEV3D_RUN_BUDGET_USD` | `5.00` | Hard ceiling per run. |
| `DEV3D_SOFT_SPEND_APPROVAL_USD` | `1.50` | Ask a human before crossing this. `0` disables. |
| `DEV3D_MAX_CONCURRENCY` | `4` | Parallel employees inside one company. |
| `DEV3D_AUTO_APPROVE_SHELL` | `false` | Skip the shell approval round trip. |
| `DEV3D_APPROVAL_TIMEOUT_MS` | `600000` | How long an approval waits before it counts as refused. |
| `DEV3D_PLUGINS_DIR` | `./plugins` | Where plugins are discovered. Each subdirectory with a `plugin.json` is one plugin. |
| `DEV3D_PLUGIN_INSTALL_DIR` | `./data/plugins` | Where marketplace installs land, kept apart from the shipped set. |
| `DEV3D_ALLOW_PLUGIN_INSTALL` | `false` | Allow installing a plugin bundle from a marketplace URL. |
| `DEV3D_MCP` | `true` | Connect to configured MCP servers. Does nothing until one is configured. |
| `DEV3D_MCP_CONFIG` | `./mcp.json` | The MCP server file. An empty value disables the file. |
| `DEV3D_MCP_SERVERS` | *(empty)* | Inline servers: `<id>=<command> [args…]`, separated by `;`. |
| `DEV3D_MCP_GRANT_ROLES` | `shell-roles` | Who may call MCP tools: role ids, `*`, or `none`. |

Provider keys: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, and `DEV3D_LOCAL_BASE_URL` for any OpenAI-compatible local
runtime (Ollama, vLLM, LM Studio).

**Precedence:** `.env` is the *bootstrap*. On a first boot these values become the
installation settings; from then on the saved settings win and the Settings page is
how they change. Three things stay environment-only: provider API keys, which are
never exposed to the browser; `DEV3D_DB`, which has to be known before the database
can be opened; and the plugin install gate, which decides whether code from the
network may run here at all.

**`.env` is read once, at startup.** Editing it therefore does nothing to a running
server, which looks exactly like a bug. The health endpoint and the console detect
that case — `configStale` is set when `.env` has been modified since boot, or when a
provider key has appeared in the environment since the mode was resolved — and the
console says so with the remedy.

---

## Documentation

| Document | What is in it |
|---|---|
| [`docs/development.md`](docs/development.md) | Working on dev3d: layout, the verification suite, the Blender asset pipeline, and the UI screenshot tooling |
| [`docs/design-notes.md`](docs/design-notes.md) | Why the model layer, plugin host, block kit and persistence are shaped the way they are |
| [`docs/wire-protocol.md`](docs/wire-protocol.md) | The WebSocket protocol, the read API, and the plugin authoring surfaces |
| [`mcp.json.example`](mcp.json.example) | MCP server configuration, with a worked example of each transport |
| [`docs/sandbox.md`](docs/sandbox.md) | Running the toolchain inside a restricted sandbox or CI runner |
| [`RELEASE.md`](RELEASE.md) | The release process and version policy |

---

## Known gaps

- **No authentication.** Everything is unauthenticated and intended for localhost.
- **A run cannot be moved between floors.** `workspaceId` is frozen at submit time;
  closing a floor does not migrate its history anywhere.
- **The office composition has not been judged by eye.** Headless Chrome renders it
  and the multi-floor building, camera framing and floor picker are verified that
  way, but lighting balance, storey height (4.2 m), plate opacity and fog are all
  first guesses.
- **Generated space is axis-aligned.** Modules are tried least-used-first, so a floor
  gets a pod, an office, a meeting room and a lounge rather than nine pods — but the
  kit has no corner or diagonal piece, so a building grows in steps and wings rather
  than around a courtyard. At seventeen modules an individual desk is small and there
  is no room-by-room navigation.
- **The regenerated office is a reconstruction.** `03_office_furniture.py` builds the
  desks, chairs, meeting table and every anchor and asserts the contract (21 seats,
  13 desks, 7 rooms), but it is not the asset a person made: fewer meshes, simpler
  forms, no bespoke detail. The hand-authored original is kept at
  `blender/reference/office.hand-authored.glb`.
- **No avatars in the GLB.** Employees are built procedurally in the browser from
  `Role.appearance`. That is deliberate, and it means the avatars are deliberately
  simple.
- **Direct messages carry no tools.** A conversation outside a pipeline routes on the
  role's default tier and answers from the model alone; it cannot read the workspace,
  and the reply says so rather than pretending.
- **A plan is local to one browser.** Submitting is the point at which a plan becomes
  the server's business, so two consoles cannot collaborate on one draft and clearing
  site data discards them.
- **The Plan page is verified in `mock` mode.** The transport, multi-turn replay,
  brief handoff and submit-to-run path are driven end to end against the scripted
  provider. What has not been exercised is a real model's planning conversation.
- **The planner builds in one style, and the marketplace site does not exist yet.**
  `PluginCatalog` and the `/api/plugins/catalog` and `/install` routes are the whole
  marketplace integration.
- **A live panel is fetched on demand, not pushed.** Opening a console triggers the
  first read, and the console then polls on the interval the manifest asks for. The
  first paint can be a moment behind.

---

## License

**AGPL-3.0-or-later.** See [`LICENSE`](LICENSE).

Chosen deliberately, because of what this project is: it is designed to be operated
as a server. A permissive license would let someone host a modified dev3d as a
service and never publish the changes, which is the one outcome the project's own
architecture — an office that grows a plugin marketplace — makes likely. The AGPL's
network clause closes that gap: if you run a modified version for other people to
use over a network, you offer them its source.

In the two common cases:

- **Running it for yourself or your team, unmodified** — nothing is asked of you
  beyond keeping the license intact. No obligation to publish anything.
- **Modifying it and letting others use it over a network** — you must offer them the
  Corresponding Source of your version. Section 13 is the clause that says so.

Plugins are separate: a plugin is your own work, and loading one into this
orchestrator does not make it a derivative of the orchestrator. That is the same line
the FSF draws for GPL-covered programs and their plugins, and it is why the plugin
host passes data rather than code across the boundary wherever it can.

If the AGPL does not suit your situation, the copyright holder can license otherwise
— open an issue to ask.
