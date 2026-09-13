/**
 * Approval queue.
 *
 * When an employee wants to run a shell command, write outside the scratch
 * area, reach the network, or spend past a threshold, the office blocks and asks
 * a human. This panel is deliberately loud while anything is pending: an
 * approval is the one thing that stops the office dead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Approval, ApprovalKind, ClientCommand } from '@dev3d/core';

import { formatAgo, formatClock } from '../app/format';
import { useNow } from '../app/hooks';
import { useApprovals, useOffice, useStore } from '../app/StoreContext';
import { Badge, Empty, Panel } from './ui';
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

export function ApprovalsPanel() {
  const store = useStore();
  const office = useOffice();
  const approvals = useApprovals();
  const now = useNow(1000);
  const [sent, setSent] = useState<Record<string, boolean>>({});

  const pending = useMemo(() => approvals.filter((approval) => approval.status === 'pending'), [approvals]);
  const decided = useMemo(() => approvals.filter((approval) => approval.status !== 'pending'), [approvals]);
  const [showDecided, setShowDecided] = useState(false);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of office?.employees ?? []) map.set(employee.id, employee.displayName);
    for (const role of office?.roles ?? []) if (!map.has(role.id)) map.set(role.id, role.displayName);
    return map;
  }, [office]);

  const decide = useCallback(
    (approval: Approval, approved: boolean) => {
      const command: ClientCommand = { type: 'approve', approvalId: approval.id, approved };
      if (store.send(command)) setSent((current) => ({ ...current, [approval.id]: true }));
    },
    [store],
  );

  /**
   * A row stops being "sending…" as soon as the office says otherwise.
   *
   * `store.send` returning true means only that a transport was attached — not
   * that the server accepted the command. The local `sent` map was never cleared
   * for any approval, so a *failed* decision left the buttons on "sending…"
   * permanently and a decision made in another tab left a stuck row for an
   * approval that no longer existed. Anything not still pending re-enables the
   * controls, which covers both: the state comes from the approval itself rather
   * than from a timer guessing at a round trip.
   */
  useEffect(() => {
    if (pending.length === approvals.length) return;
    setSent((current) => {
      let changed = false;
      const next = { ...current };
      for (const approval of approvals) {
        if (approval.status === 'pending') continue;
        if (next[approval.id] === undefined) continue;
        delete next[approval.id];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [approvals, pending.length]);

  return (
    <Panel
      title={
        <span className="inline-gap">
          Approvals
          {pending.length > 0 && <Badge tone="warn">{pending.length} pending</Badge>}
        </span>
      }
      subtitle={
        pending.length > 0
          ? 'the office is blocked until these are answered'
          : decided.length > 0
            ? `${decided.length} decided this session`
            : 'nothing waiting on a human'
      }
      tone={pending.length > 0 ? 'warn' : 'default'}
      flush
      actions={
        decided.length > 0 ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDecided((open) => !open)}>
            {showDecided ? 'hide decided' : `show decided (${decided.length})`}
          </button>
        ) : null
      }
    >
      {pending.length === 0 ? (
        <Empty
          title="No approvals pending"
          hint="When an employee asks to run a command, write outside the workspace, or spend past a threshold, its request appears here."
        />
      ) : (
        <ul className="approval-list">
          {pending.map((approval) => (
            <li key={approval.id} className="approval approval-pending">
              <div className="approval-head">
                <Badge tone={KIND_TONE[approval.kind]}>{approval.kind}</Badge>
                <span className="strong">{approval.summary}</span>
                <span className="stage-spacer" />
                <span className="dim small">{nameOf.get(approval.employeeId) ?? approval.employeeId}</span>
                <span className="dim small mono">{formatAgo(approval.requestedAt, now)}</span>
              </div>
              <div className="approval-detail">
                <div className="dim small">
                  {KIND_HINT[approval.kind]} · requested {formatClock(approval.requestedAt)} · run{' '}
                  <button type="button" className="link mono" onClick={() => store.selectRun(approval.runId)}>
                    {approval.runId.slice(0, 12)}
                  </button>
                  {approval.turnId ? ` · turn ${approval.turnId.slice(0, 10)}` : ''}
                </div>
                <pre className="approval-pre">{approval.detail}</pre>
              </div>
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
                <span className="dim small mono">
                  sends approve(approvalId={approval.id.slice(0, 10)}…)
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showDecided && decided.length > 0 && (
        <ul className="approval-list approval-list-decided">
          {decided.map((approval) => (
            <li key={approval.id} className="approval">
              <div className="approval-head">
                <Badge tone={approval.status === 'approved' ? 'ok' : 'danger'}>{approval.status}</Badge>
                <Badge tone={KIND_TONE[approval.kind]}>{approval.kind}</Badge>
                <span>{approval.summary}</span>
                <span className="stage-spacer" />
                <span className="dim small">{nameOf.get(approval.employeeId) ?? approval.employeeId}</span>
                <span className="dim small mono">
                  {approval.decidedAt ? formatAgo(approval.decidedAt, now) : '—'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
