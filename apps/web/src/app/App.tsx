/**
 * The dev3d office console.
 *
 * The 3D office *is* the application: it fills the stage, and everything else
 * floats over it.
 *
 *   - top bar      brand, the tabbed pages, live status, popout toggles
 *   - stage        the office canvas, always mounted, never re-created
 *   - page sheet   the selected tab's content, over the office (Esc closes)
 *   - popouts      base information on the left, the inspector on the right
 *   - dock         the brief composer, pinned to the bottom
 *   - callout      approvals, which stop the office dead
 *
 * This file owns the connection lifecycle for the whole app:
 *
 *   - one `OfficeSocket` for the session, feeding `ServerEvent`s into the store,
 *   - `resync` after a reconnect, because the server sends a fresh `hello` and
 *     the store replaces state wholesale,
 *   - a 3 s `/api/state` cold-start fallback so the console is never blank while
 *     the socket is still coming up,
 *   - `/api/skills` and `/api/health` for the catalogue and a real connectivity
 *     warning.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { Artifact, ClientCommand, Run, TurnRecord } from '@dev3d/core';

import { OfficeCanvas } from '../office/OfficeCanvas';
import type { AnchorDiscovery } from '../office/OfficeCanvas';
import { ApprovalCallout } from '../console/ApprovalCallout';
import { PluginPanels } from '../console/plugins/PluginPanels';
import { FloorSelector } from '../console/FloorSelector';
import { InspectorPopout } from '../console/InspectorPopout';
import type { InspectorTab } from '../console/InspectorPopout';
import { PageSheet } from '../console/PageSheet';
import { PlanPage } from '../console/PlanPage';
import { StatusPopout } from '../console/StatusPopout';
import { ActivityPage, OpsPage, OrgPage, PluginsPage, ProjectsPage, RunsPage, SettingsPage, SkillsPage } from '../console/pages';
import { SubmitBar } from '../console/SubmitBar';
import { Badge, Tabs } from '../console/ui';
import { api } from './api';
import { formatUsd } from './format';
import { useMediaQuery, usePaneResize, useStoredNumber, useStoredState } from './hooks';
import { MIN_INSPECTOR_HEIGHT } from './paneGeometry';
import {
  StoreProvider,
  useApprovals,
  useConnection,
  useNotices,
  useOffice,
  useSelection,
  useStore,
} from './StoreContext';
import { OfficeStore } from './store';
import { OfficeSocket, resolveSocketUrl } from './ws';

type PrimaryTab =
  | 'office'
  | 'plan'
  | 'projects'
  | 'org'
  | 'runs'
  | 'activity'
  | 'ops'
  | 'skills'
  | 'plugins'
  | 'settings';

const PRIMARY_TABS: ReadonlyArray<{ id: PrimaryTab; label: string }> = [
  { id: 'office', label: 'Office' },
  { id: 'plan', label: 'Plan' },
  { id: 'projects', label: 'Projects' },
  { id: 'org', label: 'Org' },
  { id: 'runs', label: 'Runs' },
  { id: 'activity', label: 'Activity' },
  { id: 'ops', label: 'Routing & cost' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'settings', label: 'Settings' },
];

const SHEET_COPY: Record<Exclude<PrimaryTab, 'office'>, { title: string; subtitle: string }> = {
  plan: {
    title: 'Plan',
    subtitle: 'mull an idea over with the office and turn it into a brief — nothing is commissioned until you submit it',
  },
  projects: {
    title: 'Projects',
    subtitle: 'the offices in this building — each floor is an independent organisation with its own people',
  },
  org: { title: 'Organisation', subtitle: 'who exists, what they own, and where they sit in the office' },
  runs: { title: 'Work', subtitle: 'approvals, runs, the transcript of each run, and the artifacts it left behind' },
  activity: { title: 'Activity', subtitle: 'every event the orchestrator has pushed, newest first' },
  ops: { title: 'Routing & cost', subtitle: 'models, prices, providers and what each employee has spent' },
  skills: { title: 'Skills', subtitle: 'the capability catalogue employees draw on per turn' },
  plugins: {
    title: 'Plugins',
    subtitle: 'what extends this office — installed plugins, their permissions and settings, and where else they can come from',
  },
  settings: {
    title: 'Settings',
    subtitle: 'installation-wide configuration, and the skills and budget of the floor you are on',
  },
};

export function App() {
  const [store] = useState(() => new OfficeStore());
  return (
    <StoreProvider store={store}>
      <Console />
    </StoreProvider>
  );
}

function Console() {
  const store = useStore();
  const selection = useSelection();
  const [seatIds, setSeatIds] = useState<string[]>([]);

  const [storedTab, setStoredTab] = useStoredState('dev3d.tab', 'office');
  const tab: PrimaryTab = useMemo(
    () => (PRIMARY_TABS.some((candidate) => candidate.id === storedTab) ? (storedTab as PrimaryTab) : 'office'),
    [storedTab],
  );
  const setTab = useCallback((next: PrimaryTab) => setStoredTab(next), [setStoredTab]);

  // Popouts start open only when there is room for them beside the office.
  const wide = useMediaQuery('(min-width: 1500px)');
  const [leftOpen, setLeftOpen] = useState(wide);
  const [rightOpen, setRightOpen] = useState(wide);
  const [inspector, setInspector] = useState<InspectorTab>('agent');
  const [jumping, setJumping] = useState(false);

  // ------------------------------------------------- inspector geometry
  //
  // The inspector is the surface you actually work in, so it is the one pane
  // that is resizable and remembers its size. Width is a stored preference, in
  // px, bounded to what is still a floating pane rather than a takeover.
  const [inspectorWidth, setInspectorWidth] = useStoredNumber('dev3d.inspectorWidth', 420, 320, 900);
  const [inspectorHeight, setInspectorHeight] = useStoredNumber('dev3d.inspectorHeight', 0, 0, 2400);

  /** The composer inside the dock wrapper - what the pane's ceiling is based on. */
  const dockInnerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [dockHeight, setDockHeight] = useState(0);

  const sheetOpen = tab !== 'office';
  // A sheet needs the room, so the base-information popout stands down while one
  // is open; the inspector stays, because it is the context for what you clicked
  // - except on Plan, which is a whole workspace in its own right and already
  // names its project, pipeline and ceiling, so the inspector would only crowd it.
  const leftVisible = leftOpen && !sheetOpen;
  const inspectorVisible = rightOpen && tab !== 'plan';

  /**
   * Measure the one thing CSS cannot: how tall the composer turned out to be.
   *
   * The observer watches the composer itself, not the dock's stage-level
   * wrapper. The wrapper is positioned between the stage's left inset and the
   * inspector's right inset, so its width follows the pane - and feeding a width
   * that follows the pane back into the pane's height is the loop that made the
   * two overlap at every window size. The composer's own layout does not depend
   * on the pane, so this converges.
   */
  useLayoutEffect(() => {
    const inner = dockInnerRef.current;
    const stage = stageRef.current;
    if (typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      if (inner) setDockHeight(inner.getBoundingClientRect().height);
    };
    measure();

    const observer = new ResizeObserver(measure);
    if (inner) observer.observe(inner);
    // The header reflows on resize, which moves the stage - and therefore the
    // room the pane has - even when the composer itself does not change.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [inspectorVisible]);

  /**
   * An upper bound for the bottom-edge drag, which works in pixels and so needs
   * some ceiling. The pane's *default* height is computed in CSS, not here.
   */
  const maxInspectorHeight = useMemo(() => {
    if (typeof window === 'undefined') return 900;
    return Math.max(MIN_INSPECTOR_HEIGHT, window.innerHeight - dockHeight - 48);
  }, [dockHeight]);

  // Grow to whatever room is going, without writing that to storage: the pane
  // should not remember a size it only had because the window was tall.
  const widthResize = usePaneResize({
    invert: true,
    min: 320,
    max: 900,
    size: inspectorWidth,
    onChange: setInspectorWidth,
  });

  const heightResize = usePaneResize({
    axis: 'y',
    invert: false,
    min: MIN_INSPECTOR_HEIGHT,
    max: maxInspectorHeight,
    size: inspectorHeight > 0 ? inspectorHeight : maxInspectorHeight,
    onChange: setInspectorHeight,
    onCommit: (next) => setInspectorHeight(Math.min(next, maxInspectorHeight)),
  });

  // ------------------------------------------------------- connection lifecycle
  useEffect(() => {
    const socket = new OfficeSocket({
      url: resolveSocketUrl(),
      onEvent: (event) => store.apply(event),
      onStatus: (update) => store.setConnectionStatus(update.status, update.attempt, update.error, update.at),
      onOpen: (resumed) => {
        // The server answers a reconnect with a fresh hello; ask for the full
        // snapshot too so nothing is missed while the socket was down.
        if (resumed) store.send({ type: 'resync' });
      },
      onProtocolError: (message) => store.notify('warn', message),
    });

    store.attachTransport((command: ClientCommand) => socket.send(command));
    store.attachDetailLoader(async (runId: string) => {
      const result = await api.run(runId);
      if (!result.ok || !result.data) return null;
      const { turns, artifacts, ...run } = result.data;
      const payload: { run: Run; turns?: TurnRecord[]; artifacts?: Artifact[] } = { run };
      if (turns) payload.turns = turns;
      if (artifacts) payload.artifacts = artifacts;
      return payload;
    });

    socket.connect();

    return () => {
      store.attachTransport(null);
      store.attachDetailLoader(null);
      socket.dispose();
    };
  }, [store]);

  // ------------------------------------------- cold start, skills and health
  useEffect(() => {
    let cancelled = false;

    store.setSkillsLoading();
    void api.skills().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) store.setSkills(result.data);
      else store.setSkillsError(result.error ?? 'unknown error');
    });

    void api.health().then((result) => {
      if (cancelled || result.ok) return;
      // Name the origin this console is actually served from rather than a
      // development default: the office is same-origin by design, so if the
      // page loaded at all, this is the host that should be answering.
      const origin = typeof window === 'undefined' ? 'the orchestrator' : window.location.host;
      store.notify(
        'warn',
        `orchestrator not reachable at /api/health (${result.error ?? 'unknown error'}) — is it listening on ${origin}?`,
      );
    });

    const timer = window.setTimeout(() => {
      if (cancelled || store.hasHello()) return;
      void api.state().then((result) => {
        if (cancelled || !result.ok || !result.data) return;
        store.applyColdState(result.data, 'loaded the office from /api/state — the websocket has not sent hello yet');
      });
    }, 3000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [store]);

  // Selecting something should show it. An avatar opens the agent view, a run
  // opens the run view, and either way the inspector comes forward.
  useEffect(() => {
    if (selection.employeeId !== null || selection.runId !== null) setRightOpen(true);
  }, [selection.employeeId, selection.runId]);

  const previous = useRef<{ employeeId: string | null; runId: string | null }>({
    employeeId: selection.employeeId,
    runId: selection.runId,
  });
  useEffect(() => {
    const employeeChanged = selection.employeeId !== previous.current.employeeId;
    const runChanged = selection.runId !== previous.current.runId;
    previous.current = { employeeId: selection.employeeId, runId: selection.runId };
    if (employeeChanged && selection.employeeId !== null) setInspector('agent');
    // A run wins if both moved in the same render: selecting a run is the more
    // specific intent, and it is the load the user is waiting to watch.
    if (runChanged && selection.runId !== null) setInspector('run');
  }, [selection.employeeId, selection.runId]);

  // Escape returns to the office from any page.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTab('office');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sheetOpen, setTab]);

  const handleAnchors = useCallback((discovery: AnchorDiscovery) => {
    setSeatIds(discovery.seats);
  }, []);

  /**
   * The pane is anchored by `top` and a height, and the height is expressed in
   * CSS against the stage and the dock (see `--dock-height`). Nothing here feeds
   * the pane's own size back into the dock's width, because that loop is what
   * made the two overlap at every window size.
   *
   * What is published is the one measurement CSS cannot take: how tall the
   * composer turned out to be.
   */
  const stageStyle = {
    '--inset-left': leftVisible ? 'var(--popout-width)' : '0px',
    // A wide inspector should not squeeze the dock once it is closed.
    '--inset-right': inspectorVisible ? `${inspectorWidth}px` : '0px',
    '--inspector-width': `${inspectorWidth}px`,
    '--dock-height': `${Math.round(dockHeight)}px`,
    // Only set once the reader has actually dragged the bottom edge; until then
    // the pane is as tall as the room allows.
    ...(inspectorHeight > 0 ? { '--inspector-height': `${Math.round(inspectorHeight)}px` } : {}),
  } as CSSProperties;

  const resetInspectorSize = useCallback(() => {
    setInspectorWidth(420);
    setInspectorHeight(0);
  }, [setInspectorHeight, setInspectorWidth]);

  // Ctrl/Cmd-K is the console's one global shortcut: jump to anything.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setRightOpen(true);
        setJumping((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const copy = sheetOpen ? SHEET_COPY[tab as Exclude<PrimaryTab, 'office'>] : null;

  return (
    <div className="app app-stage">
      <TopBar
        tab={tab}
        onTab={setTab}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onToggleLeft={() => setLeftOpen((open) => !open)}
        onToggleRight={() => setRightOpen((open) => !open)}
        onQuickJump={() => {
          setRightOpen(true);
          setJumping(true);
        }}
      />
      <NoticeBar />

      <main className="stage" style={stageStyle} ref={stageRef}>
        <div className="stage-canvas">
          <OfficeCanvas onAnchorsDiscovered={handleAnchors} />
        </div>

        {copy && (
          <PageSheet title={copy.title} subtitle={copy.subtitle} onClose={() => setTab('office')}>
            {tab === 'plan' && <PlanPage />}
            {tab === 'projects' && <ProjectsPage />}
            {tab === 'org' && <OrgPage seatIds={seatIds} />}
            {tab === 'runs' && <RunsPage />}
            {tab === 'activity' && <ActivityPage />}
            {tab === 'ops' && <OpsPage />}
            {tab === 'skills' && <SkillsPage />}
            {tab === 'plugins' && <PluginsPage />}
            {tab === 'settings' && <SettingsPage />}
          </PageSheet>
        )}

        {leftVisible && <StatusPopout onClose={() => setLeftOpen(false)} />}

        <ApprovalCallout onOpenAll={() => setTab('runs')} />

        {/* A plugin's office-overlay panel, if any plugin claimed that placement.
            It sits over the 3D view but never over the dock or an approval. */}
        <PluginPanels placement="office-overlay" className="plugin-panels-overlay" />

        <div className="stage-dock">
          <div ref={dockInnerRef} className="dock-measure">
            <SubmitBar />
          </div>
        </div>

        {/* Last in the column, so the dock can never paint over the pane you are
            working in. */}
        {rightOpen && inspectorVisible && (
          <InspectorPopout
            tab={inspector}
            onTab={setInspector}
            onClose={() => setRightOpen(false)}
            onJump={() => setJumping(true)}
            jumping={jumping}
            onJumpingChange={setJumping}
            widthResize={widthResize}
            heightResize={heightResize}
            onResetSize={resetInspectorSize}
            resizing={inspectorHeight > 0}
          />
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------- header

function TopBar({
  tab,
  onTab,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onQuickJump,
}: {
  tab: PrimaryTab;
  onTab: (tab: PrimaryTab) => void;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onQuickJump: () => void;
}) {
  const store = useStore();
  const office = useOffice();
  const connection = useConnection();
  const approvals = useApprovals();

  const connectionBadge = useMemo(() => {
    switch (connection.status) {
      case 'open':
        return { tone: 'ok' as const, label: 'connected' };
      case 'connecting':
        return { tone: 'info' as const, label: 'connecting' };
      case 'reconnecting':
        return { tone: 'warn' as const, label: `reconnecting${connection.attempt > 1 ? ` (${connection.attempt})` : ''}` };
      case 'closed':
        return { tone: 'danger' as const, label: 'disconnected' };
      case 'idle':
      default:
        return { tone: 'neutral' as const, label: 'idle' };
    }
  }, [connection.attempt, connection.status]);

  const activeRuns = office?.activeRunIds.length ?? 0;
  const pending = approvals.filter((approval) => approval.status === 'pending').length;
  const spend = useMemo(() => {
    let total = 0;
    for (const run of office?.runs ?? []) total += run.budget.spentUsd;
    return total;
  }, [office?.runs]);

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-name">dev3d office</div>
          <div className="brand-sub dim small">
            {office ? `${office.company.name} · ${office.roles.length} employees` : 'waiting for the orchestrator'}
          </div>
        </div>
      </div>

      <FloorSelector />

      <nav className="app-nav" aria-label="Sections">
        <Tabs<PrimaryTab>
          items={PRIMARY_TABS.map((entry) => ({
            id: entry.id,
            label: entry.label,
            ...(entry.id === 'runs' && (pending > 0 || activeRuns > 0)
              ? { badge: pending > 0 ? pending : activeRuns, tone: pending > 0 ? ('danger' as const) : ('warn' as const) }
              : {}),
          }))}
          active={tab}
          onChange={onTab}
        />
      </nav>

      <div className="header-status">
        <Badge tone={connectionBadge.tone} title={connection.error ?? undefined}>
          <span
            className={connection.status === 'open' ? 'dot pulse' : 'dot'}
            style={{ background: 'currentColor' }}
            aria-hidden="true"
          />
          {connectionBadge.label}
        </Badge>
        {office && (
          <>
            <Badge
              tone={
                office.llmMode !== 'mock'
                  ? 'ok'
                  : typeof office.configStale === 'string' && office.configStale !== ''
                    ? 'danger'
                    : 'warn'
              }
              // The reason, not a restatement of the mode. The top bar is the
              // badge people actually stare at, so a bare "mock" here is exactly
              // what made a stale process look like a configuration bug.
              title={office.llmModeReason ?? `llm: ${office.llmMode}`}
            >
              {office.llmMode}
            </Badge>
            {/*
              Always visible, because the mode badge alone cannot say "the
              environment changed after this process started, so restart it".
              Without this the natural conclusion is that the mode logic is
              broken, which is exactly what it looked like.
            */}
            {typeof office.configStale === 'string' && office.configStale !== '' && (
              <Badge tone="danger" title={office.configStale}>
                restart needed
              </Badge>
            )}
            <span className="dim small mono header-spend" title="active runs · total runs · spend this session">
              {activeRuns} active · {formatUsd(spend)}
            </span>
          </>
        )}

        <div className="header-toggles" role="group" aria-label="Panels">
          <button type="button" className="btn btn-sm btn-ghost header-jump" onClick={onQuickJump} title="Jump to an employee, run or artifact (⌘/ctrl + K)">
            Jump
            <span className="kbd-hint" aria-hidden="true">⌘K</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${leftOpen ? 'btn-toggle-on' : 'btn-ghost'}`}
            aria-pressed={leftOpen}
            onClick={onToggleLeft}
            title="Office information"
          >
            Info
          </button>
          <button
            type="button"
            className={`btn btn-sm ${rightOpen ? 'btn-toggle-on' : 'btn-ghost'}`}
            aria-pressed={rightOpen}
            onClick={onToggleRight}
            title="Inspector"
          >
            Inspector
          </button>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => store.send({ type: 'resync' })}
          disabled={!store.connected}
          title="Ask the orchestrator for a fresh snapshot"
        >
          Resync
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------- notices

function NoticeBar() {
  const store = useStore();
  const notices = useNotices();

  if (notices.length === 0) return null;

  return (
    <div className="notice-bar" role="status">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.level}`}>
          <span className="notice-text">{notice.text}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => store.dismissNotice(notice.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
