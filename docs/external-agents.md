# External agents

This document is the design note for connecting dev3d to **other agent systems** —
Codex, DeepSeek Harness, Hermes, OpenClaw, and whatever else shows up — rather
than to other *model APIs*. It states the reconnaissance, the one asymmetry that
decides the whole design, the integration shapes available, and the phased plan.

**Phases 1, 1b and 2 are built.** Sections 1–3 and the §5 hazard analysis are the
reasoning that produced them and are still the reference for what comes next; §6
says which phases are done and which are not. What shipped:

| | |
|---|---|
| `packages/core/src/vendor.ts` | `VendorState`, `VendorStatus`, `ReadOnlyEnforcement`, `VendorCapabilities`, `VendorBay` |
| `apps/server/src/rpc/` | the JSON-RPC envelope, the transport contract and the stdio transport — shared by MCP and ACP |
| `apps/server/src/vendors/` | `config.ts` (presets + `vendors.json`), `command.ts` (one-shot transport), `acp.ts` (the Agent Client Protocol client), `output.ts` (answer extraction), `registry.ts`, `testing.ts` (the injected-seam fake) |
| `apps/server/src/tools/vendor.ts` | one `agent__<id>__delegate` tool per vendor, granted through `Role.canDelegate` |
| `apps/web/src/office/vendorAvatar.ts` | the vendor terminal — a machine, not a person |
| `apps/web/src/console/VendorsPanel.tsx` | the roster page and the inspector panel |

All four named harnesses are covered. Codex, DeepSeek Harness and Hermes over the
one-shot command transport; **OpenClaw over ACP**, which is the transport it
actually speaks — and which reaches the rest of the ACP Registry (Claude, Gemini
CLI, OpenCode, Copilot, Cursor, Amp, Auggie, Poolside) for the same cost.

Read `design-notes.md` first for the model layer, the tool layer and the MCP
section; this document assumes all three.

---

## 1. What the named systems actually are

The four named systems are not four bespoke protocols. They are **agents**, and
they converge on two integration contracts:

| System | Headless one-shot | ACP | Who owns its filesystem |
|---|---|---|---|
| **Codex** | `codex exec --json "task"` | yes (ACP Registry) | Codex, via `--sandbox` |
| **DeepSeek Harness** | `dsh --profile headless "task"` | — | DSH, via its own tool mode |
| **Hermes** (Nous Research) | `hermes chat -q "task"` | — | Hermes |
| **OpenClaw** | Gateway chat/send | `openclaw acp` (**partial**) | OpenClaw's Gateway |
| *Claude, Gemini CLI, OpenCode, Copilot, Cursor, Amp, Auggie, Poolside, Pi…* | varies | yes (ACP Registry) | the agent |

The two contracts worth building against:

**(a) A one-shot headless command.** Prompt in, text out, exit code meaningful.

| | command | stdout | exit |
|---|---|---|---|
| Codex | `codex exec --json "…"` | JSONL events, or prose | `0` ok, `1` general, `2` auth, `3` config, `4` model, `130` SIGINT |
| DSH | `dsh --profile headless "…"` | last non-empty assistant text | `0` turn completed, `1` not completed, `130` SIGINT |
| Hermes | `hermes chat -q "…"` (`-m` to pick a model) | prose | — |

**(b) ACP — the Agent Client Protocol.** JSON-RPC 2.0 over stdio, agent as a
subprocess, with a real registry behind it. Implementing ACP *once* reaches
Codex, Claude, Gemini CLI, OpenCode, Copilot, Cursor, Amp, Auggie, Poolside and
OpenClaw — versus one bespoke adapter per vendor. It is the only contract here
that is a standard rather than a convention.

### The detail that shapes everything

**OpenClaw's ACP bridge advertises neither `fs/read_text_file` /
`fs/write_text_file` nor `terminal/*`.** Its own compatibility matrix says so. It
edits files itself, through its Gateway, and simply does not route those
operations through the client.

So "confinement" is not something ACP gives us. It is something **each agent
individually decides**, and the console has to say which one you are looking at.

---

## 2. The asymmetry this design exists to resolve

The repository already integrates one external system — MCP — and the reason it
is safe is written down in `design-notes.md`:

> a connected server is a source of *tools* and nothing more … an MCP tool is
> confined, granted and displayed by exactly the machinery a built-in tool uses

That works because an MCP tool is **adapted into a dev3d `Tool`**
(`mcp/manager.ts` → `toTool`), so it receives the same `ToolContext` every
built-in gets: `workspaceRoot`, `writtenPaths`, `plan`, `signal`,
`requestApproval`. Every path it touches goes through
`resolveInWorkspace(workspaceRoot, …)` (`tools/paths.ts:26`).

**An external agent cannot be adapted that way.** Codex writes files with its own
hands, in its own sandbox, and reports back a paragraph. It is not a function
dev3d calls; it is a process dev3d supervises.

Concretely, dev3d's guarantees degrade like this:

