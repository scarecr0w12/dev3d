/**
 * The approval interrupt.
 *
 * An approval is the one thing that stops the office completely: an employee is
 * blocked mid-turn until a human answers. The runs page keeps the full history,
 * but a pending request must not be something you have to go looking for, so it
 * floats over the stage where the work is happening. It is an interrupt on
 * purpose - hence `role="alert"` and the loud styling.
 */

import { useMemo, useState } from 'react';

import type { Approval, ApprovalKind, ClientCommand } from '@dev3d/core';

import { formatAgo } from '../app/format';
import { useNow } from '../app/hooks';
import { useApprovals, useOffice, useStore } from '../app/StoreContext';
import { Badge } from './ui';
import type { Tone } from './ui';

const KIND_TONE: Record<ApprovalKind, Tone> = {
  shell: 'warn',
  write: 'info',
  network: 'accent',
  spend: 'warn',
  risk: 'danger',
};

const KIND_HINT: Record<ApprovalKind, string> = {
  shell: 'run a command',
  write: 'write outside the scratch area',
  network: 'reach the network',
  spend: 'exceed a soft spend threshold',
  risk: 'the employee flagged its own action as risky',
};

/** How many requests get full inline controls before the rest are summarised. */
const INLINE_LIMIT = 2;

export function ApprovalCallout({ onOpenAll }: { onOpenAll?: () => void }) {
  const store = useStore();
  const office = useOffice();
  const approvals = useApprovals();
  const now = useNow(1000);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const pending = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending'),
    [approvals],
  );

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of office?.employees ?? []) map.set(employee.id, employee.displayName);
    for (const role of office?.roles ?? []) if (!map.has(role.id)) map.set(role.id, role.displayName);
    return map;
  }, [office]);

  if (pending.length === 0) return null;

  const decide = (approval: Approval, approved: boolean): void => {
    const command: ClientCommand = { type: 'approve', approvalId: approval.id, approved };
    if (store.send(command)) setSent((current) => ({ ...current, [approval.id]: true }));
  };

  const inline = pending.slice(0, INLINE_LIMIT);
  const overflow = pending.length - inline.length;

  return (
    <div className="approval-callout" role="alert">
      <div className="approval-callout-head">
        <span className="dot pulse" style={{ background: '#fbbf24' }} aria-hidden="true" />
        <span className="strong">
          {pending.length} approval{pending.length === 1 ? '' : 's'} waiting
        </span>
        <span className="dim small">the office is blocked until these are answered</span>
        <span className="stage-spacer" />
        {onOpenAll && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAll}>
            all approvals
          </button>
        )}
      </div>

      <ul className="approval-callout-list">
        {inline.map((approval) => {
          const isOpen = expanded === approval.id;
          return (
            <li key={approval.id} className="approval-callout-item">
              <div className="approval-callout-line">
                <Badge tone={KIND_TONE[approval.kind]}>{approval.kind}</Badge>
                <span className="strong">{approval.summary}</span>
                <span className="stage-spacer" />
                <span className="dim small">{nameOf.get(approval.employeeId) ?? approval.employeeId}</span>
                <span className="dim small mono">{formatAgo(approval.requestedAt, now)}</span>
              </div>

              <div className="approval-callout-meta">
                <span className="dim small">{KIND_HINT[approval.kind]}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : approval.id)}
                >
                  {isOpen ? 'hide detail' : 'show detail'}
                </button>
                {approval.runId !== '' && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => store.selectRun(approval.runId)}>
                    open run
                  </button>
                )}
              </div>

              {isOpen && <pre className="approval-pre">{approval.detail}</pre>}

              <div className="approval-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => decide(approval, true)}
                  disabled={sent[approval.id] === true}
                >
                  {sent[approval.id] === true ? 'sending…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => decide(approval, false)}
                  disabled={sent[approval.id] === true}
                >
                  Reject
                </button>
                <span className="dim small">declining never retries on its own — the employee is told and moves on</span>
              </div>
            </li>
          );
        })}
      </ul>

      {overflow > 0 && (
        <div className="approval-callout-more dim small">
          and {overflow} more waiting —{' '}
          {onOpenAll ? (
            <button type="button" className="link" onClick={onOpenAll}>
              review them all
            </button>
          ) : (
            'open the runs page'
          )}
        </div>
      )}
    </div>
  );
}
