/**
 * All runs the office knows about.
 *
 * Each row answers the four questions a supervisor asks: what was asked, who is
 * on it, is it still moving, and how much has it cost. Running rows tick their
 * elapsed time and can be cancelled from here.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { ClientCommand, Run, RunStatus } from '@dev3d/core';

import { formatDuration, formatElapsed, formatPercent, formatUsd, truncate } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { Badge, Bar, Empty, Panel } from './ui';

type Filter = 'all' | 'active' | 'done' | 'failed';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'active', label: 'active' },
  { id: 'done', label: 'done' },
  { id: 'failed', label: 'failed' },
];

const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'awaiting-approval', 'paused']);

function statusTone(status: RunStatus): 'neutral' | 'info' | 'ok' | 'warn' | 'danger' {
  switch (status) {
    case 'running':
      return 'info';
    case 'done':
      return 'ok';
    case 'awaiting-approval':
    case 'paused':
      return 'warn';
    case 'failed':
      return 'danger';
    case 'cancelled':
    case 'queued':
    default:
      return 'neutral';
  }
}

export function RunList() {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const runs = office?.runs ?? [];
  const pipelineNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const pipeline of office?.pipelines ?? []) map.set(pipeline.id, pipeline.name);
    return map;
  }, [office?.pipelines]);

  // The project a run worked in, so the list can show it without a second lookup.
  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const workspace of office?.workspaces ?? []) {
      map.set(workspace.id, { name: workspace.name, color: workspace.color ?? '#a78bfa' });
    }
    return map;
  }, [office?.workspaces]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs
      .filter((run) => {
        if (filter === 'active' && !ACTIVE.has(run.status)) return false;
        if (filter === 'done' && run.status !== 'done') return false;
        if (filter === 'failed' && run.status !== 'failed' && run.status !== 'cancelled') return false;
        if (needle.length === 0) return true;
        return `${run.brief} ${run.id} ${run.pipelineId} ${run.tags.join(' ')}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [runs, filter, query]);

  const cancel = useCallback(
    (runId: string) => {
      const command: ClientCommand = { type: 'cancel', runId };
      store.send(command);
    },
    [store],
  );

  if (!office) {
    return (
      <Panel title="Runs" subtitle="every brief the office has taken on">
        <Empty title="No state yet" hint="Runs appear as soon as the orchestrator sends office state." />
      </Panel>
    );
  }

  return (
    <Panel
      title="Runs"
      subtitle={`${runs.length} total · ${office.activeRunIds.length} active`}
      flush
      actions={
        <>
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="filter briefs"
            aria-label="Filter runs"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
          <div className="segmented" role="group" aria-label="Run status filter">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === filter ? 'segment segment-active' : 'segment'}
                aria-pressed={entry.id === filter}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      }
    >
      {visible.length === 0 ? (
        <Empty
          title={runs.length === 0 ? 'No runs yet' : 'Nothing matches this filter'}
          hint={runs.length === 0 ? 'Submit a brief above and the CEO will open a run.' : 'Try “all”, or clear the search box.'}
        />
      ) : (
        <ul className="run-list">
          {visible.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              now={now}
              selected={run.id === selection.runId}
              pipelineName={pipelineNames.get(run.pipelineId) ?? run.pipelineId}
              project={projectById.get(run.workspaceId)}
              onSelect={store.selectRun}
              onCancel={cancel}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface RunRowProps {
  run: Run;
  now: number;
  selected: boolean;
  pipelineName: string;
  /** The project the run worked in, when it is still a known workspace. */
  project?: { name: string; color: string } | undefined;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
}

function RunRow({ run, now, selected, pipelineName, project, onSelect, onCancel }: RunRowProps) {
  const active = ACTIVE.has(run.status);
  const doneStages = run.stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length;
  const spendRatio = run.budget.limitUsd > 0 ? run.budget.spentUsd / run.budget.limitUsd : 0;
  const barTone = spendRatio >= 0.9 ? 'danger' : spendRatio >= 0.7 ? 'warn' : 'accent';

  return (
    <li className={`run-row${selected ? ' run-row-selected' : ''}`}>
      <button type="button" className="run-row-main" onClick={() => onSelect(run.id)} aria-pressed={selected}>
        <div className="run-row-top">
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          <span className="mono dim small">{run.id.slice(0, 12)}</span>
          <span className="dim small">{pipelineName}</span>
          {project !== undefined && (
            <span className="project-tag dim small" title={`ran in ${project.name}`}>
              <span className="dot" style={{ background: project.color }} aria-hidden="true" />
              {project.name}
            </span>
          )}
          <span className="run-row-spacer" />
          <span className="mono small">
            {formatUsd(run.budget.spentUsd)} / {formatUsd(run.budget.limitUsd)}
          </span>
        </div>
        <div className="run-brief">{truncate(run.brief, 180)}</div>
        <div className="run-row-bottom">
          <span className="mono small dim">
            {doneStages}/{run.stages.length} stages
          </span>
          <span className="mono small dim">{formatElapsed(run.createdAt, active ? now : run.endedAt ?? run.updatedAt)}</span>
          {run.tags.length > 0 && <span className="dim small mono">{run.tags.slice(0, 4).join(' · ')}</span>}
          <span className="run-row-spacer" />
          <span className="mono small dim">{formatPercent(run.budget.spentUsd, run.budget.limitUsd)} of budget</span>
        </div>
        <Bar value={run.budget.spentUsd} max={run.budget.limitUsd} tone={barTone} />
      </button>
      {active && (
        <div className="run-row-actions">
          <span className="dim small mono">updated {formatDuration(Math.max(0, now - run.updatedAt))} ago</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onCancel(run.id)}>
            Cancel run
          </button>
        </div>
      )}
    </li>
  );
}
