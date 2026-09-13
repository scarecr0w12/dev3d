/**
 * Memory: what the office has written down, and what it used to believe.
 *
 * Two views over one store, because the two questions are different. The active
 * list answers "what do we believe", which is what an employee recalls. The ledger
 * answers "what did we believe, and what changed our mind", which is the question
 * an operator asks when something turns out to have been wrong for a month.
 *
 * The ledger is fetched rather than carried on the socket. Memory is unbounded and
 * a state frame is not the place for an unbounded payload; the live slice holds the
 * active facts, and the history is one request when somebody opens it.
 *
 * Writing is a deliberate act and lives here rather than in the pipeline. Editing a
 * fact produces a *replacement* rather than a mutation, so the old wording and the
 * moment it stopped being true both survive - and the panel says so before the
 * operator commits, because "correct" and "overwrite" look identical from a form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import type { MemoryFact, MemoryKind, MemoryRecord, MemoryScope } from '@dev3d/core';

import { formatAgo } from '../app/format';
import { useNow } from '../app/hooks';
import { useMemory, useOffice, useStore } from '../app/StoreContext';
import { Badge, Empty, Loading, Panel, Tabs } from './ui';

const KINDS: MemoryKind[] = ['convention', 'decision', 'pitfall', 'note'];

/** How each kind reads to a person, since the enum is an implementation detail. */
const KIND_LABEL: Record<MemoryKind, string> = {
  convention: 'convention',
  decision: 'decision',
  pitfall: 'pitfall',
  note: 'note',
};

const KIND_TONE: Record<MemoryKind, 'info' | 'accent' | 'warn' | 'neutral'> = {
  convention: 'info',
  decision: 'accent',
  pitfall: 'warn',
  note: 'neutral',
};

