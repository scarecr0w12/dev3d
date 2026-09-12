/**
 * Base information about the office, as a floating popout over the stage.
 *
 * The 3D view is the centrepiece now, so everything that is *about* the office
 * rather than *in* it lives here: the company and its mission, the routing
 * posture and the model providers behind it, headcount by status, spend, and
 * whatever is currently in flight. The 3D viewport's own HUD still shows the
 * selected employee and the status legend on the canvas; this is the wider
 * picture an operator wants open while watching the office work.
 */

import { useMemo } from 'react';

import type { RoutingPosture } from '@dev3d/core';

import { formatAgo, formatInt, formatUsd } from '../app/format';
import { useNow } from '../app/hooks';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../app/status';
import { useApprovals, useConnection, useOffice, useStore } from '../app/StoreContext';
import { Badge, Metric, cx } from './ui';

const POSTURES: readonly RoutingPosture[] = ['cheap', 'balanced', 'quality'];

const POSTURE_HINT: Record<RoutingPosture, string> = {
  cheap: 'always take the cheapest model that can do the job',
  balanced: 'honour each role\u2019s policy, escalate when the work is hard',
  quality: 'bias every turn one tier up',
};

export function StatusPopout({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const office = useOffice();
  const connection = useConnection();
  const approvals = useApprovals();
  const now = useNow(1000);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const employee of office?.employees ?? []) {
      counts.set(employee.status, (counts.get(employee.status) ?? 0) + 1);
    }
    return counts;
  }, [office?.employees]);

  const spend = useMemo(() => {
    let total = 0;
    for (const run of office?.runs ?? []) total += run.budget.spentUsd;
    return total;
  }, [office?.runs]);

  const activeRuns = useMemo(() => {
    if (!office) return [];
    const live = new Set(office.activeRunIds);
    return office.runs.filter((run) => live.has(run.id));
  }, [office]);

  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending').length;
  const activePath =
    office?.workspaces.find((workspace) => workspace.id === office.activeWorkspaceId)?.path ?? '';

  return (
    <aside className="popout popout-left" aria-label="Office information">
      <header className="popout-head">
        <div className="popout-heading">
          <div className="popout-title">The office</div>
          <div className="popout-sub">{office ? office.company.name : 'waiting for the orchestrator'}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Hide office information">
          ✕
        </button>
      </header>

      <div className="popout-body">
        {!office ? (
          <div className="state state-loading" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            <span>Waiting for office state…</span>
          </div>
        ) : (
          <>
            <p className="popout-mission">{office.company.mission}</p>

            <div className="metrics-grid">
              <Metric label="Employees" value={formatInt(office.roles.length)} />
              <Metric label="Departments" value={formatInt(office.departments.length)} />
              <Metric label="Active runs" value={formatInt(office.activeRunIds.length)} />
              <Metric label="Spend" value={formatUsd(spend)} />
            </div>

            <section className="popout-section">
              <div className="popout-section-title">
                Posture
                <Badge
                  tone={
                    office.llmMode !== 'mock'
                      ? 'ok'
                      : typeof office.configStale === 'string' && office.configStale !== ''
                        ? 'danger'
                        : 'warn'
                  }
                  // The reason, not a restatement of the mode. "mock" without a
                  // why reads the same whether no key was found, an operator
                  // forced it, or the process predates the key being added.
                  title={office.llmModeReason ?? `llm: ${office.llmMode}`}
                >
                  llm: {office.llmMode}
                </Badge>
              </div>
              {typeof office.configStale === 'string' && office.configStale !== '' && (
                <div className="alert alert-warn small" role="status">
                  {office.configStale}
                </div>
              )}
              <div className="segmented" role="group" aria-label="Global routing posture">
                {POSTURES.map((posture) => (
                  <button
                    key={posture}
                    type="button"
                    className={cx('segment', office.routingPosture === posture && 'segment-active')}
                    aria-pressed={office.routingPosture === posture}
                    title={POSTURE_HINT[posture]}
                    onClick={() => store.send({ type: 'setRoutingPosture', posture })}
                  >
                    {posture}
                  </button>
                ))}
              </div>
              <div className="dim small">{POSTURE_HINT[office.routingPosture]}</div>
            </section>

            <section className="popout-section">
              <div className="popout-section-title">Providers</div>
              <ul className="provider-list">
                {office.providers.map((provider) => (
                  <li key={provider.id}>
                    <span className={cx('dot', provider.configured && 'pulse')} style={{ background: provider.configured ? '#34d399' : '#475569' }} aria-hidden="true" />
                    <span className="strong">{provider.label}</span>
                    <span className="stage-spacer" />
                    <span className="dim small mono">{provider.modelCount} models</span>
                    {provider.pluginId !== null && (
                      <Badge tone="info" title={`This provider is registered by the plugin "${provider.pluginId}". Its key still comes from the environment.`}>
                        plugin
                      </Badge>
                    )}
                    <Badge tone={provider.configured ? 'ok' : 'neutral'}>
                      {provider.configured ? 'key set' : 'no key'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>

            <section className="popout-section">
              <div className="popout-section-title">
                Employee status
                {pendingApprovals > 0 && <Badge tone="warn">{pendingApprovals} awaiting approval</Badge>}
              </div>
              <div className="status-legend">
                {STATUS_ORDER.map((status) => (
                  <span className="legend-item" key={status}>
                    <span className="dot" style={{ background: STATUS_COLOR[status] }} aria-hidden="true" />
                    <span>{STATUS_LABEL[status]}</span>
                    <span className="mono dim">{statusCounts.get(status) ?? 0}</span>
                  </span>
                ))}
              </div>
              <div className="dim small">
                drag to orbit · scroll to zoom · click an employee to inspect and message them
              </div>
            </section>

            <section className="popout-section">
              <div className="popout-section-title">
                In flight
                <span className="dim small mono">{activeRuns.length}</span>
              </div>
              {activeRuns.length === 0 ? (
                <div className="dim small">
                  Nothing running. Commission work from the bar at the bottom of the office.
                </div>
              ) : (
                <ul className="popout-runs">
                  {activeRuns.map((run) => (
                    <li key={run.id}>
                      <button type="button" className="popout-run" onClick={() => store.selectRun(run.id)}>
                        <span className="strong">{run.brief.replace(/\s+/g, ' ').slice(0, 68)}</span>
                        <span className="stage-spacer" />
                        <Badge tone="info">{run.status}</Badge>
                        <span className="dim small mono">{formatUsd(run.budget.spentUsd)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="popout-section">
              <div className="popout-section-title">
                Building
                <span className="dim small mono">
                  {office.workspaces.length} floor{office.workspaces.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="provider-list">
                {office.workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <span className="floor-tag mono">F{workspace.floor}</span>
                    <span
                      className="dot"
                      style={{ background: workspace.color ?? '#a78bfa' }}
                      aria-hidden="true"
                    />
                    <span className={workspace.id === office.activeWorkspaceId ? 'strong' : 'dim'}>
                      {workspace.name}
                    </span>
                    {workspace.id === office.activeWorkspaceId && <Badge tone="accent">viewing</Badge>}
                    <span className="stage-spacer" />
                    <span className="dim small mono">{workspace.roleCount} staff</span>
                  </li>
                ))}
              </ul>
              <div className="mono small popout-workspace" title={activePath}>
                {activePath}
              </div>
              <div className="dim small">
                each floor is an independent organisation: its own people, skills, pipelines and budget, confined
                to its own directory
              </div>
            </section>

            <div className="popout-foot">
              <span className="dim small mono">
                {connection.events} events
                {connection.lastEventAt !== null ? ` · last ${formatAgo(connection.lastEventAt, now)}` : ''}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => store.send({ type: 'resync' })} disabled={!store.connected}>
                Resync
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
