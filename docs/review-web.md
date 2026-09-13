# Web application — technical review

A read-only technical review of `apps/web` (the dev3d office console: Vite + React 18 +
three.js r171), cross-checked against the wire protocol in `packages/core/src/events.ts` and
the server implementation in `apps/server/src/index.ts`.

## Scope & method

**In scope.** Every file under `apps/web/src` (`main.tsx`, `app/*`, `console/**`, `office/*`,
`styles.css`), plus `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`,
`.verify/tsconfig.json`, `.verify/smoke.ts`, and `public/office/*`. The wire protocol
(`packages/core/src/events.ts`) and the server's command switch / HTTP routes
(`apps/server/src/index.ts`, `apps/server/src/server/runtime.ts`) were read to verify that
client and server agree.

**Method.**

- Every claim below was verified by reading the actual source. Line numbers and identifiers
  are real; quoted snippets are verbatim.
- No files were modified. `pnpm run` scripts are unusable in this environment (`spawn EPERM`:
  pnpm pipes child stdio over named pipes, which the sandbox forbids), so tools were invoked
  directly. The web package **typechecks clean**:
  `node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` → exit 0, no diagnostics.
  Consequence: every finding below is a *runtime*, *protocol* or *design* defect, not a type
  error. Type safety is genuinely good — a repo-wide grep for `as any`, `: any`, `@ts-ignore`
  and `@ts-expect-error` across `apps/web/src` returns **zero matches**.
- Findings are severity-tagged (`[CRITICAL]` … `[INFO]`) and ordered by severity. Within each
  entry, **[CONFIRMED]** means the code path is unambiguous from reading it; **[SUSPECTED]** means
  the conclusion depends on runtime behaviour that could not be executed in this environment. An
  entry with no such label is confirmed.

**Deliverable:** this file. The reply accompanying it is a digest.

---

## Findings

### [CRITICAL] The keepalive `ping` is answered with a full office snapshot, so every client re-renders and spams its own activity feed every 25 seconds

- **Evidence — client side.** `apps/web/src/app/ws.ts:182-187`:

  ```ts
  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);   // PING_INTERVAL_MS = 25_000, ws.ts:43
  }
  ```

  The comment above the class (`ws.ts:10`) states the purpose plainly: *"a keepalive `ping` so
  proxies do not silently drop an idle socket"*.

- **Evidence — server side.** `apps/server/src/index.ts:785-788`:

  ```ts
  case 'ping': {
    push(ws, { type: 'office.updated', state: runtime.state(), at: Date.now() });
    return;
  }
  ```

  `runtime.state()` (`apps/server/src/server/runtime.ts:1194-1267`) builds a **whole** `OfficeState`:
  `structuredClone` of settings, company, departments, roles, every employee (`:1248`), every
  model (`structuredClone(registry.models())`), the plugin system state, the MCP state, the memory
  state and the vendor bay — serialised to JSON and pushed to that socket. Every 25 s. Per client.

- **Evidence — client reaction.** `apps/web/src/app/store.ts:650-653`:

  ```ts
  case 'office.updated':
    this.adoptState(event.state);
    this.pushFeed({ kind: 'lifecycle', text: 'office state replaced by a full server snapshot', at: event.at });
  ```

  There is no `ping`/`pong` variant in `ServerEvent` (`packages/core/src/events.ts:220-311`), so
  the reply is indistinguishable from a genuine full-state push.

- **Why it matters.** Three compounding effects, all user-visible:
  1. **A false, repeating feed entry.** The activity feed gains
     `lifecycle · office state replaced by a full server snapshot` every 25 s forever. The feed
     filter `work` explicitly matches `lifecycle` (`console/ActivityFeed.tsx:48`), so the "work"
     view of the office fills with a line that describes nothing that happened. `MAX_FEED = 500`
     (`store.ts:141`) means a long-lived console is eventually mostly heartbeat noise.
  2. **A full-console re-render.** `adoptState` ends with `this.emit('office', 'selection', 'memory')`
     (`store.ts:1246`), so every `useOffice()` subscriber re-renders on every keepalive. That
     includes `OfficeCanvas` (`office/OfficeCanvas.tsx:196`), whose `syncScene` effect
     (`:1333-1357`) depends on `employees` / `roles` / `vendors` — arrays that
     `structuredClone` guarantees are **new object identities on every snapshot**. So every 25 s
     the canvas re-runs `syncScene`, which clears and rebuilds `employeesRef`/`rolesRef`/`workspacesRef`,
     calls `buildFloors`, walks every employee to call `avatar.setStatus(...)` and
     `avatar.setSelected(...)`, and then calls `setParked(...)` (`OfficeCanvas.tsx:954-1052`,
     `:1336`). `setParked` is passed a freshly built array, so React never bails out.
  3. **A 25-second poll of a large payload per open tab.** The state is one of the largest
     objects the server produces and it is re-serialised and re-sent on a timer that was
     intended to carry a few bytes.

  The same effect feeds a second bug: `usePanelRead`'s effect
  (`console/plugins/PluginPanels.tsx:47-73`) has `body` in its dependency array, and `body` is
  `panel.body` from a `structuredClone`d plugin state. So every 25 s each contributed panel
  **re-issues its HTTP request and resets its polling interval**. The interval is clamped to
  `Math.max(5_000, source.refreshMs ?? 30_000)` (`:67`), meaning the intended poll period is
  never actually reached.

- **Suggested fix.** Make the keepalive not carry state. Either (a) add a `pong` variant to
  `ServerEvent` and have the server answer `{ type: 'pong', at }` — the client already ignores
  unknown types safely, but the store should not feed-notify it; or (b) drop the application-level
  ping entirely and let the transport detect liveness (the `ws` server already closes dead
  sockets, and the client's `onclose` drives reconnect). If the ping's real purpose was "refresh
  state periodically", make it explicit and rate-limit it, and do **not** route it through the
  `office.updated` handler that writes a feed line. Independently, `PluginPanels.tsx:73` should
  depend on a stable key (`source.url`, `panel.id`) rather than the cloned `body` object.

---

### [CRITICAL] Pending approvals are not in `OfficeState`, are never replayed and are never resynced — a page refresh permanently hides a blocking approval

- **Evidence.** The client's only two writers of the approvals slice are the two live events
  (`store.ts:708-713`), and `handleApproval` (`store.ts:1160-1173`) is the only thing that
  touches `approvalList`:

  ```ts
  case 'approval.requested': this.handleApproval(event.approval, false, event.at); break;
  case 'approval.decided':   this.handleApproval(event.approval, true, event.at); break;
  ```

  A repo-wide grep for `approvals` across `apps/web/src` shows the slice is read by
  `ApprovalCallout`, `ApprovalsPanel`, `App.tsx:478`, `InspectorPopout.tsx:66` and
  `StatusPopout.tsx:34` — and **written nowhere else**. In particular:
  - `adoptState` (`store.ts:1223-1247`) replaces `officeState`, the selection and `memoryState`,
    but never `approvalList`.
  - `handleHello` (`store.ts:770-788`) does not seed it either.
  - `applyColdState` (`store.ts:592-596`) and `ingestRunDetail` (`store.ts:599-614`) do not.

- **The server agrees with the client only by accident.** `OfficeState`
  (`packages/core/src/events.ts:102-218`) has no `approvals` field — the server builds the state
  in `runtime.ts:1216-1267` and never includes them. `approval.requested` is emitted through the
  live runtime sink (`runtime.ts:1187`) and broadcast (`index.ts:505-517`); it is **not** part of
  `store.eventsForRun` replay (`index.ts:747`) and there is no `/api/approvals` route (the route
  inventory at `index.ts:853-1455` has none). The one place the server *does* ship approvals over
  HTTP, `GET /api/runs/:id` (`index.ts:894`), is destructured away by the client's detail loader —
  `App.tsx:251`: `const { turns, artifacts, ...run } = result.data;` drops `approvals`.
  The server already exposes `runtime.pendingApprovals()` (`runtime.ts:213`, implemented at `:1628`)
  and uses it only for the `/api/health` counter (`index.ts:867`).

- **Why it matters.** This is a *blocking* state the UI is explicitly designed around.
  `ApprovalCallout`'s own docstring (`console/ApprovalCallout.tsx:1-9`) says *"a pending request
  must not be something you have to go looking for"*, and its body reads *"the office is blocked
  until these are answered"* (`:77`). But:
  - **Refresh the browser** → `approvalList` is empty → the callout returns `null`
    (`ApprovalCallout.tsx:60`) → the banner is gone while the employee is still blocked.
  - **Open a second tab** → same, so two consoles on the same office disagree about whether
    anything is waiting.
  - **The socket drops and reconnects** (a laptop sleeping, a proxy blip) → the `hello` the server
    re-sends (`index.ts:1578`) carries no approvals, so the approval disappears from a console that
    was correctly showing it a second earlier.
  - **`/api/state` cold-start** (`App.tsx:290-296`) → never had them.
  Once hidden, the only ways back are a *new* approval event or restarting the console. Nothing
  re-requests them, and the run sits in `awaiting-approval` (which the client itself counts as
  active, `store.ts:148`).

- **Suggested fix.** Add `approvals: Approval[]` to `OfficeState` (or a `pendingApprovals` array),
  populate it from `runtime.pendingApprovals()` in `runtime.state()`, and seed `approvalList` from
  it in `adoptState`/`handleHello`. That is one field and two lines and it makes every one of the
  four paths above correct at once. Also keep `approvals` in the detail payload rather than
  discarding it at `App.tsx:251`.

---

### [HIGH] The 3D canvas is not memoised and re-syncs on every unrelated office event

- **Evidence.** `OfficeCanvas` subscribes to the whole office (`office/OfficeCanvas.tsx:196`,
  `const office = useOffice();`) and derives its sync inputs at `:229-239`
  (`office?.employees`, `office?.roles`, `office?.vendorBay.vendors`). The sync effect
  (`:1333-1357`) depends on those arrays, and `syncScene` (`:954-1052`) rebuilds its refs, walks
  every employee, and returns a **new** `parkedIds` array which is handed straight to `setParked`
  (`:1336-1346`), so React always re-renders. `OfficeCanvas` is not wrapped in `memo`, and it is
  mounted unconditionally as a child of `Console` (`app/App.tsx:402`).
- **Why it matters.** `store.ts` emits the `office` slice from a lot of places that are not
  relevant to the 3D scene: `handleTurnStarted` → `updateRun` → `setOffice` (`:965-972`,
  `:1265-1272`), `handleEmployeeUpdated` (`:1026`), `handleEmployeeMoved` (`:1045`),
  `handleBudget` (`:1183`), `handleArtifact` → `updateRun` (`:1141`), `handleSettingsUpdated`
  (`:846`), `handlePluginsUpdated` (`:858`). Every one of those re-runs `syncScene`. With the
  heartbeat above, a busy office re-syncs the whole scene several times a minute for changes that
  affect at most one avatar. The cost is a full `buildFloors` plus an avatar status pass per event.
- **Suggested fix.** Two independent changes, either of which removes most of the cost:
  (1) give `syncScene`'s caller a cheap change signature (e.g. a string of
  `id:status:seatId:selected` per employee plus the workspace/floor ids) and skip the call when it
  is unchanged; (2) bail out of `setParked` when the array contents are equal
  (`parkedIds.length === parked.length && parkedIds.every((id, i) => id === parked[i])`) to return
  the previous state object, which lets React skip the re-render. Wrapping the component in
  `memo` alone will not help because its props are already stable and the re-render is driven by
  a context/store subscription.

---

### [HIGH] `useStoredNumber` can return `NaN` and `useStoredState` can return a non-string, so the inspector geometry can become `NaNpx`

- **Evidence.** `app/hooks.ts:144-151`:

  ```ts
  const [value, setValue] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : clamp(Number.parseFloat(stored));
    } catch { return initial; }
  });
  ```

  `clamp` (`:139-142`) is `Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : initial` —
  the guard is on `value`, not on the `parseFloat` result… and `NaN` *is* not finite, so it falls
  through to `initial`. That part is correct. The hole is elsewhere: `initial` itself is not
  validated, and `App.tsx:158` passes `initial = 0` for a range of `min = 0`:

  ```ts
  const [inspectorHeight, setInspectorHeight] = useStoredNumber('dev3d.inspectorHeight', 0, 0, 2400);
  ```

  So the "unset" sentinel and a legal value are the same number. `App.tsx:361` then decides whether
  to publish a height with `inspectorHeight > 0`, and `App.tsx:228` passes
  `size: inspectorHeight > 0 ? inspectorHeight : maxInspectorHeight`. `Number.parseFloat` also
  accepts trailing garbage (`"420px"` → `420`, `"420.5.5"` → `420.5`), so a hand-edited or
  corrupted `localStorage` value is silently truncated rather than rejected.

  The sibling hook has the same class of hole without even a numeric guard: `useStoredState`
  (`hooks.ts:100-124`) returns the raw stored string, and `App.tsx:139-142` narrows it with a cast:

  ```ts
  const tab: PrimaryTab = useMemo(
    () => (PRIMARY_TABS.some((c) => c.id === storedTab) ? (storedTab as PrimaryTab) : 'office'),
    [storedTab]);
  ```

  The membership test makes the cast sound, but `storedTab` is only ever a `string` by
  convention — `localStorage.getItem` has no type. (`useStoredNumber`'s read is wrapped in
  `try/catch`, which is good and does cover a `localStorage` access that throws.)

- **Why it matters.** A `NaN` reaching `--inspector-height` produces `NaNpx`, which CSS discards,
  so the pane silently falls back to its default and the Reset button appears not to work. More
  importantly the read-modify-write pattern is fragile: the only thing standing between a corrupt
  preference and a broken layout is a clamp whose `initial` happens to be inside the range.