| | MCP tool / built-in tool | External agent |
|---|---|---|
| Path confinement | `resolveInWorkspace` choke point | the agent's own sandbox, or none |
| Approval gate | `ctx.requestApproval` → callout | ACP `session/request_permission` **if** the agent sends it |
| Who may use it | per-role grant, default-deny | per-role grant, default-deny (we can keep this) |
| Files touched | `affectsPaths`, exact | ACP `tool_call` updates, best-effort; else unknown |
| Cost | real tokens, real dollars | usually **nothing dev3d can see** — a subscription |
| Runaway risk | `MAX_TOOL_ITERATIONS` bounds it | nothing bounds it; one call can run for hours |

Every one of those is a decision the design has to make explicitly rather than
inherit. That is the work.

---

## 3. Where it plugs in: the two seams, and which to use

### Seam A — the tool layer (recommended first)

An external agent becomes a **tool employees may call**, granted exactly like an
MCP tool.

Why this is the right first home: `ToolContext` (`tools/types.ts:20-60`) already
carries *everything* an external agent needs and the provider layer carries
*none* of it.

```ts
export interface ToolContext {
  workspaceRoot: string;              // where to spawn it
  writtenPaths: Set<string>;
  plan: AgentPlanStep[];
  recall?(query, limit): MemoryFact[];
  requestApproval(req): Promise<boolean>;   // the approval gate
  autoApproveShell: boolean;
  signal?: AbortSignal;                     // cancellation
  log(level, message): void;
}
```

And the grant machinery is already built and tested for exactly this case:

- `mcpGrantedForRole(role, config)` — a pure exported function (`runtime.ts:408`),
  deliberately pure because it decides whether an employee can reach somebody
  else's infrastructure.
- `withMcpGrants(role)` — adds the published names to `role.allowedTools`
  (`runtime.ts:1001-1009`), returning the role untouched in the common case.
- `executeToolCall` enforces the grant at one point (`engine/turn.ts:126-134`).

An external-agent tool is a copy of that pattern, not a new subsystem.

### Seam B — the provider layer (phase 2)

An external agent becomes a **model the router can pick**, so an operator can pin
the developer role to Codex and the office shows it in *Routing & cost*.

This is where "work with other LLM systems" most literally belongs, and it is why
phase 2 exists. But it needs a real change first:

```ts
// llm/types.ts:20 — no workspace, no run, no approval hook, no tool context.
export interface ChatRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  tools?: LlmToolSchema[];
  temperature?: number; maxOutputTokens?: number;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}
```

`deps.registry.chat(...)` is called from `engine/turn.ts:424` and hands the
adapter nothing about *which run* it is serving. An agent-as-provider would not
know its working directory, could not ask a human, and could not report files
touched. So phase 2 requires widening `ChatRequest` with an optional context —
which is a change to the adapter contract, and therefore to every adapter.

**Do it in that order.** The tool layer proves the transports, the observability
and the honesty surfaces against a real agent before any of it is load-bearing
for routing.

### The seams that are *not* worth touching

- **Do not** make the external agent a pipeline stage kind. `stages.ts` modes are
  about *how many models argue*, which is orthogonal.
- **Do not** reuse the plugin `ProviderKind` union for a CLI agent as-is:
  `manifest.ts:483-507` **requires a `baseUrl` that is https or loopback** and
  `:508` restricts `kind` to `openai-compat | anthropic`. A command has no URL,
  so a plugin-authored agent is unrepresentable today. That is a real edit, not a
  workaround.

---

## 4. The proposed shape

### 4.1 An agent registry, modelled on the MCP manager

`apps/server/src/agents/` — the analogue of `mcp/`.

```ts
export interface ExternalAgentConfig {
  id: string;                    // slug, used in the tool name
  label: string;
  kind: 'acp' | 'command';
  /** command: the program. acp: the program that speaks ACP on stdio. */
  command: string;
  args?: string[];
  /** command only: how the prompt reaches it. */
  prompt?: { transport: 'argv' | 'stdin'; flag?: string };
  /** Where it runs. Always the run's workspace; never the repo. */
  cwdPolicy: 'run-workspace';
  env?: Record<string, string>;
  /** The real ceiling. See §5.1 — the budget cannot bound this. */
  timeoutMs: number;
  /** What the console may claim about it. */
  capabilities: {
    streams: boolean;
    reportsToolCalls: boolean;
    /** True when it honours ACP fs/*, i.e. when dev3d can confine it. */
    usesClientFs: boolean;
    reportsCost: boolean;
  };
  enabled?: boolean;
  description?: string;
  authNote?: string;             // "run `codex login` — this agent owns its own auth"
}
```

Configured the way MCP is: `DEV3D_AGENTS` for inline config and
`agents.json` for a file, with the same "on by default but does nothing until
something is named" posture, and the same background-connect, per-connection
failure isolation (a down agent must not delay boot or affect its siblings).

Shipped **presets** so the four named systems are one line each:

```jsonc
{ "preset": "codex",    "command": "codex", "args": ["exec", "--json"] }
{ "preset": "dsh",      "command": "dsh",   "args": ["--profile", "headless"] }
{ "preset": "hermes",   "command": "hermes","args": ["chat", "-q"] }
{ "preset": "openclaw", "command": "openclaw", "args": ["acp"], "kind": "acp" }
```

