/**
 * The compact run chooser.
 *
 * A run is chosen far more often than anything else in this console, so this is
 * a dense, filterable list rather than a set of cards: status, brief, cost and
 * age on one line each. It is the master half of the Run tab's master-detail,
 * which is why it caps its own height and scrolls internally instead of pushing
 * the transcript below the fold.
 */

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { ClientCommand, Run, RunStatus } from '@dev3d/core';

import { formatElapsed, formatPercent, formatUsd, truncate } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { statusTone } from '../app/vocabulary';
import { Badge, cx } from './ui';
import type { Tone } from './ui';

type Filter = 'all' | 'active' | 'done' | 'failed';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'active', label: 'active' },
  { id: 'done', label: 'done' },
  { id: 'failed', label: 'failed' },
];

const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'awaiting-approval', 'paused']);

export function RunSwitcher() {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);

  const runs = office?.runs ?? [];

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

  const cancel = (runId: string): void => {
    const command: ClientCommand = { type: 'cancel', runId };
    store.send(command);
  };

  const activeCount = office?.activeRunIds.length ?? 0;
  // Which run the transcript below is actually showing. Worth naming whenever the
  // list is out of the way - a short window shows one row, and "which run am I
  // reading?" should not be a question the layout makes you ask.
  const selected = runs.find((run) => run.id === selection.runId) ?? null;

  return (
    <div className="chooser chooser-runs">
      <div className="chooser-head">
        <button
          type="button"
          className="chooser-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          title={open ? 'Collapse the run list' : 'Expand the run list'}
        >
          <span className="chooser-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          Runs
          <span className="dim small mono">
            {runs.length}
            {activeCount > 0 ? ` · ${activeCount} active` : ''}
          </span>
        </button>
        {open && (
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="filter briefs"
            aria-label="Filter runs"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        )}
      </div>

      {!open && selected && (
        <button
          type="button"
          className="chooser-pin"
          onClick={() => setOpen(true)}
          title="Expand the run list"
        >
          <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
          <span className="chooser-pin-brief">{truncate(selected.brief.replace(/\s+/g, ' '), 64)}</span>
        </button>
      )}

      {open && (
        <>
          <div className="segmented chooser-segments" role="group" aria-label="Run status filter">
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
          <div className="chooser-list chooser-list-runs">
            {visible.length === 0 ? (
              <div className="dim small chooser-empty">
                {runs.length === 0 ? 'no runs yet' : 'nothing matches that filter'}
              </div>
            ) : (
              visible.map((run) => (
                <RunSwitchRow
                  key={run.id}
                  run={run}
                  now={now}
                  selected={run.id === selection.runId}
                  onSelect={store.selectRun}
                  onCancel={cancel}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RunSwitchRow({
  run,
  now,
  selected,
  onSelect,
  onCancel,
}: {
  run: Run;
  now: number;
  selected: boolean;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
}) {
  const active = ACTIVE.has(run.status);
  const spendRatio = run.budget.limitUsd > 0 ? run.budget.spentUsd / run.budget.limitUsd : 0;

  return (
    <div className={cx('chooser-run', selected && 'chooser-row-active')}>
      <button type="button" className="chooser-run-main" aria-pressed={selected} onClick={() => onSelect(run.id)}>
        <span className="chooser-run-top">
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          <span className="chooser-run-brief">{truncate(run.brief.replace(/\s+/g, ' '), 140)}</span>
        </span>
        <span className="chooser-run-meta dim small mono">
          <span>{formatUsd(run.budget.spentUsd)}</span>
          <span>·</span>
          <span>{formatPercent(run.budget.spentUsd, run.budget.limitUsd)}</span>
          <span>·</span>
          <span>{formatElapsed(run.createdAt, active ? now : run.endedAt ?? run.updatedAt)}</span>
          <span className="chooser-run-spacer" />
          <span>{run.stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length}/{run.stages.length}</span>
        </span>
      </button>
      {active && (
        <button
          type="button"
          className="btn btn-ghost btn-sm chooser-run-cancel"
          onClick={() => onCancel(run.id)}
          title="Cancel this run"
        >
          ✕
        </button>
      )}
    </div>
  );
}
