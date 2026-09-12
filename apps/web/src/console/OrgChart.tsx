/**
 * The org chart.
 *
 * Renders the real hierarchy from `roles` + `reportsTo` using the core helpers
 * (`directReports`, `chainOfCommand`), coloured by department. Selecting a role
 * both selects that employee in the office (so the 3D view rings them) and opens
 * the role editor: mission, responsibilities, skills, allowed tools, model
 * policy, and the seat it occupies.
 *
 * Everything a user can change here is a real `ClientCommand`: `setModelPolicy`,
 * `setRoleGrants`, `setSeat`, `hire`, `fire`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type {
  ClientCommand,
  Department,
  EmployeeState,
  ModelPolicy,
  ModelTier,
  Role,
  Seniority,
  TaskClass,
} from '@dev3d/core';
import { MODEL_TIER_ORDER, TASK_CLASSES, chainOfCommand, directReports } from '@dev3d/core';

import { api, type RoleTemplate, type ToolSummary } from '../app/api';
import { humaniseToken } from '../app/format';
import { useOffice, useSelection, useSkills, useStore } from '../app/StoreContext';
import { STATUS_COLOR, STATUS_LABEL } from '../app/status';
import { Badge, Chips, Dot, Empty, KeyValue, Panel } from './ui';

const TIERS: readonly ModelTier[] = MODEL_TIER_ORDER;
const SENIORITIES: readonly Seniority[] = ['executive', 'lead', 'senior', 'mid', 'junior'];

export interface OrgChartProps {
  /** `Seat_*` names discovered in the office model, for the seat picker. */
  seatIds: string[];
}

