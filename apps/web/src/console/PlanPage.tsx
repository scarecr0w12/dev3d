/**
 * Plan: the conversation you have before you commit.
 *
 * Every other surface in this console is about work that already exists. This
 * one is for the work that does not yet: you bring a rough idea, argue it out
 * with the office, and only then does anything get commissioned. The brief is a
 * first-class object here rather than a text box you had one shot at.
 *
 * The shape is three columns, because planning has three parts and they do not
 * fit in one scroll:
 *
 *   sessions   the plans you are mulling over, newest first
 *   the thread the conversation itself, with the model's context replayed
 *   the brief  what would actually be submitted, editable, plus the pipeline,
 *              project and ceiling it would run under
 *
 * A plan is deliberately *not* a run. Nothing here spends anything beyond the
 * model calls in the conversation, and nothing is written to the office until
 * someone presses Submit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { ChatTurnInput, ClientCommand, Pipeline } from '@dev3d/core';

import { api } from '../app/api';
import { formatAgo, formatUsd } from '../app/format';
import { useAutoScroll, useNow } from '../app/hooks';
import { titleFrom, usePlanSessions } from '../app/planStore';
import type { PlanMessage } from '../app/planStore';
import { useOffice, usePlanReplies, useStore } from '../app/StoreContext';
import { Badge, Empty, cx } from './ui';

/**
 * The prompt that turns a conversation into a submittable brief.
 *
 * It is sent as the operator's own turn rather than as a hidden instruction,
 * so the exchange in the thread is the whole truth of what happened - there is
 * no invisible prompt the transcript omits.
 */
const DRAFT_INSTRUCTION =
  'Draft the brief now. One paragraph stating the objective, then a short bulleted list of what must be true for this to count as finished. No preamble.';

/**
 * Strips the markdown emphasis a model wraps a label in.
 *
 * A drafted brief arrives as `**Objective:** …`, and passing that through to the
 * office puts literal asterisks in the run's objective - the brief is a value
 * here, not a document, so it should not carry the formatting of the reply it
 * was lifted from. Everything after the first line is left exactly as written,
 * because the person may well have edited it.
 */
function stripLeadingEmphasis(text: string): string {
  return text.replace(/^\s*(?:\*\*|__|\*|_)+/, '').trimStart();
}

function messageId(): string {
  return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The conversation as the server wants it: two visible roles, oldest first. */
function toHistory(messages: readonly PlanMessage[]): ChatTurnInput[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: message.text,
  }));
}