- **Suggested fix.** Validate on read rather than trusting `parseFloat`: reject a stored value
  whose `String(Number(stored))` round-trip does not match (or use a strict
  `/^-?\d+(\.\d+)?$/` test), and represent "unset" for the inspector height with a separate
  boolean or `null` rather than the in-range sentinel `0`.

---

### [HIGH] `ChatThread` never clears its `sending` flag on the socket path, and the HTTP fallback leaves a permanent duplicate of the user's own message

- **Evidence — the missing indicator.** `console/ChatThread.tsx:48-70`:

  ```ts
  store.appendDirectMessage({ id: `local-${at}`, employeeId, role: 'user', text, at });
  setDraft('');
  setSendError(null);

  if (store.connected) {
    const command: ClientCommand = { type: 'chat', employeeId, text };
    store.send(command);
    return;                                  // <-- setSending(true) is never reached
  }

  setSending(true);
  const result = await api.chat(employeeId, text);
  setSending(false);
  ```

  `sending` gates the "…{employeeName} is thinking" placeholder (`:104`) and the Send button's
  `disabled` (`:128`). On the *normal* path (socket up) it is never set, so the user gets no
  feedback between sending and the reply. The HTTP path does set it — but `setSending(true)` is
  not wrapped in `try/finally`, so a rejected `api.chat` promise (rather than a resolved
  `{ ok: false }`) leaves the button disabled with no error. `api.request` is careful to convert
  throwables into results (`api.ts:162-172`), so this is narrow, but the `.finally` is missing.

  The fallback also never clears `sending` on unmount, so switching employee mid-flight updates
  state on an unmounted component (React 18 no longer warns, but the stale write is real).

- **Evidence — the duplicate.** `app/store.ts:254-281` (docstring at `:237-251`) reconciles a
  *server* copy of a user message against a pending local echo:

  ```ts
  const echo = thread.find(c =>
    c.id.startsWith('local-') && c.role === 'user' &&
    c.text === message.text && Math.abs(candidate.at - message.at) <= ECHO_WINDOW_MS);
  if (echo) superseded.add(message.id);
  ```

  That works for the socket path because the server's `direct.message` carries the user's message
  back (`index.ts:552-559` → `engine.directMessage`). It does **not** run for the HTTP path:
  `ChatThread.tsx:68` calls `store.ingestDirectMessages(employeeId, result.data)` — which *does*
  go through `mergeMessages`/`reconcileEchoes` (`store.ts:1089-1094`) — but only if the response
  actually contains a user-role message. `POST /api/chat` (declared at `api.ts:242-247`, typed
  `DirectMessage[]`) is the engine's reply; whether it echoes the prompt is not something the
  client can rely on. When it does not, the optimistic `local-<at>` echo survives forever as a
  second copy of the message the user typed. The store's own comment at `:576` warns that feeding
  an echo through `mergeMessages` "drops the echo itself" — the reconcile is one-directional by
  design, and the fallback path is the case it does not cover.

- **Why it matters.** The socket path is the common one, so the missing "thinking" indicator is
  the everyday experience; the duplicate is a rarer but visible data-integrity bug in the same
  component.
- **Suggested fix.** Set `sending` before the branch and clear it in a `finally` for both paths,
  and clear the placeholder when the `direct.message` event for that employee arrives (or key the
  placeholder off the store's `feed`/`messages` length instead of local state). For the duplicate,
  tag the optimistic echo with a client id that the HTTP fallback can match, or have
  `POST /api/chat` return the persisted exchange including the user turn so the existing
  reconcile applies.

---

### [HIGH] Choosing a chat target on the Inspector's Chat tab throws you out of the Chat tab

- **Evidence.** The Chat tab's picker calls the store synchronously (`console/InspectorPopout.tsx:193-200`):

  ```tsx
  <select id="inspector-chat-target" value={chatEmployee?.id ?? ''}
    onChange={(event) => {
      const next = event.target.value;
      setChatTarget(next);
      store.selectEmployee(next);
    }}>
  ```

  `store.selectEmployee` is synchronous and emits immediately (`app/store.ts:502-508`), which makes
  `useSelection()` return a new `employeeId` in the same commit. The shell then reacts
  (`app/App.tsx:316-329`):

  ```ts
  const employeeChanged = selection.employeeId !== previous.current.employeeId;
  ...
  if ((employeeChanged && selection.employeeId !== null) || (vendorChanged && selection.vendorId !== null)) {
    setInspector('agent');
  }
  ```

  so `tab` flips from `'chat'` to `'agent'` and the Chat tab unmounts — the very act of picking who
  to talk to navigates away from the conversation surface. Note the interaction with
  `InspectorPopout.tsx:73-75` (`useEffect(() => { if (selection.employeeId !== null) setChatTarget(null); }, [selection.employeeId])`):
  it immediately nulls the local `chatTarget`, so the only reason the chat target survives at all
  is that `chatEmployeeId` falls back to `selection.employeeId` (`:71`).
- **Why it matters.** The Chat tab is one of three inspector tabs and is reachable (`Agent | Run |
  Chat`, `InspectorPopout.tsx:137-145`), but its employee picker cannot be used without being
  ejected. Selecting a different employee from the switcher, from an avatar, or from the activity
  feed does the same thing by design — the bug is that the *chat picker itself* is routed through
  `selectEmployee`, which is the "show me this person" intent rather than the "talk to this person"
  intent. `chatTarget` is effectively dead state: because the effect clears it whenever the
  selection changes and the `onChange` always sets both, it can never diverge from
  `selection.employeeId`.
- **Suggested fix.** Keep "who am I looking at" and "who am I talking to" distinct: have the chat
  picker set only `chatTarget` (and not `selectEmployee`), or add a `selectEmployee(id, { focus: false })`
  option, or have `App.tsx:323-325` skip the tab switch when the inspector is already on `'chat'`.
  The first is the smallest change and matches the state the component already maintains.

---

### [HIGH] `jumping` is never reset, so the quick-jump palette can appear later, unasked

- **Evidence.** A grep for `setJumping` across `apps/web/src` returns exactly four writes, all of
  them `true`/toggle: `App.tsx:375` (Ctrl/Cmd-K toggles), `:395` (the top-bar Jump button),
  `:442` (the inspector's Jump button), and `InspectorPopout.tsx:152`
  (`onClose={() => onJumpingChange(false)}` — the only `false`). Nothing resets it when the surface
  it belongs to goes away:

  ```ts
  // App.tsx:370-380 — the only global shortcut
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setRightOpen(true);
    setJumping((open) => !open);
  }
  ```

  The palette renders only inside the inspector (`App.tsx:437-450` → `InspectorPopout.tsx:151-152`),
  and the inspector is hidden on the Plan tab (`App.tsx:171`, `inspectorVisible = rightOpen && tab !== 'plan'`)
  and when `rightOpen` is false. So: press Ctrl-K while the Plan sheet is open → `jumping` becomes
  `true` with nothing rendered; later close Plan or click the inspector's ✕ (`App.tsx:441`,
  `setRightOpen(false)`) and reopen it → the palette is sitting there unprompted. Pressing Ctrl-K
  twice on the Plan tab flips it back to `false`, which is the toggle at `:375` working on state
  nobody can see.
- **Why it matters.** A modal search surface appearing without the user having asked for it in that
  moment is disorienting, and the state is genuinely unreachable otherwise — there is no visual
  indication that the palette is "open behind" the sheet.
- **Suggested fix.** Reset `jumping` to `false` when it cannot be shown: add
  `useEffect(() => { if (!inspectorVisible) setJumping(false); }, [inspectorVisible])`, and close
  the palette when `rightOpen` goes false. Alternatively gate the Ctrl-K handler on
  `inspectorVisible` rather than unconditionally calling `setRightOpen(true)`.

---

### [HIGH] One Escape closes two overlays at once

- **Evidence.** `console/QuickJump.tsx:197-202` handles Escape on the input and calls
  `event.preventDefault()` but **not** `event.stopPropagation()`:

  ```ts
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
  ```

  The shell's page-sheet handler is a `window` listener that never inspects `defaultPrevented`
  (`app/App.tsx:331-338`):

  ```ts
  useEffect(() => {
    if (!sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTab('office');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sheetOpen, setTab]);
  ```

  React 18 attaches its handlers at the root container, and the native event still reaches
  `window` afterwards (the handler neither stops propagation nor marks the event handled in a way
  the window listener checks), so one Escape keypress closes the palette *and* the page sheet
  underneath it. The same handler also fires while `ApprovalCallout` (z-index 8, `styles.css:3747`)
  is the topmost surface, and never inspects `event.target`, so Escape pressed inside a
  `<select>` or a text input also closes the sheet.
- **Why it matters.** Escape is the console's primary "get me out of here" affordance, and the
  layering is deliberate everywhere else (`styles.css` reserves 5/6/7/8 for popout/sheet/dock/approval).
  Closing two layers at once loses the reader's place, and closing the sheet from under a native
  `<select>` popup is a focus-management bug in its own right.
- **Suggested fix.** In the shell handler, bail out on `event.defaultPrevented` (and ideally on
  events whose target is an input/select/textarea), and close only the topmost overlay — the
  pattern `QuickJump` already establishes. `QuickJump` should also `stopPropagation()` for
  belt-and-braces.

---

### [HIGH] The transcript's auto-scroll listener is attached to nothing on a cold start, so it can never be unpinned

- **Evidence.** `app/hooks.ts:78-88`:

  ```ts
  useEffect(() => {
    const el = ref.current;
    if (!el) return;                       // <-- bails, and the deps never change
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
  }, [measure]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [dep, pinned]);
  ```

  `measure` is a `useCallback` keyed on `threshold` (`:72-76`), and the one caller in the
  transcript uses the default (`RunTranscript.tsx:91`, `useAutoScroll(liveSignature)`), so
  `measure` is stable for the component's life and the effect runs **once**. But
  `RunTranscript` returns early *before* the scrolling element exists:
  `RunTranscript.tsx:107-113` returns a "No office state" panel and `:115-124` a "No run selected"
  panel; the transcript div with `ref={autoScroll.ref}` is at `:193`. So on a cold load
  (`office === null` until `hello` arrives, or an office with `runs.length === 0`) the first commit
  has `ref.current === null`, the listener is never attached, and `pinned` stays at its initial
  `true` (`hooks.ts:70`) forever.
- **Why it matters.** With `pinned` stuck true, every streamed delta force-scrolls the container to
  the bottom (`hooks.ts:85-88`), so the operator cannot scroll back to read an earlier turn while a
  run is producing text — the view yanks them down on the next `turn.delta`. It also silently kills
  a control: the panel's own scroll button is `{autoScroll.pinned ? 'Collapse finished' : 'Jump to live'}`
  (`RunTranscript.tsx:187`), and the `!autoScroll.pinned` branch that offers "Jump to live"
  (`:175-178`) is therefore unreachable. The trigger is the ordinary flow — open the Runs tab before
  submitting the first brief, then submit one.
- **Suggested fix.** Do not gate the listener on a ref that may not be mounted: use a callback ref
  that attaches/detaches the listener when the node appears and disappears, or re-run the effect on
  a state flag set by the ref callback. The same latent bug affects any caller that conditionally
  renders its scroll container, so fixing it in `useAutoScroll` is the right place.

---

### [HIGH] Re-selecting a streamed run replays its whole event log into the live streaming buffers, doubling its text

- **Evidence.** `selectRun` sends `loadRun` *unconditionally*, outside the change check
  (`app/store.ts:523-533`):

  ```ts
  selectRun = (runId: string | null): void => {
    if (this.sel.runId !== runId) { this.sel = { ...this.sel, runId }; this.emit('selection'); }
    if (runId) {
      this.send({ type: 'loadRun', runId });   // <-- even when it is already the selected run
      this.ensureRunDetail(runId);
    }
  };
  ```

  `RunList` calls it on every click (`console/RunList.tsx:176`), and the server answers `loadRun` by
  replaying **the entire persisted event log** for that run (`apps/server/src/index.ts:739-757`,
  which pushes `JSON.parse(entry.payloadJson)` for every row from `store.eventsForRun(cmd.runId)`).
  Every event is persisted (`apps/server/src/server/runtime.ts:924-929`), including each
  `turn.delta`. The client's delta handler is a blind append (`app/store.ts:676-681`):

  ```ts
  this.streamingByTurn = { ...this.streamingByTurn,
    [event.turnId]: (this.streamingByTurn[event.turnId] ?? '') + event.text };
  ```

  so a replayed run concatenates the full historical text of that turn onto whatever is already
  buffered. It is only cleaned up when that turn's `turn.finished` arrives
  (`store.ts:1005`, `omitKey`).
- **Why it matters.** Clicking a running run that is already selected — or clicking it twice, which
  is the normal way to "refresh" a list item — visibly duplicates its streamed text mid-flight.
  Even for a finished run, the click costs a full event-log replay over the socket for no
  information gain, and `ensureRunDetail` does not help because it early-returns once turns are
  known (`store.ts:616-618`).
- **Suggested fix.** Two independent guards: (a) in `selectRun`, only send `loadRun` when the
  selection actually changed (move it inside the `if`); (b) anchor `loadRun`'s replay to history
  rather than the live buffer — e.g. treat `turn.started` as a reset for that `turnId`'s streaming
  entry instead of only appending, which also makes a genuine replay idempotent.

---

### [HIGH] The marketplace "Update" button always fails: a bundle URL is passed where the server requires a catalog URL

- **Evidence.** `console/plugins/PluginsPanels.tsx:170`:

  ```ts
  void api.installPlugin(update.downloadUrl, pluginId, true).then((result) => {
  ```

  `api.installPlugin` is `(catalogUrl: string, pluginId: string, upgrade = false)`
  (`app/api.ts:343`), and the server treats the first argument as a catalog document — it fetches it
  and then searches it for the plugin (`apps/server/src/plugins/host.ts:823-826`). But
  `PluginUpdateInfo.downloadUrl` is the **bundle archive** URL
  (`packages/core/src/plugin.ts:244`, populated from `entry.downloadUrl`, which `parseCatalog`
  already made absolute). The server's own test uses the catalog URL:
  `apps/server/src/plugins/plugins.test.ts:1690` —
  `await h.host.install(\`${market.baseUrl}/catalog.json\`, 'dev3d.remote-demo', true)`.
- **Why it matters.** The operator clicks Update and always gets a
  "could not reach the marketplace … is not valid JSON" error, because the server fetched a
  `.tar.gz` and tried to parse it as a catalog — so the console blames the marketplace for a
  client-side URL mistake. The feature is documented (`docs/design-notes.md`) and the server
  supports it fully; only this call is wrong, which makes it a pure one-line defect that makes an
  advertised feature dead.
- **Suggested fix.** Resolve the catalog URL from state the panel already holds — `sources` is
  available at `PluginsPanels.tsx:102` and `PluginUpdateInfo` carries `sourceId` — e.g.
  `const source = sources.find((s) => s.id === update.sourceId)?.url;` and surface a clear error
  when the source has been removed. Alternatively have the server accept a `sourceId`.

---

### [HIGH] An in-flight edit to plugin settings is silently discarded by any incoming office update

- **Evidence.** `console/plugins/PluginSettings.tsx:52-64`:

  ```ts
  // Seeding happens when the selected plugin changes - a different record - so
  // an event arriving mid-edit cannot overwrite what has been typed.
  useEffect(() => {
    ...
    setDraft(seed);
  }, [record]);
  ```

  The comment states the intended guard; the dependency does not implement it. `record` identity is
  never stable: the server rebuilds every record on each state call
  (`apps/server/src/plugins/host.ts:449-452` spreads each record with a fresh `settings` object),
  `runtime.state()` calls that on every snapshot (`apps/server/src/server/runtime.ts:1219`), and the
  server broadcasts a full `office.updated` — which carries `OfficeState.plugins`
  (`packages/core/src/events.ts:183`) — on `run.created`, on a run finishing, on
  `settings.updated` and on `org.updated` (`apps/server/src/index.ts:509-516`). Every one of those
  re-runs this effect and overwrites `draft` with the server's values.
- **Why it matters.** Typed settings are wiped mid-keystroke — by a run finishing, by another tab
  toggling a plugin, or by the 25-second heartbeat described in the first CRITICAL finding. This is
  silent loss of user input in a form, and the code comment actively asserts the opposite, which
  makes it unlikely to be caught by review.
- **Suggested fix.** Key the seed on identity rather than on the object — `}, [record?.manifest.id])`
  — and re-seed explicitly after a successful save (the `saver` at `:66-69` already knows when a
  save succeeded).

---

### [HIGH] `motion.yaw` is produced by the liveliness director and read by nobody, so bodies never turn

- **Evidence.** `office/avatar.ts:405-424`:

  ```ts
  update(dt, elapsed, reducedMotion, motion) {
    ...
    if (motion) group.position.set(motion.x, motion.y, motion.z);
    ...
    const delta = angleDelta(group.rotation.y, facingYaw);
    group.rotation.y = reducedMotion ? facingYaw : group.rotation.y + delta * (1 - Math.exp(-9 * dt));
  ```

  `motion.yaw` is documented as the body's facing (`liveliness.ts:64`) and produced on every path —
  travel (`liveliness.ts:874`), standing about (`:802`), turning to face a conversation partner
  (`:813`) — and published at `:945`. `update` reads only `mode`/`speed`/`phase`/`x`/`y`/`z`/`bubble`.
  A repo-wide grep for `motion.yaw` returns **one** hit: the producer at `liveliness.ts:945`. The only
  writer of the avatar's `facingYaw` is `setFacing` (`avatar.ts:402`), and `OfficeCanvas` calls it in
  exactly one place (`OfficeCanvas.tsx:1045`) inside a guard that excludes anyone the director knows
  (`:1042`, `if (liveliness.motionFor(employee.id) === null)`). After the first
  `applyLiveliness()` the director knows every employee, so the facing is frozen at the seat yaw for
  the whole session.
- **Why it matters.** Walking avatars strafe sideways instead of facing their direction of travel,
  and two employees in conversation never turn towards each other — directly contradicting
  `liveliness.ts:21` ("both turn to face each other for the whole exchange") and the avatar module's
  own header. It is invisible to the project's verification harness, which asserts position and pose
  but never `group.rotation.y`.
- **Suggested fix.** Read it where it is produced: `const yaw = motion ? motion.yaw : facingYaw;`
  inside `update`, keeping `setFacing` for the director-less case.

---

### [HIGH] Disabling a model removes its row, so the console can never re-enable it

- **Evidence.** The table renders an "Enable" affordance for disabled models
  (`console/SettingsPanel.tsx:317-346`):

  ```tsx
  const isOff = off.includes(model.id);
  <tr key={model.id} className={isOff ? 'row-off' : undefined}>
  ...
  {isOff ? 'Enable' : 'Disable'}
  ```

  but its rows come from `office.models` (`:238-245`, `:313`), and the server *excludes* disabled
  models from that catalog — `apps/server/src/llm/registry.ts:286`:

  ```ts
  if (disabled.has(model.id) || seen.has(model.id)) continue;
  ```

  fed by the operator's own setting (`apps/server/src/index.ts:231`,
  `disabledModelIds: () => runtimeRef?.settings().disabledModelIds ?? []`). After the `Disable`
  click the server broadcasts a full state (`index.ts:509-516`), the row disappears, and there is
  nothing left to click. The registry's own comment (`:276-277`) says disabled models are kept
  visible *precisely so* "the console can show them".
