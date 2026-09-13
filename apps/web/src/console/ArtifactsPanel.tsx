/**
 * Artifacts produced by the office.
 *
 * Every `artifact.created` event lands here: the objective, the plan, the
 * decision record, the design spec, review verdicts, test reports and the final
 * report. Bodies are markdown and are rendered with the same safe renderer used
 * by the transcript.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { Artifact } from '@dev3d/core';

import { formatAgo } from '../app/format';
import { useNow } from '../app/hooks';
import { useArtifacts, useOffice, useSelection, useStore } from '../app/StoreContext';
import { Markdown, plainPreview } from './markdown';
import { Badge, Empty, Panel } from './ui';

const NONE: Artifact[] = [];

export function ArtifactsPanel() {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const artifacts = useArtifacts();
  const now = useNow(2000);

  const [scope, setScope] = useState<'run' | 'all'>('run');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const scoped = useMemo(() => {
    if (scope === 'run' && selection.runId) return artifacts[selection.runId] ?? NONE;
    const everything: Artifact[] = [];
    for (const list of Object.values(artifacts)) everything.push(...list);
    return everything;
  }, [artifacts, scope, selection.runId]);

  const kinds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const artifact of scoped) seen.set(artifact.kind, (seen.get(artifact.kind) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scoped
      .filter((artifact) => (kindFilter === 'all' ? true : artifact.kind === kindFilter))
      .filter((artifact) =>
        needle.length === 0 ? true : `${artifact.title} ${artifact.body} ${artifact.path ?? ''}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [scoped, kindFilter, query]);

  const copy = useCallback(async (artifact: Artifact) => {
    try {
      await navigator.clipboard.writeText(artifact.body);
      setCopied(artifact.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* the clipboard can be blocked; the body is on screen anyway */
    }
  }, []);

  const employeeName = useCallback(
    (employeeId: string | null) => {
      if (!employeeId) return 'the office';
      return (
        office?.employees.find((employee) => employee.id === employeeId)?.displayName ??
        office?.roles.find((role) => role.id === employeeId)?.displayName ??
        employeeId
      );
    },
    [office],
  );

  const totalCount = useMemo(() => Object.values(artifacts).reduce((total, list) => total + list.length, 0), [artifacts]);

  return (
    <Panel
      title="Artifacts"
      subtitle={`${visible.length} shown · ${scope === 'run' && selection.runId ? 'selected run' : `all runs (${totalCount})`}`}
      flush
      actions={
        <>
          <div className="segmented" role="group" aria-label="Artifact scope">
            <button
              type="button"
              className={scope === 'run' ? 'segment segment-active' : 'segment'}
              onClick={() => setScope('run')}
              disabled={selection.runId === null}
            >
              this run
            </button>
            <button type="button" className={scope === 'all' ? 'segment segment-active' : 'segment'} onClick={() => setScope('all')}>
              all runs
            </button>
          </div>
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="search artifacts"
            aria-label="Search artifacts"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </>
      }
    >
      {/*
        Shown whenever there is more than one kind **or** a kind is selected. The
        second half is the fix: the row used to appear only when `kinds.length > 1`,
        so picking a kind and then switching scope to a run whose artifacts are all
        a different kind hid the whole row — the list was empty, the empty state
        said "pick another kind", and there was no kind control left on screen.
      */}
      {(kinds.length > 1 || kindFilter !== 'all') && (
        <div className="filter-row">
          <button type="button" className={kindFilter === 'all' ? 'chip chip-active' : 'chip'} onClick={() => setKindFilter('all')}>
            all · {scoped.length}
          </button>
          {kinds.map(([kind, count]) => (
            <button
              key={kind}
              type="button"
              className={kindFilter === kind ? 'chip chip-active' : 'chip'}
              onClick={() => setKindFilter(kind)}
            >
              {kind} · {count}
            </button>
          ))}
          {/*
            A selected kind that this scope has none of still gets a chip, so the
            reason the list is empty is on screen next to the way out of it. Without
            this the reader sees no active chip at all and cannot tell whether the
            filter is set or the scope is simply empty.
          */}
          {kindFilter !== 'all' && !kinds.some(([kind]) => kind === kindFilter) && (
            <button type="button" className="chip chip-active" onClick={() => setKindFilter('all')} title="No artifacts of this kind in this scope — click to clear">
              {kindFilter} · 0
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <Empty
          title={scoped.length === 0 ? 'No artifacts yet' : 'Nothing matches'}
          hint={
            scoped.length === 0
              ? selection.runId
                ? 'Artifacts appear as stages complete: the objective, the plan, the decision record, the spec, reviews, the test report.'
                : 'Select a run, or switch to “all runs”, to see artifacts.'
              : 'Clear the search box or pick another kind.'
          }
        />
      ) : (
        <ul className="artifact-list">
          {visible.map((artifact) => (
            <li key={artifact.id} className="artifact">
              <details>
                <summary>
                  <Badge tone="accent">{artifact.kind}</Badge>
                  <span className="strong">{artifact.title}</span>
                  {artifact.path !== undefined && <span className="mono small dim">{artifact.path}</span>}
                  <span className="stage-spacer" />
                  <span className="dim small">{employeeName(artifact.employeeId)}</span>
                  <span className="dim small mono">{formatAgo(artifact.createdAt, now)}</span>
                </summary>
                <div className="artifact-body">
                  <div className="artifact-meta dim small mono">
                    {artifact.id} · run {artifact.runId}
                    {artifact.stageId ? ` · stage ${artifact.stageId}` : ''}
                  </div>
                  <Markdown text={artifact.body} idPrefix={`art-${artifact.id}`} />
                  {artifact.body.length > 0 && (
                    <div className="artifact-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(artifact)}>
                        {copied === artifact.id ? 'copied' : 'copy markdown'}
                      </button>
                      <span className="dim small">{plainPreview(artifact.body, 80)}</span>
                    </div>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {!store.connected && <div className="dim small padded">socket closed — artifacts will resume when it reconnects</div>}
    </Panel>
  );
}