### 4.2 Two transports, both reusing what exists

**`command` — one-shot headless.** The cheapest useful thing, and it covers the
three systems with no ACP today.

Copy `StdioTransport` (`mcp/stdio.ts`) almost wholesale, because it already
solved the hard parts:

- an injectable `spawnFn` (`stdio.ts:27-44`) — the *only* way to test a
  subprocess in this sandbox (§5.4);
- `shell: false`, so a config file cannot smuggle in a shell command
  (`stdio.ts:100`);
- a bounded stderr ring, read continuously so it cannot fill the pipe
  (`stdio.ts:108-117`);
- `stdin.end()` → `kill()` → `SIGKILL` after 2 s (`stdio.ts:179-210`);
- the EPERM hint, which turns "it did not start" into "your sandbox blocks piped
  child stdio" (`stdio.ts:119-130`).

Add: an `AbortSignal` path copied from `run_shell` (`tools/shell.ts:93-103`),
which is the only existing spawn that wires cancellation correctly (`git.ts`
does not).

**`acp` — the standard.** Newline-delimited JSON-RPC over stdio.

The framing is *identical* to MCP's, so the right move was to **generalise the
transport** and have both protocols use it. It is now `apps/server/src/rpc/`:
`jsonrpc.ts` (the envelope), `transport.ts` (the `JsonRpcTransport` contract and
the child-process seam), and `stdio.ts` (`StdioTransport`). `mcp/client.ts` keeps
`McpTransport` as an alias of the shared interface, so nothing at the call sites
changed. ACP became "a client class over the transport we already trust", and the
framing, the stderr ring, the start handshake, the kill sequence and the injectable
`spawnFn` were written once.

What dev3d implements as the ACP **client** — all of it shipped:

| Surface | What dev3d does |
|---|---|
| `initialize` | advertises `readTextFile: true`, **`writeTextFile: false`**, no `terminal` |
| `session/new`, `session/prompt` | one turn, in the run's workspace |
| `session/cancel` | sent on abort and on timeout, so the agent stops rather than being dropped |
| `session/update` → `agent_message_chunk` | streams the answer as it arrives, so a delegation shows progress |
| `session/update` → `tool_call` / `tool_call_update` | collected as `toolCalls`, with `locations` and diff paths relativised and confined |
| `fs/read_text_file` | **served by the office** through `resolveInWorkspace`, honouring `line`/`limit` |
| `fs/write_text_file` | **refused**, in words, even though it was never advertised |
| `session/request_permission` | put to a human through `ctx.requestApproval`; refused when nobody can answer |

Three of those rows are the whole reason ACP is worth the work. Reads are answered
by `resolveInWorkspace` — the same choke point every built-in tool goes through —
so an escape attempt fails *here* rather than being reported. Writes are refused,
so read-only is dev3d's own behaviour rather than the agent's promise. And a
permission request lands in the approval callout a `run_shell` uses, so an
external agent is gated by machinery that already exists and is already tested.

**What this corrected in the plan above.** The original text said OpenClaw reports
no `fs/*` and therefore `usesClientFs: false`, and that read-only would be
"enforced by dev3d: `--sandbox read-only` to Codex, the equivalent elsewhere".
Both halves were wrong about the important part:

- OpenClaw's ACP bridge does not *call* the client filesystem methods — but that
  is a property of that bridge, not of ACP. dev3d still **advertises** the
  capability, and still refuses writes to any agent that asks. So the enforcement
  claim is about dev3d's own behaviour, which is knowable, rather than about what
  a vendor will or will not do, which is not.
- "The equivalent elsewhere" does not exist. Codex has a sandbox flag; DSH and
  Hermes have nothing. See §4.2's sibling below.

**Option selection on a permission request is defensive, on purpose.** The options
are the *agent's* list, so nothing about them can be trusted: the client picks by
documented `kind` first and falls back to a name match, never assumes the first
option is the permissive one, and refuses when nothing offered means "no" — because
a list containing only "Allow" must not turn a refusal into a yes.

### 4.2b Read-only is three-valued, not two

`VendorCapabilities.readOnlyEnforcement` replaced what would have been a boolean,
and ACP is what forced it. There are three genuinely different guarantees:

| Level | Who makes it true | What it does *not* cover |
|---|---|---|
| `sandbox` | the harness, via an OS sandbox dev3d asked for (`codex exec -s read-only`) | nothing — this holds for the whole process |
| `client` | **dev3d**, over ACP: writes refused, reads confined, tool calls put to a human | the agent is still a local process, so it constrains what it does *through dev3d* |
| `requested` | nobody; the task text asks | everything |

A boolean would have had to call the middle case one of its two neighbours, and
both would have been wrong: `sandbox` would overstate it (it is not an OS
sandbox), and `requested` would understate it (dev3d really does refuse). It is
also load-bearing rather than descriptive — `requested` is the only level nothing
bounds, so it is the one that asks a human to approve the delegation up front,
while a `client` vendor is mediated per tool call instead and needs no blanket
gate.