- **Why it matters.** `Disable` is a one-way door in the UI: the only writer of
  `disabledModelIds` in the entire web app is this button, so restoring a model requires `curl` or
  editing the settings file by hand. The panel renders `row-off` styling and an "Enable" label for
  a state it can never reach.
- **Suggested fix.** Either keep disabled models in `OfficeState.models` with a `disabled: true`
  flag and filter only the routing pool, or render the disabled rows from
  `office.settings.disabledModelIds` joined against the catalog independently of the routing list.

---

### [HIGH] Clearing a numeric settings field sends `0`, which silently switches off the spend-approval gate

- **Evidence.** `console/SettingsPanel.tsx:764-766`:

  ```tsx
  value={softSpend}
  onChange={(event) => setDraft((current) => ({ ...current, softSpendApprovalUsd: Number(event.target.value) }))}
  ```

  A controlled `<input type="number">` reports `''` when cleared, and `Number('') === 0`, so the
  field can never be left blank and the save carries `softSpendApprovalUsd: 0`. The server only
  rejects `< 0` (`apps/server/src/server/runtime.ts:1335-1337`), and the field's own hint
  (`:758`) states that "0 disables the gate". The same unguarded pattern appears at `:178-181`
  (`maxConcurrency`), `:646-648` (`defaultRunUsd`) and `:780-782` (`approvalTimeoutMs`); the first
  and last are refused by the server with a visible error
  (`runtime.ts:1332-1334`, `:1338-1340`) but `defaultRunUsd: 0` is accepted
  (`runtime.ts:1494-1498`), which silently means "no ceiling".
- **Why it matters.** A select-all-then-delete turns "ask a human before a run crosses $X" into
  "never ask" — an accidental, silent weakening of a spend control, with no error and no visible
  difference in the form. The codebase already knows the fix: `:659-664` deliberately preserves
  `''` for `totalUsd` (`event.target.value === '' ? '' : Number(event.target.value)`), and
  `plugins/PluginSettings.tsx:206-209` uses the correct guard
  (`const next = Number(...); onChange(Number.isFinite(next) ? next : current)`).
- **Suggested fix.** Keep the raw string in the draft and coerce on save, or ignore a non-finite
  parse and keep the previous value, as `PluginSettings` does. Never let `''` become `0`.

---

### [HIGH] The model-correction editor is not keyed, so editing model B can save A's prices into B

- **Evidence.** `console/SettingsPanel.tsx:365-378` renders the editor without a `key`:

  ```tsx
  {editedModel !== null && (
    <ModelOverrideEditor
      model={editedModel}
      override={overrides[editedModel.id]}
  ```

  while `:352` switches which model is being edited without unmounting anything
  (`onClick={() => setEditing(editing === model.id ? null : model.id)}`). `ModelOverrideEditor`
  seeds its four fields once, in `useState` initialisers (`:422-425`):

  ```ts
  const [tier, setTier] = useState<ModelTier>(override?.tier ?? model.tier);
  const [priceIn, setPriceIn] = useState(String(override?.costPerMTokIn ?? model.costPerMTokIn));
  ```

  Same element type at the same position, so React reuses the instance and the initialisers never
  re-run. `onApply` then writes the stale field values against the *new* model
  (`:370-374`, `map[editedModel.id] = next`).
- **Why it matters.** The header shows model B (`:450-453`) while the fields still hold model A's
  tier, prices and quality — and applying saves A's numbers as B's override. That is silent
  routing and cost corruption, persisted for the whole installation.
- **Suggested fix.** `<ModelOverrideEditor key={editedModel.id} … />`. This is the class of bug the
  review brief asks about specifically, and it is a one-token fix.

---

### [HIGH] The skills selection survives a floor switch, so saving writes one floor's skills to another

- **Evidence.** `console/SettingsPanel.tsx:544-552`:

  ```ts
  const [selection, setSelection] = useState<string[] | null>(null);
  const activeId = office?.activeWorkspaceId ?? '';
  const enabled = selection ?? office?.skillIds ?? [];
  const saver = useSaver<string[]>(async (ids) => {
    const result = await api.updateWorkspace(activeId, { skillIds: ids });
  ```

  `office.skillIds` is documented as the *active* organisation's skills
  (`packages/core/src/events.ts:118-119`). Once the operator clicks a checkbox, `selection` is
  non-null and wins over `office.skillIds` for the rest of the component's life — and nothing
  re-seeds it. The floor selector is always mounted in the header (`App.tsx:516` →
  `FloorSelector.tsx:31`), and `SettingsPanel` does not remount on a floor change, so the sequence
  "toggle skills on floor A → switch floor in the header → Save" PUTs floor A's id list to floor B
  (`apps/server/src/server/runtime.ts:1468-1486` filters only against *known* skill ids, so floor B
  quietly inherits them).
- **Why it matters.** A cross-tenant write: one organisation's capability policy is applied to
  another, silently, in a product whose whole premise is per-floor isolation.
- **Suggested fix.** `useEffect(() => setSelection(null), [activeId])`, or key the skills editor by
  `activeId`. The budget draft (`:604-616`) has the identical defect and needs the same reset — it
  shadows `office.budget` indefinitely and can write floor A's total to floor B.

---

### [HIGH] A plan reply is appended to whichever session is active when it arrives, not the one that asked

- **Evidence.** `console/PlanPage.tsx:96` records only the request id:

  ```ts
  const awaiting = useRef<{ requestId: string; asDraft: boolean } | null>(null);
  ```

  and the effect that consumes the reply (`:217-229`) resolves the target from the *current*
  render:

  ```ts
  updateSession(active.id, {
    messages: [...active.messages, { id: messageId(), role: 'assistant', text: reply.text, at: reply.at }],
  ```

  Session switching is not disabled while a turn is in flight (`:303` `selectSession`,
  `:313` `removeSession`), and a planning turn takes seconds to a minute. So switching or deleting
  the asking session mid-flight lands the model's answer in a different plan — or, if the session
  was deleted, `:221` (`if (!reply || !active) return;`) bails **without** consuming the reply or
  clearing `busy`, leaving the composer disabled until the 180-second timeout (`:232-241`) fires.
- **Why it matters.** Silent mis-attribution of model output in the one surface whose job is to
  keep a conversation coherent, plus a wedged composer in the delete case. The HTTP fallback is
  unaffected because it captures `active` in a closure (`:205`) — which is exactly the difference
  that makes this a bug rather than a design choice.
- **Suggested fix.** Store `sessionId` next to `requestId` in `awaiting.current` and patch that
  id, falling back to dropping the reply (and clearing `busy`) when the session is gone.

---

### [MEDIUM] `usePanelRead`'s dependency array uses a cloned object, so contributed panels re-poll on every state push

- **Evidence.** `console/plugins/PluginPanels.tsx:32-37` and `:73`:

  ```ts
  const body = panel.body;
  ...
  }, [pluginId, panel.id, source === undefined ? '' : source.url, body]);
  ```

  `panel` comes from `office.plugins.records[].manifest.contributes.uiPanels`
  (`:113-126`), and `office.plugins` is rebuilt server-side through `structuredClone`
  (`runtime.ts:1219` calling `pluginHost.state()`), so `panel.body` is a **new array identity on
  every `office.updated`**. `:68` then tears down and recreates the interval.
- **Why it matters.** This is the mechanism by which the heartbeat bug (the first CRITICAL finding)
  becomes a
  network bug rather than only a CPU bug: each plugin panel issues a fresh
  `GET /api/plugins/:id/panels/:panelId` every 25 s per console, and the panel's configured
  `refreshMs` is effectively a lower bound that is never honoured from above. It also means an
  unrelated `office.updated` (a run being created) restarts every panel's poll.
- **Suggested fix.** Depend on a primitive derived from the body (its length, or a stable hash) or
  on `body === undefined` alone, and read the current body from a ref inside `load`. A short
  `JSON.stringify(body)` memo key is the pragmatic version.

---

### [MEDIUM] `handleEmployeeMoved` cannot represent "moved to the bench", and the feed says it did

