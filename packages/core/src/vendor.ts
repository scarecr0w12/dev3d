/**
 * Third-party vendors.
 *
 * A **vendor** is an external agent harness - Codex, DeepSeek Harness, OpenClaw,
 * Hermes - that this office has engaged to do a piece of work. It is not a
 * `Role`, and it is deliberately not dressed up as one.
 *
 * ## Why this is its own type rather than an `EmployeeState`
 *
 * The tempting shortcut is to give a vendor an `EmployeeState` and a `roleId`,
 * because every surface in the console already reads `office.employees` and the
 * 3D view would place it for free. It was rejected, and the reason is worth
 * writing down: an `EmployeeState` is *staff*. Routing a vendor through that
 * list would put it in the headcount, the spend leaderboard, the org chart, the
 * quick-jump index, the approval `nameOf` maps and `PlanPage`'s search for the
 * CEO. Every one of those is a place where "a machine somebody else operates"
 * would read as "somebody who works here".
 *
 * So a vendor is a second, parallel list with its own status vocabulary, its own
 * console panel, and its own place in the 3D office. The cost is that the
 * surfaces which should know about vendors must be told about them; the benefit
 * is that the surfaces which should not cannot accidentally find them.
 *
 * ## What a vendor can be trusted with
 *
 * Nothing here is confined the way a built-in tool is. A built-in tool and an
 * MCP tool both receive a `ToolContext` whose every path goes through
 * `resolveInWorkspace`, so the office can *prove* what they touched. A vendor is
 * a process with its own sandbox: it writes with its own hands, and the office
 * can only ask it not to.
 *
 * `VendorCapabilities.enforcesReadOnly` is the field that says which of those
 * two worlds an operator is in. It is not a detail - it is the difference
 * between a guarantee and a request - so it travels with the vendor rather than
 * being assumed, and the console is expected to say so.
 */

/**
 * What a vendor is doing, from the office's point of view.
 *
 * Deliberately **not** `EmployeeStatus`. Those seven words describe a person at
 * a desk - thinking, talking, on a break - and none of them is true of a machine
 * that is either plugged in or not. Reusing the union would also have made
 * `Record<EmployeeStatus, …>` (the label, colour and style tables in
 * `apps/web/src/app/status.ts`) silently indexable with a foreign key, which is
 * exactly the class of mistake a total map exists to prevent.
 *
 * Coarse on purpose, like `McpServerStatus.state`: the question an operator asks
 * is "is it working, and if not why", and `detail` carries the why.
 */
export type VendorStatus =
  /** Configured but switched off by the operator. A choice, not a fault. */
  | 'offsite'
  /** Enabled, but its command could not be run. A fault, not a choice. */
  | 'unreachable'
  /** On site and available; nothing in flight. */
  | 'docked'
  /** A delegation is running right now. */
  | 'engaged'
  /** Its last delegation failed. */
  | 'errored';

/**
 * How much of "read-only" is actually enforced, and by whom.
 *
 * Not a boolean, and the reason is that the three answers are genuinely
 * different guarantees rather than points on a scale:
 *
 *  - **`sandbox`** — the harness confines *itself*, with an OS-level sandbox the
 *    office asked for. `codex exec -s read-only` is the example. This is the
 *    strongest claim available, because it holds for everything the process
 *    does, not just the paths the office mediates.
 *  - **`client`** — **dev3d** enforces it over the Agent Client Protocol: write
 *    access is not advertised and is refused if attempted, reads are confined to
 *    the run's workspace, and every tool call the agent reports is put to a human
 *    before it proceeds. Strong over the protocol path, and it is the office's
 *    own code doing the refusing rather than the vendor's promise — but the agent
 *    is still a local process, so this constrains what it can do *through dev3d*,
 *    not what it can do to the machine.
 *  - **`requested`** — the task text asks the harness to stay read-only and
 *    nothing enforces it. DSH and Hermes expose no sandbox flag and speak no
 *    protocol the office can mediate.
 *
 * Collapsing these into "enforced / not enforced" would either overstate the
 * middle case or understate it, and an operator reading a badge is entitled to
 * the real answer. It is also load-bearing rather than descriptive: `requested`
 * is the only level the office cannot bound at all, so it is the one that asks a
 * human to approve the delegation up front.
 */
export type ReadOnlyEnforcement = 'sandbox' | 'client' | 'requested';

/**
 * What the office knows it can expect from a vendor.
 *
 * Every field here is something dev3d has *decided*, not something it detected
 * by asking the vendor - these harnesses have no capability handshake worth the
 * name, and inventing one would be a lie told in a type. They are declared per
 * vendor in `vendors.json`, and the console reports them as a declaration.
 */