An unrecognised value in `vendors.json` falls back to the preset's level and never
to `sandbox`: a typo must not be able to upgrade a request into a guarantee.

### 4.3 The tool surface

One tool per configured agent, namespaced by the rule that already prevents a
class of bug (`design-notes.md`, "Naming"):

```
mcp__<serverId>__<toolName>        existing
agent__<agentId>__delegate         proposed
```

Granted through a pure exported `agentsGrantedForRole(role, config)` mirroring
`mcpGrantedForRole` (`runtime.ts:408`), defaulting to `shell-roles` for the same
reason MCP does — role ids belong to an org chart an operator can edit, and
"whoever can already run a command" keeps meaning the same thing as the chart
changes.

#### The hook that is already there

`Role.canDelegate: boolean` exists on the shared contract
(`packages/core/src/org.ts:232`), is populated for every seeded role
(`org/defaultCompany.ts:196,243,281,…`) and for `syntheticRole`
(`runtime.ts:986`) — and **is read by nothing.** A repo-wide grep finds zero read
sites. It is a declared control with no enforcement, which is exactly the defect
`design-notes.md` describes for `Role.maxTurnsPerStage` before it was wired up:

> An operator could open the org chart, see a per-employee limit, change it, and
> change nothing.

So the delegation feature has a natural, already-declared gate: **`canDelegate`
is who may delegate**, `agentsGrantedForRole` is *which* agents they may reach,
and `maxDirectReports`/`directReports` (`org.ts:327-343`, currently display-only)
stay out of it — delegating to a Codex process is not the same as putting work on
a report, and conflating them would make an org-chart edit silently change
whether an employee can spawn a subprocess.

#### The prompt currently forbids this, and must change in the same commit

`engine/prompt.ts:212-223` tells a manager with reports that it may not assign
them work — "an employee cannot change either" — because nothing in the engine
could hand work to a report. That text ships today.

Adding a delegation tool without changing that text produces a model that
contradicts its own instructions, which `HOUSE_RULES` (`prompt.ts:151-159`)
explicitly forbids. **The prompt edit is part of the feature, not a follow-up.**

#### The event is already there too

`speech` carries `kind: 'debate' | 'report' | 'question' | 'answer' | 'handoff'`
(`core/events.ts:238`) and **`'handoff'` is declared but never emitted anywhere in
the repository.** The web store already renders any speech kind generically
(`store.ts:1018-1028`), so "Ana handed this to Codex" is one `emit` with **no
protocol change and no web change at all**. Prefer that to a new variant.

A delegation tool's arguments are deliberately narrow:

```jsonc
{
  "task": "Why does the session lookup deref null? Report the call path.",
  "mode": "read-only"      // read-only | write
}
```

`mode: "write"` is what routes through the approval gate and what the console
colours differently. The distinction is enforced by dev3d, not requested of the
agent — `read-only` is passed as `--sandbox read-only` / `-s read-only` to Codex
and as the equivalent to anything else that has one, because a prompt is not a
security boundary.

Two details of the gate come free from what already exists: `ApprovalKind`
already includes `'network'` (`core/run.ts:198-204`), which is what a delegation
request is, and the broker is kind-agnostic — so a Codex permission request lands
in the same callout, with the same 600 s
default timeout resolving to **refused** (`runtime.ts:1042-1049`), that a
`run_shell` already uses. An approval that cannot be answered must not wedge a
run, and that promise is already kept.

### 4.4 Phase 2 — the provider kind

Only after the tool path works.

- `ProviderKind` (`config.ts:99`) gains `'external-agent'`.
- `registry.ts:199-207` gains an **explicit** branch. This matters: the final
  `else` is a catch-all, so a new kind that is added to the union but forgotten
  here silently becomes an OpenAI-compatible HTTP adapter pointed at a program
  name.
- `plugin.ts:190` and `manifest.ts:483-511` widen so a plugin can contribute one:
  a `command` satisfies the "endpoint" requirement that `baseUrl` currently
  satisfies, and `keyless: true` is implied rather than demanded.
- `listModels` is **omitted**, and that is fine by design — `LlmProvider.listModels`
  is already optional (`llm/types.ts:56`) precisely because "a provider without a
  list endpoint … the office falls back to the curated seed rather than treating
  'I cannot ask' as 'there are none'". `discovery.test.ts:98-124` already pins
  that behaviour.
- Cost: `costPerMTokIn/Out` default to `0` and are **operator-set**, because a
  Codex or Hermes subscription bills nothing dev3d can observe. The adapters
  already tolerate `costUsd: 0` (`engine/turn.ts:449-451`, `:519`); the honest
  move is a *notional* price the operator can enter, and a console note that it
  is notional.

---

## 5. What will bite, and what to do about it

### 5.1 The run budget cannot bound an external agent — and does not even bound a turn

The problem is worse than "the agent bills nothing dev3d can see". The
enforcement points are:

- **Between stages**, `runEngine.ts:203-211`, and exposed to stages as
  `ctx.abortReason()`.