- **Evidence.** The wire event allows a `null` room (`events.ts:239-245`), and
  `store.ts:1029-1054`:

  ```ts
  const next: EmployeeState = { ...employee, seatId: toSeatId, roomId: toRoomId ?? employee.roomId };
  ...
  text: `${employee.displayName} moved ${fromSeatId ?? 'bench'} → ${toSeatId ?? 'bench'}${
    toRoomId ? ` (${toRoomId.replace('Anchor_Room_', '')})` : ''}`
  ```

  `toSeatId` is applied as `null` correctly, but `roomId` falls back to the *previous* room. The
  feed line then reports `moved <from> → bench` while the state it just wrote still carries a
  room. The server's own `employee.updated` (which contains the full, authoritative record) is
  emitted alongside (`runtime.ts:1669` and `:1749` in the same region), so the two racing writers
  can disagree for as long as the events arrive in the other order.
- **Why it matters.** The 3D scene reads `employee.roomId ?? role?.roomId` to pick a facing
  (`OfficeCanvas.tsx:1029`), so a stale room changes where a benched avatar looks. The feed line is
  the operator's record of what happened and is simply wrong in that case.
- **Suggested fix.** Apply the event as written — `roomId: toRoomId` — and let the following
  `employee.updated` correct anything the event omits. If the fallback is deliberate, the feed text
  should say so rather than claiming "bench".

---

### [MEDIUM] An approval whose `approve` command fails is disabled forever in that console

- **Evidence.** `console/ApprovalsPanel.tsx:54-60` and `console/ApprovalCallout.tsx:62-65` both do:

  ```ts
  const command: ClientCommand = { type: 'approve', approvalId: approval.id, approved };
  if (store.send(command)) setSent((current) => ({ ...current, [approval.id]: true }));
  ```

  `sent` is initialised to `{}` (`ApprovalsPanel.tsx:41`, `ApprovalCallout.tsx:45`) and **never
  cleared or reset for any approval**. The buttons are `disabled={sent[approval.id] === true}`
  (`ApprovalsPanel.tsx:118`, `:126`; `ApprovalCallout.tsx:123`, `:131`).
- **Why it matters.** `store.send` returns `true` as soon as a transport is attached
  (`store.ts:467-474`) — it does **not** mean the server accepted the command. If the
  `decideApproval` fails, the server answers with an `error` *frame* (`index.ts:644-650`) which the
  store turns into a notice (`store.ts:746-749`); nothing tells the panel, so the buttons stay on
  "sending…" permanently. If the same approval is decided in another tab, the
  `approval.decided` event updates `approvalList` but the panel's local `sent` map keeps the row
  disabled, so the operator sees a stuck button for an approval that no longer exists. The
  `notify` de-duplication (`store.ts:554-555`, matched on identical text) also means a second
  identical failure is silently swallowed.
- **Suggested fix.** Derive the disabled/busy state from the approval's own `status`
  (`store.ts:1160-1173` already keeps decided approvals in the list) rather than from a local map,
  or reset `sent` when a matching `approval.decided`/`approval.requested` arrives. The store could
  also track the command type of an outbound command so an `error` frame can clear the right
  pending flag — the error frame currently carries no correlation id at all (`events.ts:311`).

---

### [MEDIUM] `OfficeState` is the only channel for models/settings, so `ping` aside, the client re-clones and re-renders on every roster change; `validate` of the `office` slice is too coarse for large tables

- **Evidence.** `store.ts:1249-1252`:

  ```ts
  private setOffice(state: OfficeState): void {
    this.officeState = state;
    this.emit('office');
  }
  ```

  The `office` slice is a single listener set (`store.ts:335-350`), and the largest tables in the
  console read it wholesale: `Telemetry.tsx` (models × providers × per-employee spend),
  `OrgChart.tsx`, `SettingsPanel.tsx`. There is no memoisation of the derived tables beyond
  `useMemo` on the whole array, and the array identity changes on every `setOffice`.
- **Why it matters.** A stream of small mutations — `employee.updated`, `handleBudget`, a
  `tool.result` on a run — each replaces the whole state object, so every large table recomputes
  and re-renders. The store's architecture is described as slice-scoped precisely to avoid this
  (`store.ts:9-13`), and the streaming/turns/approvals slices do deliver that; the `office` slice
  does not. This is the reason finding 1 and finding 3 are more than theoretical.
- **Suggested fix.** Split the coarse `office` slice into the pieces the big panels actually need
  (`runs`, `employees`, `models`+`providers`, `settings`, `plugins`) — the store already emits
  `memory` separately on exactly this reasoning (`store.ts:317-324`), so the pattern exists.

---

### [MEDIUM] `styles.css`: `.status-*` variants never match a vendor status, and two employee statuses have no rule

- **Evidence.** `styles.css:732-755` defines exactly five variants:
  `.status-thinking`, `.status-working`, `.status-talking`, `.status-blocked`, `.status-error`
  (verified by grep: no `.status-offline`, no `.status-idle`, no vendor variants).
  `console/VendorsPanel.tsx:109` emits `` className={`status status-${vendor.status}`} `` and
  `VendorStatus` is `offsite | unreachable | docked | engaged | errored`
  (`packages/core/src/vendor.ts`), so **none** of the five match. `OfficeCanvas.tsx:1515` emits
  `status-${selectedVendor.status}` with the same non-overlap, and `OfficeCanvas.tsx:1488` emits
  `status-${selected.status}` for an employee, where `EmployeeStatus` includes `offline` and `idle`
  — neither of which has a rule.
- **Why it matters.** Seven of the nine reachable states render with only the base `.status`
  styling (`styles.css:724`), so the colour that carries the meaning is absent — a vendor that is
  `errored` and one that is `offsite` look identical, and the vendor bay loses its entire colour
  vocabulary. `status.ts:38-46` and `:106-112` define a full colour table for both vocabularies, so
  the *data* is right and only the CSS is missing.
- **Suggested fix.** Add `.status-offline`/`.status-idle` for employees and the five vendor
  variants, or set the colour inline from `STATUS_STYLE`/`VENDOR_STATUS_STYLE` the way the dots
  already do (`ui.tsx:102`, `OfficeCanvas.tsx:1510`).

---

### [MEDIUM] `styles.css`: `--text-mute: #6c7686` is below WCAG AA on every surface it is used on

- **Evidence.** `styles.css:26` defines `--text-mute: #6c7686`. It is used at 28 sites
  (`styles.css:285, 327, 642, 830, 841, 859, 962, 1096, 1561, 1937, 2136, 2174, 2273, 2283, 2422,
  2468, 2495, 2701, 2798, 3191, 3235, 3568, 3971, 4028, 4277, 4343, 4406`), and the consumers are
  all small text: `.field-label` (`:642`, 10.5px), `.metric-label` (`:830`), `.kv-label` (`:859`),
  `.panel-sub` (`:285`), `.state-hint` (`:327`).
- **Why it matters.** Against the palette's own backgrounds the contrast ratios are
  **4.36:1** on body `#07080b`, **4.03:1** on panel `#101419`, **3.56:1** on surface-3 `#1a202b` —
  all below the 4.5:1 AA threshold for normal text, and these are the *labels*, not decorative
  chrome. Two uses make it worse by adding opacity: `.dock-hint` at `opacity: .7` (`:3729-3731`)
  composites to roughly 2.6:1 and `.kbd-hint` at `.75` (`:2221`) to roughly 2.9:1.
  This is a large-surface accessibility defect: `--text-mute` is the app's entire "secondary text"
  vocabulary.
- **Suggested fix.** Raise the token until it clears 4.5:1 on the lightest surface it is used on
  (≈`#8b95a5` is a starting point) and remove the opacity multiplications in favour of a dedicated
  dimmer token where a hint genuinely may be lower contrast. Adding a
  `@media (forced-colors: active)` block would also help, since meaning is currently carried by
  `background` colour alone in `.dot` (`:701`), `.floor-dot` (`:3974`) and
  `.office-style-swatch` (`:1135`).

---

### [MEDIUM] `styles.css`: `var(--radius-md)` is undefined and `.stage` is declared twice with conflicting rules

- **Evidence.** `styles.css:1154` uses `border-radius: var(--radius-md);` inside
  `.office-style-body`, but `:root` (`:13-45`) defines only `--radius` and `--radius-sm`. With no
  fallback value the declaration is invalid and `border-radius` computes to `0` — verified by
  grepping the whole sheet for `--radius-md`: one hit, the use, no definition.
  Separately, `.stage` is declared at `:2425` and again at `:2895`; the later block wins, making
  `:2426-2427` and `:2429` dead. The single consumer is `app/App.tsx:400`.
- **Why it matters.** The undefined variable is a silent visual regression with no error anywhere
  — exactly the class of drift that accumulates. The duplicate `.stage` means the sheet's cascade
  cannot be read top-to-bottom, which is how the `.segmented`/`.segment` and `.kv-grid` duplicates
  (also present: `:542-577` vs `:3277-3302`, `:844` vs `:4075`) came about; in the `.segmented`
  case the later `border`/`background` shorthands reset the earlier block's `border-right`, so the
  segmented control renders as detached pills rather than a connected unit.
- **Suggested fix.** Define `--radius-md` (or delete the use); fold the duplicate `.stage`,
  `.segmented`/`.segment` and `.kv-grid` blocks into one declaration each. The repo already ships
  `scripts/check-css.mjs` (`package.json:24`) — a rule that fails the build on an undefined
  `var()` or a duplicated selector would prevent the whole category.

---

### [MEDIUM] `styles.css`: focus rings are clipped by `overflow: hidden` ancestors

- **Evidence.** The global ring is `styles.css:110-114`
  (`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`) — a genuinely good
  choice, and there is no `outline: none` anywhere in the sheet. But it is drawn 2px *outside* the
  element, and it lives inside containers that clip: `.segmented { overflow: hidden }` (`:546`)
  contains focusable `.segment` buttons, and `.office-style-preset-chips { overflow: hidden }`
  (`:1207-1212`) contains focusable chips. There are 37 `overflow: hidden` containers in total.
- **Why it matters.** Keyboard focus on the first and last segment of a group — the routing
  posture control (`StatusPopout.tsx:114-127`), the activity filter
  (`ActivityFeed.tsx:95-107`) — is partially or wholly invisible, which is the one place a
  keyboard user must be able to see. There is also no keyboard path for the two pane-resize
  handles at all (`styles.css:3113-3152`; `InspectorPopout.tsx:102-111` declares them
  `role="presentation"` and wires only `onPointerDown`), so the pane can only be resized with a
  mouse — the "Reset" button is the sole keyboard-accessible alternative, as
  `InspectorPopout.tsx:99-101` acknowledges.
- **Suggested fix.** Replace `overflow: hidden` on the segmented/chips containers with a
  radius-preserving clip that does not clip the ring (e.g. clip the *children*' backgrounds
  instead, or use `outline-offset: -2px` inside those specific controls), and give the resize
  handles `role="separator"` with `aria-orientation`, `tabIndex={0}` and arrow-key handling.

---

### [MEDIUM] The quick-jump palette's combobox ARIA does not work, and focus is not restored

- **Evidence.** `console/QuickJump.tsx:233-249` declares `role="combobox"`,
  `aria-expanded={flat.length > 0}` and `aria-controls="quick-jump-results"`, but there is **no**
  `aria-activedescendant` — the highlighted row is communicated only visually
  (`aria-selected={position === active}`, `:274`). The options are real `<button>` elements
  (`:270-283`), so they are individually tabbable and there is no `tabIndex={-1}`; the
  arrow/Enter/Escape handler is attached **only to the input** (`:247`). Consequence: Tab out of the
  input into the list and the keyboard handler stops working entirely. `aria-expanded` is also
  `flat.length > 0` while the listbox container (`:255`) is always rendered, and the listbox's
  structure is `listbox > div.quick-jump-group > button[role=option]` with unassociated group
  titles (`:263-265`, no `role="group"`/`aria-labelledby`).
  Focus is moved into the input on mount (`:85-87`, good) but nothing restores it to the element
  that opened the palette on close: the input unmounts and focus falls to `<body>`.
- **Why it matters.** The component is the console's keyboard-first navigation surface — it is
  explicitly reached by Ctrl/Cmd-K and its docstring (`:1-13`) frames it as the answer to "I know
  what I want and not where it is". As shipped, a keyboard user who presses Tab loses the ability to
  choose anything, and a screen-reader user is told there is a combobox but never which option is
  active.
- **Suggested fix.** Add `aria-activedescendant={`quick-jump-option-${active}`}` and give each
  option an `id`; set `tabIndex={-1}` on the options (or use `role="listbox"` with the input as the
  only tab stop); attach the key handler to the palette container rather than the input; and store
  the previously focused element on mount to restore it on unmount.

---

### [MEDIUM] `Tabs` declares the tab roles but not any of the behaviour they promise

- **Evidence.** `console/ui.tsx:162-184`:

  ```tsx
  <div className="tabs" role="tablist">
    {items.map((item) => (
      <button key={item.id} type="button" role="tab" aria-selected={item.id === active} ...>
  ```

  There is no roving `tabIndex`, no arrow-key handling, no `id`/`aria-controls` pairing, and no
  `role="tabpanel"` anywhere in the codebase. The 12 top-level tabs (`app/App.tsx:519-529`) and the
  3 inspector tabs (`InspectorPopout.tsx:137-145`) are therefore all in the document tab sequence,
  and ArrowLeft/ArrowRight do nothing — which is the opposite of what `role="tablist"` leads an
  assistive-technology user to expect (per the WAI-ARIA authoring practices, only the active tab
  should be tabbable and arrows should move between them).
- **Why it matters.** It is a promise the markup makes and the code does not keep, and it makes
  the top bar cost 12 tab stops to traverse. This is a systemic issue: `Tabs` is used by both
  navigations.
