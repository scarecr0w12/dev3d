# The wire protocol

dev3d is a server and a browser that speak one typed protocol. This document is
for anyone integrating with the orchestrator directly, or writing a client of
their own.

Everything here is defined in `packages/core/src/events.ts`, and both ends compile
against those types — which is what keeps the protocol honest. There is no
protocol negotiation and no version handshake: the UI is served by the orchestrator
it talks to, and the two are expected to be the same version.

---

## WebSocket

One socket, at `/ws`.

- On connect the server sends `hello` carrying the whole `OfficeState` — the org
  chart, every floor, the model catalog, plugin records, settings and what is in
  flight. A client needs no second request to render.
- The client sends a **`ClientCommand`** (14 of them). Commands cover submitting
  and cancelling runs, direct messages, planning turns, approving or denying a
  request, and editing the org chart live.
- The server pushes a **`ServerEvent`** (24 of them). Every event is persisted
  *before* it is broadcast, so a reconnecting client replaying from the log sees a
  superset of what it had and never a gap.
- `loadRun` replays a run's persisted events to the asking socket, which is how a
  browser rebuilds a transcript it never watched — with no extra protocol surface.

### Two conversation-shaped commands, and why they differ

`chat` is a direct message to one employee. Its answer comes back as
`direct.message`, **broadcast to every console**, because an office where somebody
is being talked to is office business.

`plan` shapes a brief that has not been commissioned. Its answer is `plan.reply`,
**pushed to the asking socket only**, because a half-finished idea appearing in
every other console's feed would be noise at best. A plan carries its own `history`
and is otherwise stateless on the server: nothing is commissioned, so there is
nothing to persist.

## Read API

| Route | Returns |
|---|---|
| `GET /api/health` | Mode, the reason for it, store status, uptime, active runs, pending approvals |
| `GET /api/state` | The current `OfficeState` |
| `GET /api/runs` | Run summaries |
| `GET /api/runs/:id` | One run, with its persisted turns and artifacts |
| `GET /api/skills` | The skill catalog |
| `GET /api/models` | The merged model catalog, with provenance |
| `GET /api/providers` | Provider status, including how each model list was obtained |
| `GET /api/workspaces` | One summary per floor |

## Write API

| Route | Purpose |
|---|---|
| `POST /api/submit` | Start a run from a brief |
| `POST /api/chat` | A direct message to one employee |
| `POST /api/plan` | A planning turn, answered to the caller only |
| `GET`/`PUT /api/settings` | Installation settings |
| `POST`/`PUT`/`DELETE /api/workspaces` | Create, edit and close floors |
| `POST /api/models/discover` | Ask providers what they serve |
| `POST /api/models/benchmarks` | Refresh pooled quality; returns coverage |
| `POST /api/models/health` | Sample upstream endpoint uptime |

A malformed body is a `400` with a message, never a `500`.

## Security

Nothing on the wire authenticates, by design: this is an application you run
locally, and it has the authority of the workspace it is pointed at. **Bind it to
`localhost`.** Provider API keys are never exposed to the browser — the client
learns whether a key is present, never its value.

---

# Writing a plugin

A plugin adds a provider, models, skills, routing rules, tools, role templates,
pipelines or console panels **without anyone editing this repository**.

A plugin is a directory containing `plugin.json`. A **declarative** plugin ships
that file alone; a **code** plugin also ships an `entry` module, which runs in the
orchestrator's process with the orchestrator's authority. The console labels which
kind you are looking at before you enable it.

## A manifest

```jsonc
{
  "id": "dev3d.cost-guard",
  "name": "Cost guard",
  "version": "1.0.0",
  "description": "route mechanical work to cheap models",
  "apiVersion": "1",
  "author": "dev3d",
  "license": "MIT",
  "permissions": ["models", "routing", "skills", "settings"],
  "contributes": {
    "models": [ /* … */ ],
    "routingRules": [ /* … */ ],
    "skills": [ /* … */ ],
    "toolNames": ["echo"],
    "uiPanels": [ /* … */ ]
  },
  "settings": [
    { "key": "aggressiveness", "label": "How hard", "type": "select",
      "default": "balanced", "options": ["balanced", "aggressive"] }
  ]
}
```

Three example plugins ship in `plugins/`: `dev3d.cost-guard`,
`dev3d.local-coder` and `dev3d.office-echo`.

## What each contribution reaches

| Contribution | Effect |
|---|---|
| `providers` | A whole provider: adapter kind, base URL, and the **name of the environment variable** holding the key. The registry rebuilds on every plugin change, so it appears without a restart. https only, or keyless http on loopback. |
| `models` | Merged into the provider registry's catalog, so the router can pick it. |
| `skills` | Merged into the office skill catalog; a floor can enable one like any other. |
| `routingRules` | Applied by the router to reorder candidates, scoped by task class. |
| `toolNames` | Registered, namespaced, and grantable per role from the Org tab. Code plugins only. |
| `roleTemplates` | Offered in the hire form alongside the floor's own roles. |
| `pipelines` | Offered to every floor. |
| `uiPanels` | Rendered in the placement the manifest declares. |
| `settings` | Rendered as a form; values are coerced against the manifest on every write. |

## Panels are data, never code

A panel declares either a fixed `body` of widgets or a `source` URL that the
**server** fetches and validates:

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
```

`PanelWidget` is a closed set — `metric`, `keyValue`, `table`, `list`, `bars`,
`note` — so the renderer can index cells positionally and a hostile manifest cannot
render an unbounded structure. Bodies are capped at 24 widgets, 60 rows and 500
characters, and are truncated rather than rejected.

A `source` is fetched server-side with a 10 s timeout, cached for at least 5 s,
coalesced so concurrent consoles share one request, capped at 12 live panels, and
refused unless it is http(s). **The browser never learns the plugin's URL**, so a
panel endpoint cannot be aimed at the operator's machine, and a dead one costs a
panel rather than the console.

## Rules the host enforces

- **A plugin cannot reach the browser.** No panel ships JavaScript. This is the
  trade: panels are less expressive than an iframe, and a marketplace plugin cannot
  touch the page, the socket or the session.
- **A plugin cannot shadow a built-in provider.** The first declaration of a
  provider id wins and the `DEV3D_*` ones are always first, so `.env` stays
  authoritative over a manifest.
- **A plugin cannot move a turn to another tier.** A routing rule's preferences
  apply as score bonuses *confined to the tier the policy chose*, so a rule can
  reorder candidates without overriding the policy.
- **`activate()` is not sandboxed.** A code plugin runs with the orchestrator's full
  authority. The permission list is a consent record shown to the operator, not a
  runtime gate. Only install one from somewhere you trust.
- **A plugin cannot be unloaded from memory.** Node cannot unload an ES module, so
  disabling a code plugin withdraws its contributions and calls `deactivate()`, but
  the module stays resident until restart.

## Installing and updating

Installing is gated behind `DEV3D_ALLOW_PLUGIN_INSTALL`, because an install runs
code in the orchestrator's process. Updates are **found, not pushed**: nothing polls
a marketplace on its own, the operator asks. There is no downgrade and no version
pinning, so a marketplace that publishes a bad release can only be answered by
disabling the plugin.

The marketplace integration is `PluginCatalog` plus the `/api/plugins/catalog` and
`/install` routes. The catalogue site itself is a separate project.