- **At debate and review-loop boundaries only** — `stages.ts:360-362` and
  `:437-438` are the only two callers.

`runSingle` and `runParallel` never call `abortReason()`, and **inside a turn the
tool loop checks only `req.signal.aborted`** (`turn.ts:418-422`) — never the
budget. Cost reaches `run.budget.spentUsd` only *after* the turn completes
(`turn.ts:517-526`).

So a single tool call that costs money is unbounded until it returns, and the
8-iteration cap limits *round trips*, not cost per call. A delegation to Codex is
exactly such a call.

Three consequences, all of which need a decision rather than a workaround:

1. **The spend ceiling is inert for delegated work**, by construction: an agent on
   a Codex, Hermes or DSH subscription reports no `costUsd` at all, so
   `budget.spentUsd` silently under-counts and `budget.updated` and the workspace
   roll-up (`runtime.ts:839-847`) are wrong rather than merely approximate.
2. **The real control is a per-delegation timeout**, and it must be a hard kill
   rather than a polite request: abort → `session/cancel` → `SIGKILL` after a
   grace period, the shape `StdioTransport.close()` already uses
   (`stdio.ts:179-210`).
3. **A mid-turn budget check is worth adding regardless of this feature** — it is
   a pre-existing hole that the delegation tool would be the first thing to fall
   through.

A **concurrency cap on delegations** is the second control, so one employee
cannot fan out to six Codex processes and saturate the machine.

### 5.2 Cost and quality signals go quiet