- **Suggested fix.** Either implement the pattern (roving `tabIndex`, Arrow/Home/End, `id` +
  `aria-controls` + `role="tabpanel"` on the content) or drop `role="tablist"`/`role="tab"` and
  present the buttons as a plain `nav` with `aria-current="page"` — the latter is honest and much
  smaller. `App.tsx:518` already wraps them in `<nav className="app-nav" aria-label="Sections">`.

---

### [MEDIUM] The page sheet does not occlude the background, and one overlay stays keyboard-reachable behind it

- **Evidence.** `PageSheet` renders a plain `<section className="sheet" aria-label={title}>`
  (`console/PageSheet.tsx:22-24`). Its docstring (`:5-7`) states this is deliberate — *"A sheet is
  not a modal dialog - the office stays live and clickable around it - so it declares itself as a
  labelled region rather than trapping focus."* That is a defensible design, but it has a concrete
  failure: a repo-wide grep for `inert` across `apps/web/src` returns **zero** hits.
  `App.tsx:427` renders `<PluginPanels placement="office-overlay" className="plugin-panels-overlay" />`,
  and `styles.css:4486-4495` positions it at `z-index: 4` with `left: var(--inset-left)` (which is
  `0px` while a sheet is open, per `App.tsx:354`) and `pointer-events: auto` — the same horizontal
  band the sheet occupies at `z-index: 6` (`styles.css:2930`). DOM order puts the sheet first
  (`App.tsx:405`) and the overlay second (`:427`), so the plugin overlay's buttons are painted
  *behind* the near-opaque sheet but remain in the tab order.
- **Why it matters.** Tab order can reach controls the user cannot see and cannot click. Whether
  that is reachable in practice depends on a loaded plugin contributing an `office-overlay` panel —
  which is exactly the case the placement exists for.
- **Suggested fix.** Apply `inert` (or `aria-hidden` plus `tabIndex={-1}`) to the stage content
  behind an open sheet, or hide `office-overlay` panels while `sheetOpen`. Since the design
  intentionally keeps the office interactive, the narrower fix is to render
  `PluginPanels placement="office-overlay"` only when no sheet is open.

---

### [MEDIUM] The office canvas silently loses every grown room when the block kit loads after the floor model

- **Evidence.** The component's own comment says the opposite of what the code does
  (`office/OfficeCanvas.tsx:220-226`):

  ```ts
  /**
   * Whether the block kit has settled, one way or the other.
   * ...
   * The floors are rebuilt when this flips, which is what lets a floor that was
   * drawn before the kit arrived pick up its modules without a reload.
   */
  const [kitReady, setKitReady] = useState(false);
  ```

  The only rebuild trigger inside `buildFloors` is a layout-signature comparison
  (`:674`, `:696`):

  ```ts
  const key = layoutKeyOf(workspace);   // :674
  ...
  if (existing.layoutKey !== key) {     // :696
  ```

  and `layoutKeyOf` derives **only** from the server's block list (`:446-450`):

  ```ts
  return workspace.layout.blocks.map((b) => `${b.id}:${b.kind}@${b.x},${b.z}r${b.rotation}`).join('|');
  ```

  `kitReady` is set at `:1209` (kit success) and `:1213` (kit *failure*) and appears nowhere else
  except as a dependency of the sync effect (`:1356`). It cannot change `layoutKeyOf`'s output, so
  the `:696` branch does not fire when the kit arrives. Meanwhile the builder skips any placement
  whose kind is not in the kit (`:475-476`):

  ```ts
  const kind = kit.get(placed.kind) ?? kit.get(`Kit_${placed.kind}`);
  if (!kind) continue;
  ```

  Both GLB requests start on the same tick (`:1195` kit, `:1217` office), and `office.glb`
  (281,904 bytes) is smaller than `blocks.glb` (448,148 bytes), so the office model is the likelier
  to resolve first — producing a floor with an empty `modules` group and `layoutKey` already
  recorded.
- **Why it matters.** A floor that has grown rooms renders without them and keeps reporting the
  pre-growth anchor counts, until the layout actually changes or the floor is recreated. The code
  comment asserts this case is handled, which makes it more likely to be trusted and not retested.
  The same path is taken on a kit *failure*, where the misleading HUD label compounds it
  (`:1404-1410` hardcodes "the server room" from the server's block list while the scene docks at
  reception per `anchors.ts:277-286`).
- **Suggested fix.** Fold kit state into the signature — e.g. include `kit.size` (or an explicit
  `kitVersion` counter) in the value `layoutKeyOf` returns, so the `:696` branch fires once when the
  kit lands. Log the kit failure instead of swallowing it (`:1212-1214` takes no argument and
  reports nothing, unlike the office loader's handler at `:1255-1259`).

---

### [MEDIUM] Invisible avatar geometry is raycast-and-selectable, and non-primary buttons count as clicks

- **Evidence.** Picking intersects recursively with no visibility test
  (`office/OfficeCanvas.tsx:877-880`):

  ```ts
  const targets: THREE.Object3D[] = [];
  for (const avatar of avatars.values()) targets.push(avatar.group);
  for (const terminal of vendorAvatars.values()) targets.push(terminal.group);
  const hits = raycaster.intersectObjects(targets, true);
  ```

  three.js's traversal helper tests `object.layers` only and neither `Mesh.raycast` nor
  `Sprite.raycast` consults `visible` (verified in the installed
  `three@0.171.0/build/three.cjs`). The speech bubble is hidden but still positioned above the
  avatar's head at ~1.84 m and scaled 2.16 × 0.54 (`office/avatar.ts:285-288`,
  `bubbleSprite.visible = false`) — so a click on apparently empty air above a person selects them.
  The hidden selection ring, halo, legs and tablet are toggled the same way.
  Separately, neither pointer handler inspects `event.button` (`:893-895`, `:897-912`):
  `onPointerDown` only records the position and `onPointerUp` selects when the pointer moved less
  than 6px — so a right-or-middle click that barely moves hits `store.selectEmployee(null)` and
  clears the selection. `OrbitControls` is bound to the same element (`:317`) and uses the right
  button to pan.
- **Why it matters.** Clicking "nothing" selects somebody, and a failed right-drag clears the
  inspector. Both are small but constant sources of the "the console did something I did not ask
  for" feeling that makes a 3D UI feel unreliable.
- **Suggested fix.** Filter hits whose object (or nearest visible ancestor) is not visible before
  treating a hit as a pick, and add `if (event.button !== 0) return;` to `onPointerDown` with a
  matching guard in `onPointerUp`.

---

### [MEDIUM] The camera fly-to ignores `prefers-reduced-motion`, and a full avatar raycast runs on every mouse move

- **Evidence.** Reduced motion reaches the bodies but not the camera
  (`office/OfficeCanvas.tsx:1278-1291`):

  ```ts
  if (focusTarget) {
    const desired = focusTarget.point.clone().add(new THREE.Vector3(0, 0.95, 0));
    const k = 1 - Math.exp(-5 * dt);
    controls.target.lerp(desired, k);
  ```

  `let reduced = reducedMotion;` is in scope at `:252` and is correctly passed to every avatar
  (`:1293`) and terminal (`:1297`) update, and liveliness is disabled under it (`:286-288`), so the
  camera ease is the one animation path that ignores the preference — a ~1s animated flight every
  time someone is selected, plus `OrbitControls` damping (`:1298`).
  Hover picking does no throttling (`:914-916`, registered at `:931`): each `pointermove` rebuilds
  the `targets` array and intersects recursively over every avatar group, and each avatar is
  roughly twenty meshes plus label and bubble sprites — so a fast sweep across a full office runs
  thousands of intersections per second on the main thread, competing with the render loop. The
  loop also allocates three `Vector3`s per frame while easing (`:1279`, `:1282`).
- **Why it matters.** The reduced-motion contract is documented and honoured everywhere else in the
  component (`:1328-1330` even refuses to rebuild the scene when it changes), so one inconsistent
  path is a defect rather than an oversight of scope. The hover cost scales with the roster.
- **Suggested fix.** `const k = reduced ? 1 : 1 - Math.exp(-5 * dt);` and skip the lerp entirely when
  reduced. Coalesce hover picking to one resolution per frame (mark dirty in the handler, resolve
  inside `tick`) and keep a persistent `targets` array refreshed when the avatar maps change.

---

### [MEDIUM] The shadow map and the WebGL context are never released on unmount

- **Evidence.** `office/OfficeCanvas.tsx:337-338` requests a 2048² shadow map:

  ```ts
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  ```

  but the cleanup (`:1303-1327`) disposes floors, avatars, the ground meshes and the renderer, and
  never calls `keyLight.shadow.dispose()`. In three.js, `LightShadow.dispose()` is what releases
  `this.map`, and `WebGLRenderer.dispose()` does not touch the shadow map (verified in the installed
  `three.cjs`). The cleanup ends at `:1324` with `renderer.dispose();` and then detaches the canvas
  (`:1325`) — `renderer.forceContextLoss()` is never called, and in three.js that is a separate,
  explicit operation that actually loses the GL context.
- **Why it matters.** `apps/web/src/main.tsx:20` mounts under `<StrictMode>`, so in development the
  very first mount already creates two renderers, and each HMR cycle adds more. A 2048² depth
  target plus a live GL context per unmount is the standard route to the browser's "too many active
  WebGL contexts" warning, after which the oldest context is force-lost.
- **Suggested fix.** Add `keyLight.shadow.dispose();` before `renderer.dispose()`, and call
  `renderer.forceContextLoss()` after it.

---

### [MEDIUM] Re-selecting a run is the normal click, and every click replays the run's whole log

- **Evidence.** See the streaming-doubling entry above for the mechanism: `RunList.tsx:176` calls
  `onSelect(run.id)` on every click and `store.ts:529-532` sends `loadRun` even when the run is
  already selected. The server's answer is a full replay of `store.eventsForRun(cmd.runId)`
  (`index.ts:747-754`).
- **Why it matters.** On a long run this is the largest single message stream the console receives,
  triggered by a click that the user reasonably expects to be a no-op because the run is already
  open. It is also what makes the doubling above possible at all.
- **Suggested fix.** Same as the streaming-doubling fix: guard `loadRun` on an actual selection
  change, and add an explicit "reload transcript" affordance for the case where a reload is
  genuinely wanted.

---

### [MEDIUM] `paneGeometry.ts` is entirely dead code, and it is the module that documents the bug it was written to prevent

- **Evidence.** `app/paneGeometry.ts` exports `MIN_INSPECTOR_HEIGHT` (`:26`), `PANE_DOCK_GUTTER`
  (`:28`), the `PaneCeiling` interface (`:30-35`) and `paneCeiling()` (`:43-59`). A repo-wide grep
  for `paneCeiling`, `PaneCeiling` and `PANE_DOCK_GUTTER` returns **only that file** — no consumer
  anywhere. `app/App.tsx:46` imports only `MIN_INSPECTOR_HEIGHT`, and recomputes the ceiling
  inline instead (`App.tsx:208-211`):

  ```ts
  const maxInspectorHeight = useMemo(() => {
    if (typeof window === 'undefined') return 900;
    return Math.max(MIN_INSPECTOR_HEIGHT, window.innerHeight - dockHeight - 48);
  }, [dockHeight]);
  ```

- **Why it matters.** Nothing is broken at runtime, but the file's 23-line docstring explains at
  length that this arithmetic *was* wrong and that the module exists "so it can be checked"
  (`paneGeometry.ts:21-22`) — and the shipped formula is a different one using `window.innerHeight`
  in place of `stageHeight - paneTop`, with a hardcoded `48` in place of `PANE_DOCK_GUTTER`. So the
  checkable version is uncheckable-in-practice and the unchecked version is what runs. The
  hardcoded `48` also does not track the CSS (`--pane-dock-gutter: 24px`, `styles.css:3084`), so
  the intended 24px gutter plus the stage's own top inset have been collapsed into a magic number.
- **Suggested fix.** Either delete `paneGeometry.ts` and fold its reasoning into a comment at
  `App.tsx:208`, or actually call `paneCeiling()` from `App.tsx` with a measured stage height and
  delete the duplicate arithmetic. Keeping the dead copy is the worst of the three.

---

### [MEDIUM] The console's own tools disagree with the server about what a "compatible" plugin is

- **Evidence.** `console/plugins/format.ts:179-190`:

  ```ts
  const matches = plugin === hostApiVersion;   // exact string equality
  ```

  with a docstring stating that "a mismatch is a refusal to load". The host does not do that: it
  compares **major versions** (`apps/server/src/plugins/manifest.ts:85-88`, `apiCompatible`, used as
  the load gate at `:671-679`). So a plugin declaring `apiVersion: "1.2"` loads perfectly and the
  console paints its card red with "host implements 1 — mismatch"
  (`console/plugins/PluginList.tsx:253-260`). `console/plugins/Marketplace.tsx:502` goes further and
  hardcodes `manifest.apiVersion !== '1'` instead of importing `PLUGIN_API_VERSION`, which the web
  app never imports at all.
- **Why it matters.** The console accuses a correctly-built plugin of an incompatibility it does not
  have, on the card and in the marketplace browser. The `'1'` literal will also flag *every* catalog
  entry as soon as the API version is bumped.
- **Suggested fix.** Mirror the host's major-version comparison and share the rule — export
  `apiCompatible` from `@dev3d/core` beside `PLUGIN_API_VERSION` so both sides use one function
  instead of three hand-written checks.

---

### [MEDIUM] `maxOutputTokens` is read with `parseInt`, so `1e3` becomes a one-token cap

- **Evidence.** `console/OrgChart.tsx:569-578`:

  ```ts
  const parsedTokens = Number.parseInt(maxOutputTokens, 10);
  ...
  if (Number.isFinite(parsedTokens)) { ... { maxOutputTokens: parsedTokens } ... }
  ```

  The field is an `<input type="number">`, and a number input legitimately returns exponent notation
  as its string value: `Number.parseInt('1e3', 10) === 1`. `Number.isFinite(1)` is true, so the
  guard passes and `{ maxOutputTokens: 1 }` is written into the role policy (the server accepts it at
  `apps/server/src/server/runtime.ts:1766-1768`). The sibling `parseFloat` for `escalateAt` (`:569`)
  is correct for this reason — `parseFloat('')` and `parseFloat('abc')` are `NaN`, which the same
  guard then drops rather than sending.
