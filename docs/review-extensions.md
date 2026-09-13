# Plugins, MCP and vendor harnesses — technical review

## Scope & method

Three extension boundaries of the orchestrator:

- **Plugins** — `apps/server/src/plugins/{manifest,host,bundle,panels,plugins.test}.ts`,
  `packages/core/src/plugin.ts`, the three shipped plugins in `plugins/`, and every
  consumer of `contributions()` (the provider registry, the runtime, the HTTP API,
  the console).
- **MCP** — `apps/server/src/mcp/*` plus the shared wire it stands on
  (`apps/server/src/rpc/{jsonrpc,stdio,transport}.ts`), `mcp.json`/`.example`, and
  the grant path through `runtime.ts`/`turn.ts`.
- **Vendors** — `apps/server/src/vendors/*`, `packages/core/src/vendor.ts`,
  `apps/server/src/tools/vendor.ts`, `apps/server/src/server/vendorGrant.test.ts`,
  `vendors.json`/`.example`.

Method: full read of every file above plus the files they depend on or are consumed
by (`tools/paths.ts`, `tools/registry.ts`, `engine/turn.ts`, `router/modelRouter.ts`,
`llm/{registry,pricing}.ts`, `config.ts`, `index.ts`, the console components under
`apps/web/src/console/plugins/` and `OrgChart.tsx`). Every claim below was checked
against the source; line numbers are from this revision.

Verification actually run (read-only; no file was modified except this report):

| Check | Result |
| --- | --- |
| `tsc -p apps/server/tsconfig.json --noEmit` | **clean, exit 0** |
| `node --test --test-isolation=none "src/plugins/plugins.test.ts" "src/mcp/protocol.test.ts" "src/mcp/manager.test.ts"` | **89 pass / 0 fail** |
| `node --test --test-isolation=none "src/vendors/*.test.ts" "src/server/vendorGrant.test.ts"` | **101 pass / 0 fail** |
| `node scripts/check-failure-paths.mjs` | **10/10** |
| `node -e "path.relative(...)"` containment probe (Windows) | confirmed `path.relative` never throws (evidence for V4) |

Not run, and why: no long-lived server, no real child process (this environment
blocks piped child stdio — `spawn EPERM`), no live MCP/Streamable-HTTP server, no
marketplace contacted, no browser session. The environment defaults are conservative
(`.env`: `DEV3D_ALLOW_PLUGIN_INSTALL=false`, `DEV3D_VENDORS=` empty,
`DEV3D_MCP_SERVERS=` empty, `mcp.json`/`vendors.json` both `[]`), so nothing in the
extension surface is switched on in this checkout.

Counts: **0 CRITICAL, 5 HIGH, 16 MEDIUM, 6 LOW, 5 INFO** — Plugins 2/3/2/2,
MCP 1/9/1/3, Vendors 2/4/3/0 (HIGH/MEDIUM/LOW/INFO).

---

## Plugins

### [HIGH] A code plugin is unmediated code in the orchestrator process, and the declared permission set is never enforced

**Evidence.** `apps/server/src/plugins/host.ts:312` loads the entry with a plain
`await import(pathToFileURL(entryPath).href)` — same realm, same `process`, full
`node:fs`/`node:child_process`/network. The only API surface offered is
`host.ts:320-350` (`registerTool`, `on`, `log`), but nothing restricts what the
module does before or after `activate()` returns. `permissions` is written into the
manifest (`manifest.ts:730`) and then read by exactly two places: two *warnings*
(`manifest.ts:734-739`) and the console's descriptive copy
(`apps/web/src/console/plugins/PluginList.tsx:166`, `describePermissions`). Nothing
in `host.ts` consults `manifest.permissions`: `registerTool` does not require the
`tools` permission, `on()` does not require `events`, and a plugin declaring
`permissions: ["models"]` can still register a tool and subscribe to the stream.

**Why it matters.** The consent screen tells an operator that a plugin "asks for"
a permission list; that list is consent theatre. A plugin that declares one
permission and behaves like another is indistinguishable from one that declared it.
The honest signal that does exist is the `runs code` badge
(`PluginList.tsx:196-203`, `PluginSettings.tsx:94`), but the permission chips imply
a boundary the runtime does not draw.

**Fix.** Pick one and say so:

1. Keep in-process code and delete the permission list from the consent UI,
   replacing it with "this plugin runs arbitrary code as the orchestrator".
2. Enforce it: `registerTool` throws unless `permissions.includes('tools')`,
   `on()` throws unless `'events'`, and load the entry in a Node 24 permission-model
   child (`--permission --allow-fs-read=<pluginDir> --experimental-permission`) or a
   `worker_threads` isolate with a message-passing host.

Also require `entry` to resolve inside `pluginsRoot`, not merely inside the plugin
directory (see INFO below).

### [HIGH] A **data-only** plugin can route prompts to an attacker-controlled endpoint and can drive the run budget negative

**Evidence.** Nothing in the manifest validator restricts a contributed provider to
a host the operator has agreed to. `pickProviders` accepts any `https://` base URL
(`apps/server/src/plugins/manifest.ts:499-507`), and the `keyless` escape hatch —
intended for a loopback runtime — is accepted for *any* https URL because the
loopback rule only applies to plain `http` (`manifest.ts:499-507`, `521-527`).
`isProviderConfigured` then counts that provider as usable purely on `keyless`
(`apps/server/src/config.ts:402-407`), `index.ts:302-320` turns it into a live
`ProviderConfig` with `apiKey: null`, and `routableModels()` includes it
(`apps/server/src/llm/registry.ts:329-337`). A contributed `routingRules` entry can
push the plugin's own model to the front (`router/modelRouter.ts:246-263`, `329`)
and `preferModelIds`/`preferProviderIds` are applied verbatim
(`packages/core/src/plugin.ts:425-455`).