The learned-quality layer reads finished turns (`design-notes.md`, "Where quality
numbers come from"). A turn served by an external agent with `costUsd: 0` and
guessed token counts would enter that layer as a suspiciously free, suspiciously
perfect model. Two options, and the design should pick one deliberately:

- record the turn with `servedBy` naming the agent and **exclude it from learned
  quality** (the agent is not a model, and blending it would corrupt real
  measurements); or
- give it an operator-declared notional price and let it compete.

Recommendation: **exclude**, and say why in the console. A "model" that reports
no cost and no real token counts is not comparable, and a corrupted learned layer
degrades *every* routing decision, not just this one.

### 5.3 Cancellation, and a bug that delegation will inherit

`req.signal` is threaded correctly all the way down: `StageContext.signal`
(`runEngine.ts:251`) → `runOneTurn` (`stages.ts:270`) → `TurnRequest.signal`
(`turn.ts:81`) → both the provider call (`turn.ts:439`) and `ToolContext.signal`
(`turn.ts:188`).

Two things are still wrong, and both matter more with an agent behind the call:

- **`run_shell` kills the child but does not settle its promise**
  (`tools/shell.ts:93-103`). A detached grandchild that holds the pipe keeps the
  tool call alive, so aborting from the console can fail to abort. Codex, Hermes
  and DSH all spawn their own subprocesses, so a delegation tool would hit this
  immediately. Fixing it properly means a process group on POSIX and a job object
  on Windows; until then the honest position is a stated limit — **a killed
  delegation may leave a running grandchild**, and the timeout bounds dev3d's
  patience, not the machine's work.
- `tools/git.ts` has **no `AbortSignal` support at all** (`:133-156`). It is not
  the pattern to copy; `shell.ts:93-103` is.

### 5.4 This sandbox blocks piped child stdio

`docs/development.md` already documents four skipped tests for exactly this
reason, and `tools/plan.test.ts:52-58` probes for it with `spawnSync`. So:

- **every** test of an external agent goes through the injected `spawnFn` seam —
  protocol, framing, JSONL parsing, timeout, abort, stderr ring, exit-code
  mapping — exactly as `mcp/manager.test.ts` does;
- the one or two tests that need a *real* child skip with the reason, in the
  established style;
- the ACP client is testable the same way, because it is a client over an
  injected transport. This is the strongest argument for generalising
  `StdioTransport` rather than writing a new one.

### 5.5 Recursion, and the machine's own state

dev3d → DSH → … is unbounded as written. Two guards:

- a **depth cap** (`DEV3D_AGENT_MAX_DEPTH`), passed to the child as an env var so
  a nested dev3d (or any agent that honours it) can refuse to recurse;
- a note in the console when the configured `command` resolves to *this* project's
  own agent, because `dsh --profile headless` from inside a DSH-hosted dev3d
  shares the DSH home and profile store with the session that launched it.

There is no global ceiling on concurrent runs either — `maxConcurrency` bounds
branches *within* a stage (`stages.ts:324`), not runs — and `EmployeeState` is a
single mutable record per employee (`runtime.ts:936-950`), so two runs sharing a
role already overwrite each other's status. Delegation multiplies both.

### 5.6 A delegated agent's writes would be invisible — and that is not cosmetic

`affectsPaths` is how a tool reports what it touched. It flows
`tool.result` → `turn.wroteFiles` → `run` → `knowledge.filesWritten`, and
`knowledge.producers` is what decides **who revises in a review-loop**
(`stages.ts:225-233`, `:480-483`).

An MCP tool always returns `affectsPaths: []` (`mcp/manager.ts:316`). So today a
remote agent that edits files leaves the run blind: the transcript cannot show
what changed, and a review-loop cannot send the work back to whoever produced it.

A delegation tool must therefore **populate `affectsPaths`**, and the only honest
source is the agent itself:

- **ACP**: `session/update` → `tool_call` / `tool_call_update` carry file
  locations. Translate them to workspace-relative paths and the delegated work
  becomes visible in the console *and* correct in the review loop.
- **one-shot CLI**: Codex's `--json` stream reports file changes; DSH and Hermes
  report prose only, so for them `affectsPaths` stays `[]` — and the console
  should say the working tree may have changed without being able to name how.

That asymmetry is worth stating in the UI rather than smoothing over: "this agent
reports what it touched" is a real property of an integration, and a reviewer
needs to know which kind they are looking at.

### 5.7 A delegation must return a summary, not a transcript

A tool result is capped before it reaches the model:

| Bound | Value |
|---|---|
| Model↔tool round trips per turn | 8 (`turn.ts:36`) |
| Tool result fed back to the model | 8 000 chars (`turn.ts:38`, `:236`) |
| Result preview stored for the UI | 300 chars (`turn.ts:235`) |

A Codex or DSH run produces far more than 8 000 characters. So a delegation tool
has to be explicit about what it returns: **a bounded summary plus a pointer to
any artifact it wrote**, never the raw stream. Truncation does happen visibly
(`turn.ts:49` marks it), but a silently truncated delegation reads as a complete
answer, which is the failure mode `design-notes.md` already calls out for
unconverged turns.

### 5.8 Adding an event is enforced by the compiler, not by convention

If the design does add a `ServerEvent` variant, `apps/web/src/app/store.ts:712-726`
ends its `switch` with:

```ts
// Compile-time exhaustiveness: if a future `ServerEvent` variant is not
// handled above, `event` is no longer `never` here and this line fails
// the typecheck.
const exhaustive: never = event;
```

So the web typecheck fails until a case is added — good, and worth knowing before
starting. But note §4.3: `speech` already carries an **unused `'handoff'` kind**
and the store renders every speech kind generically, so the delegation feature
can report itself with **no protocol change and no web change at all.**

---

## 6. Phases

| Phase | State | What lands |
|---|---|---|
| **1 — one-shot delegation** | **shipped** | `vendors/` registry; the `command` transport; presets for `codex exec`, `dsh --profile headless`, `hermes chat -q`; `agent__<id>__delegate` tools; `vendorsGrantedForRole` gated on the already-declared `Role.canDelegate`; a per-vendor timeout with a SIGKILL; `vendors.json` + `DEV3D_VENDORS`; the conditional prompt paragraph |
| **1b — the office metaphor** | **shipped** | a vendor is a *terminal*, not a person (§7): its own `Avatar` implementation, docked in the rack room or reception, its own status vocabulary, a Vendors page and an inspector panel |
| **2 — ACP** | **shipped** | `rpc/` extracted from MCP so both protocols share one JSON-RPC envelope and one stdio transport; `vendors/acp.ts` — initialize, session, prompt, streaming updates, tool calls; `fs/read_text_file` served through `resolveInWorkspace`; `fs/write_text_file` refused; `session/request_permission` routed to a human; **OpenClaw arrives here** |
| **3 — as a provider** | not started | `ProviderKind: 'external-agent'`; widen `ChatRequest` with a turn context; an explicit `registry.ts` branch; manifest `command`-instead-of-`baseUrl`; notional pricing; learned-quality exclusion |
| **4 — writes** | not started | `mode: "write"` behind the approval gate, and `affectsPaths` populated for command vendors too — see §5.6 for why this is the hard one |
| **5 — the reverse direction** | not started | expose the office *as* an MCP server, and/or as an ACP agent, so DSH and OpenClaw can drive dev3d |

Phase 1 came first for the reasons §3 gives — `ToolContext` already carries
everything a delegation needs and the provider layer carries none of it — and it
proved the grant, timeout and honesty surfaces against a real harness before
routing depended on any of it. Phase 1b came with it because a capability nobody
can see in the office is a capability nobody will trust; see §7.

Phase 2 turned out to be where the *honesty* work was, not just the plumbing. The
plan said read-only would be "enforced by dev3d: `--sandbox read-only` to Codex,
the equivalent elsewhere" — and there is no equivalent elsewhere. ACP made that
concrete: dev3d *can* refuse the write path and confine reads, which is neither a
sandbox nor a request. That is why `ReadOnlyEnforcement` is three-valued (§4.2 and
`packages/core/src/vendor.ts`), and why an ACP vendor requires no blanket approval
while a `requested` one does — the protocol mediates per tool call, so a human is
asked the precise question rather than a vague one.

Two things changed from the plan above. The approval gate moved out of phase 1 and
into phase 4 for writes, because read-only delegation needs no gate; and the
console work moved from phase 4 into 1b, because the capability table that
distinguishes an *enforced* read-only promise from a *requested* one is not
decoration — it is the thing that tells an operator what they are actually
trusting.

### What phase 1 did not need

**No change to the router, no change to the stage modes, and no change to the
tool loop.** The loop (`turn.ts:417-484`) already does the right thing with a tool
that returns text and `affectsPaths`, so a delegation is an ordinary tool call
from end to end.

Three files were touched anyway, and each for a reason worth keeping:

- **`packages/core` gained one module and one field** — `vendor.ts`, and
  `OfficeState.vendorBay`. The original plan claimed no core change was needed
  because `speech`'s unused `'handoff'` kind would carry the news; that turned out
  to be the wrong shape. A vendor is a *capability the office has*, alongside the
  MCP server list and the memory index, and those are carried in the state rather
  than announced as events. It is also what lets the office show who is on site
  before anything has been delegated.
- **`engine/prompt.ts` gained a conditional paragraph**, not a change to
  `HOUSE_RULES`. The "you cannot put work on your reports" line (§4.3) is about
  *colleagues*, so a vendor tool contradicts nothing — but a delegation is
  precisely the shape that tempts a model into breaking the house rule against
  claiming work it did not do, because the vendor *did* run something. Employees
  holding a vendor tool are now told to attribute what it reports. It is written
  per-turn from `grantedTools`, so it appears and disappears with the grant.
- **`engine/turn.ts` gained nothing.** §5.1's mid-turn budget check would be a
  real improvement, but it is a pre-existing hole rather than something this
  feature opens, and it is left as one.

The protocol did not move: no new `ServerEvent` variant, and therefore no change
to the web store's exhaustiveness switch (§5.8).

---

## 7. The office metaphor: a vendor is a machine, not a colleague

Everything above is about plumbing. This section is about what the office should
*show*, because in this application the 3D view is the product and an integration
nobody can see is one nobody will trust.

### The decision

A third-party harness is drawn as a **rented workstation**: a plinth, a screen, a
beacon, a cable to the floor. Not a person. Staff remain the only humanoids on the
floor.

That was a choice about meaning rather than about effort. A `Role` is *staff*: it
has a desk, a department, a manager, a model policy and a lifetime of usage, and
the office's entire visual vocabulary — a figure that thinks, types, argues and
walks to the meeting room — exists to make those seven statuses legible at a
glance across a 22 × 16 m floor. An external harness has none of it. It is a
process somebody else operates, which the office switches on, hands a job to, and
switches off. Dressing Codex as an employee would be the same category error as
calling an MCP server a colleague, and it would make "there is a person at that
desk" stop meaning anything.

### The rejected shortcut, and why it was tempting

The cheap implementation is to give a vendor an `EmployeeState` with a `roleId`
and a seat. Every surface in the console already reads `office.employees`, so it
would render, animate, be pickable and appear in the roster for free.

It was rejected because an `EmployeeState` is staff, and routing a vendor through
that list puts it in the headcount, the spend leaderboard, the org chart, the
quick-jump index, the approval `nameOf` maps and `PlanPage`'s search for the CEO.
Every one of those is a place where a machine somebody else operates would read as
somebody who works here.

So a vendor is a **second, parallel list** — `OfficeState.vendorBay` — with its own
status vocabulary and its own surfaces. The cost is that the surfaces which
*should* know about vendors must be told; the benefit is that the surfaces which
should not cannot accidentally find them. `VendorStatus` is likewise its own
union, not more keys in `EmployeeStatus`: `Record<EmployeeStatus, …>` refusing a
`VendorStatus` key at compile time is the type system catching exactly the drift
this design exists to prevent.

### Where the bay goes

`anchors.ts` places the terminals by looking up an anchor, the way everything else
in this office is placed — preferring, in order:

1. **`Anchor_Room_SERVER4`** — the rack room, when the floor has grown one.
   `server4` is the only module in the kit whose furniture (`racks`) implies
   machinery rather than people, and its single seat means housing a bank of
   terminals there never competes with the roster.
2. **`Anchor_Room_Lobby`** — reception, in the core office. Not every floor grows
   a server room: modules are added on demand, least-used-first. A contractor with
   nowhere to work waits in reception, which is a degradation rather than a
   compromise.
3. **The bench origin** — for a floor with neither, so a vendor the office is
   paying for is still visible somewhere rather than silently at the world origin.

The lookup is by *bare* anchor name, because a rack room is a grown module and
therefore arrives as `B1::Anchor_Room_SERVER4` — matching on the full name would
work on one floor and fail on the next depending on which instance was built
first. The HUD reads the same preference back out of the floor's own `layout`,
so the label and the geometry agree by construction rather than by the panel
asking the renderer.

### Reading it at a distance

The screen is the vendor's face and carries the vendor's own colour — the one
thing that tells four otherwise identical terminals apart, and the reason
`VendorState.color` exists. Around it, the same three-channel language an
employee uses:

| | |
|---|---|
| **Beacon** on the plinth | status colour, the counterpart of an employee's chest lamp |
| **Standby breath** when docked | lit but dim and slowly pulsing: available, without competing for attention |
| **Work scroll** when engaged | the panel brightens and its scanlines run fast, which reads as "busy" from across the room |
| **Darkness** when off site or unreachable | a vendor that is not there must not look like one that is |

Nothing here walks or talks. Vendors are deliberately kept **out of the
liveliness roster**: a terminal is bolted to the floor of a room, so it is never
handed a `LivelinessMotion`, never wanders to the lounge, and is not counted as a
body for others to walk around.

Two details are load-bearing rather than decorative. The kiosk stamps
`userData.avatarId` exactly as an employee avatar does, because that single field
is the only thing picking reads — a distinct visual that skipped it would be
unselectable. And `Avatar` was made generic over its status type (`Avatar<S>`), so
the canvas places, animates, picks, focuses and disposes both kinds through one
code path while the two status vocabularies stay apart.

### Presence, and what the console says

Every configured vendor is docked whether or not anything is in flight, dim on
standby: an operator should be able to see who they have on retainer, and an
unreachable vendor is then visibly dead rather than simply absent. This is the
same posture MCP servers get.

The panel leads with the three questions that matter, in this order — *is it
working and if not why*, *what did we actually promise*, *whose machine and whose
bill* — and the second one is the point of the whole panel. `enforcesReadOnly`
distinguishes a harness pinned to a real sandbox (`codex exec -s read-only`) from
one that has merely been asked to behave, and those two are rendered differently
rather than both as a green "read-only" badge. A capability flag that changed
nothing on screen would be decoration; this one is the difference between a
guarantee and a request, and it is the fact an operator most needs when a machine
is being pointed at their project directory.

---

## 8. Decisions and open questions

**Decided, and shipped: read-only delegations only.**

The first release sends `read-only` work and nothing else. An external agent that
may not write is a research assistant, and it removes the entire confinement
question — §2's asymmetry — from the first release rather than arguing about it.
The reasoning is worth keeping written down, because "we will add writes later" is
exactly the kind of promise that becomes a default:

- **It makes §5.6 not apply yet** — a delegated agent's writes would be invisible,
  and a review loop would not know who produced what. That is the single hardest
  problem in this document, deferred rather than half-solved.
- **It keeps the approval gate out of the first cut**, so the first cut has one
  fewer thing to get wrong.

**One correction to the plan above.** This section originally said read-only would
be "enforced by dev3d, not requested: `--sandbox read-only` to Codex, the
equivalent elsewhere". There is no equivalent elsewhere. Codex takes a real
sandbox mode; **DSH and Hermes expose no documented per-invocation flag that
confines them**, so for those two the office asks and the harness may decline.

Rather than paper over that, the difference became a first-class field —
`VendorCapabilities.enforcesReadOnly` — set per preset from what the invocation
actually does, shown on the panel as *enforced* versus *requested*, and carried
into the 3D HUD. Phase 4's approval gate triggers on exactly this flag, which is
what stops it being a badge: a harness the office cannot confine is one a human
has to say yes to.

**Settled — the seam.** The delegation tool (Seam A, §4.3) went first, on the
three grounds below, and it is now built. Nothing about that choice forecloses
Seam B: an ACP client (phase 2) is the next step and the provider adapter
(phase 3) after it.

1. `ToolContext` already carried `workspaceRoot`, `requestApproval`, `signal`,
   `plan` and `log`. The provider layer carries none of them, and §3's Seam B
   would have had to invent all five.
2. Grants, approvals, cancellation and the tool-call UI already existed and were
   tested. The provider path would be new machinery in the one place where a
   mistake costs every turn rather than one tool call.
3. It touched almost nothing the other two agents were working in — which turned
   out to matter, because `engine/turn.ts`, `tools/registry.ts`,
   `packages/core/events.ts`, `server/runtime.ts` and `store/store.ts` were all
   being edited in the same working tree throughout.

**Still open — writes.** §5.6 is deferred, not solved: a vendor that writes files
leaves `turn.wroteFiles` and `knowledge.producers` blind, so a review loop cannot
send the work back to whoever produced it. Doing it properly means reading file
locations out of ACP's `tool_call` updates, which is why it belongs with phase 2
rather than on its own.

**Also open — how much the console says.** Capability badges are cheap and
honest; a *per-agent* disclosure ("edits files itself; dev3d cannot confine it")
is arguably mandatory for anything whose `usesClientFs` is false (`openclaw acp`
is the concrete case, §1).

---

## Sources

- [Codex CLI — non-interactive mode](https://mintlify.wiki/openai/codex/concepts/non-interactive-mode)
- [DeepSeek Harness — CLI and headless agent](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/en/getting-started/headless-agent.md)
- [Hermes Agent — Alibaba Cloud Model Studio](https://www.alibabacloud.com/help/en/model-studio/hermes-agent)
- [OpenClaw — `acp`](https://docs.openclaw.kr/cli/acp) (compatibility matrix)
- [Agent Client Protocol — protocol overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP Registry](https://agentclientprotocol.com/get-started/registry)
- [Zed — External Agents](https://zed.dev/docs/ai/external-agents)