export function OrgChart({ seatIds }: OrgChartProps) {
  const office = useOffice();
  const skills = useSkills();
  const selection = useSelection();
  const store = useStore();
  const [query, setQuery] = useState('');
  const [showHire, setShowHire] = useState(false);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);

  // The tool list is what makes a plugin-registered tool grantable at all, so it
  // is read once and refreshed whenever the plugin set changes - a tool appearing
  // or disappearing is exactly a plugin being enabled or disabled.
  const pluginSignature = useMemo(
    () => (office?.plugins.records ?? []).map((record) => `${record.manifest.id}:${record.status}`).join(','),
    [office?.plugins.records],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [toolResult, templateResult] = await Promise.all([api.tools(), api.roleTemplates()]);
      if (cancelled) return;
      if (toolResult.ok && toolResult.data !== null) setTools(toolResult.data);
      if (templateResult.ok && templateResult.data !== null) setTemplates(templateResult.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginSignature]);

  const roles = office?.roles ?? [];
  const departments = office?.departments ?? [];
  const employees = office?.employees ?? [];

  const departmentById = useMemo(() => new Map(departments.map((department) => [department.id, department])), [departments]);
  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const skillNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const skill of skills.skills ?? []) map.set(skill.id, skill.name);
    return map;
  }, [skills.skills]);

  const roots = useMemo(() => {
    const sorted = roles.slice().sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    const filtered = query.trim().length === 0
      ? sorted
      : sorted.filter((role) => {
          const haystack = `${role.displayName} ${role.title} ${role.id} ${role.departmentId}`.toLowerCase();
          return haystack.includes(query.trim().toLowerCase());
        });
    const ids = new Set(filtered.map((role) => role.id));
    return filtered.filter((role) => {
      if (role.reportsTo === null) return true;
      // A filtered-out parent would orphan its subtree; keep the child at the root.
      return !ids.has(role.reportsTo);
    });
  }, [roles, query]);

  const selectedRoleId = selection.employeeId;
  const selectedRole = useMemo(() => {
    if (!selectedRoleId) return null;
    return roles.find((role) => role.id === selectedRoleId) ?? null;
  }, [roles, selectedRoleId]);

  const fire = useCallback(
    (roleId: string) => {
      const command: ClientCommand = { type: 'fire', roleId };
      store.send(command);
    },
    [store],
  );

  const hire = useCallback(
    (role: Role) => {
      const command: ClientCommand = { type: 'hire', role };
      if (store.send(command)) setShowHire(false);
    },
    [store],
  );

  const setSeat = useCallback(
    (employeeId: string, seatId: string | null, roomId: string | null) => {
      const command: ClientCommand = { type: 'setSeat', employeeId, seatId, roomId };
      store.send(command);
    },
    [store],
  );

  const setModelPolicy = useCallback(
    (roleId: string, policy: ModelPolicy) => {
      const command: ClientCommand = { type: 'setModelPolicy', roleId, policy };
      store.send(command);
    },
    [store],
  );

  const setGrants = useCallback(
    (roleId: string, patch: { allowedTools?: string[]; skillIds?: string[] }) => {
      const command: ClientCommand = { type: 'setRoleGrants', roleId, ...patch };
      store.send(command);
    },
    [store],
  );

  if (!office) {
    return (
      <Panel title="Organisation" subtitle="hierarchy, roles and model policy">
        <Empty title="No org chart yet" hint="The orchestrator has not sent office state. The console will fill in as soon as the socket connects." />
      </Panel>
    );
  }

  return (
    <Panel
      title="Organisation"
      subtitle={`${roles.length} roles · ${departments.length} departments`}
      flush
      actions={
        <>
          <input
            className="input input-sm"
            type="search"
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
            placeholder="filter roles"
            aria-label="Filter roles"
          />
          <button type="button" className="btn btn-sm" onClick={() => setShowHire((open) => !open)}>
            {showHire ? 'Cancel hire' : 'Hire'}
          </button>
        </>
      }
    >
      {showHire && (
        <HireForm roles={roles} departments={departments} seatIds={seatIds} templates={templates} onSubmit={hire} />
      )}

      <div className="org-tree">
        {roots.length === 0 && <Empty title="No roles match" hint={query.length > 0 ? `Nothing matches “${query}”.` : undefined} />}
        {roots.map((role) => (
          <RoleNode
            key={role.id}
            role={role}
            depth={0}
            roles={roles}
            departmentById={departmentById}
            employeeById={employeeById}
            selectedId={selectedRoleId}
            onSelect={(employeeId) => store.selectEmployee(employeeId)}
          />
        ))}
      </div>

      {selectedRole ? (
        <RoleEditor
          key={selectedRole.id}
          role={selectedRole}
          department={departmentById.get(selectedRole.departmentId) ?? null}
          employee={employeeById.get(selectedRole.id) ?? null}
          chain={chainOfCommand(roles, selectedRole.id)}
          skillNames={skillNames}
          seatIds={seatIds}
          tools={tools}
          onSetModelPolicy={setModelPolicy}
          onSetGrants={setGrants}
          onSetSeat={setSeat}
          onFire={fire}
          onSelect={store.selectEmployee}
        />
      ) : (
        <div className="org-hint dim">Select a role to see its mission, skills, tools and model policy.</div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------- tree

interface RoleNodeProps {
  role: Role;
  depth: number;
  roles: Role[];
  departmentById: Map<string, Department>;
  employeeById: Map<string, EmployeeState>;
  selectedId: string | null;
  onSelect: (employeeId: string) => void;
}

function RoleNode({ role, depth, roles, departmentById, employeeById, selectedId, onSelect }: RoleNodeProps) {
  const children = directReports(roles, role.id);
  const department = departmentById.get(role.departmentId);
  const employee = employeeById.get(role.id);
  const status = employee?.status ?? 'offline';
  const colour = department?.color ?? STATUS_COLOR[status];

  return (
    <div className="org-node">
      <button
        type="button"
        className={`org-row${selectedId === role.id ? ' org-row-selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px`, borderLeftColor: colour }}
        onClick={() => onSelect(role.id)}
        title={`${role.displayName} — ${role.title}`}
      >
        <Dot color={STATUS_COLOR[status]} />
        <span className="org-name strong">{role.displayName}</span>
        <span className="org-title dim">{role.title}</span>
        <Badge tone="neutral">{role.seniority}</Badge>
        {department && <span className="org-dept" style={{ color: colour }}>{department.name}</span>}
        <span className="org-status dim small mono">{STATUS_LABEL[status]}</span>
      </button>
      {children.map((child) => (
        <RoleNode
          key={child.id}
          role={child}
          depth={depth + 1}
          roles={roles}
          departmentById={departmentById}
          employeeById={employeeById}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------- role editor

interface RoleEditorProps {
  role: Role;
  department: Department | null;
  employee: EmployeeState | null;
  chain: Role[];
  skillNames: Map<string, string>;
  seatIds: string[];
  tools: ToolSummary[];
  onSetModelPolicy: (roleId: string, policy: ModelPolicy) => void;
  onSetGrants: (roleId: string, patch: { allowedTools?: string[]; skillIds?: string[] }) => void;
  onSetSeat: (employeeId: string, seatId: string | null, roomId: string | null) => void;
  onFire: (roleId: string) => void;
  onSelect: (employeeId: string | null) => void;
}

function RoleEditor({
  role,
  department,
  employee,
  chain,
  skillNames,
  seatIds,
  tools,
  onSetModelPolicy,
  onSetGrants,
  onSetSeat,
  onFire,
  onSelect,
}: RoleEditorProps) {
  const [confirmFire, setConfirmFire] = useState(false);
  const chainLabel = chain.map((entry) => entry.displayName).join(' → ');

  return (
    <div className="role-editor">
      <div className="role-editor-head" style={{ borderLeftColor: department?.color ?? '#334155' }}>
        <div>
          <div className="strong">
            {role.displayName} · {role.title}
          </div>
          <div className="dim small mono">{role.id}</div>
        </div>
        <div className="role-editor-actions">
          <button type="button" className="btn btn-sm" onClick={() => onSelect(role.id)}>
            Focus in office
          </button>
          {confirmFire ? (
            <>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => onFire(role.id)}>
                Confirm fire
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmFire(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmFire(true)} disabled={role.reportsTo === null}>
              {role.reportsTo === null ? 'cannot fire the CEO' : 'Fire'}
            </button>
          )}
        </div>
      </div>

      <p className="role-mission">{role.mission}</p>

      <div className="kv-grid">
        <KeyValue label="Department">{department ? `${department.name} — ${department.mission}` : role.departmentId}</KeyValue>
        <KeyValue label="Reports to">{role.reportsTo ?? '— (top of the org)'}</KeyValue>
        <KeyValue label="Chain of command">{chainLabel}</KeyValue>
        <KeyValue label="Can delegate">
          {role.canDelegate ? `yes · up to ${role.maxDirectReports} reports` : 'no'}
        </KeyValue>
        <KeyValue label="Max turns / stage" mono>
          {role.maxTurnsPerStage}
        </KeyValue>
        <KeyValue label="Voice">{role.persona.voice}</KeyValue>
        {role.persona.debateStyle !== undefined && <KeyValue label="Debate style">{role.persona.debateStyle}</KeyValue>}
      </div>

      <div className="role-section">
        <div className="role-section-title">Accountable for</div>
        <ul className="tight-list">
          {role.responsibilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="role-section">
        <div className="role-section-title">Values</div>
        <Chips values={role.persona.values} />
      </div>

      <div className="role-section">
        <div className="role-section-title">
          Skills <span className="dim small">({role.skillIds.length})</span>
        </div>
        <span className="chips">
          {role.skillIds.map((skillId) => (
            <Badge key={skillId} tone="accent" title={skillId}>
              {skillNames.get(skillId) ?? humaniseToken(skillId)}
            </Badge>
          ))}
        </span>
      </div>

      <div className="role-section">
        <div className="role-section-title">Allowed tools</div>
        <Chips values={role.allowedTools} tone="info" />
        <ToolGrantEditor role={role} tools={tools} onApply={(allowedTools) => onSetGrants(role.id, { allowedTools })} />
      </div>

      <div className="role-section">
        <div className="role-section-title">Desk</div>
        <div className="seat-row">
          <select
            value={employee?.seatId ?? role.seatId ?? ''}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const value = event.target.value;
              onSetSeat(role.id, value.length === 0 ? null : value, role.roomId);
            }}
            aria-label={`Seat for ${role.displayName}`}
          >
            <option value="">hot-desking (no seat)</option>
            {seatIds.map((seatId) => (
              <option key={seatId} value={seatId}>
                {seatId}
              </option>
            ))}
            {employee?.seatId !== null && employee?.seatId !== undefined && !seatIds.includes(employee.seatId) && (
              <option value={employee.seatId}>{employee.seatId} (not in model)</option>
            )}
          </select>
          <span className="dim small mono">
            room {role.roomId ?? '—'} · live seat {employee?.seatId ?? 'none'}
          </span>
        </div>
      </div>

      <ModelPolicyEditor role={role} onApply={(policy) => onSetModelPolicy(role.id, policy)} />
    </div>
  );
}

// ------------------------------------------------------- tool grants

/**
 * Grant or revoke tools for one role.
 *
 * This is what makes a plugin's tool usable: a tool a plugin registers is
 * namespaced and unknown to the shipped org chart, so without this the only way
 * to hand it to someone was to hire a role that already named it. The server
 * filters the list against the registry, so an unknown name cannot be granted
 * even by a hand-crafted command.
 */
function ToolGrantEditor({
  role,
  tools,
  onApply,
}: {
  role: Role;
  tools: readonly ToolSummary[];
  onApply: (allowedTools: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const granted = useMemo(() => new Set(role.allowedTools), [role.allowedTools]);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(role.allowedTools));

  // Re-seed when the role or its grants change underneath, so a grant made
  // elsewhere is reflected rather than silently overwritten on the next tick.
  useEffect(() => {
    setDraft(new Set(role.allowedTools));
  }, [role.allowedTools]);

  const dirty = draft.size !== granted.size || [...draft].some((name) => !granted.has(name));
  const known = tools.length > 0;

  if (!open) {
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
        Change tools
      </button>
    );
  }

  return (
    <div className="grant-editor">
      {!known && <div className="dim small">The tool list has not been read yet.</div>}
      <div className="grant-grid">
        {tools.map((tool) => (
          <label className="grant-row" key={tool.name}>
            <input
              type="checkbox"
              checked={draft.has(tool.name)}
              onChange={(event) => {
                const next = new Set(draft);
                if (event.target.checked) next.add(tool.name);
                else next.delete(tool.name);
                setDraft(next);
              }}
            />
            <span className="strong mono small">{tool.name}</span>
            {tool.pluginId !== null && (
              <Badge tone="info" title={`Registered by the plugin "${tool.pluginId}"`}>
                plugin
              </Badge>
            )}
            <span className="dim small grant-detail">{tool.description}</span>
          </label>
        ))}
      </div>
      <div className="grant-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!dirty || draft.size === 0}
          onClick={() => {
            onApply([...draft]);
            setOpen(false);
          }}
        >
          Save {draft.size} tool{draft.size === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setDraft(new Set(role.allowedTools));
            setOpen(false);
          }}
        >
          Cancel
        </button>
        {draft.size === 0 && <span className="dim small">An employee has to keep at least one tool.</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------- model policy

function isTaskClass(value: string): value is TaskClass {
  return (TASK_CLASSES as readonly string[]).includes(value);
}

function ModelPolicyEditor({ role, onApply }: { role: Role; onApply: (policy: ModelPolicy) => void }) {
  const office = useOffice();
  const policy = role.modelPolicy;
  const [defaultTier, setDefaultTier] = useState<ModelTier>(policy.defaultTier);
  const [minTier, setMinTier] = useState<ModelTier>(policy.minTier);
  const [maxTier, setMaxTier] = useState<ModelTier>(policy.maxTier);
  const [preferredModelId, setPreferredModelId] = useState<string>(policy.preferredModelId ?? '');
  const [overrides, setOverrides] = useState<Partial<Record<TaskClass, ModelTier>>>({ ...(policy.byTaskClass ?? {}) });
  const [escalateAt, setEscalateAt] = useState<string>(policy.escalateAtComplexity !== undefined ? String(policy.escalateAtComplexity) : '');
  const [escalateTo, setEscalateTo] = useState<ModelTier | ''>(policy.escalateTo ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>(policy.maxOutputTokens !== undefined ? String(policy.maxOutputTokens) : '');
  const [pin, setPin] = useState<boolean>(policy.pin === true);
  const [newClass, setNewClass] = useState<TaskClass>('coding');
  const [newTier, setNewTier] = useState<ModelTier>('standard');
  const [applied, setApplied] = useState(false);

  /**
   * The models this role may actually be pinned to.
   *
   * Sourced from the live catalog rather than a literal, so the list is whatever
   * the providers reported - and filtered to the policy's own tier bounds, since
   * a pin outside them is refused by the router and offering one would be
   * offering a setting that cannot work.
   */
  const pinChoices = useMemo(() => {
    const minRank = MODEL_TIER_ORDER.indexOf(minTier);
    const maxRank = MODEL_TIER_ORDER.indexOf(maxTier);
    return (office?.models ?? [])
      .filter((model) => {
        const rank = MODEL_TIER_ORDER.indexOf(model.tier);
        return rank >= minRank && rank <= maxRank;
      })
      .sort((a, b) => a.tier.localeCompare(b.tier) || a.label.localeCompare(b.label));
  }, [office?.models, minTier, maxTier]);

  const overrideEntries = useMemo(
    () => Object.entries(overrides).filter((entry): entry is [string, ModelTier] => typeof entry[1] === 'string'),
    [overrides],
  );

  const dirty =
    defaultTier !== policy.defaultTier ||
    minTier !== policy.minTier ||
    maxTier !== policy.maxTier ||
    preferredModelId !== (policy.preferredModelId ?? '') ||
    pin !== (policy.pin === true) ||
    escalateAt !== (policy.escalateAtComplexity !== undefined ? String(policy.escalateAtComplexity) : '') ||
    escalateTo !== (policy.escalateTo ?? '') ||
    maxOutputTokens !== (policy.maxOutputTokens !== undefined ? String(policy.maxOutputTokens) : '') ||
    JSON.stringify(overrides) !== JSON.stringify(policy.byTaskClass ?? {});

  const apply = useCallback(() => {
    const parsedComplexity = Number.parseFloat(escalateAt);
    const parsedTokens = Number.parseInt(maxOutputTokens, 10);
    const next: ModelPolicy = {
      defaultTier,
      minTier,
      maxTier,
      ...(preferredModelId !== '' ? { preferredModelId } : {}),
      ...(Number.isFinite(parsedComplexity) ? { escalateAtComplexity: Math.min(1, Math.max(0, parsedComplexity)) } : {}),
      ...(escalateTo !== '' ? { escalateTo } : {}),
      ...(Number.isFinite(parsedTokens) && parsedTokens > 0 ? { maxOutputTokens: parsedTokens } : {}),
      ...(pin ? { pin: true } : {}),
      ...(overrideEntries.length > 0
        ? {
            byTaskClass: overrideEntries.reduce<Partial<Record<TaskClass, ModelTier>>>((acc, [taskClass, tier]) => {
              if (isTaskClass(taskClass)) acc[taskClass] = tier;
              return acc;
            }, {}),
          }
        : {}),
    };
    onApply(next);
    setApplied(true);
  }, [defaultTier, escalateAt, escalateTo, maxOutputTokens, maxTier, minTier, onApply, overrideEntries, pin, preferredModelId]);

  return (
    <div className="role-section policy-editor">
      <div className="role-section-title">
        Model policy
        {dirty && <Badge tone="warn">unsaved</Badge>}
        {!dirty && applied && <Badge tone="ok">applied</Badge>}
      </div>
      <div className="policy-row">
        <label className="field">
          <span className="field-label">Default tier</span>
          <select value={defaultTier} onChange={(event) => setDefaultTier(event.target.value as ModelTier)}>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Min tier</span>
          <select value={minTier} onChange={(event) => setMinTier(event.target.value as ModelTier)}>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Max tier</span>
          <select value={maxTier} onChange={(event) => setMaxTier(event.target.value as ModelTier)}>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-check">
          <input type="checkbox" checked={pin} onChange={(event) => setPin(event.target.checked)} />
          <span>pin (never escalate)</span>
        </label>
      </div>

      <div className="policy-row">
        <label className="field field-wide">
          <span className="field-label">Pin to a specific model</span>
          <select
            value={preferredModelId}
            onChange={(event) => setPreferredModelId(event.target.value)}
            title="Tiers keep a policy portable; a pin is for when you know exactly which model this role must run on."
          >
            <option value="">no pin — let the router choose within the tiers</option>
            {pinChoices.map((model) => (
              <option key={`${model.providerId}/${model.id}`} value={model.id}>
                {model.label} · {model.providerId}/{model.id} ({model.tier})
              </option>
            ))}
          </select>
          <span className="dim small">
            {preferredModelId === ''
              ? `${pinChoices.length} model(s) within ${minTier}..${maxTier} available to pin`
              : 'a pin is honoured inside the min/max tiers above; one outside them is refused and reported'}
          </span>
        </label>
      </div>

      <div className="policy-row">
        <label className="field field-narrow">
          <span className="field-label">Escalate at complexity</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={escalateAt}
            placeholder="—"
            onChange={(event) => setEscalateAt(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Escalate to</span>
          <select value={escalateTo} onChange={(event) => setEscalateTo(event.target.value as ModelTier | '')}>
            <option value="">never</option>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-narrow">
          <span className="field-label">Max output tokens</span>
          <input
            type="number"
            min={0}
            step={256}
            value={maxOutputTokens}
            placeholder="default"
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </label>
      </div>

      <div className="policy-overrides">
        <div className="field-label">Per-task-class overrides</div>
        {overrideEntries.length === 0 && <div className="dim small">none — the default tier is used everywhere</div>}
        {overrideEntries.map(([taskClass, tier]) => (
          <div className="policy-override-row" key={taskClass}>
            <span className="mono small">{taskClass}</span>
            <select
              value={tier}
              onChange={(event) => {
                const value = event.target.value as ModelTier;
                setOverrides((current) => (isTaskClass(taskClass) ? { ...current, [taskClass]: value } : current));
              }}
              aria-label={`Tier for ${taskClass}`}
            >
              {TIERS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setOverrides((current) => {
                  const next = { ...current };
                  if (isTaskClass(taskClass)) delete next[taskClass];
                  return next;
                })
              }
            >
              remove
            </button>
          </div>
        ))}
        <div className="policy-override-row">
          <select value={newClass} onChange={(event) => setNewClass(event.target.value as TaskClass)} aria-label="Task class">
            {TASK_CLASSES.filter((taskClass) => overrides[taskClass] === undefined).map((taskClass) => (
              <option key={taskClass} value={taskClass}>
                {taskClass}
              </option>
            ))}
          </select>
          <select value={newTier} onChange={(event) => setNewTier(event.target.value as ModelTier)} aria-label="Tier">
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOverrides((current) => ({ ...current, [newClass]: newTier }))}
            disabled={overrides[newClass] !== undefined}
          >
            add override
          </button>
        </div>
      </div>

      <div className="policy-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={apply} disabled={!dirty}>
          Apply policy
        </button>
        <span className="dim small">
          sends <span className="mono">setModelPolicy</span> for {role.id}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- hire form

interface HireFormProps {
  roles: Role[];
  departments: Department[];
  seatIds: string[];
  templates: RoleTemplate[];
  onSubmit: (role: Role) => void;
}

function HireForm({ roles, departments, seatIds, templates, onSubmit }: HireFormProps) {
  const [templateId, setTemplateId] = useState<string>(roles[0]?.id ?? '');
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState<string>(departments[0]?.id ?? '');
  const [reportsTo, setReportsTo] = useState<string>('');
  const [seatId, setSeatId] = useState<string>('');
  const [seniority, setSeniority] = useState<Seniority>('mid');

  // A template is either one of this floor's roles or one a plugin offers. The
  // value is namespaced so the two sources cannot collide.
  const template = useMemo(() => {
    if (templateId.startsWith('plugin:')) {
      const key = templateId.slice('plugin:'.length);
      return templates.find((entry) => `${entry.pluginId}/${entry.role.id}` === key)?.role ?? roles[0] ?? null;
    }
    return roles.find((role) => role.id === templateId) ?? roles[0] ?? null;
  }, [roles, templates, templateId]);
  const valid = id.trim().length > 0 && displayName.trim().length > 0 && title.trim().length > 0 && template !== null;

  const submit = (): void => {
    if (!valid || !template) return;
    const role: Role = {
      ...template,
      id: id.trim(),
      displayName: displayName.trim(),
      title: title.trim(),
      departmentId: departmentId || template.departmentId,
      seniority,
      reportsTo: reportsTo.length > 0 ? reportsTo : template.reportsTo,
      seatId: seatId.length > 0 ? seatId : null,
      appearance: { ...template.appearance },
      responsibilities: [...template.responsibilities],
      skillIds: [...template.skillIds],
      allowedTools: [...template.allowedTools],
      modelPolicy: { ...template.modelPolicy, ...(template.modelPolicy.byTaskClass ? { byTaskClass: { ...template.modelPolicy.byTaskClass } } : {}) },
      persona: { ...template.persona, values: [...template.persona.values] },
    };
    onSubmit(role);
    setId('');
    setDisplayName('');
    setTitle('');
  };

  return (
    <div className="hire-form">
      <div className="hire-grid">
        <label className="field">
          <span className="field-label">Clone from</span>
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <optgroup label={`This floor's roles`}>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.displayName} · {role.title}
                </option>
              ))}
            </optgroup>
            {templates.length > 0 && (
              <optgroup label="Templates from plugins">
                {templates.map((entry) => (
                  <option key={`${entry.pluginId}/${entry.role.id}`} value={`plugin:${entry.pluginId}/${entry.role.id}`}>
                    {entry.role.displayName} · {entry.role.title} ({entry.pluginId})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Role id</span>
          <input value={id} onChange={(event) => setId(event.target.value)} placeholder="frontend-dev-3" spellCheck={false} />
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nadia" />
        </label>
        <label className="field">
          <span className="field-label">Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Frontend Engineer" />
        </label>
        <label className="field">
          <span className="field-label">Department</span>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Reports to</span>
          <select value={reportsTo} onChange={(event) => setReportsTo(event.target.value)}>
            <option value="">same as template ({template?.reportsTo ?? 'none'})</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.displayName} · {role.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Seat</span>
          <select value={seatId} onChange={(event) => setSeatId(event.target.value)}>
            <option value="">hot-desking</option>
            {seatIds.map((seat) => (
              <option key={seat} value={seat}>
                {seat}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Seniority</span>
          <select value={seniority} onChange={(event) => setSeniority(event.target.value as Seniority)}>
            {SENIORITIES.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="hire-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={!valid}>
          Hire into the org chart
        </button>
        <span className="dim small">
          sends <span className="mono">hire</span> — the new employee keeps the template's skills, tools and policy
        </span>
      </div>
    </div>
  );
}