export function PlanPage() {
  const store = useStore();
  const office = useOffice();
  const replies = usePlanReplies();
  const now = useNow(5000);
  const {
    store: sessions,
    active,
    createSession,
    selectSession,
    removeSession,
    updateSession,
  } = usePlanSessions();

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  /**
   * The turn in flight: its requestId, so the reply can be matched to it, and
   * whether the answer should *become* the brief.
   *
   * The flag has to survive the round trip on both transports. Only honouring
   * it on the HTTP path made the button work with the socket down and quietly
   * do nothing with it up, which is the worse of the two ways to be wrong.
   */
  const awaiting = useRef<{ requestId: string; asDraft: boolean } | null>(null);

  const employees = office?.employees ?? [];
  const workspaces = office?.workspaces ?? [];
  const pipelines = office?.pipelines ?? [];

  /**
   * Who shapes the brief. The CEO owns the objective for a run, so the CEO is
   * the right person to shape one - and falling back to the first employee
   * keeps the page usable in a building with an unusual org chart.
   */
  const planner = useMemo(
    () => employees.find((employee) => employee.roleId === 'ceo') ?? employees[0] ?? null,
    [employees],
  );

  const activeWorkspace = useMemo(() => {
    if (workspaces.length === 0) return null;
    const named = active?.workspaceId ?? '';
    return (
      workspaces.find((entry) => entry.id === named) ??
      workspaces.find((entry) => entry.id === office?.activeWorkspaceId) ??
      workspaces.find((entry) => entry.isDefault === true) ??
      workspaces[0] ??
      null
    );
  }, [active?.workspaceId, office?.activeWorkspaceId, workspaces]);

  const activePipeline: Pipeline | null = useMemo(() => {
    if (pipelines.length === 0) return null;
    const named = active?.pipelineId ?? '';
    return pipelines.find((pipeline) => pipeline.id === named) ?? pipelines[0] ?? null;
  }, [active?.pipelineId, pipelines]);

  const thread = active?.messages ?? [];
  const autoScroll = useAutoScroll(thread.length + (busy ? 1 : 0));

  // ---------------------------------------------------------------- sessions

  // Opening the page with nothing to look at is a dead end, so it starts one.
  useEffect(() => {
    if (sessions.items.length === 0) createSession();
  }, [createSession, sessions.items.length]);

  // A new session inherits the floor you are looking at, so a plan started on a
  // floor is not silently submitted against another one.
  useEffect(() => {
    if (!active || active.workspaceId !== '') return;
    const fallback = office?.activeWorkspaceId ?? workspaces.find((w) => w.isDefault)?.id ?? '';
    if (fallback !== '') updateSession(active.id, { workspaceId: fallback });
  }, [active, office?.activeWorkspaceId, updateSession, workspaces]);

  // --------------------------------------------------------- sending a turn

  const send = useCallback(
    async (text: string, options?: { asDraftRequest?: boolean }) => {
      const body = text.trim();
      if (body.length === 0 || busy || !active || !planner) return;
      const asDraft = options?.asDraftRequest === true;

      const at = Date.now();
      const nextMessages: PlanMessage[] = [
        ...active.messages,
        { id: messageId(), role: 'user', text: body, at },
      ];
      const requestId = `plan-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const patch = {
        messages: nextMessages,
        // The first thing said is the best title there is; a later rename sticks.
        ...(active.title === 'Untitled plan' ? { title: titleFrom(body) } : {}),
      };

      updateSession(active.id, patch);
      setDraft('');
      setError(null);
      setBusy(true);
      awaiting.current = { requestId, asDraft };

      const history = toHistory(active.messages);

      // The socket is the normal path. The HTTP fallback exists so a plan can
      // still be developed while the socket is reconnecting, and it lands in
      // exactly the same place.
      if (store.connected) {
        const command: ClientCommand = {
          type: 'plan',
          employeeId: planner.id,
          text: body,
          history,
          requestId,
          ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
        };
        if (!store.send(command)) {
          setBusy(false);
          awaiting.current = null;
          setError('the command could not be sent');
        }
        return;
      }

      const result = await api.plan({
        employeeId: planner.id,
        text: body,
        history,
        ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
      });
      setBusy(false);
      awaiting.current = null;
      if (result.ok && result.data) {
        updateSession(active.id, {
          messages: [...nextMessages, { id: messageId(), role: 'assistant', text: result.data.text, at: Date.now() }],
          ...(asDraft ? { draft: stripLeadingEmphasis(result.data.text) } : {}),
        });
      } else {
        setError(result.error ?? 'the planning turn failed');
      }
    },
    [active, activeWorkspace, busy, planner, store, updateSession],
  );

  // A reply that came in over the socket, matched to the turn that asked for it.
  useEffect(() => {
    const pending = awaiting.current;
    if (pending === null) return;
    const reply = replies.find((candidate) => candidate.requestId === pending.requestId);
    if (!reply || !active) return;
    store.takePlanReply(pending.requestId);
    awaiting.current = null;
    setBusy(false);
    updateSession(active.id, {
      messages: [...active.messages, { id: messageId(), role: 'assistant', text: reply.text, at: reply.at }],
      ...(pending.asDraft ? { draft: stripLeadingEmphasis(reply.text) } : {}),
    });
  }, [active, replies, store, updateSession]);

  // A budget or a plan that never answers must not leave the composer disabled.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => {
      if (awaiting.current === null) return;
      awaiting.current = null;
      setBusy(false);
      setError('the planning turn is taking a long time — the reply will not be shown even if it arrives');
    }, 180_000);
    return () => window.clearTimeout(timer);
  }, [busy]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void send(draft);
    }
  };

  // ------------------------------------------------------------- the handoff

  const submit = useCallback(() => {
    const brief = (active?.draft ?? '').trim();
    if (brief.length === 0) return;
    const parsedBudget = Number.parseFloat(active?.budgetUsd ?? '');
    const command: ClientCommand = {
      type: 'submit',
      brief,
      ...(activePipeline ? { pipelineId: activePipeline.id } : {}),
      ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
      ...(Number.isFinite(parsedBudget) && parsedBudget > 0 ? { budgetUsd: parsedBudget } : {}),
    };
    if (!store.send(command)) {
      setError('the brief could not be submitted — the orchestrator is not connected');
      return;
    }
    setSubmitted(brief);
    setError(null);
  }, [active?.budgetUsd, active?.draft, activePipeline, activeWorkspace, store]);

  const update = useCallback(
    (patch: Parameters<typeof updateSession>[1]) => {
      if (!active) return;
      updateSession(active.id, patch);
    },
    [active, updateSession],
  );

  if (!office) {
    return (
      <div className="plan">
        <Empty title="Waiting for the office" hint="Plan sessions appear once the orchestrator has sent office state." />
      </div>
    );
  }

  return (
    <div className="plan">
      {/* ------------------------------------------------------------ sessions */}
      <aside className="plan-sessions" aria-label="Plan sessions">
        <div className="plan-sessions-head">
          <span className="field-label">Plans</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => createSession()}>
            New
          </button>
        </div>
        <div className="plan-session-list">
          {sessions.items.length === 0 ? (
            <div className="dim small plan-session-empty">No plans yet.</div>
          ) : (
            sessions.items.map((session) => (
              <div key={session.id} className={cx('plan-session', session.id === sessions.activeId && 'plan-session-active')}>
                <button type="button" className="plan-session-main" onClick={() => selectSession(session.id)}>
                  <span className="plan-session-title">{session.title}</span>
                  <span className="dim small mono">
                    {session.messages.length} turn{session.messages.length === 1 ? '' : 's'} ·{' '}
                    {formatAgo(session.updatedAt, now)}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm plan-session-remove"
                  onClick={() => removeSession(session.id)}
                  aria-label={`Discard ${session.title}`}
                  title="Discard this plan"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
        <div className="plan-sessions-foot dim small">
          Plans stay in this browser. Nothing is commissioned until you submit a brief.
        </div>
      </aside>

      {/* -------------------------------------------------------------- thread */}
      <section className="plan-thread" aria-label="Planning conversation">
        <header className="plan-thread-head">
          <div>
            <div className="plan-thread-title">Plan with {planner?.displayName ?? 'the office'}</div>
            <div className="dim small">
              {planner
                ? `${planner.title} · ${activeWorkspace?.name ?? 'no project'} · shaping a brief, not running one`
                : 'nobody available to plan with'}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || thread.length === 0}
            onClick={() => void send(DRAFT_INSTRUCTION, { asDraftRequest: true })}
            title="Ask for the brief itself, and put it in the brief panel"
          >
            Draft the brief
          </button>
        </header>

        <div className="plan-scroll" ref={autoScroll.ref}>
          {thread.length === 0 ? (
            <div className="plan-intro">
              <div className="plan-intro-title">What are you trying to build or change?</div>
              <p className="dim">
                Describe it roughly. {planner?.displayName ?? 'Your planning partner'} will ask what “done” means,
                push back on the expensive decisions, and turn the conversation into a brief you can submit.
              </p>
              <div className="plan-prompts">
                {[
                  'Our checkout retries double-charge on timeout. I want it to be safe to retry, but I do not know the right fix yet.',
                  'I want an audit trail for admin actions, and I have not decided whether it belongs in the database or the log pipeline.',
                  'The onboarding flow loses people at step 3. I need a plan before anyone writes code.',
                ].map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="btn btn-ghost btn-sm plan-prompt"
                    onClick={() => void send(example)}
                    title={example}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            thread.map((message) => (
              <div key={message.id} className={cx('plan-bubble', `plan-${message.role}`)}>
                <div className="plan-bubble-meta mono small">
                  {message.role === 'user' ? 'you' : planner?.displayName ?? 'office'} · {formatAgo(message.at, now)}
                </div>
                <div className="plan-bubble-text">{message.text}</div>
              </div>
            ))
          )}
          {busy && (
            <div className="plan-bubble plan-assistant plan-pending">
              <span className="spinner spinner-sm" aria-hidden="true" />
              {planner?.displayName ?? 'the office'} is thinking…
            </div>
          )}
        </div>

        {!autoScroll.pinned && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={autoScroll.scrollToBottom}>
            Jump to latest
          </button>
        )}

        {error !== null && (
          <div className="alert alert-danger small" role="alert">
            {error}
          </div>
        )}
        {submitted !== null && (
          <div className="alert alert-ok small" role="status">
            Brief submitted — the run is open in the inspector.
          </div>
        )}

        <div className="plan-composer">
          <textarea
            className="plan-input"
            rows={4}
            value={draft}
            placeholder={
              planner
                ? `Describe the idea. ${planner.displayName} will ask about the parts that are still vague…  (⌘/ctrl + ↵ to send)`
                : 'No employee to talk to yet.'
            }
            disabled={!planner || busy}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Planning message"
            spellCheck={false}
          />
          <div className="plan-composer-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={draft.trim().length === 0 || busy || !planner}
              onClick={() => void send(draft)}
            >
              Send
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={draft.length === 0}
              onClick={() => setDraft('')}
            >
              Clear
            </button>
            <span className="stage-spacer" />
            <span className="dim small mono">
              {busy ? 'waiting for a reply' : store.connected ? 'socket live' : 'socket down — using /api/plan'}
            </span>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- brief */}
      <aside className="plan-brief" aria-label="The brief">
        <div className="plan-brief-head">
          <span className="field-label">The brief</span>
          <Badge tone={active?.draft.trim() ? 'ok' : 'neutral'}>
            {active?.draft.trim() ? `${active.draft.trim().length} chars` : 'empty'}
          </Badge>
        </div>

        <textarea
          className="plan-brief-text"
          value={active?.draft ?? ''}
          placeholder={
            'Nothing here yet.\n\nTalk it through, then press “Draft the brief” — or write it yourself. This is exactly what gets submitted.'
          }
          disabled={!active}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update({ draft: event.target.value })}
          aria-label="The brief to submit"
          spellCheck={false}
        />

        <div className="plan-brief-fields">
          <label className="field">
            <span className="field-label">Project</span>
            <select
              value={activeWorkspace?.id ?? ''}
              disabled={workspaces.length === 0 || !active}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => update({ workspaceId: event.target.value })}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">Pipeline</span>
            <select
              value={activePipeline?.id ?? ''}
              disabled={pipelines.length === 0 || !active}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => update({ pipelineId: event.target.value })}
            >
              {pipelines.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name} · {pipeline.stages.length} stages
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">Budget ceiling</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={active?.budgetUsd ?? ''}
              placeholder={office.budget.defaultRunUsd > 0 ? String(office.budget.defaultRunUsd) : 'default'}
              disabled={!active}
              onChange={(event: ChangeEvent<HTMLInputElement>) => update({ budgetUsd: event.target.value })}
            />
          </label>
        </div>

        {activePipeline && (
          <div className="plan-brief-stages">
            <span className="field-label">Stages this will run</span>
            <ol className="stage-strip">
              {activePipeline.stages.map((stage) => (
                <li key={`${activePipeline.id}-${stage.kind}-${stage.name}`} className="stage-strip-item">
                  <span className="strong">{stage.name}</span>
                  <Badge tone={stage.mode === 'parallel' ? 'info' : stage.mode === 'debate' ? 'accent' : 'neutral'}>
                    {stage.kind}
                  </Badge>
                  {stage.optional && <Badge tone="warn">optional</Badge>}
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="plan-brief-foot">
          <div className="dim small">
            {activeWorkspace ? (
              <span className="mono plan-brief-path" title={activeWorkspace.path}>
                {activeWorkspace.path}
              </span>
            ) : (
              'no project selected'
            )}
            {office.budget.defaultRunUsd > 0 && (
              <span> · default {formatUsd(office.budget.defaultRunUsd)} per run</span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={(active?.draft ?? '').trim().length === 0 || !store.connected}
            onClick={submit}
            title={store.connected ? 'Commission this brief as a run' : 'The orchestrator is not connected'}
          >
            Submit brief
          </button>
        </div>
      </aside>
    </div>
  );
}