- **Why it matters.** Typing `1e3` — a natural way to enter a thousand — silently caps a role's
  output at one token, with no error and no visible symptom until a turn produces nothing useful.
- **Suggested fix.** Use `Number(maxOutputTokens)` (or `parseFloat`), which evaluates `'1e3'`
  correctly and still yields `NaN` for empty/non-numeric input.

---

### [MEDIUM] The "docked, nothing in flight" line contradicts the badge directly above it

- **Evidence.** `console/VendorsPanel.tsx:300-305`: the status badge is
  `<Badge tone={toneFor(vendor.status)}>` (`:290`), and the activity line below is

  ```tsx
  {vendor.activity ?? <span className="dim">docked, nothing in flight</span>}
  ```

  `VendorState.activity` is `string | null`, so the fallback fires for **every** status with no
  activity — including `unreachable` and `errored`. The same panel's row for a vendor uses
  `status-${vendor.status}` (`:109`), which matches no CSS rule (see the `.status-*` finding
  above), so the roster row has no colour and then the detail pane explains a fault as "docked".
- **Why it matters.** For the two states an operator most needs to act on, the panel asserts the
  opposite of the badge next to it. The roster is also the one surface where vendor status is not
  rendered at all, so the bay's legend (`:194-201`, which *is* coloured) and its rows disagree.
- **Suggested fix.** Branch the fallback on `vendor.status` (the panel already has a total
  `toneFor` map at `:71-85` covering all five), and render the roster chip as a `Badge` for the same
  reason. Also change `actions={vendor.status === 'engaged' ? … : null}` (`:300`) to `undefined` —
  `Panel` tests `actions !== undefined` (`console/ui.tsx:43`), so `null` emits an empty
  `.panel-actions` flex item.

---

### [MEDIUM] `AppliedStyle.unmapped` is always empty in production, and the dressing pass writes its report to a scratch object

- **Evidence.** `office/theme.ts:270` returns `unmapped: []` from `applyStyle`, while
  `theme.ts:303` writes the real list onto whatever object it was handed:
  `applied.unmapped = [...unmapped].sort();`. The caller passes a fabricated object
  (`OfficeCanvas.tsx:437`):

  ```ts
  const styleScratch = { materials: {} as FloorMaterials } as AppliedStyle;
  ```

  which is threaded through `withMaterials()` into every `dressMaterials` call (`:490`, `:542`). The
  floor's own `AppliedStyle` — stored at `:677` and used for re-dressing at `:690` — therefore never
  learns which materials could not be mapped. Nothing reads `unmapped` anywhere in the repo (grep
  finds only the four sites in `theme.ts`).
- **Why it matters.** The documented field ("Materials whose name this build could not place; they
  render unstyled", `theme.ts:215-216`) is dead *and* would be wrong if anyone read it — the exact
  kind of silent gap that lets a new GLB material go unstyled unnoticed. The unchecked
  `{} as FloorMaterials` cast exists only because `dressMaterials`' parameter type demands a whole
  palette for a call that uses one field.
- **Suggested fix.** Narrow the parameter to `{ materials: FloorMaterials; unmapped?: string[] }` and
  return the list, so the caller keeps its scratch-materials optimisation without the cast and the
  report lands somewhere real.

---

### [MEDIUM] The A* heuristic mixes metres with cell costs

- **Evidence.** `office/navgrid.ts:373-380` computes the heuristic in **metres**:

  ```ts
  const dx = Math.abs(centreX(col) - endX);
  const dz = Math.abs(centreZ(row) - endZ);
  const diagonal = Math.min(dx, dz);
  return (dx + dz - diagonal) + diagonal * Math.SQRT2;
  ```

  while the accumulated cost is in **cells** (`:412-413`):

  ```ts
  const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
  const tentative = currentG + step;
  ```

  One cell is `cell` metres (`DEFAULT_CELL = 0.2`, `:97`), so the heuristic is under-scaled by that
  factor. The comment at `:372` claims it returns "the real cost of moving on an eight-way grid".
- **Why it matters.** At the shipped 0.2 m cell the heuristic is 5× too small, so the search
  degenerates towards Dijkstra and expands far more nodes than needed — which is what makes the
  `guard = total * 4` pop cap (`:385-387`) reachable. For any caller passing a larger `cell` the
  heuristic becomes inadmissible and routes can be non-optimal; `NavGridOptions.cell` is public API
  and the verification harness already exercises a non-default `0.25`
  (`apps/web/.verify/smoke.ts:976`). A capped search returns `null`, which is not a benign answer:
  the caller teleports the employee home (`liveliness.ts:527-531`) and **permanently** removes that
  destination from their list for the session (`liveliness.ts:654`).
- **Suggested fix.** Return cell-unit octile distance — divide by `cell` — and raise or remove the pop
  guard, distinguishing "capped" from "no route" in the return type so the caller does not prune a
  spot on a cap.

---

### [MEDIUM] `wandering` is an O(N) getter read per actor per frame, making the director O(N²)

- **Evidence.** `office/liveliness.ts:279-287`:

  ```ts
  get wandering(): number {
    let count = 0;
    for (const actor of this.actors.values()) {
      ...
      if (Math.hypot(actor.x - actor.home.x, actor.z - actor.home.z) < 0.4) continue;
      count += 1;
    }
    return count;
  }
  ```

  It is read inside `stepActor` at `:804` and `:828`, and `stepActor` runs for every actor every
  frame (`:384`). Being a getter, each read is a full scan and nothing memoises the result.
- **Why it matters.** O(K·N) `hypot` calls per frame where K is the number of actors reaching those
  branches — cheap at twenty employees, real work in exactly the growing-office case this layer is
  designed for. It is CPU only (no allocation), but it is the one per-frame super-linear cost in the
  office modules.
- **Suggested fix.** Maintain an away-counter updated on state transitions, or compute it once per
  `update` and pass it into `stepActor` the way `idle` already is (`:384`).

---

### [MEDIUM] Renamed employees and vendors keep a stale name plate, and a vendor's engagement counter can never change

- **Evidence.** `office/avatar.ts:390-395` redraws the plate from a closure variable captured at
  construction:

  ```ts
  setStatus(next) { if (next === status) return; status = next; applyStyle(next); drawLabel(displayName, next); }
  ```

  `displayName` is the `createAvatar` parameter (`:102`), and `OfficeCanvas.tsx:1014-1019` creates one
  avatar per employee id and never recreates it. Renames are real: `store.ts:804` pushes a new
  `displayName` into `EmployeeState`, and the director updates its own copy
  (`liveliness.ts:323 actor.name = member.name`) — so the speech bubble can show a new name above a
  plate showing the old one. The vendor terminal has the same freeze plus one worse: `engagements` is
  read only inside `drawScreen` (`office/vendorAvatar.ts:292`), which runs at construction (`:368`)
  and on `setStatus` (`:380`), and the returned object exposes no way to update it — so a terminal's
  engagement count is frozen at whatever it was when the terminal was first created
  (`OfficeCanvas.tsx:1073-1082` creates it only when the id is absent, then only calls
  `setStatus`/`setSelected`/`setFacing`).
- **Why it matters.** The plate is the only label distinguishing two avatars; a renamed employee
  shows a name that no longer exists in the org chart, and a terminal advertising "engagements 3"
  keeps saying 3 for the rest of the session while the panel beside it counts up. `vendorAvatar.ts`
  documents the counter as being "drawn on the screen so the terminal carries a record".
- **Suggested fix.** Add a `setInfo`/`setName` to both avatar types and call it from `syncScene` when
  the record changes, redrawing the canvas only when a value actually differs.

---

### [MEDIUM] The shared `useSaver` hook has no `try/finally`, and its "saved" timer outlives the component

- **Evidence.** `console/SettingsPanel.tsx:38-62` — `useSaver` awaits the caller's `save`, then clears
  `busy` and shows `saved` for 2.5 s via a `setTimeout` (`:55`), with no cleanup anywhere in the hook,
  and no `try/finally` around the await. The tab body is unmounted on every page switch (`:874-879`,
  `{tab === 'general' && <GeneralSettings />}`), so after a save plus a tab switch the timer always
  fires on an unmounted component. In-scope callers never reject only because `api.request` converts
  every throwable into a result (`app/api.ts:162-172`) — but the hook's own docstring exports it for
  plugin-generated forms, and `plugins/PluginSettings.tsx:66-69` passes a host-supplied `onSave`
  straight through, so a `save` that throws leaves the button on "saving…" forever with an unhandled
  rejection.
- **Why it matters.** The only thing between a third-party form and a permanently disabled Save
  button is another module's error handling. `PluginPanels`/`PluginWidgets` guard the equivalent path
  with a `cancelled`/`alive` pair, so the discipline already exists in the same feature.
- **Suggested fix.** `try { … } finally { setBusy(false) }`, hold the timer in a ref and clear it in
  an effect cleanup, and guard post-await state with a mounted ref.

---

### [MEDIUM] Reading a URL parameter to decide rendering is fine, but `markdown.tsx` passes link targets straight to `href` with no scheme check

- **Evidence.** `console/markdown.tsx:40-46` builds anchors from model output, whose docstring
  describes the content as untrusted, and the target is applied without validating the scheme. The
  tokenizer accepts any run of non-parenthesis, non-whitespace characters as a URL, so a
  `javascript:` target survives to `<a href>`. A grep for `javascript:|sanitize|safeHref` across
  `apps/web/src` returns nothing, and the server sets no CSP (`apps/server/src/index.ts:844-846` sets
  CORS headers only).
- **Confirmed/Suspected:** the absence of any scheme check is **CONFIRMED**; whether the click
  executes is browser/React-version behaviour that was not executed. React 18.3.1 warns about a
  `javascript:` URL in development but still writes the attribute.
- **Why it matters.** Transcript text, artifact bodies and stage summaries are untrusted model output,
  so this is the one place where untrusted text becomes a clickable navigation target. Everything else
  in the renderer is safe by construction — there is no `dangerouslySetInnerHTML` anywhere in
  `apps/web/src`, and the renderer builds React elements.
- **Suggested fix.** Allow-list the scheme before it reaches the `<a>` —
  `const safe = /^(https?:|mailto:|\/|#)/i.test(href) ? href : undefined;` — and render plain text
  otherwise.

---

### [MEDIUM] The style editor can revert a change it just sent, and loses a pending change on unmount

- **Evidence.** `console/StylePanel.tsx:88-91` and `:103-113`:

  ```ts
  useEffect(() => { if (timer.current !== null) return; setDraft(committed); }, [committed]);
  ...
  const commit = (next) => { timer.current = window.setTimeout(() => {
    timer.current = null;            // <-- cleared BEFORE the send
    store.send({ type: 'setWorkspaceStyle', style: next });
  }, COMMIT_DELAY_MS); };
  ```

  The guard tests "a debounce is pending", but the timer is nulled before the round trip, so during
  the round trip the guard reads "not editing". `committed` is `office.style`, and every full-state
  frame is a brand-new object (`store.ts` `adoptState` assigns `this.officeState = state`), so **any**
  `office.updated` re-runs the effect and snaps the draft back to the server's older style — including
  the reply to the client's own 25-second heartbeat (the first CRITICAL finding) and the fan-out on
  `run.created`/terminal `run.updated`/`org.updated`/`settings.updated`
  (`apps/server/src/index.ts:509-516`). If the operator then moves another control, `setSurface`
  rebuilds from the reset draft (`:129-137`), so the just-sent change is dropped from the next
  whole-style payload — a real server-side revert.
- **Why it matters.** The style editor is the one surface where a lost update is visible on the 3D
  floor, and the window is exactly one round trip wide, so it will present as an intermittent
  "it didn't stick" rather than a reproducible failure. The same file also clears a pending
  debounced change on unmount without flushing (`:93-95`), silently discarding a change made in the
  last 260 ms before the panel closes.
- **Suggested fix.** Track "a commit is in flight / unacknowledged" separately from "a timer is
  pending" (keep a pending ref until the echoed style equals what was sent), compare incoming
  styles by value rather than identity, and flush the pending style in the unmount cleanup.
- **Confirmed/Suspected:** the guard defect and the unmount loss are **CONFIRMED** from the code;
  the server-side revert requires the frame to land inside the round-trip window, so that variant
  is **SUSPECTED**.

---

### [MEDIUM] `!store.send(...)` is used as a "the socket is down" test, which it is not

- **Evidence.** `console/MemoryPanel.tsx:107-110`:

  ```ts
  const sent = store.send({ type: 'rememberFact', fact });
  if (!sent) { store.notify('error', 'the socket is down, so that was not saved'); return; }
  ```

  `store.send` returns `false` **only** when no transport is attached (`app/store.ts:467-474`), and
  `OfficeSocket.send` *queues* commands while the socket is closed (`app/ws.ts:141-155`,
  `MAX_QUEUE = 64`; flushed on open at `:99`). So while the socket is genuinely down the call
  returns `true` and the command is queued — the branch cannot fire for the condition it names. When
  it *does* fire (transport detached, `App.tsx:261`), the message is wrong *and* `store.send` has
  already emitted its own warning notice, so one failure produces two notices.
- **Why it matters.** The panel's stated guarantee — "the socket is down, so that was not saved" —
  is not the guarantee the code provides: a queued write is sent later, and a detached transport
  loses it silently after the form has been cleared. The same pattern appears at `:324-326`.
- **Suggested fix.** Test `store.connected` (or `connection.status`) for the message, and let
  `store.send`'s own notice stand rather than adding a second one.

---

### [LOW] A numeric filter that can hide its own reset control

- **Evidence.** `console/ArtifactsPanel.tsx:113` renders the kind-filter row (including the `all · N`
  reset chip at `:115-117`) only when `kinds.length > 1`, while the filter itself is still applied at
  `:51`. Pick a kind with the scope on "all runs", then switch to "this run" whose artifacts are all
  of a different kind: `kinds.length` becomes 1, the whole row disappears, `visible` is empty, and the
  empty state tells the reader to "pick another kind" (`:139`) — with no kind control left on screen.
- **Suggested fix.** Render the row whenever `kindFilter !== 'all' || kinds.length > 1`, or reset
  `kindFilter` in an effect when it is no longer present in `kinds`.

---

### [LOW] Other dead exports, unread server fields, and unpruned state

- **Evidence.** Repo-wide greps (across `apps/web/src`, `apps/server/src`, `packages/core/src`,
  `scripts/`) find exactly one hit for each of these — their own definition:
  - `console/pages.tsx:185` `CountBadge` — exported, never imported. (`App.tsx:519-529` builds the
    tab badges inline instead.)
  - `console/ui.tsx:99` `StatusPill` — never imported, and it is the only emitter of `pill-${status}`.
    `styles.css:757` defines base `.pill` but **no** `.pill-*` variant rules at all, so the
    component would render uncoloured even if it were used.
  - `app/format.ts:89` `firstLine` — never imported.
  - `app/api.ts:386` `asArray` — never imported, despite its docstring describing it as the
    defensive array reader.
- `styles.css:1352` `.fact-inactive` uses `opacity: .62` on `--text-dim`, compositing to ≈3.55:1
  (below AA) for text whose whole purpose is to be legible-but-historical.
- **Why it matters.** Individually trivial; collectively they are the drift the review asked about.
  `asArray` being unused is mildly interesting because `api.request` already does an unchecked
  `parsed as T` (`api.ts:161`) with no shape validation — the helper that would have made the
  response-shape problem visible exists and is not called.
- **Suggested fix.** Delete or wire up. For `api.request`, validating the top-level shape of the
  responses the panels depend on (arrays especially — `asArray` exists for exactly this) would turn
  a malformed server response from a panel crash into an error state.

**Also confirmed dead or inert (each verified by a repo-wide grep returning only its own
definition, with `apps/web/.verify/` searched explicitly because `grep` skips dot-directories):**
`console/ui.tsx:99` `StatusPill`; `console/pages.tsx:185` `CountBadge`; `app/format.ts:89`
`firstLine`; `app/api.ts:386` `asArray`; `app/StoreContext.tsx:197,209,267` `useEmployeeView`,
`useSelectedEmployeeView`, `useStageTurns` (the last duplicates `RunTranscript.tsx:200-203`
verbatim); `console/markdown.tsx:215` `MarkdownLines`; `office/OfficeCanvas.tsx:113` `SceneSync`;
`console/plugins/format.ts:89` `permissionCopy` (used only internally);
`office/theme.ts:94` `KNOWN_MATERIAL_NAMES` (exported "for the coverage test", which instead
hardcodes its own copy at `apps/web/.verify/smoke.ts:904-913`);
`office/navgrid.ts:53` `NavGrid.regions` (written, never read) and `:102` `navBoundsOf` (exported,
used only internally); `office/anchors.ts` `getSeat`/`getRoom`/`getDesk`/`deskPosition`/`missing`/
`hasServerRoom`/`vendorBayLabel` (see the vendor-bay finding above);
`console/PageSheet.tsx:14-19` `actions`/`closeLabel` props that the only call site
(`App.tsx:406`) never passes, making the `.sheet-actions` branch (`:30-42`) unreachable;
`console/ApprovalCallout.tsx:142-153`'s `'open the runs page'` branch (the only caller always
passes `onOpenAll`, `App.tsx:423`); `styles.css:2892` `--inspector-bottom-inset` (declared, read
nowhere); `index.html:2` `data-theme="dark"` (inert — `styles.css` has no `data-theme` or
`prefers-color-scheme` rules); and `apps/web/.verify/smoke.ts:361-362`, a leftover
`DEV3D_TRACE` diagnostic flag that nothing reads.

