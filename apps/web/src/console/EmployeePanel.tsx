/**
 * Selected employee: who they are, what they are doing right now, and how to
 * talk to them directly.
 *
 * The conversation itself lives in `ChatThread`, which the office shows in two
 * places (here and the inspector's Chat tab). This panel is about the person:
 * their live status, the routing decision behind their last turn, their
 * lifetime cost, and what they have been working on.
 */

import { useMemo } from 'react';

import type { TurnRecord } from '@dev3d/core';

import { formatAgo, formatDuration, formatInt, formatTokens, formatUsd, tierClassName, truncate } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useSelection, useSkills, useStore, useTurns } from '../app/StoreContext';
import { STATUS_LABEL } from '../app/status';
import { ChatThread } from './ChatThread';
import { Badge, Empty, Metric, Panel } from './ui';

export function EmployeePanel() {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const turns = useTurns();
  const skills = useSkills();
  const now = useNow(1000);

  const employeeId = selection.employeeId;
  const employee = useMemo(
    () => (employeeId ? office?.employees.find((candidate) => candidate.id === employeeId) ?? null : null),
    [office, employeeId],
  );
  const role = useMemo(
    () => (employee ? office?.roles.find((candidate) => candidate.id === employee.roleId) ?? null : null),
    [office, employee],
  );
  const department = useMemo(
    () => (role ? office?.departments.find((candidate) => candidate.id === role.departmentId) ?? null : null),
    [office, role],
  );

  const skillNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const skill of skills.skills ?? []) map.set(skill.id, skill.name);
    return map;
  }, [skills.skills]);

  const recentTurns = useMemo<TurnRecord[]>(() => {
    if (!employeeId) return [];
    const collected: TurnRecord[] = [];
    for (const byId of Object.values(turns)) {
      for (const turn of Object.values(byId)) {
        if (turn.employeeId === employeeId) collected.push(turn);
      }
    }
    collected.sort((a, b) => b.startedAt - a.startedAt);
    return collected.slice(0, 6);
  }, [turns, employeeId]);

  if (!office) {
    return (
      <Panel title="Employee" subtitle="live status, routing and direct messages">
        <Empty title="Nothing selected" hint="Waiting for office state from the orchestrator." />
      </Panel>
    );
  }

  if (!employeeId || !employee) {
    return (
      <Panel title="Employee" subtitle="live status, routing and direct messages">
        <Empty
          title="No employee selected"
          hint="Click an avatar in the office or a row in the org chart to inspect someone."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title={
        <span className="inline-gap">
          {employee.displayName}
          <Badge tone={employee.status === 'error' ? 'danger' : employee.status === 'blocked' ? 'warn' : 'neutral'}>
            {STATUS_LABEL[employee.status]}
          </Badge>
        </span>
      }
      subtitle={
        <span className="inline-gap">
          <span>{employee.title}</span>
          {department && <span style={{ color: department.color }}>· {department.name}</span>}
          <span className="mono dim">· {employee.id}</span>
        </span>
      }
      actions={
        employee.currentRunId ? (
          <button type="button" className="btn btn-sm" onClick={() => store.selectRun(employee.currentRunId)}>
            Open run
          </button>
        ) : null
      }
    >
      <div className="employee-activity">
        <div className="field-label">Current activity</div>
        <div className="activity-line">{employee.activity ?? <span className="dim">nothing in flight</span>}</div>
        <div className="dim small mono">
          seat {employee.seatId ?? 'hot-desking'} · room {employee.roomId ?? '—'} · turn {employee.currentTurnId ?? '—'}
        </div>
      </div>

      {employee.lastError !== null && employee.lastError !== undefined && (
        <div className="alert alert-danger" role="alert">
          <span className="strong">Last error</span>
          <span className="mono small">{employee.lastError}</span>
        </div>
      )}

      <div className="metrics-grid">
        <Metric label="Turns (lifetime)" value={formatInt(employee.lifetime.turns)} />
        <Metric label="Tokens" value={formatTokens(employee.lifetime.tokensIn, employee.lifetime.tokensOut)} />
        <Metric label="Spend (lifetime)" value={formatUsd(employee.lifetime.costUsd)} />
        <Metric
          label="Skills in context"
          value={employee.activeSkillIds.length > 0 ? `${employee.activeSkillIds.length}` : '0'}
        />
      </div>

      <div className="role-section">
        <div className="role-section-title">Active skills</div>
        {employee.activeSkillIds.length === 0 ? (
          <span className="dim small">no skills pulled into context for the current turn</span>
        ) : (
          <span className="chips">
            {employee.activeSkillIds.map((skillId) => (
              <Badge key={skillId} tone="accent" title={skillId}>
                {skillNames.get(skillId) ?? skillId}
              </Badge>
            ))}
          </span>
        )}
        {role && (
          <div className="dim small" style={{ marginTop: '4px' }}>
            role skills: {role.skillIds.join(', ')}
          </div>
        )}
      </div>

      <div className="role-section">
        <div className="role-section-title">Last routing decision</div>
        {employee.lastRoute ? (
          <div className="route-card">
            <div className="inline-gap">
              <span className="mono strong">{employee.lastRoute.modelId}</span>
              <span className={tierClassName(employee.lastRoute.tier)}>{employee.lastRoute.tier}</span>
              <span className="dim small mono">{employee.lastRoute.providerId}</span>
              <span className="dim small">{formatAgo(employee.lastRoute.at, now)}</span>
            </div>
            <div className="small">{employee.lastRoute.reason}</div>
          </div>
        ) : (
          <span className="dim small">no route decision recorded yet</span>
        )}
      </div>

      <div className="role-section">
        <div className="role-section-title">Recent turns</div>
        {recentTurns.length === 0 ? (
          <span className="dim small">this employee has not taken a turn yet in this session</span>
        ) : (
          <ul className="turn-list">
            {recentTurns.map((turn) => (
              <li key={turn.id}>
                <button type="button" className="turn-row" onClick={() => store.selectRun(turn.runId)}>
                  <span className="strong">{turn.purpose}</span>
                  <span className={tierClassName(turn.route.tier)}>{turn.route.tier}</span>
                  <span className="dim small mono">{turn.status}</span>
                  <span className="dim small mono">
                    {formatDuration((turn.endedAt ?? now) - turn.startedAt)} · {formatUsd(turn.usage.costUsd)}
                  </span>
                  <span className="turn-excerpt dim small">{truncate(turn.text.replace(/\s+/g, ' '), 120)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="role-section">
        <div className="role-section-title">Direct message</div>
        <ChatThread employeeId={employee.id} employeeName={employee.displayName} />
      </div>
    </Panel>
  );
}
