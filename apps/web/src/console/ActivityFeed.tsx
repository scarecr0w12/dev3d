/**
 * The rolling activity feed.
 *
 * One line per thing that happened, newest first: log lines, speech, moves,
 * tool results, approvals, budgets, routing decisions and errors. Rows that
 * mention an employee or a run are clickable, so the feed doubles as a way to
 * jump into the 3D view or a transcript.
 */

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import { formatClock } from '../app/format';
import { useNow } from '../app/hooks';
import { useFeed, useOffice, useStore } from '../app/StoreContext';
import type { FeedItem } from '../app/store';
import { Badge, Empty, Panel } from './ui';
import type { Tone } from './ui';

type Filter = 'all' | 'work' | 'talking' | 'tools' | 'attention';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'work', label: 'work' },
  { id: 'talking', label: 'talk' },
  { id: 'tools', label: 'tools' },
  { id: 'attention', label: 'attention' },
];

const RENDER_LIMIT = 250;

function kindTone(kind: string, level: FeedItem['level']): Tone {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  if (kind === 'approval') return 'warn';
  if (kind === 'error') return 'danger';
  if (kind === 'artifact') return 'accent';
  if (kind === 'run') return 'info';
  if (kind === 'lifecycle') return 'ok';
  if (kind.startsWith('speech')) return 'accent';
  if (kind === 'tool' || kind === 'route' || kind === 'turn' || kind === 'stage') return 'info';
  return 'neutral';
}

function matches(item: FeedItem, filter: Filter): boolean {
  switch (filter) {
    case 'work':
      return ['run', 'stage', 'turn', 'artifact', 'budget', 'lifecycle', 'org', 'move'].includes(item.kind);
    case 'talking':
      return item.kind.startsWith('speech') || item.kind === 'direct';
    case 'tools':
      return item.kind === 'tool' || item.kind === 'route';
    case 'attention':
      return item.level === 'error' || item.level === 'warn' || item.kind === 'approval' || item.kind === 'error';
    case 'all':
    default:
      return true;
  }
}

export function ActivityFeed() {
  const store = useStore();
  const office = useOffice();
  const feed = useFeed();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return feed
      .filter((item) => matches(item, filter))
      .filter((item) => (needle.length === 0 ? true : `${item.kind} ${item.text}`.toLowerCase().includes(needle)))
      .slice(0, RENDER_LIMIT);
  }, [feed, filter, query]);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of office?.employees ?? []) map.set(employee.id, employee.displayName);
    return map;
  }, [office]);

  const attentionCount = useMemo(
    () => feed.filter((item) => item.level === 'error' || item.level === 'warn' || item.kind === 'approval').length,
    [feed],
  );

  return (
    <Panel
      title="Activity"
      subtitle={`${feed.length} events${attentionCount > 0 ? ` · ${attentionCount} needing attention` : ''}`}
      flush
      actions={
        <>
          <div className="segmented" role="group" aria-label="Activity filter">
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
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="search feed"
            aria-label="Search the activity feed"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </>
      }
    >
      {visible.length === 0 ? (
        <Empty
          title={feed.length === 0 ? 'Nothing has happened yet' : 'No events match'}
          hint={
            feed.length === 0
              ? 'Speech, tool calls, moves, budget changes and log lines stream in here as the office works.'
              : 'Try “all”, or clear the search box.'
          }
        />
      ) : (
        <ul className="feed">
          {visible.map((item) => {
            const employeeName = item.employeeId ? nameOf.get(item.employeeId) ?? item.employeeId : null;
            return (
              <li key={item.id} className={`feed-row feed-${item.level ?? 'info'}`}>
                <span className="feed-time mono">{formatClock(item.at)}</span>
                <Badge tone={kindTone(item.kind, item.level)}>{item.kind}</Badge>
                <span className="feed-text" title={item.text}>
                  {item.text}
                </span>
                <span className="feed-links">
                  {item.employeeId && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => store.selectEmployee(item.employeeId ?? null)}
                      title="Select this employee"
                    >
                      {employeeName}
                    </button>
                  )}
                  {item.runId && (
                    <button type="button" className="link mono" onClick={() => store.selectRun(item.runId ?? null)} title="Open this run">
                      {item.runId.slice(0, 8)}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {visible.length === RENDER_LIMIT && (
        <div className="dim small padded">
          showing the newest {RENDER_LIMIT} events — the store keeps {feed.length}
        </div>
      )}
      <div className="dim small padded mono">now {formatClock(now)}</div>
    </Panel>
  );
}