The same manifest can declare `costPerMTokIn: -1e6`
(`manifest.ts:132-135` accepts any finite number, defaulting to `0`), which flows
through `computeCost` (`llm/pricing.ts:12-14`) into
`run.budget.spentUsd += usage.costUsd` (`engine/turn.ts:552`) against a budget gate
that only tests `spentUsd >= limitUsd` (`engine/runEngine.ts:203`). Negative prices
therefore *refund* a run and the ceiling never trips.

**Why it matters.** Every turn's prompt — the brief, the stage transcript, the
knowledge block, and any file the tool loop read — is POSTed to that endpoint. No
`entry`, no code, and the console shows `data only`. Preconditions are honest: the
plugin must be installed (`DEV3D_ALLOW_PLUGIN_INSTALL`, off by default, plus an
explicit install action) or dropped into `plugins/` by hand. But "data-only" is
currently presented as a safety property, and it is not one.

**Fix.** (a) Make a plugin `keyless` provider require a loopback base URL
unconditionally, and require an explicit operator acknowledgement (with the host
displayed) before any *plugin-owned* provider becomes routable — e.g.
`contributes.providers[].requiresConsent: true` written to the office document on
first enable. (b) Clamp `costPerMTokIn/Out`, `contextWindow` and `maxOutputTokens`
to finite non-negatives in `pickModels`, and assert non-negative `usage.costUsd`
before it touches the budget ledger.

### [MEDIUM] Plugin install accepts unverified bundles, from a plaintext catalog, from any host it names