export function MemoryPanel() {
  const store = useStore();
  const office = useOffice();
  const memory = useMemory();
  // One clock for the panel, rather than each row reading its own: two rows
  // rendered in the same frame should not be able to disagree about "just now".
  const now = useNow(5000);

  const [view, setView] = useState<'active' | 'ledger'>('active');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<MemoryKind | 'all'>('all');

  // Form state. Kept here rather than in the panel's parent because a half-typed
  // fact is not office state and should not survive a tab switch.
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<MemoryKind>('convention');
  const [draftScope, setDraftScope] = useState<MemoryScope>('workspace');
  const [draftRole, setDraftRole] = useState<string>('');
  const [draftTags, setDraftTags] = useState('');
  const [draftSource, setDraftSource] = useState('');
  const [correcting, setCorrecting] = useState<MemoryFact | null>(null);

  const ledger = useLedger(view === 'ledger');
  const backfill = useBackfill();

  const workspaceId = office?.activeWorkspaceId ?? '';
  const roles = office?.roles ?? [];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return memory.facts.filter((fact) => {
      if (kindFilter !== 'all' && fact.kind !== kindFilter) return false;
      if (needle === '') return true;
      return `${fact.text} ${fact.tags.join(' ')} ${fact.scopeId ?? ''} ${fact.source ?? ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [memory.facts, kindFilter, query]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (text === '') {
        store.notify('warn', 'a fact needs some text');
        return;
      }
      const sent = store.send({
        type: 'rememberFact',
        fact: {
          scope: draftScope,
          // The installation scope names nothing, and sending an id for it is
          // refused by the server - so it is omitted rather than sent empty.
          ...(draftScope === 'installation' ? {} : { scopeId: draftScope === 'role' ? draftRole : workspaceId }),
          kind: draftKind,
          text,
          tags: draftTags.split(',').map((t) => t.trim()).filter((t) => t !== ''),
          source: draftSource.trim() === '' ? null : draftSource.trim(),
          ...(correcting === null ? {} : { supersedes: correcting.id }),
        },
      });
      if (!sent) {
        // `store.send` returns false only when no transport is attached at all,
        // and it already emitted its own warning — so this says what actually
        // happened rather than claiming the socket is down. While the socket *is*
        // down a command is queued and flushed on reconnect, which is a different
        // situation with a different answer.
        store.notify('error', 'the office is not connected, so that was not recorded');
        return;
      }
      if (!store.connected) {
        // Queued rather than lost — but the form is about to be cleared, so say
        // so instead of implying it landed.
        store.notify('warn', 'queued: it will be recorded when the office reconnects');
      }
      setDraft('');
      setDraftTags('');
      setDraftSource('');
      setCorrecting(null);
      store.notify('info', correcting === null ? 'fact recorded' : 'fact corrected — the old wording is kept');
    },
    [store, draft, draftKind, draftScope, draftRole, draftTags, draftSource, correcting, workspaceId],
  );

  /** Load a fact into the form as a correction rather than editing it in place. */
  const beginCorrection = useCallback((fact: MemoryFact) => {
    setCorrecting(fact);
    setDraft(fact.text);
    setDraftKind(fact.kind);
    setDraftScope(fact.scope);
    setDraftRole(fact.scopeId ?? '');
    setDraftTags(fact.tags.join(', '));
    setDraftSource(fact.source ?? '');
    setView('active');
  }, []);

  return (
    <Panel
      title="Memory"
      subtitle={
        memory.searchable
          ? `${memory.counts.installation} installation · ${memory.counts.workspace} workspace · ${memory.counts.role} role` +
            (memory.semantic
              ? ` · semantic on (${memory.vectorCoverage}/${memory.facts.length} active facts embedded)`
              : '')
          : `${memory.facts.length} fact(s) · search is degraded (no full-text index)`
      }
      flush
      actions={
        <>
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="filter facts"
            aria-label="Filter facts"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </>
      }
    >
      {!memory.searchable && (
        <div className="alert alert-warn small">
          <span className="strong">Recall is unranked</span>
          <span className="dim small">
            This store has no full-text index, so searches fall back to a substring scan. Facts
            still work and stay scoped; they are just not ordered by relevance.
          </span>
        </div>
      )}

      {memory.semantic && memory.vectorCount < memory.facts.length && (
        <div className="alert small">
          <span className="strong">Semantic search is on</span>
          <span className="dim small">
            {memory.vectorCoverage} of {memory.facts.length} current facts have a vector. Searches embed a
            few more as they pass, and a fact with no vector keeps its full-text position rather
            than being ranked — so a partial backfill is never wrong, only incomplete.
          </span>
          <button type="button" className="btn btn-sm" disabled={backfill.busy} onClick={() => backfill.run()}>
            {backfill.busy ? 'embedding…' : 'Embed now'}
          </button>
          {backfill.result !== null && <span className="dim small mono">{backfill.result}</span>}
        </div>
      )}

      <Tabs
        items={[
          { id: 'active', label: `Active · ${memory.facts.length}` },
          { id: 'ledger', label: 'Ledger' },
        ]}
        active={view}
        onChange={(id) => setView(id)}
      />

      <form className="memory-form" onSubmit={submit}>
        {correcting !== null && (
          <div className="memory-correcting small">
            <span className="strong">Correcting</span> <span className="dim">{correcting.text}</span>
            <button type="button" className="link" onClick={() => { setCorrecting(null); setDraft(''); }}>
              cancel
            </button>
            <div className="dim">
              Saving writes a replacement and marks the original no longer true. Neither is
              deleted, so the record still answers what you believed before.
            </div>
          </div>
        )}
        <textarea
          className="input memory-text"
          value={draft}
          rows={2}
          placeholder={
            correcting === null
              ? 'Something worth not having to work out twice — a convention, a decision, a trap.'
              : 'What is true instead?'
          }
          aria-label="Fact text"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
        />
        <div className="memory-form-row">
          <label className="memory-field">
            <span className="dim small">kind</span>
            <select className="input input-sm" value={draftKind} onChange={(e) => setDraftKind(e.target.value as MemoryKind)}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </label>
          <label className="memory-field">
            <span className="dim small">scope</span>
            <select
              className="input input-sm"
              value={draftScope}
              disabled={correcting !== null}
              onChange={(e) => setDraftScope(e.target.value as MemoryScope)}
            >
              <option value="installation">everywhere</option>
              <option value="workspace">this project</option>
              <option value="role">one role</option>
            </select>
          </label>
          {draftScope === 'role' && (
            <label className="memory-field">
              <span className="dim small">role</span>
              <select
                className="input input-sm"
                value={draftRole}
                disabled={correcting !== null}
                onChange={(e) => setDraftRole(e.target.value)}
              >
                <option value="">pick a role…</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="memory-field memory-field-grow">
            <span className="dim small">tags, comma separated</span>
            <input
              className="input input-sm"
              value={draftTags}
              placeholder="testing, windows"
              onChange={(e) => setDraftTags(e.target.value)}
            />
          </label>
          <label className="memory-field memory-field-grow">
            <span className="dim small">source (optional)</span>
            <input
              className="input input-sm"
              value={draftSource}
              placeholder="a file, a run id, an issue"
              onChange={(e) => setDraftSource(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-sm">
            {correcting === null ? 'Record' : 'Correct'}
          </button>
        </div>
        {draftScope === 'role' && draftRole === '' && (
          <div className="dim small">A role-scoped fact needs a role; the server will refuse it otherwise.</div>
        )}
      </form>

      {view === 'active' ? (
        <>
          {memory.facts.length > 0 && (
            <div className="filter-row">
              <button type="button" className={kindFilter === 'all' ? 'chip chip-active' : 'chip'} onClick={() => setKindFilter('all')}>
                all · {memory.facts.length}
              </button>
              {KINDS.map((kind) => {
                const count = memory.facts.filter((fact) => fact.kind === kind).length;
                if (count === 0) return null;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={kindFilter === kind ? 'chip chip-active' : 'chip'}
                    onClick={() => setKindFilter(kind)}
                  >
                    {KIND_LABEL[kind]} · {count}
                  </button>
                );
              })}
            </div>
          )}

          {visible.length === 0 ? (
            <Empty
              title={memory.facts.length === 0 ? 'Nothing written down yet' : 'Nothing matches'}
              hint={
                memory.facts.length === 0
                  ? 'Add a convention, a decision, or a trap above. Employees recall these through the `recall` tool, and the prompt carries a short index of them.'
                  : 'Clear the filter or pick another kind.'
              }
            />
          ) : (
            <FactList
              facts={visible}
              now={now}
              onCorrect={beginCorrection}
              onRetract={(fact) => {
                // Same shape as the record path above, and for the same reason:
                // `store.send` returns false only when no transport is attached —
                // while the socket is *down* the command is queued and flushed on
                // reconnect — so the old message named a condition it could not
                // detect, and duplicated the warning `send` had already emitted.
                if (!store.send({ type: 'retractFact', factId: fact.id })) {
                  store.notify('error', 'the office is not connected, so that was not recorded');
                  return;
                }
                if (!store.connected) {
                  store.notify('warn', 'queued: the retraction will be recorded when the office reconnects');
                }
              }}
            />
          )}
        </>
      ) : (
        <LedgerView
          record={ledger.record}
          now={now}
          loading={ledger.loading}
          error={ledger.error}
          onReload={ledger.reload}
        />
      )}
    </Panel>
  );
}

/**
/**
 * Embed the facts that have no vector yet.
 *
 * Explicit rather than automatic because it spends money against a metered
 * endpoint. The endpoint is bounded per call, so this is a batch rather than a
 * complete drain - which is why the result is reported as a count and not as
 * success. A partial backfill is the honest answer, and the design makes it a
 * harmless one: a fact with no vector keeps its full-text position.
 */
function useBackfill(): { run: () => void; busy: boolean; result: string | null } {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = useCallback(() => {
    setBusy(true);
    setResult(null);
    fetch('/api/memory/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 64 }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return (await response.json()) as { embedded: number; semantic: boolean };
      })
      .then((body) => {
        // Zero gets its own answer rather than being reported as a failure:
        // "nothing left to embed" and "semantic search is not active" are
        // different situations and an operator needs to tell them apart.
        setResult(
          body.embedded > 0
            ? `embedded ${body.embedded}`
            : body.semantic
              ? 'nothing left to embed'
              : 'semantic search is not active, so nothing was embedded',
        );
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        setResult(message);
        store.notify('error', `embedding failed: ${message}`);
      })
      .finally(() => setBusy(false));
  }, [store]);

  return { run, busy, result };
}

/**
 * Fetch the ledger, but only when somebody is looking at it.
 *
 * Lazy on purpose: opening the console should not pull every fact the office has
 * ever written down, and the active list on the socket is enough for the common
 * case.
 */
function useLedger(enabled: boolean): {
  record: MemoryRecord | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const memory = useMemory();
  const activeCount = memory.facts.length;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch('/api/memory')
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return (await response.json()) as MemoryRecord;
      })
      .then((next) => {
        if (cancelled) return;
        setRecord(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-reads when the ledger is opened, when it is manually reloaded, and when a
    // fact changes while it is on screen - so the history never silently lags the
    // active list sitting beside it.
  }, [enabled, nonce, activeCount]);

  return {
    record,
    loading,
    error,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}

function FactList({
  facts,
  now,
  onCorrect,
  onRetract,
}: {
  facts: readonly MemoryFact[];
  now: number;
  onCorrect: (fact: MemoryFact) => void;
  onRetract: (fact: MemoryFact) => void;
}) {
  const office = useOffice();
  return (
    <ul className="fact-list">
      {facts.map((fact) => (
        <li key={fact.id} className="fact">
          <div className="fact-head">
            <Badge tone={KIND_TONE[fact.kind]}>{KIND_LABEL[fact.kind]}</Badge>
            <span className="dim small">{scopeLabel(fact, office?.activeWorkspaceId ?? '', office?.roles ?? [])}</span>
            <span className="stage-spacer" />
            {fact.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
            <span className="dim small" title={new Date(fact.validFrom).toISOString()}>
              {formatAgo(fact.validFrom, now)}
            </span>
          </div>
          <div className="fact-text">{fact.text}</div>
          <div className="fact-foot dim small">
            <span>{fact.origin === 'operator' ? 'written by the operator' : fact.origin}</span>
            {fact.source !== null && <span className="mono"> · {fact.source}</span>}
            {/* Read count is shown because it is the only evidence the office has
                that a fact earned its place - and a fact nobody ever recalls is
                worth an operator's attention, not silent deletion. */}
            <span> · recalled {fact.readCount === 0 ? 'never' : `${fact.readCount}×`}</span>
            <span className="stage-spacer" />
            <button type="button" className="link" onClick={() => onCorrect(fact)}>
              correct
            </button>
            <button type="button" className="link" onClick={() => onRetract(fact)}>
              retract
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function LedgerView({
  record,
  now,
  loading,
  error,
  onReload,
}: {
  record: MemoryRecord | null;
  now: number;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const office = useOffice();
  const roles = office?.roles ?? [];
  const workspaceId = office?.activeWorkspaceId ?? '';

  if (loading && record === null) return <Loading label="reading the ledger…" />;
  if (error !== null) {
    return (
      <Empty
        title="The ledger could not be read"
        hint={error}
        action={
          <button type="button" className="btn btn-sm" onClick={onReload}>
            Try again
          </button>
        }
      />
    );
  }
  if (record === null || record.facts.length === 0) {
    return <Empty title="The ledger is empty" hint="Nothing has ever been written down for this office." />;
  }

  return (
    <>
      <div className="memory-summary small dim">
        {record.total} fact(s) on record · {record.total - record.inactive} current · {record.inactive} no
        longer believed. Nothing here is deleted; a fact that stopped being true keeps its wording
        and gains the moment it stopped.
      </div>
      <ul className="fact-list">
        {record.facts.map((fact) => {
          const inactive = fact.invalidFrom !== null || fact.supersededBy !== null;
          return (
            <li key={fact.id} className={inactive ? 'fact fact-inactive' : 'fact'}>
              <div className="fact-head">
                <Badge tone={inactive ? 'neutral' : KIND_TONE[fact.kind]}>{KIND_LABEL[fact.kind]}</Badge>
                <span className="dim small">{scopeLabel(fact, workspaceId, roles)}</span>
                <span className="stage-spacer" />
                {inactive ? (
                  <Badge tone="warn">{fact.supersededBy === null ? 'retracted' : 'superseded'}</Badge>
                ) : (
                  <Badge tone="ok">current</Badge>
                )}
              </div>
              <div className="fact-text">{fact.text}</div>
              <div className="fact-foot dim small">
                <span title={new Date(fact.validFrom).toISOString()}>from {formatAgo(fact.validFrom, now)}</span>
                {fact.invalidFrom !== null && (
                  <span title={new Date(fact.invalidFrom).toISOString()}>
                    {' '}· until {formatAgo(fact.invalidFrom, now)}
                  </span>
                )}
                {fact.supersededBy !== null && <span className="mono"> · replaced by {fact.supersededBy}</span>}
                {fact.supersedes !== null && <span className="mono"> · replaced {fact.supersedes}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * How a fact's scope reads.
 *
 * Named rather than shown as an id wherever the id can be resolved, because "this
 * binds only the Backend role" is the thing the operator needs to know and
 * `role_backend-01` is not.
 */
function scopeLabel(fact: MemoryFact, workspaceId: string, roles: ReadonlyArray<{ id: string; displayName: string }>): string {
  if (fact.scope === 'installation') return 'everywhere';
  if (fact.scope === 'workspace') {
    return fact.scopeId === workspaceId ? 'this project' : `project ${fact.scopeId ?? '?'}`;
  }
  const role = roles.find((candidate) => candidate.id === fact.scopeId);
  return role === undefined ? `role ${fact.scopeId ?? '?'}` : `only ${role.displayName}`;
}
