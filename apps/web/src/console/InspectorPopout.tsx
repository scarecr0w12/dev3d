/**
 * The inspector: everything about *one* thing, as a floating, resizable popout.
 *
 * Three surfaces share the space because they are the same act of looking
 * closely at the office - at a person, at a run, or at a conversation. The tab
 * follows what you clicked (an avatar opens Agent, selecting a run opens Run)
 * but is always yours to override.
 *
 * Two things make it usable rather than merely present:
 *
 *   - **It is yours to size.** Both inner edges drag, and the width is
 *     remembered. The pane is where the detail is read, so it is the one
 *     surface that does not get to decide for the reader how much room it needs.
 *   - **Each tab owns its own scrolling.** `Agent` and `Run` are master-detail:
 *     a compact chooser above a detail pane that takes the remaining height.
 *     Stacking both into one shared scroll is what made this cramped - the
 *     thing you selected would sit below the list you selected it from.
 */

import { useEffect, useMemo, useState } from 'react';

import { useApprovals, useOffice, useSelection, useStore } from '../app/StoreContext';
import { EmployeePanel } from './EmployeePanel';
import { VendorPanel } from './VendorsPanel';
import { EmployeeSwitcher } from './EmployeeSwitcher';
import { RunSwitcher } from './RunSwitcher';
import { RunTranscript } from './RunTranscript';
import { ChatThread } from './ChatThread';
import { QuickJump } from './QuickJump';
import { Badge, Empty, Tabs, cx } from './ui';
import type { PaneResizeHandlers } from '../app/hooks';
import { PluginPanels } from './plugins/PluginPanels';

export type InspectorTab = 'agent' | 'run' | 'chat';

export interface InspectorPopoutProps {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  /** Opens the quick-jump overlay. */
  onJump: () => void;
  jumping: boolean;
  onJumpingChange: (open: boolean) => void;
  widthResize: PaneResizeHandlers;
  heightResize: PaneResizeHandlers;
  onResetSize: () => void;
  /** True once the reader has dragged the bottom edge and chosen a height. */
  resizing?: boolean;
}

export function InspectorPopout({
  tab,
  onTab,
  onClose,
  onJump,
  jumping,
  onJumpingChange,
  widthResize,
  heightResize,
  onResetSize,
  resizing = false,
}: InspectorPopoutProps) {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const approvals = useApprovals();
  const [chatTarget, setChatTarget] = useState<string | null>(null);

  // The chat tab follows the selected employee unless the user picked someone
  // else explicitly in this popout.
  const chatEmployeeId = chatTarget ?? selection.employeeId;

  useEffect(() => {
    if (selection.employeeId !== null) setChatTarget(null);
  }, [selection.employeeId]);

  const employees = useMemo(() => {
    const list = [...(office?.employees ?? [])];
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return list;
  }, [office?.employees]);

  const chatEmployee = employees.find((employee) => employee.id === chatEmployeeId) ?? null;

  const activeRuns = office?.activeRunIds.length ?? 0;
  const pending = approvals.filter((approval) => approval.status === 'pending').length;

  return (
    <aside
      className={cx(
        'popout',
        'popout-right',
        'popout-inspector',
        resizing && 'is-sized',
        (widthResize.dragging || heightResize.dragging) && 'is-dragging',
      )}
      aria-label="Inspector"
    >
      {/* Drag the inner edge to size the pane. It is a mouse affordance, but it
          is not the only way to change the width: the same variable backs the
          Reset control, so a keyboard user can still get a different layout. */}
      <div
        className="pane-handle pane-handle-left"
        role="presentation"
        onPointerDown={widthResize.onPointerDown}
      />
      <div
        className="pane-handle pane-handle-bottom"
        role="presentation"
        onPointerDown={heightResize.onPointerDown}
      />

      <header className="popout-head">
        <div className="popout-heading">
          <div className="popout-title">Inspector</div>
          <div className="popout-sub">
            {pending > 0 ? `${pending} approval${pending === 1 ? '' : 's'} waiting` : 'live detail'}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onJump} title="Jump to anything (⌘/ctrl + K)">
          ⌕ Jump
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onResetSize}
          title="Reset the inspector to its default size"
        >
          Reset
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Hide inspector">
          ✕
        </button>
      </header>

      <div className="popout-tabs">
        <Tabs<InspectorTab>
          items={[
            { id: 'agent', label: 'Agent' },
            { id: 'run', label: 'Run', badge: activeRuns, tone: 'warn' },
            { id: 'chat', label: 'Chat' },
          ]}
          active={tab}
          onChange={onTab}
        />
      </div>

      {/* The body and the overlay are alternatives, not siblings: quick-jump is
          a mode you are in, so it replaces the pane's content rather than
          taking a slice of its height. */}
      {jumping ? (
        <QuickJump onClose={() => onJumpingChange(false)} />
      ) : (
        /* The class per tab is what switches the body from one shared scroll to
           per-tab master-detail - see styles.css. */
        <div className={cx('popout-body', `popout-body-${tab}`)}>
          {tab === 'agent' && (
            <>
              <EmployeeSwitcher />
              <div className="popout-detail">
                {/*
                  A vendor and an employee both answer "what did I just click",
                  and the Agent tab is that answer. They share the tab rather than
                  getting one each because they share the *slot*: the store keeps
                  at most one of the two selected, so exactly one of these panels
                  can ever have something to say.
                */}
                {selection.vendorId !== null ? <VendorPanel /> : <EmployeePanel />}
                <PluginPanels placement="inspector" className="plugin-panels-popout" />
              </div>
            </>
          )}

          {tab === 'run' && (
            <>
              <RunSwitcher />
              <div className="popout-detail">
                <RunTranscript />
              </div>
            </>
          )}

          {tab === 'chat' && (
            <>
              {employees.length === 0 ? (
                <Empty title="No employees" hint="The org chart is empty." />
              ) : (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="inspector-chat-target">
                      Talking to
                    </label>
                    <select
                      id="inspector-chat-target"
                      value={chatEmployee?.id ?? ''}
                      onChange={(event) => {
                        const next = event.target.value;
                        setChatTarget(next);
                        store.selectEmployee(next);
                      }}
                    >
                      <option value="" disabled>
                        choose an employee
                      </option>
                      {employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.displayName} · {employee.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  {chatEmployee ? (
                    <ChatThread
                      employeeId={chatEmployee.id}
                      employeeName={chatEmployee.displayName}
                      header={
                        <div className="chat-head">
                          <Badge tone="neutral">{chatEmployee.title}</Badge>
                          <span className="stage-spacer" />
                          <span className="dim small">
                            a conversation outside every pipeline: no run, no stage, no cost beyond the model call
                          </span>
                        </div>
                      }
                    />
                  ) : (
                    <Empty
                      title="Nobody selected"
                      hint="Pick an employee above, or click an avatar in the office."
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
