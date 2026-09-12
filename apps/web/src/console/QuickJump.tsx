/**
 * Jump to anything.
 *
 * The inspector can only show one thing at a time, which is fine until you know
 * *what* you want and not *where* it is. Hunting for it by opening tabs and
 * scrolling is the navigation problem this replaces: one box, and everything the
 * console already knows about — people, runs, artifacts, and the event feed — is
 * a few characters away.
 *
 * It is deliberately a search over the state already in the client rather than a
 * server query: every result here is something the console could already render,
 * so jumping to one is instant and cannot fail on a round trip.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { Artifact } from '@dev3d/core';

import { formatAgo, truncate } from '../app/format';
import { useNow } from '../app/hooks';
import { useArtifacts, useFeed, useOffice, useSelection, useStore } from '../app/StoreContext';
import { Badge, cx } from './ui';
import type { Tone } from './ui';

type JumpKind = 'employee' | 'run' | 'artifact' | 'event';

interface JumpEntry {
  id: string;
  kind: JumpKind;
  title: string;
  detail: string;
  /** A lower score is a better match. */
  score: number;
  /** Extra text to match on that never gets displayed. */
  haystack: string;
  activate: (store: ReturnType<typeof useStore>, close: () => void) => void;
}

const KIND_TONE: Record<JumpKind, Tone> = {
  employee: 'accent',
  run: 'info',
  artifact: 'neutral',
  event: 'warn',
};

const KIND_LABEL: Record<JumpKind, string> = {
  employee: 'person',
  run: 'run',
  artifact: 'artifact',
  event: 'event',
};

const KIND_ORDER: readonly JumpKind[] = ['employee', 'run', 'artifact', 'event'];

/** Results per group. Enough to choose from, few enough to still be a glance. */
const PER_GROUP = 8;

/**
 * Ranks a candidate. A prefix beats a word start, a word start beats a
 * substring, and nothing beats no match at all — which is `null`.
 */
function score(haystack: string, needle: string): number | null {
  const text = haystack.toLowerCase();
  const at = text.indexOf(needle);
  if (at < 0) return null;
  if (at === 0) return 0;
  const before = text[at - 1];
  return before === ' ' || before === '-' || before === '/' || before === '.' ? 6 : 12;
}