**Unread or dead server-side capability.** `TurnRecord.servedBy` and `attemptedRoutes` are
populated by the server and documented as things "the console should be able to say", but no panel
reads them. `Run.plan` (`packages/core/src/run.ts:243-252`) is pushed on every `run.updated` and
persisted, and rendered nowhere. `StageRun.artifactIds` is maintained by the store
(`store.ts:1140-1148`) and never read; the transcript re-derives the same mapping less reliably
from `artifact.stageId` (`RunTranscript.tsx:66-75`), so run-level artifacts with a null `stageId`
never appear inline. `ProviderStatus` drops the registry's `local` flag
(`apps/server/src/llm/registry.ts:38-45` — *"tell an expected downtime from an actionable one"*),
so a local runtime that simply is not started renders as an unreachable provider. `signals.health`
carries no timestamp in `HealthRecordView` (`app/api.ts:96-103` drops it), so a stale uptime
reading reads as fresh.

**Misleading copy and identity-by-name.** `console/SettingsPanel.tsx`'s `KIND_LABEL` and
`MemoryPanel.tsx:31-37`'s `KIND_LABEL` are identity maps (every value equals its key) presented as
translations. `console/SkillsPanel.tsx:174-176` resolves a role by `displayName` and keys the
holder list by that name, while the server enforces uniqueness on `role.id` only — two roles
sharing a name collide on both. `console/plugins/Marketplace.tsx:502` hardcodes
`apiVersion !== '1'` where core exports `PLUGIN_API_VERSION`. `console/Telemetry.tsx:25-29`
duplicates `StatusPopout.tsx:24-28`'s `POSTURE_HINT` **with different wording for the same
setting**, and `:22` re-declares `TIERS` rather than importing `MODEL_TIER_ORDER`.

**Duplicated logic that has already drifted.** The run-status vocabulary and filter predicate exist
in three copies (`RunList.tsx:21-46`, `RunSwitcher.tsx:24-49`, `RunTranscript.tsx:36-50`), and they
already disagree — the transcript's `statusTone` has no `cancelled` case. The approval
`KIND_TONE`/`KIND_HINT` tables are duplicated across `ApprovalsPanel.tsx:20-34` and
`ApprovalCallout.tsx:21-35` and the `risk` hint has drifted. `roundRectPath`, the label plate
drawing and the ring/halo block are duplicated between `office/avatar.ts` and
`office/vendorAvatar.ts`, and the bottom-right `arcTo` argument order differs between them
(`avatar.ts:94` vs `vendorAvatar.ts:74`).

**Two more file-access gaps in the build/verify path** (from the tooling sub-review):
`apps/web/vite.config.ts:12-16` documents an `apps/web/.env.local` fallback for
`DEV3D_SERVER_PORT`, but Vite's `loadEnv` only surfaces `VITE_`-prefixed keys and never writes
non-prefixed ones into `process.env` — so the documented method silently produces a proxy pointed
at nothing; only an exported shell variable works. And `vite.config.ts:37`'s
`server.watch.ignored` globs contain a literal `..`
(`'**/../../apps/server/**'`), which chokidar can never match against an absolute path, so five
lines of configuration and a paragraph of rationale are inert.
`apps/web/.verify/tsconfig.json` has no `extends`, so the harness — the only automated check of
`store.ts` — loses `noUncheckedIndexedAccess`, `noImplicitOverride` and
`noFallthroughCasesInSwitch` from `tsconfig.base.json`, and `apps/web` has no `test` script, so
`pnpm test` and `pnpm typecheck` report green without running it. (The harness itself is real: it
reports **192/192 checks passed** and exits non-zero on failure.)

---

### [LOW] `index.html` and the shell are sound, with one missing meta tag and one layout assumption

- **Evidence.** `index.html` is correct where it matters: `<!doctype html>` (`:1`), `lang="en"`
  (`:2`), `<meta name="viewport">` (`:5`), `name="color-scheme" content="dark"` (`:6`), `<title>`
  (`:15`), and an inline critical-style block for first paint (`:16-25`). `main.tsx:14-17` throws a
  named error if `#root` is missing, and `main.tsx:12` imports the full stylesheet, so there is no
  flash of unstyled content. `data-theme="dark"` on `<html>` (`:2`) is inert — `styles.css` has
  zero occurrences of `data-theme` or `prefers-color-scheme`, and the palette is a single hardcoded
  `:root` (`:13`) — which is harmless but suggests a light theme was once planned.
- **The two real items.** `<meta name="theme-color">` is absent (minor, mobile chrome colour), and
  `.app { height: 100vh }` (`styles.css:147`) is the only viewport-height unit in the app — a grep
  for `dvh|svh|lvh` across `apps/web/src` returns nothing. On mobile Safari/Chrome the browser
  chrome makes `100vh` taller than the visible viewport, and `overflow: hidden` (`:148`) then
  clips the dock. The media queries are all `max-width` (`:4600, :4614, :4666, :4705`) with no
  zoom-aware fallback, and the header's fixed `min-width: 210px` brand (`:166`) plus fixed-basis
  dock fields (`:3712-3719`, 88-168px) cannot reflow at 200% zoom.
- **Suggested fix.** `height: 100dvh` with a `100vh` fallback for older engines; add
  `theme-color`. If this console is desktop-only by intent, say so in the README rather than
  leaving the mobile media query as the only signal.

---

### [INFO] The reconnect path is correct but does more work than it says

- **Evidence.** `ws.ts:93-102` sets `resumed = this.opened` on open and calls
  `onOpen?.(resumed)`; `App.tsx:239-243` answers a resumed open with `store.send({ type: 'resync' })`.
  But the server pushes `hello` to every new connection unconditionally
  (`index.ts:1575-1578`: `push(ws, { type: 'hello', state: runtime.state(), at: Date.now() })`), so
  a reconnect already receives a full snapshot and the `resync` command prompts a **second**
  identical one (`index.ts:780-782`). Both are applied; `handleHello` (`store.ts:770-788`) clears
  streamed text and prunes indexes twice, which is idempotent, so nothing is broken.