**Evidence.** `entry.sha256` is optional at parse time
(`apps/server/src/plugins/host.ts:719`) and only verified when present
(`host.ts:859-867`) — so the marketplace that supplies the bundle also supplies the
only integrity check, which protects against corruption and not against a hostile
marketplace. `fetchCatalog` accepts `http://` (`host.ts:737`), and `install()`
fetches `entry.downloadUrl` with no scheme or host restriction after resolving it
against the catalog URL (`host.ts:717`, `852`). Since `new URL(downloadUrl, base)`
preserves an absolute URL, a catalog can point the download at any host — including
one on the operator's intranet — and `data:` is preserved as a scheme too
(**SUSPECTED**: `data:` delivery would bypass the network entirely; I did not
execute a fetch to confirm undici's support). `allowPluginInstall` gates the whole
path (`host.ts:815-821`) and is `false` by default, which is the mitigating control.

**Fix.** Require `https` for both the catalog and the bundle, require `sha256`
(refuse a catalog entry without one), pin the download to the catalog's own origin
(or an explicit allowlist), and surface the resolved host and the declared
permissions on the install confirmation.

### [MEDIUM] The HTTP API is unauthenticated and sets `access-control-allow-origin: *` on every method — a visited web page can install, delete and reconfigure plugins

**Evidence.** `apps/server/src/index.ts:844-851` sets `ACAO: *`,
`allow-headers: content-type`, `allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`
and answers `OPTIONS` with 204 for *every* route, with no token, no `Origin` check
and no preflight distinction between reads and mutations. The plugin mutations are
`POST /api/plugins/install` (`index.ts:1332-1346`), `PUT|PATCH /api/plugins/:id/settings`
(`1410-1427`), `POST /api/plugins/:id/enable` (`1391-1408`) and, worst,
`DELETE /api/plugins/:id` → `rmSync(directory, {recursive:true, force:true})`
(`1444-1453`, `host.ts:661`). The same exposure reaches `POST /api/submit` (spends
money), `PUT /api/settings`, `/api/mcp/refresh` and every read route.

**Why it matters.** The server binds `127.0.0.1:8787` (`config.ts:457-458`), which is
not a security boundary against a browser: any page the operator visits can script
`fetch('http://127.0.0.1:8787/api/plugins/...')` and the browser will send it,
because the preflight succeeds and the response is readable. Install is additionally
behind the env flag; delete and settings are not.

**Fix.** Allow only the console's own origin (`http://127.0.0.1:<web port>`) *and*
require a per-session token in a header for non-GET methods; treat `DELETE`/`PUT`
as same-origin only. A localhost API with mutation routes is a CSRF surface
regardless of the subject matter — this is the boundary that makes the plugin and
MCP mutation routes reachable.

### [MEDIUM] Role templates are validated in name only, and a short one crashes the console and the prompt builder

**Evidence.** `pickRoles` checks `id`, `displayName` and `title` and passes the
object through otherwise (`apps/server/src/plugins/manifest.ts:440-452`). The
console then dereferences the rest of the contract:
`[...template.responsibilities]`, `[...template.skillIds]`, `[...template.allowedTools]`,
`persona.values` at `apps/web/src/console/OrgChart.tsx:812-817` — a `TypeError` in a
submit handler, and there is no error boundary in `apps/web/src` (grep: no
`ErrorBoundary`/`componentDidCatch`). Server-side, `runtime.hire()` validates only
id-uniqueness, `reportsTo` and skills (`runtime.ts:1638-1652`), so a role stored
without `persona`/`responsibilities` reaches `engine/prompt.ts:204` (`bullets(role.responsibilities)`)
and `:207` (`role.persona.values.join(', ')`) on every turn that employee takes.

**Fix.** Validate or normalise role templates against the full `Role` contract in
`pickRoles` (defaults for `persona`, `appearance`, `responsibilities`, `skillIds`,
`allowedTools`, `modelPolicy`), and make `prompt.ts` tolerant of a partial role
rather than throwing mid-run.

### [LOW] Panel `source` URLs are fetched server-side with no host restriction, following redirects

**Evidence.** `pickPanelSource` accepts any `http(s)` URL (`manifest.ts:366-383`) and
`panels.ts:98-101` fetches it with a 10 s timeout, following redirects by default.
The console never sees the URL (good), but a plugin can make the server issue GETs
to loopback/link-local/private addresses (`http://169.254.169.254/…`,
`http://127.0.0.1:<other service>/…`) and read the *shape* of the answer back on the
operator's screen. The response is a blind channel for the plugin author, so this is
a side-effect/timing SSRF rather than exfiltration — but the module comment
("Fetching server-side means a plugin endpoint cannot be used to probe the
operator's machine or intranet from the browser", `panels.ts:13-15`) overstates
the protection: the *server* is the one probing, and the answer is rendered to the
operator.

**Fix.** Refuse non-public address ranges (with an explicit opt-out), cap redirects
to zero, and log the resolved host on first fetch.

### [LOW] Two declared extension points are never consumed: `contributes.toolNames` and `UiPanelContribution.tokens`

**Evidence.** `toolNames` is documented as "for the consent screen"
(`packages/core/src/plugin.ts:170-171`) but no console code reads it (grep for
`toolNames` in `apps/web/src`: **no matches**), and the host overwrites the count
with what `activate()` actually registered (`host.ts:422`). `tokens` ("Optional CSS
custom properties this panel needs", `plugin.ts:118-119`) is validated and passed
through (`manifest.ts:422-428`, `host.ts:510`) and read by nothing in
`apps/web/src` (grep: **no matches**).

**Fix.** Either surface the registered tool names on the consent screen (and stop
trusting the declared list), or remove both fields from `PluginContributions` /
`UiPanelContribution`.

### [INFO] `activatePlugin`'s containment check uses `startsWith` on a resolved path

`host.ts:306-309` — `!entryPath.startsWith(resolve(directory))` also accepts a
*sibling* directory sharing the prefix (`…\plugins\foo-evil` for `…\plugins\foo`).
Not exploitable today because `validateManifest` already refuses `..`, absolute and
drive-relative entries (`manifest.ts:697-708`), so this is defence-in-depth only;
`path.relative`-based containment (as `tools/paths.ts:26-48` does) would be correct.

### [INFO] `hydrate()` trusts the persisted document's shape

`host.ts:924-930` copies `enabled`, `settings` and `sources` out of the office
document with no validation. Settings are coerced at use (`coerceSettings`) and a
non-boolean `enabled` value is simply truthy, so the impact is limited to
"configuration the operator cannot see but that takes effect" — worth a shape check
on read for the same reason `readManifest` has one.

---

## MCP

### [HIGH] A server→client JSON-RPC *request* is treated as a response, silently resolving an in-flight call with `undefined`

**Evidence.** `apps/server/src/mcp/client.ts:271-297`. The only structural test is
`if (!('id' in msg) || msg.id === undefined || msg.id === null)` — a message with an
id and a `method` (i.e. a request *from the server*) falls through to
`this.pending.get(msg.id)`, and if the id matches one of ours it is resolved as a
response: `isFailure()` is false (there is no `error` key), so
`entry.resolve(response.result)` runs with `result === undefined`. The correct
classification already exists one file over — `parseMessage` returns a request when
`method` is a string and an id is present (`rpc/jsonrpc.ts:96-99`) — and the ACP
client branches on `'method' in message` *first* (`vendors/acp.ts:308`), which is
exactly the check missing here.

**Why it matters.** MCP defines server→client requests (`ping`,
`sampling/createMessage`, `roots/list`, `elicitation/create`), and a server is
entitled to `ping` the client at any time. Both sides start ids at 1, so a collision
is likely on the very first exchange. Impact is a *silently wrong* result rather
than a visible failure: `initialize` resolving `undefined` yields
`serverInfo {name:'unknown'}` and a connection reported `ready`
(`client.ts:315-325`, `manager.ts:240-249`), and a `tools/call` resolving `undefined`
hands the model an empty tool result (`client.ts:183-200`). The client also never
answers the ping, which is a spec violation on its own.

**Fix.** Branch on `'method' in msg` before the id lookup. For an inbound request,
reply `-32601 method not found` (or implement `ping` → `{}`) and never touch
`pending`.

### [MEDIUM] A server that dies mid-session is never noticed: status stays `ready`, its tools stay granted, and nothing reconnects

**Evidence.** `manager.ts:218-255` is the only place a connection's state is set;
the transport error path lives entirely inside `McpClient.failAll`
(`client.ts:300-307`), which rejects in-flight calls and records `closeReason` but
has no way to tell the manager. `StdioTransport`'s `close` handler calls
`errorHandler` (that same `failAll`) and nothing else (`rpc/stdio.ts:120-124`).
There is no reconnect, no backoff and no `'failed'` transition anywhere in
`manager.ts`; `status()` (`127-129`) keeps reporting the last successful probe and
`tools()` keeps handing out the now-dead tool names, so a role's grant and the
console's green row both survive the crash.

**Fix.** Give the client/transport an `onClose`/`onFatal` hook the manager can
subscribe to; on it, mark the connection `failed` with the transport's stderr tail,
decide the tools' fate explicitly, and schedule a bounded reconnect with backoff.

### [MEDIUM] `refresh()` cannot recover a connection that failed — including the boot failure the route exists for

**Evidence.** `manager.ts:115-124` disconnects only connections that are *unwanted*;
`connectAll` then skips anything already in the map (`156-162`). A failed connect is
stored and retained (`199-206` for an unbuildable transport, `216` for a real one),
so `POST /api/mcp/refresh` (`index.ts:1166-1187`, whose comment promises "a new
server is picked up") leaves a `failed` row `failed` for the process's lifetime. The
only remedy is a full restart.

**Fix.** In `refresh`, `disconnect` any connection whose `status.state !== 'ready'`
before `connectAll` (or add a `retry(id)` path used by both boot and refresh).

### [MEDIUM] The HTTP transport's session teardown sends `DELETE` without the session id, so sessions are never closed

**Evidence.** `apps/server/src/mcp/http.ts:92-99` does
`const session = this.sessionId; this.sessionId = null;` and *then* builds
`headers: this.headers()` — and `headers()` only adds `mcp-session-id` when
`this.sessionId !== null` (`http.ts:115`). The line `void session;` at `104` is the
only use of the local. Per the Streamable HTTP spec the `DELETE` must carry
`Mcp-Session-Id`; without it a compliant server cannot terminate the session, so
every connection leaks a server-side session (and any per-session resources) until
the server expires it.

**Fix.** Build the headers from the captured `session` value, e.g.
`headers: { ...this.headers(), 'mcp-session-id': session }`.

### [MEDIUM] The HTTP transport's response body is unbounded in both time and size

**Evidence.** `http.ts:120-139`: the per-request `AbortController` timer is cleared
in the `finally` **as soon as the headers arrive** (`137-139`), while the body is
read afterwards — `await response.text()` at `160` (single JSON reply) and the SSE
reader at `166-207`, whose `buffer` grows for as long as the peer keeps producing
bytes without a blank-line delimiter (`187-196`). There is no byte cap on either
path. A server that sends headers and then stalls hangs that fetch (and its socket)
indefinitely; a server that floods allocates without bound. Contrast the stdio
transport, which caps its line buffer at 8 MB (`rpc/stdio.ts:217`). The caller's own
request timer (`client.ts:229-234`) does reject the promise, so a turn is not
wedged — but the fetch, the socket and the `inFlight` controller in `http.ts:45`
leak until `close()`.

**Fix.** Keep a deadline on the body read (idle + overall), cap accumulated bytes
(8 MB, matching stdio) and abort past the cap.

### [MEDIUM] SSE parsing assumes LF-only event separators, so a CRLF server delivers nothing until the stream ends

**Evidence.** `http.ts:190` splits on `buffer.indexOf('\n\n')` only. SSE permits
`\r\n` line endings, and `\r\n\r\n` contains no `\n\n`, so no event boundary is ever
found; the whole stream is buffered until `done` (handled once at `198`) or until
the 120 s idle timer aborts the controller (`170-176`). The common single-response
case still works by accident when the server closes the stream; a spec-compliant
server that holds the SSE stream open (the normal shape for server-initiated
messages) yields a 120 s stall followed by a client-side failure.

**Fix.** Normalise `\r\n` → `\n` before splitting, or scan for both separators;
add a unit test — `http.ts` has none (see INFO below).

### [MEDIUM] `initialize` advertises a client capability that does not exist (`tools`)

**Evidence.** `client.ts:120-128` sends
`capabilities: { tools: {} }`. In MCP, `tools` is a *server* capability;
`ClientCapabilities` is `{ experimental?, roots?, sampling?, elicitation? }`. The
client therefore declares nothing real and one thing the schema does not define.
Impact is **SUSPECTED** to be server-dependent (the reference SDK's schemas are
permissive enough that most servers ignore unknown keys), but a strict validator may
reject the handshake with `-32602`.

**Fix.** Send `capabilities: {}` (this client implements no roots/sampling/elicitation),
or add the capabilities actually implemented; never claim `tools`.

### [MEDIUM] `notifications/tools/list_changed` is ignored, so the published tool set is frozen at connect time

**Evidence.** `listTools()` is called once per connection (`manager.ts:220`),
`cachedTools` is refreshed only by a subsequent explicit call (`client.ts:143-161`),
and every inbound notification is dropped (`client.ts:275-280` — "this client
registers no notification handlers"). Grep for `list_changed`/`listChanged` across
`apps/server/src`: only the `notifications/initialized` literal exists. A server that
adds or removes tools at runtime keeps publishing the stale set (and keeps relying on
the operator's `POST /api/mcp/refresh`, which cannot re-list a healthy connection
either — see the `refresh` finding).

**Fix.** Handle `notifications/tools/list_changed` by re-running `listTools()` and
diffing the registry (`unregister` gone tools, `register` new ones, warn on rename).

### [MEDIUM] Every spawned MCP server inherits the orchestrator's entire environment, including every API key

**Evidence.** `rpc/stdio.ts:78-86` spawns with
`env: { ...process.env, ...(this.options.env ?? {}) }`. An MCP server configured the
documented way — `npx -y @modelcontextprotocol/server-filesystem` — is
third-party code from a mutable registry, and it receives `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `ARTIFICIAL_ANALYSIS_API_KEY` and anything else in `.env`
(the file documents the inheritance at `stdio.ts:35` but not this consequence; the
same line is used by the ACP vendor path, `vendors/acp.ts:182-190`).

**Fix.** Pass an allowlist instead of the environment: `PATH`, `HOME`/`USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `TEMP`/`TMP`, `LANG`, plus exactly the
`env` the config declares. Say so in `mcp.json.example`.

### [MEDIUM] Untrusted server text reaches the model context unbounded and unsanitised

**Evidence.** `tools/list` `description` and `inputSchema` are copied with no length
cap and no structural validation (`client.ts:327-337`; `manager.ts:298-304` puts the
whole schema into the tool's `parameters`), a server-chosen string that becomes part
of every system prompt that grants the tool. Tool results are clipped to 20 000
characters (`manager.ts:83`, `309`, `332-335`) but are otherwise passed through as
`role: 'tool'` content (`engine/turn.ts:511`) with no control-character/ANSI
stripping and no "this is untrusted remote text" framing — a remote server (or
anything that can answer as one) is a prompt-injection and context-flooding channel.

**Fix.** Cap description (~1 000 chars) and schema size, strip C0/C1 controls,
reject a schema that is not an object with `type: 'object'`, and fence remote tool
output in the tool loop the way other untrusted text should be.

### [LOW] A server id may contain `_`, so two distinct tools can share one published name — contradicting the comment that claims otherwise

**Evidence.** `apps/server/src/mcp/config.ts:32` allows `[A-Za-z0-9_-]`, and `publishedToolName` is a
plain concatenation (`manager.ts:271-273`). `mcp__a__b__c` is produced both by
server `a` tool `b__c` and by server `a__b` tool `c`; `parsePublishedToolName`
(`manager.ts:276-287`) splits at the first `__` and cannot invert the second form.
The manager's own doc comment says ids and tool names "are both restricted to
characters that cannot be confused with the `__` separator" (`manager.ts:264-270`) —
untrue for ids. The collision is handled by skipping the second publisher with a
warning (`manager.ts:225-228`), so the impact is one server shadowing another's tool
depending on connect order, plus a broken inverse that nothing currently calls
(grep: `parsePublishedToolName` is used only by its test).

**Fix.** Forbid `_` in server ids (the vendor config already does,
`vendors/config.ts:118`) or switch the separator to one that cannot appear in an id.

### [INFO] `mcp/http.ts` has no tests at all

No test file imports `HttpTransport` (grep across `apps/server/src`: only
`manager.ts` and `index.ts` reference it). The whole Streamable HTTP transport — SSE
framing, session handling, timeouts, teardown — is untested, which is why the
DELETE-header, CRLF and body-bound issues above went unnoticed. `protocol.test.ts`
exercises `McpClient` against a `FakeTransport` (`protocol.test.ts:65`) and never
touches HTTP.

### [INFO] Redirects are followed silently in the HTTP transport and the plugin fetchers

`fetch` follows redirects by default (`http.ts:128`, `panels.ts:98`, `host.ts:739`,
`852`). For a 301/302 the fetch spec rewrites the POST into a GET, dropping the
JSON-RPC body (a handshake failure that reports as a protocol error, not a
misconfiguration), and non-standard headers such as `mcp-session-id` are preserved
across a cross-origin redirect. **SUSPECTED** in detail (undici strips
`Authorization`/`Cookie` cross-origin but not arbitrary custom headers; I did not
run a redirect against a live server). Fix: `redirect: 'error'` (or manual) on the
JSON-RPC POST.

### [INFO] The stdio reader silently discards an over-long line

`rpc/stdio.ts:215-217` drops the entire 8 MB buffer when it is exceeded. That bounds
memory (good) but corrupts framing without a diagnostic; a warning plus a
connection-level failure would be more honest than a truncated stream.

---

## Vendors

### [HIGH] The delegation timeout does not bound a command vendor: the promise settles only on `close`, so a harness that leaves a grandchild holding the pipes hangs the vendor forever

**Evidence.** `apps/server/src/vendors/command.ts:129-135` — `settle()` is reachable
from exactly two places: the `error` handler (`189-209`) and the `close` handler
(`211-230`). The timeout only kills (`232-235` → `killIfPossible()` → `child.kill('SIGKILL')`,
`137-143`). The module comment already names the trigger — "a harness that spawned
its own children holds the pipe open" (`command.ts:19-23`) — and Node fires `close`
only once the process has exited *and* its stdio streams are closed, so a grandchild
that inherited stdout/stderr keeps `close` from firing. `child.kill()` terminates
only the direct child (`SIGKILL` semantics on Windows too), so `npx -y …`, `dsh`, or
any shell-wrapping harness can produce exactly this. The test double always closes
when killed (`vendors/testing.ts:84-93`), so the case is untested
(`command.test.ts:134-154` asserts the SIGKILL, not the settle).

**Why it matters.** The tool call never returns, the turn never ends, and
`runtime.status` was set to `engaged` before the run (`registry.ts:254`) and is only
cleared after the result arrives (`271-274`), so **every later delegation to that
vendor is refused** with "already working on something" (`registry.ts:230-239`) until
the orchestrator restarts. The documented control ("the real control on an external
agent, not the run budget", `config.ts:83-90`) is not a control in this case.

**Fix.** Bound the wait independently of `close`: after killing, arm a short grace
timer (~2 s) that settles with outcome `timeout` and the output collected so far;
spawn POSIX children `detached: true` and kill the process group; on Windows use
`taskkill /T /F` or a Job Object so the tree actually dies.

### [HIGH] For `requested`-enforcement vendors, nothing asks the vendor to work read-only — the outbound prompt is exactly the model-authored task

**Evidence.** `tools/vendor.ts:128-131` takes `args.task` verbatim and passes it to
`registry.delegate` (`178-196`), which passes it to `runVendorCommand` as
`prompt: task` (`registry.ts:315-324`), appended as a single argv element
(`command.ts:105-106`) or written to stdin (`244-252`). No read-only instruction is
added anywhere on that path. `config.ts:134-136` claims the opposite ("The office
still only ever sends them read-only work and says so in the prompt"), and the
*model-facing* tool description says the vendor "is *asked* to work read-only"
(`tools/vendor.ts:90`) — but the model is the only one who could have asked, and
nothing guarantees it did.

**Why it matters.** For the `dsh` and `hermes` presets
(`vendors/config.ts:165-185`, `readOnlyEnforcement: 'requested'`) the vendor is an
unconfined process with the run's workspace as its cwd. The compensating control is
the human approval at `tools/vendor.ts:152-176`, which is skipped whenever
`ctx.autoApproveShell` is on (`config.ts:445` sets the default false; the operator
can flip it in Settings) — and the vendor's self-reported paths are then trusted for
`turn.wroteFiles` (see the path-confinement finding below).

**Fix.** For `requested` vendors, prepend a fixed, non-model-controlled instruction
block ("You are a read-only contractor: do not create, modify or delete any file;
report the paths you read") to the vendor prompt, and state in `docs/external-agents.md`
that this is advisory. Consider post-run verification (workspace mtime/hash delta)
before reporting a read-only delegation as clean.

### [MEDIUM] A preset's capability claim survives a `command`/`args` override, so an arbitrary command can inherit "sandbox" and lose its approval gate

**Evidence.** `vendors/config.ts:337-345` lets an entry override `command` and `args`
while defaulting the rest from the preset, and `385-401` then takes
`base = preset.capabilities` — so `{"id":"x","preset":"codex","command":"my-thing"}`
inherits `readOnlyEnforcement: 'sandbox'`. That value is what decides the approval
gate (`tools/vendor.ts:72-78`, `152`) and what the model is told ("pinned to a
read-only sandbox of its own, so it cannot change any file", `tools/vendor.ts:87`).
`vendors/config.test.ts:116-149` locks the inheritance in ("Undeclared: the preset's
value survives") for the legitimate case where the operator keeps `-s read-only`.

**Why it matters.** The capability field is the gate for an unconfined process
touching a project directory, and it is self-declared by the same file that names
the command, with no cross-check between the two. Reachable by anyone who can edit
`vendors.json` (the operator — so this is a footgun and a stale-config hazard, not a
remote exploit), but the failure mode is an unattended third-party process with
write access to a repository, which is precisely what the field exists to prevent.

**Fix.** When `command`/`args` differ from the preset's, reset
`readOnlyEnforcement` to `'requested'` unless the entry declares the level
explicitly; and when it declares `'sandbox'`, require evidence in the invocation
(e.g. an `args` entry from a per-preset `sandboxArgs` list) or record the claim as
operator-asserted in the console.

### [MEDIUM] Vendor-reported paths are not confined: `relativeOrNull` assumes a function that never throws

**Evidence.** `apps/server/src/tools/vendor.ts:242-250` wraps
`toWorkspaceRelative` in a `try/catch` and documents it as "`toWorkspaceRelative`
refuses anything outside the root" — it does not: `tools/paths.ts:55-59` is
`relative()` plus slash normalisation and has no containment logic. Verified on
Windows: `path.relative('E:\\ws\\proj','E:\\other\\x') === '..\\..\\other\\x'` and
`path.relative('E:\\ws\\proj','C:\\Windows\\notepad.exe') === 'C:\\Windows\\notepad.exe'`
— no throw in either case. Every path a command vendor prints in its event stream
(`output.ts:148-171`, `PATH_KEYS`) therefore lands in `affectsPaths` (`vendor.ts:217-221`)
and from there in `turn.wroteFiles` (`engine/turn.ts:506-509`), including absolute
paths outside the workspace; the accompanying note "N reported path(s) were outside
the workspace and ignored" (`vendor.ts:225-227`) can never fire. The ACP path gets
this right by calling `resolveInWorkspace` first (`acp.ts:558-564`).

**Fix.** Use the same pattern as `acp.ts:558-564`
(`toWorkspaceRelative(root, resolveInWorkspace(root, candidate))`), or reject any
relative result that is `..`-prefixed or absolute.

### [MEDIUM] Every vendor process inherits the orchestrator's entire environment

**Evidence.** `vendors/command.ts:150-159` (`env: { ...process.env, ...(options.env ?? {}) }`)
for one-shot harnesses, and `rpc/stdio.ts:78-86` for the ACP path
(`vendors/acp.ts:182-190`). `registry.delegate`/`probeOne` never pass `env`, so the
third-party harness (Codex, DSH, Hermes, an arbitrary `command`) receives every key
in `.env` in addition to its own credentials.

**Fix.** Same allowlist as the MCP finding; make the extra environment an explicit
per-vendor `env` map in `vendors.json`.

### [MEDIUM] ACP `fs/read_text_file` reads the whole file into memory before applying its own cap

**Evidence.** `vendors/acp.ts:355-356`: `const raw = await readFile(absolute, 'utf8')`
followed by `raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw`
(`MAX_FILE_BYTES = 2 MB`, `acp.ts:71`). The cap is applied *after* the whole file is
in memory, so a large file inside the workspace (a video, a database dump, a log) is
a memory spike driven by the remote agent's request; `raw.length` also counts UTF-16
code units, not bytes.

**Fix.** `stat` first and refuse above the cap, or stream with a byte budget and
truncate mid-read.

### [LOW] Vendor output is handed to the model without stripping ANSI/control sequences

**Evidence.** `vendors/output.ts:52-58` returns `raw.trim()` for `text` vendors and
`extractCodexJsonl` (`74-138`) joins event text verbatim; nothing in the file
escapes or strips anything (`command.ts` captures raw chunks; only the truncation
caps at `command.ts:45-48` apply). Harnesses colourise their output, so CSI/OSC
sequences — which can set the terminal title, move the cursor, or in the OSC-52 case
write the clipboard — arrive as tokens in the model's context.

**Fix.** Strip `\u001b\[[0-9;?]*[ -/]*[@-~]` and `\u001b\][^\u0007]*(\u0007|\u001b\\)`
plus the C0 range (except `\n`/`\t`) in `extractVendorAnswer`, and note the strip in
`DelegationResult`.

### [LOW] ACP read requests ignore `sessionId`, and the read boundary is lexical (symlinks pass through)

**Evidence.** `vendors/acp.ts:348-362` serves `fs/read_text_file` for any
`params.path` without checking that `params.sessionId` is the session this turn
opened. Confinement is `resolveInWorkspace` (`acp.ts:354`), which normalises the
path but does not resolve symlinks (`tools/paths.ts:26-48`), so a symlink inside the
workspace pointing outside it is served. Impact is limited — the ACP agent is a
local process that can read the target itself, and this matters mainly for a
Gateway-backed agent whose filesystem access goes through dev3d — but it is worth
closing.

**Fix.** Validate `params.sessionId` against the opened session, and confirm
containment with `realpath` after opening.

### [LOW] Vendor commands are not resolved to an absolute path, and the child's cwd is a model-writable workspace

**Evidence.** `vendors/config.ts:337` accepts any non-empty command string, and
`registry.probeOne` runs it with `cwd: process.cwd()` (`registry.ts:453`) while
`delegate` runs it with `cwd: request.cwd` — the run's workspace
(`registry.ts:320`, `tools/vendor.ts:180`), which the office's own agents can write
to. **SUSPECTED** on Windows: `CreateProcessW`'s search order is documented to start
with the parent's own directory and PATH, but Node/libuv's exact behaviour with a
relative command plus a custom `cwd` is not something I could execute here (no
piped child stdio in this environment). If the child's `cwd` is consulted, a planted
`codex.exe`/`codex.bat` in a model-writable workspace is a binary-planting path to
running arbitrary code as the operator.

**Fix.** Resolve `command` to an absolute path once at config load (`where`/`which`),
record it on the `VendorConfig`, and refuse a bare name at delegation time.

---

## Verified healthy

Read carefully and found sound; recorded here so the posture is accurate.

**Plugin system**

- **Manifest validation is genuinely two-tier and thorough** (`manifest.ts:645-742`):
  id/semver/ApiVersion/entry (`697-708`, `..`, absolute and drive-relative entries
  refused)/permissions are hard problems; a malformed *contribution* is dropped with
  a warning; settings-schema errors reject the plugin.
- **The tar reader is written as an untrusted-input parser**
  (`bundle.ts:84-179`): POSIX normalisation, absolute paths, `..`, symlinks/hardlinks
  and device nodes refused, base-256 sizes refused, GNU long names refused, 32 MB /
  2 048-file caps, truncation detected, and a staging directory moved into place only
  after the id is re-verified (`host.ts:869-891`).
- **Panel widgets are a closed data set, capped hard** (`manifest.ts:234-363`):
  24 widgets, 60 rows/items, 8 columns, 500-char text, control characters stripped;
  the browser renders React text nodes only (no `dangerouslySetInnerHTML` anywhere in
  `apps/web/src/console/plugins`), and live panels are fetched *server-side* with a
  10 s timeout, a 5 s refresh floor, coalesced in-flight requests and a 12-panel
  ceiling (`panels.ts:38-45`, `121-157`).
- **Plugin tool names are namespaced and collision-checked**
  (`host.ts:122-137`, `331-336`), the tool registry throws on a duplicate
  (`tools/registry.ts:41-46`, asserted in `tools.test.ts:212`), and `unloadPlugin`
  takes back both tools and event subscriptions (`host.ts:355-374`).
- **Containment of a bad plugin works**: import failure or a throw inside `activate`
  rolls back what was registered, records `status:'error'` with the message, and
  leaves the other plugins and the office running (`host.ts:407-420`).
- **No path traversal in the plugin APIs**: `enable`/`configure`/`readPanel`/`delete`
  all key off `loaded.get(pluginId)`, and `install` requires the requested id to
  equal a manifest id that already passed `ID_RE`, so
  `join(installDir, pluginId)` cannot escape; `remove` refuses a bundled plugin
  (`host.ts:653-658`) rather than deleting the checkout.
- **Settings are coerced, not trusted** (`manifest.ts:756-800`): unknown keys dropped,
  types enforced, numeric `min`/`max` enforced, select options enforced, values merged
  over declared defaults; the console form is manifest-driven and typed
  (`PluginSettings.tsx`), so no plugin string is interpolated into markup or a query.
- **Every advertised extension point I traced is actually consumed** — providers
  (`index.ts:302-320` → `registry.refreshProviders`), models (`index.ts:230`),
  skills (`runtime.ts:1623-1626` → `turn.ts:269`), routing rules
  (`index.ts:460` → `turn.ts:325` → `modelRouter.ts:246-263`, tier included),
  tools (`host.ts:511-518` → `/api/tools` provenance at `index.ts:985-1001`), role
  templates (`runtime.ts:1841` → `OrgChart.tsx:792-846`), pipelines
  (`runtime.ts:1283-1303`, with a shipped-id precedence rule), console panels
  (`PluginsPanels` per placement) and events (`host.ts:338-349`). The only dead
  fields are the two LOW findings above.
- **Install/upgrade lifecycle is careful**: `allowPluginInstall` default false,
  checksum verified when published, id re-verified after extraction, staged then
  renamed, the old version unloaded *before* the swap so a run cannot call into the
  deleted build (`host.ts:810-905`), and a marketplace update is only offered when
  the version is strictly newer (`compareVersions`, `host.ts:151-167`).

**MCP**

- **The JSON-RPC envelope and framing are correct**: `parseMessage` validates
  `jsonrpc: '2.0'` and the request/notification/response shapes
  (`rpc/jsonrpc.ts:85-99`); the stdio transport splits on newlines across chunk
  boundaries, ignores non-JSON lines as noise rather than failing
  (`rpc/stdio.ts:206-230`), keeps a bounded stderr ring with continuous reads so a
  chatty server cannot wedge the pipe (`95-105`), and shuts down with
  `stdin.end()` → `SIGTERM` → 2 s → `SIGKILL`, bounded independently of the peer
  (`172-203`).
- **The handshake is right**: `initialize` (with protocol version and client info) →
  `notifications/initialized` before any other request (`client.ts:114-134`), and the
  server's chosen protocol version is accepted rather than enforced (`61-68`).
- **Timeouts and cancellation are per-call and unref'd** (`client.ts:228-268`):
  every request is bounded, an already-aborted signal is handled, listeners are
  removed on settle (no listener leak), a transport failure rejects everything in
  flight with the reason (`300-307`).
- **Tool discovery is paginated with a page cap** (`client.ts:143-161`), malformed
  entries are skipped rather than fatal (`327-337`), and `tools/call` results
  distinguish "the tool failed" (`isError`, handed to the model as
  `ok: false`) from a transport fault, joining text blocks and *naming* non-text
  content instead of dropping it (`176-201`).
- **Published names cannot collide with built-ins** (`mcp__` prefix,
  `manager.ts:271-273`), and the remote name — not the published one — is what goes
  on the wire (`manager.ts:308`).
- **Grant separation is real**: MCP tool names are checked against `allowedTools`
  at execution (`engine/turn.ts:137-145`) and added per turn only for roles the
  policy allows (`runtime.ts:1104-1112`, `418-426`); the registry is the source of
  truth for what exists, so a revoked server's tools disappear from the grant list.
- **A failed server does not break the others or the boot** (`manager.ts:250-255`,
  `index.ts:348-357`), and config parsing is per-entry failure-tolerant with a
  file-wins-over-env merge (`mcp/config.ts:48-123`, `208-241`).
- Shipped state is inert: `mcp.json` has `servers: []` and `DEV3D_MCP_SERVERS` is
  empty.

**Vendors**

- **Command construction is injection-safe**: `shell: false` in both spawns
  (`vendors/command.ts:150-159`, `rpc/stdio.ts:78-86`) with a comment recording why;
  the model-authored task is appended as exactly one argv element or written to
  stdin (`command.ts:105-106`, `244-252`); stdin is closed (`'ignore'`) for the argv
  transport so a harness reading stdin cannot block; `describeVendorCommand` shows a
  placeholder rather than the last task (`command.ts:90-100`, asserted by
  `registry.test.ts:302`).
- **The read-only gate is honest about itself**: the tool description tells the model
  which of the three enforcement levels is in force and what it means
  (`tools/vendor.ts:84-95`), the up-front approval is reserved for the level the
  office cannot bound (`72-78`), the approval text warns that the vendor may write,
  and a decline produces guidance rather than a retry loop (`169-176`).
- **The grant flow is default-deny with two independent gates**, tested directly:
  `vendorsGrantedForRole` requires `enabled`, `canDelegate` (unless explicitly
  relaxed) and a non-empty grant list, with the `delegate-roles` marker granting
  nobody extra (`runtime.ts:460-472`, `vendorGrant.test.ts:27-79`), and grants are
  added at the point of use rather than frozen into the org chart
  (`runtime.ts:1129-1139`).
- **Argument/preset handling is defensive**: `readOnlyEnforcement` only accepts the
  three known levels and otherwise falls back to the preset and then to the weakest
  claim (`config.ts:434-443`), an unknown `outputFormat`/`transport` degrades rather
  than dropping the vendor (`347-362`), a vendor colour must be a hex triple before it
  reaches a shader (`425-426`), timeouts are clamped (`370-374`), and a caller may
  lower the ceiling but never raise it (`registry.ts:249-252`).
- **Serialisation and status bookkeeping are deliberate**: one delegation per vendor
  at a time (`registry.ts:230-239`), a probe is bounded and skippable
  (`433-456`), "not claimed available until checked" (`151-160`), and a failure keeps
  a reason the console shows (`271-278`).
- **The ACP client is the strongest part of the three subsystems**: reads are served
  through `resolveInWorkspace` — the same choke point as the built-in tools — and
  `writeTextFile` is neither advertised nor honoured (`acp.ts:364-371`, `427-435`);
  permission requests are put to a human, and an unanswerable request resolves to
  *cancelled* rather than to the first option (`577-633`); the turn is bounded by an
  outer timer that sends `session/cancel` before tearing the wire down (`395-414`);
  cancellation is checked before every step so an abort cannot open a session
  (`201-253`, `429`, `449`); tool-call paths are confined and relativised before
  anything downstream can record them (`520-564`); and every inbound shape is read
  defensively, ignoring unknown `sessionUpdate` variants (`264-298`).
- **Output parsing degrades rather than failing** (`output.ts:52-138`): a banner, a
  malformed line or an unknown event shape still yields the answer, deltas are used
  only when no completed message arrives, prose that merely starts with `{` is not
  mistaken for JSONL, and the "answer" is capped again before it reaches the model
  (`tools/vendor.ts:49`, `229-232`). Path extraction is deliberately narrow
  (`148-171`).
- Shipped state is inert: `vendors.json` has `vendors: []`, `DEV3D_VENDORS` is empty,
  and `DEV3D_VENDOR_DELEGATION=true` therefore exposes no tool.

---

## Coverage gaps

What I could not verify, and how that limits the findings above.

1. **No real child process.** This sandbox blocks piped child stdio (`spawn EPERM`),
   so no MCP server, vendor harness, `npx`, `codex` or `dsh` was actually run.
   Consequences: the *code* path for the vendor timeout hang (V1) is confirmed by
   reading — the only `settle()` calls are `error`/`close` — but whether `close`
   fails to fire for a specific harness is inferred from Node's documented
   `close`-vs-`exit` semantics and the module's own comment, not observed. The same
   applies to orphaned grandchildren (`npx` → `node`) at shutdown and to the
   Windows executable-search question in the binary-planting finding.
2. **No Streamable HTTP server.** `mcp/http.ts` was reviewed statically; the
   session-header bug (M4) and the CRLF framing bug (M6) are confirmed by inspection,
   but the end-to-end behaviour (does a real server hold the SSE stream open? does a
   `data:` bundle URL fetch?) was not executed. The `data:` URL variant of the
   install finding is explicitly marked SUSPECTED.
3. **No marketplace and no network install.** The install/checksum/verification
   review rests on `plugins.test.ts` (which uses a local HTTP server and temp dirs,
   all passing) plus reading; I did not contact a real catalog.
4. **No browser session.** Console-side claims (the role-template crash, the fact
   that `tokens`/`toolNames` are unread, the placement rendering, the absence of an
   error boundary) come from reading the components and grepping the source, not from
   rendering the page.
5. **ACP spec details are from the code plus my knowledge of the protocol**, not a
   fetched schema: I did not re-fetch `agentclientprotocol.com` to confirm the exact
   `initialize`/`session/new`/`session/prompt`/`request_permission` shapes, so the
   "protocol correct" assessment of `acp.ts` is high-confidence but not
   document-verified in this session. The MCP findings (capability block, `ping`
   requests, `tools/list_changed`, `Mcp-Session-Id` on DELETE) are stated against the
   2025-06-18 revision the client itself claims (`client.ts:68`).
6. **Not in scope, not checked**: `data/dev3d.sqlite` contents, the live orchestrator
   on `127.0.0.1:8787`, the web shell's build, and `packages/core/src/vendor.ts`
   beyond the types the vendor code actually uses. The CORS/no-auth finding is the
   host HTTP layer (`index.ts`) rather than the plugin code proper; I included it
   because it is the boundary that makes the plugin and MCP mutation routes
   reachable, but a full HTTP-layer review is a different exercise.