export interface VendorCapabilities {
  /**
   * How read-only is enforced. See {@link ReadOnlyEnforcement}.
   *
   * This replaces what would otherwise be an always-true `readOnly: boolean`:
   * every vendor in this release is only ever *sent* read-only work, so that flag
   * would have carried no information at all. What varies - and what an operator
   * actually needs - is who makes it true.
   */
  readOnlyEnforcement: ReadOnlyEnforcement;
  /**
   * Whether it reports which files it touched.
   *
   * `affectsPaths` is how a tool's writes become visible: it flows to
   * `turn.wroteFiles` and from there to `knowledge.filesWritten`, which is what
   * decides who revises work in a review loop. A vendor that does not report
   * files leaves the run blind to what it did, and saying so is better than
   * reporting an empty list as though it were an answer.
   */
  reportsFiles: boolean;
  /** Emits progress rather than answering once. */
  streams: boolean;
  /**
   * Reports a cost the office can observe.
   *
   * Almost always false. A vendor on a Codex, Hermes or DSH subscription bills
   * nothing dev3d can see, which means the run's spend ceiling cannot bound it
   * and any figure shown for it would be notional. `docs/external-agents.md` §5.1
   * covers why the real control is a wall-clock timeout instead.
   */
  reportsCost: boolean;
}

/** One configured vendor, as the console and the 3D office see it. */
export interface VendorState {
  /** Stable slug. Also the middle segment of its tool name. */
  id: string;
  /** What the office calls it, e.g. 'Codex'. */
  label: string;
  /** Who operates it, e.g. 'OpenAI'. Shown so "whose machine is this" is never a guess. */
  operator: string;
  status: VendorStatus;
  /**
   * The command line the office would run, for display.
   *
   * Carried so an operator can see exactly what the office intends to execute
   * without reading a config file. It is never sent back to the server - the
   * server owns the config, and a console that could name a command would be a
   * console that could run one.
   */
  command: string;
  /** Why it is not available, when it is not. */
  detail: string | null;
  capabilities: VendorCapabilities;
  /**
   * Delegations this vendor has completed for the office, lifetime.
   *
   * A count rather than a log: the engagements themselves are already visible
   * as tool calls on the runs that made them, and duplicating them here would
   * create a second record that could disagree with the first.
   */
  engagements: number;
  /** What it is doing right now, while engaged. */
  activity: string | null;
  /** Its last failure, cleared by the next success. */
  lastError: string | null;
  /**
   * How to authenticate it, when it owns its own auth.
   *
   * These harnesses bill and authenticate themselves - a dev3d key does nothing
   * for `codex login` - so the honest thing is to say how, rather than let an
   * operator conclude the integration is broken.
   */
  authNote: string | null;
  /**
   * This vendor's own colour, for its terminal and its console row.
   *
   * Optional because most vendors do not have one and a deterministic default is
   * better than a required field nobody fills in. Present so a fork can brand
   * the ones it cares about.
   */
  color?: string;
}

/**
 * Every vendor this office is configured with.
 *
 * A wrapper rather than a bare array, mirroring `McpState`, because the console
 * needs the *policy* alongside the list: which roles may hand work over, whether
 * the feature is on at all, and which file the answer came from. A bare
 * `VendorState[]` would make "no vendors configured" and "vendors exist but
 * nobody may use them" the same thing on screen.
 */
export interface VendorBay {
  /** Whether vendor delegation is enabled at all. */
  enabled: boolean;
  /** The config file that was read, when one was. */
  configPath: string | null;
  /** Role ids that may hand work to a vendor. `['*']` means every role. */
  grantRoles: string[];
  /**
   * Whether `Role.canDelegate` is also required.
   *
   * On by default, because `canDelegate` already exists on the org chart and
   * already means "this person may put work on somebody else". Reading it is
   * what finally gives that field an effect; ignoring it would leave an operator
   * with a control that looks like it does something and does not, which is the
   * defect `docs/design-notes.md` describes for `maxTurnsPerStage` before it was
   * wired up.
   */
  requireCanDelegate: boolean;
  vendors: VendorState[];
}

/** The status words that mean "the office could hand this vendor work now". */
export const VENDOR_AVAILABLE_STATUSES: readonly VendorStatus[] = ['docked'];

/** True when a vendor is on site and idle, i.e. can be handed a job. */
export function isVendorAvailable(vendor: VendorState): boolean {
  return vendor.status === 'docked';
}