- **Why it matters.** Little beyond bandwidth on a reconnect — but `resync` also resets
  `connection.hello`-dependent logic twice and doubles the largest payload on the wire at the
  moment the network just came back. The comment at `App.tsx:240-241` ("ask for the full snapshot
  too so nothing is missed") describes a need the server already satisfies.
- **Suggested fix.** The first `hello` after a reconnect is sufficient; the explicit `resync` is
  only needed for the manual "Resync" button (`App.tsx:600-608`, `StatusPopout.tsx:236`).

---

### [INFO] `bin`/`docs` drift and the verification harness

- `README.md:46` documents `curl -s -X POST localhost:8787/api/submit` as the way to start a run.
  That route does exist — `apps/server/src/index.ts:1455`
  (`if (path === '/api/submit' && req.method === 'POST')`) — so the README is accurate here.
  `package.json:22` defines `test:web` as `node apps/web/.verify/smoke.ts`; that file exists.
- See **Coverage gaps** for what the harness does and does not prove.

---

## Verified healthy

These were checked specifically and found sound; they are recorded so the overall posture is
accurate.

- **Type safety is real.** `tsc -p apps/web/tsconfig.json --noEmit` exits 0 with no diagnostics,
  and a grep for `as any` / `: any` / `@ts-ignore` / `@ts-expect-error` across `apps/web/src`
  returns nothing. The `default:` arm of the store's event switch uses the classic exhaustiveness
  trick (`store.ts:750-755`: `const exhaustive: never = event; void exhaustive;`) so a new
  `ServerEvent` variant cannot be silently unhandled.
- **The store's slice architecture works where it is applied.** `streaming` and `reasoning` are
  separate slices (`store.ts:677-689`, `:413-414`) emitted only on deltas, so `turn.delta` frames
  do not re-render the org chart, approvals or run list — the claim at `store.ts:9-13` holds for
  those slices.
- **Reconnect/backoff is well built.** `ws.ts:45-49` uses exponential backoff capped at 20 s with
  full-ish jitter; the outbound queue is bounded and drops oldest-first (`:153-154`); `onclose`
  nulls `this.socket` before scheduling (`:130-138`); `dispose` detaches every handler before
  closing (`:157-174`); malformed frames are counted and dropped rather than thrown (`:104-122`).
- **Unmount cleanup in the shell and canvas is complete.** `App.tsx:198-201` disconnects the
  `ResizeObserver` and removes the resize listener; `:260-264` detaches the transport and detail
  loader and disposes the socket; `:298-301` cancels the cold-start timer; `:334-338` and `:378-380`
  remove both keydown listeners. `OfficeCanvas.tsx:1303-1309` (and beyond) sets `disposed`, cancels
  the animation frame, disconnects the observer and removes the window and canvas listeners;
  avatars whose employee has left are disposed and deleted (`:1054-1058`).
- **`prefers-reduced-motion` is honoured end to end, not just in CSS.** `hooks.ts:24-37` tracks the
  live media query; `OfficeCanvas.tsx:198` feeds it to `setReducedMotion` (`:1367-1369`), which
  updates the effect-local `reduced` used by both the avatar update (`:1293`, `:1297`) and
  `livelinessEnabled()` (`:286-288`); the canvas toggle is `disabled` and `aria-pressed` reflects
  the composite state (`:1466-1476`). `styles.css:4750-4772` additionally neutralises all
  animation/transition durations and explicitly stops `.spinner`, `.caret` and `.pulse`. The scene
  is deliberately *not* rebuilt when the preference changes (`:1328-1330`).
- **The focus ring is never removed.** The global `:focus-visible` rule (`styles.css:110-114`)
  exists and there is no `outline: none`/`outline: 0` in the sheet. `user-select: none` appears
  only on live drag states (`:3104`, `:3109`), and `pointer-events: none` only on decorative or
  pass-through layers (`:1115`, `:3668`) with the interactive children re-enabling it (`:3683`,
  `:4494`).
- **Optimistic echo reconciliation is carefully reasoned and mostly right.**
  `store.ts:237-281` matches a server copy of a user message against a *pending* echo by content
  and a 120 s window rather than by id, and deliberately keeps the echo's own timestamp so the
  message does not jump; `:569-587` explains, correctly, why `appendDirectMessage` must be an
  append and not a merge. The design is right; only the HTTP fallback is outside it (see the
  `ChatThread` finding above).
- **Memory state is derived, not incremented.** `recountMemory` (`store.ts:172-193`) recomputes the
  counts from the fact list on every change and preserves the server-owned `searchable`/`semantic`
  fields rather than guessing them — the docstring's argument at `:164-171` is sound and the code
  matches it. `memory.created` applies the new fact and its superseded predecessor together
  (`:879-893`), which is the right call for a correction.
- **Plan-page transport handling is the model the rest of the app should follow.**
  `PlanPage.tsx:188-192` checks `store.send()`'s return value and surfaces a real error when the
  command could not be sent, matches replies by `requestId` (`:217-229`), and has a timeout that
  releases the composer and tells the user the reply will not be shown (`:232-239`).
- **Tab indexing is unused where it would be wrong.** Every list that reorders or filters keys on a
  stable id, not an index: `ApprovalsPanel.tsx:95`/`:142` (`approval.id`), `ui.tsx:145`
  (`value`), `QuickJump.tsx:271` (`entry.id`), `ActivityFeed.tsx:133` (`item.id`),
  `PluginPanels.tsx:139` (`` `${record.manifest.id}/${panel.id}` ``), `QuickJump.tsx:264`
  (`group.kind`).
- **`api.request` is defensive where it counts.** Every call is wrapped and returns a result rather
  than throwing (`api.ts:125-173`); non-JSON and empty bodies produce a real error string
  (`:151-160`); an abort is reported as a timeout rather than a generic failure (`:163-168`); and a
  non-OK response surfaces the server's own `error` field in preference to the status line
  (`:139-149`).
- **`QuickJump` is a solid, self-contained search.** Ranking is total and deterministic
  (`QuickJump.tsx:63-70`), results are grouped in a fixed kind order so arrow keys do not reshuffle
  the list (`:156-187`), the cursor is clamped against the flat list (`:190`), and the focused row
  is scrolled into view with `block: 'nearest'` (`:220-223`).
- **No three.js resource leak in the office modules.** A traced disposal audit of every resource the
  factories create comes out clean: `avatar.ts` releases 22/22 geometries, 10/10 materials and 2/2
  `CanvasTexture`s; `vendorAvatar.ts` 9/9, 8/8 and 2/2; `theme.ts`'s per-floor pattern clones are
  released with the floor (`OfficeCanvas.tsx:529`, `:686`) and its two caches are bounded by
  `StylePattern`'s six values. three r171's `Texture.clone()` shares its source and `WebGLTextures`
  reference-counts the GL texture per source and cache key, so disposing one floor's tiled map
  cannot free a sibling floor's — the comment at `theme.ts:307-315` is correct, not hopeful. The one
  omission found is the shadow map (reported above).
- **The office modules allocate nothing per frame.** `avatar.ts:405-595` and
  `vendorAvatar.ts:399-446` contain no `new THREE.Vector3`/`Color`/`Matrix4`; the vendor's scanline
  motion is a texture-offset change and its glow is a lerp on pre-allocated colours. `liveliness.ts`
  reuses one `motion` object per actor and documents that it is handed out live (`:395-397`,
  `:940-971`). The only per-frame allocation in the seven office modules is one array in
  `updateChats` (`liveliness.ts:710`).
- **The pathfinding core is careful.** `navgrid.ts`'s hand-rolled `CellHeap` (`:126-180`) handles the
  single-element pop case before sifting (`:151`); non-finite obstacle coordinates are skipped in
  both `navBoundsOf` (`:108-109`) and the rasteriser (`:226-227`) so one bad box cannot poison the
  extent; degenerate geometry returns `emptyGrid` rather than a zero-size grid (`:204-210`);
  centre-sampling with explicit bounds re-checks (`:232-240`) gives the symmetric inflation the
  comment promises, so doorways are not narrowed; `resolve` picks the nearest free cell per ring by
  Euclidean distance (`:308-327`) rather than the first hit, so snapping has no corner bias, and it
  refuses beyond `snapDistance` (`:328`); corner-cutting is explicitly forbidden (`:409`).
- **The liveliness director's lifetime hygiene is genuinely good.** `actors` is pruned for ids absent
  from the incoming roster (`liveliness.ts:335-341`); a departing member's conversation is detached
  for **both** ends with the partner settled (`:560-575`) and the chat entry spliced out (`:566`);
  there is no `Math.random` anywhere (a seeded `mulberry32`, `:265`); and every division sits behind a
  guard (`advance` returns before `dx / distance`, `:855-877`).
- **`theme.ts`'s pattern bake is deterministic and its caches are bounded.** Pattern noise is integer
  arithmetic, not `Math.random` (`:152-158`), and `dressMaterials` memoises the role lookup per
  distinct `Material` (`:284-301`), which is what makes the dressing pass O(materials) rather than
  O(meshes) — and it matters, because a GLB's materials are shared across every clone.
- **`anchors.ts` is null-safe and NaN-safe.** Zero non-null assertions; every lookup goes through
  `lookup`/`peek` with a real branch (`:164-180`); `seatFacing` guards the degenerate case before
  `Math.atan2` (`:265-266`), as does `vendorBayFacing` (`:294`); and `worldPosition` mints a fresh
  `Vector3` (`:175`) so callers cannot alias a shared vector.
- **`markdown.tsx` never injects HTML.** There is no `dangerouslySetInnerHTML` anywhere in
  `apps/web/src`; the renderer builds React elements only. Its regexes are also backtracking-safe —
  the inline pattern alternates four branches over disjoint character classes and `plainPreview`'s
  fence matcher is lazy — and `renderInline` cannot throw on malformed input, because the link branch
  is only reachable once the regex has matched, so the `indexOf` calls always resolve. (Its missing
  URL scheme check is reported above; that is the one gap.)
- **No native dialogs and no accidental form submits.** A grep for `alert(`/`prompt(`/`confirm(`
  across `apps/web/src` returns nothing — confirmation UX is done in-panel
  (`plugins/PluginList.tsx:354`). The only `<form>` elements are real ones, and every button inside
  them is explicitly `type="button"` or the intended `type="submit"`.
- **No controlled/uncontrolled input hazard.** Every `value=` in the reviewed panels is either
  `… ?? ''` or a value the server guarantees, so React cannot switch an input from uncontrolled to
  controlled mid-life.
- **Numeric parsing is guarded where it was done deliberately.** `PlanPage.tsx:255-261` and
  `SubmitBar.tsx:75-81` both use `parseFloat` plus `Number.isFinite(...) && > 0` before putting a
  budget on the wire, so an empty or non-numeric box omits the field rather than sending `0` or
  `NaN`. `SettingsPanel.tsx:427-431`'s `price()` returns `null` for blank and `NaN` for garbage, and
  the form's own validity check gates its button (`:433-444`). These are the correct patterns — see
  the `softSpendApprovalUsd` finding above for the four fields that do not follow them.
- **`vite.config.ts` proxies exactly what the server serves.** `:28-31` maps `/api` to
  `http://127.0.0.1:8787` and `/ws` to `ws://127.0.0.1:8787` with `ws: true`, matching the server's
  defaults (`apps/server/src/config.ts:457-458`) and its single accepted upgrade path
  (`index.ts:1566`). `strictPort: true` on the documented port 5273; the production `outDir` (`dist`)
  is the same directory the server serves from (`index.ts:808`); the SPA fallback and the traversal
  guard are both correct (`:825-826`). The client derives the same origin at runtime
  (`ws.ts:227`), so dev and production share one code path.
- **The types, the dependencies and the versions all line up.** All four tsconfig projects typecheck
  clean (`core`, `server`, `web`, `.verify`). Every bare import in `apps/web/src` resolves to a
  declared dependency and every declared dependency is used. React-18 idioms only (`createRoot`,
  `useSyncExternalStore`); no React-19 API. three.js usage is r171-correct and contains none of the
  long-removed names (`outputEncoding`, `sRGBEncoding`, `useLegacyLights`, `physicallyCorrectLights`).
  `"three": "^0.171.0"` is a 0.x caret, so it cannot drift to r172.
- **The verification harness is real and passing.** `node apps/web/.verify/smoke.ts` reports
  **192/192 checks passed** and exits non-zero when a check fails; its central `apply()` loop
  deliberately records a reducer throw as a failure rather than swallowing it
  (`smoke.ts:348-355`). CI runs it alongside the harness typecheck (`ci.yml:62`, `:68-69`). Its
  coverage boundary is in **Coverage gaps** below.

---

## Coverage gaps

- **No runtime execution.** Nothing was rendered. Per the environment constraints, `pnpm test` /
  `pnpm typecheck` fail with `spawn EPERM`, no server was started and no browser was driven; tools
  were invoked directly instead. Every finding is a code-reading result. The three **[CRITICAL]**
  findings would be worth confirming against a live socket: a packet capture on `/ws` shows the
  heartbeat arriving as full `office.updated` frames, refreshing a console with a pending approval
  shows the empty callout, and clicking Update on a marketplace plugin reproduces the
  bundle-URL-as-catalog-URL failure.
- **What `.verify/smoke.ts` does not cover.** It *was* executed — it reports 192/192 passed — but its
  imports (`smoke.ts:37-47`) show it exercises only the store reducer and the office modules
  (`store.ts`, `paneGeometry.ts`, `format.ts`, `floors.ts`, `liveliness.ts`, `navgrid.ts`,
  `avatar.ts`, `theme.ts`, `status.ts`). It never imports `app/ws.ts` (so the backoff, the outbound
  queue, the keepalive and `resolveSocketUrl` are untested), never imports `app/api.ts`, and never
  imports any component under `console/**` or `app/*.tsx` — there is no jsdom, no testing library and
  no render test anywhere in `apps/web`. The WebSocket client and the whole React tree are covered by
  nothing. Its material-coverage check also hardcodes its own copy of the GLB material list
  (`smoke.ts:904-913`) rather than importing `KNOWN_MATERIAL_NAMES`, so it can detect a *listed*
  material failing to map but not a *new* material appearing.
- **One harness assertion is near-tautological.** `smoke.ts:1308-1311` checks the avatar's null-motion
  path with `return avatarBody?.position.y !== undefined;` — `Vector3.y` can never be `undefined`, so
  the assertion effectively proves only that the `Body` node still exists.
- **`public/office/office.glb`, `blocks.glb` and `blocks.json` were not rendered or parsed.** They
  are the floor model, the growable module kit, and the kit's anchor/seat manifest. Whether the GLB's
  node names match what `anchors.ts` looks for, and whether `blocks.json`'s schema matches what the
  loader expects, could not be checked without running three.js. (The client never parses
  `blocks.json` — it arrives typed over the wire as `FloorLayout`; the parsing lives in
  `apps/server/src/office/kit.ts`, which validates and try/catches it.)
- **GLB-level three.js resource accounting is unverified.** Per-object geometry/material/texture
  disposal on unmount, and whether the loader leaves anything orphaned, needs a WebGL context and a
  memory profile. Static reading can show that `dispose()` is called (it is — `OfficeCanvas.tsx:1319`)
  but not that it is sufficient. There is no `AnimationMixer`, `SkinnedMesh`, `Skeleton` or
  `TextureLoader` anywhere in `apps/web/src` (all textures are procedural), so the usual mixer/skeleton
  and texture-rejection concerns do not apply.
- **The `blocks.glb` load-order race is a static conclusion.** That `office.glb` (281,904 bytes) is
  likelier than `blocks.glb` (448,148 bytes) to resolve first is an inference from file sizes and the
  fact that both loads start on the same tick; the visible symptom needs a browser and a network
  throttle to confirm.
- **No accessibility testing with assistive technology**, no contrast measurement in a browser
  beyond the computed ratios for `--text-mute`, no 200%-zoom or mobile-viewport check, and no
  keyboard-only walkthrough. The focus-clipping, mouse-only-resize, combobox-ARIA and
  `role="alert"`-churn findings are static deductions from the CSS and JSX, not observed failures.
- **Server-side behaviour was read, not exercised.** The protocol mismatches reported here are
  derived from reading `apps/server/src/index.ts`, `server/runtime.ts`, `llm/registry.ts` and
  `plugins/host.ts`; the server has its own test suite (`apps/server/src/**/*.test.ts`, ~40 files)
  which was **not** run.
- **The two `plugins.test.ts` cross-references in the marketplace-update finding were read, not run** —
  they are cited as evidence of the intended calling convention, not as a passing test run.
- **File sizes for the two GLBs were read from disk**; the assets themselves were not opened.
- **Delegated review.** The `styles.css`, `console/plugins/**`, `.verify`/config, `OfficeCanvas.tsx`,
  `office/*.ts` and large-panel findings in this report came from scoped read-only reviews whose
  claims were spot-checked against the source before inclusion. The claims read directly while
  writing this document are the protocol/store findings (`ping`, approvals, `selectRun`/`loadRun`,
  `handleEmployeeMoved`, `usePanelRead`), the `ws.ts`/`hooks.ts`/`App.tsx` findings, the office
  module findings I cited line by line (`kitReady`, `motion.yaw`, paint/disposal, `modelsFor`), and
  the CSS findings verified by grep (`--radius-md`, `--text-mute` sites, `.status-*`, duplicate
  selectors). Claims marked **[SUSPECTED]** should be treated as one notch less certain.

---