export function QuickJump({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const feed = useFeed();
  const artifactsByRun = useArtifacts();
  const now = useNow(5000);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const entries = useMemo<JumpEntry[]>(() => {
    const collected: JumpEntry[] = [];

    for (const employee of office?.employees ?? []) {
      collected.push({
        id: `employee:${employee.id}`,
        kind: 'employee',
        title: employee.displayName,
        detail: `${employee.title} · ${employee.status}`,
        score: 0,
        haystack: `${employee.displayName} ${employee.title} ${employee.id} ${employee.status}`,
        activate: (target, close) => {
          target.selectEmployee(employee.id);
          close();
        },
      });
    }

    for (const run of office?.runs ?? []) {
      collected.push({
        id: `run:${run.id}`,
        kind: 'run',
        title: run.brief.replace(/\s+/g, ' ').trim() || run.id,
        detail: `${run.status} · ${run.id} · ${formatAgo(run.createdAt, now)}`,
        score: 0,
        haystack: `${run.brief} ${run.id} ${run.status} ${run.pipelineId} ${run.tags.join(' ')}`,
        activate: (target, close) => {
          target.selectRun(run.id);
          close();
        },
      });
    }

    for (const [runId, artifacts] of Object.entries(artifactsByRun)) {
      for (const artifact of artifacts) {
        collected.push(artifactEntry(artifact, runId));
      }
    }

    // Only the recent events: an unbounded feed would drown every other kind of
    // result, and an event from a thousand lines ago is not something you were
    // looking for by name.
    for (const item of feed.slice(0, 400)) {
      const label = item.text.replace(/\s+/g, ' ').trim();
      if (label.length === 0) continue;
      collected.push({
        id: `event:${item.id}`,
        kind: 'event',
        title: truncate(label, 110),
        detail: `${item.kind} · ${formatAgo(item.at, now)}`,
        score: 0,
        haystack: `${label} ${item.kind}`,
        activate: (target, close) => {
          if (item.runId !== undefined) target.selectRun(item.runId);
          else if (item.employeeId !== undefined) target.selectEmployee(item.employeeId);
          close();
        },
      });
    }

    return collected;
  }, [artifactsByRun, feed, now, office?.employees, office?.runs]);

  /**
   * Ranked results, grouped by kind in a fixed order so the list does not
   * reshuffle underneath the arrow keys as scores change.
   */
  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      // With no query, offer what you are most likely to want: whoever is
      // selected, and the runs that are actually moving.
      const recent = [...(office?.runs ?? [])]
        .filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'awaiting-approval')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, PER_GROUP)
        .map((run) => `run:${run.id}`);
      const wanted = new Set(recent);
      if (selection.runId) wanted.add(`run:${selection.runId}`);
      if (selection.employeeId) wanted.add(`employee:${selection.employeeId}`);
      const picked = entries.filter((entry) => wanted.has(entry.id));
      return KIND_ORDER.map((kind) => ({ kind, items: picked.filter((entry) => entry.kind === kind) })).filter(
        (group) => group.items.length > 0,
      );
    }

    const matched = entries
      .map((entry) => ({ entry, hit: score(entry.haystack, needle) }))
      .filter((candidate): candidate is { entry: JumpEntry; hit: number } => candidate.hit !== null)
      .map(({ entry, hit }) => ({ ...entry, score: hit }));

    return KIND_ORDER.map((kind) => ({
      kind,
      items: matched
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => a.score - b.score || a.title.length - b.title.length)
        .slice(0, PER_GROUP),
    })).filter((group) => group.items.length > 0);
  }, [entries, office?.runs, query, selection.employeeId, selection.runId]);

  const flat = useMemo(() => grouped.flatMap((group) => group.items), [grouped]);
  const active = Math.min(cursor, Math.max(0, flat.length - 1));

  const choose = (entry: JumpEntry | undefined): void => {
    if (!entry) return;
    entry.activate(store, onClose);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, Math.max(0, flat.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(flat[active]);
    }
  };

  // Keep the highlighted row inside the scroller as the arrows move it.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let index = -1;

  return (
    <div className="quick-jump">
      <div className="quick-jump-field">
        <span className="quick-jump-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={inputRef}
          className="quick-jump-input"
          type="text"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="quick-jump-results"
          aria-autocomplete="list"
          value={query}
          placeholder="Jump to a person, run, artifact or event…"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Jump to anything"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close quick jump">
          Esc
        </button>
      </div>

      <div className="quick-jump-results" id="quick-jump-results" role="listbox" ref={listRef}>
        {flat.length === 0 ? (
          <div className="dim small quick-jump-empty">
            {query.trim().length === 0
              ? 'Nothing in flight and nothing selected. Type to search everything the console knows.'
              : `Nothing matches “${query.trim()}”.`}
          </div>
        ) : (
          grouped.map((group) => (
            <div className="quick-jump-group" key={group.kind}>
              <div className="quick-jump-group-title">{KIND_LABEL[group.kind]}</div>
              {group.items.map((entry) => {
                index += 1;
                const position = index;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={position === active}
                    data-index={position}
                    className={cx('quick-jump-row', position === active && 'quick-jump-row-active')}
                    onMouseEnter={() => setCursor(position)}
                    onClick={() => choose(entry)}
                  >
                    <Badge tone={KIND_TONE[entry.kind]}>{KIND_LABEL[entry.kind]}</Badge>
                    <span className="quick-jump-title">{entry.title}</span>
                    <span className="quick-jump-detail dim small mono">{entry.detail}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function artifactEntry(artifact: Artifact, runId: string): JumpEntry {
  return {
    id: `artifact:${artifact.id}`,
    kind: 'artifact',
    title: artifact.title,
    detail: `${artifact.kind} · ${runId}`,
    score: 0,
    haystack: `${artifact.title} ${artifact.kind} ${artifact.id} ${runId}`,
    activate: (target, close) => {
      target.selectRun(runId);
      close();
    },
  };
}
