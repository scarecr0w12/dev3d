/**
 * The conversation surface for one employee.
 *
 * A direct message is not a run: it has no stage, no turn and no pipeline. It
 * goes out as a `chat` command over the socket and comes back as a
 * `direct.message` event carrying the exchange. If the socket is down the same
 * conversation is served by `POST /api/chat`, so the thread keeps working - both
 * paths land in the same place in the store.
 *
 * This is extracted from the employee panel because the office now shows a
 * conversation in two places (the inspector's Chat tab and the agent view), and
 * two copies of a chat composer would drift apart.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';

import type { ClientCommand, DirectMessage } from '@dev3d/core';

import { api } from '../app/api';
import { formatAgo } from '../app/format';
import { useAutoScroll, useNow } from '../app/hooks';
import { useMessages, useStore } from '../app/StoreContext';
import { Badge, cx } from './ui';

export interface ChatThreadProps {
  employeeId: string;
  employeeName: string;
  /** Shown above the thread - used by the popout to offer an employee picker. */
  header?: ReactNode;
  /** Muted copy for an empty thread; the default explains what a DM is. */
  emptyHint?: ReactNode;
  className?: string;
}

export function ChatThread({ employeeId, employeeName, header, emptyHint, className }: ChatThreadProps) {
  const store = useStore();
  const messages = useMessages();
  const now = useNow(1000);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const thread: DirectMessage[] = useMemo(() => messages[employeeId] ?? [], [messages, employeeId]);
  const autoScroll = useAutoScroll(thread.length + (sending ? 1 : 0));

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    const at = Date.now();
    // Optimistic echo under a local id: the server's copy of the same message
    // arrives with its own id, so this one is a placeholder rather than a
    // duplicate that has to be reconciled.
    store.appendDirectMessage({ id: `local-${at}`, employeeId, role: 'user', text, at });
    setDraft('');
    setSendError(null);

    if (store.connected) {
      const command: ClientCommand = { type: 'chat', employeeId, text };
      store.send(command);
      return;
    }

    setSending(true);
    const result = await api.chat(employeeId, text);
    setSending(false);
    if (result.ok && result.data) store.ingestDirectMessages(employeeId, result.data);
    else setSendError(result.error ?? 'the chat request failed');
  }, [draft, employeeId, store]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className={cx('chat', className)}>
      {header}

      <div className="chat-scroll" ref={autoScroll.ref}>
        {thread.length === 0 && (
          <div className="dim small chat-empty">
            {emptyHint ?? (
              <>
                No messages yet. This is a conversation outside any pipeline: {employeeName} answers directly, with
                no run, stage or ceremony.
              </>
            )}
          </div>
        )}
        {thread.map((message) => (
          <div key={message.id} className={`chat-bubble chat-${message.role}`}>
            <div className="chat-meta mono small">
              {message.role === 'user' ? 'you' : employeeName}
              {message.route ? ` · ${message.route.modelId} (${message.route.tier})` : ''}
              {` · ${formatAgo(message.at, now)}`}
            </div>
            <div className="chat-text">{message.text}</div>
          </div>
        ))}
        {sending && <div className="chat-bubble chat-employee chat-pending">…{employeeName} is thinking</div>}
      </div>

      {!autoScroll.pinned && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={autoScroll.scrollToBottom}>
          Jump to latest
        </button>
      )}
      {sendError !== null && <div className="alert alert-danger small">chat failed: {sendError}</div>}

      <textarea
        className="chat-input"
        rows={2}
        value={draft}
        placeholder={`Ask ${employeeName} something…  (⌘/ctrl + ↵ to send)`}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={`Message ${employeeName}`}
      />
      <div className="chat-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void send()}
          disabled={draft.trim().length === 0 || sending}
        >
          Send
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft('')} disabled={draft.length === 0}>
          Clear
        </button>
        {!store.connected && <Badge tone="warn">socket down — using /api/chat</Badge>}
      </div>
    </div>
  );
}
