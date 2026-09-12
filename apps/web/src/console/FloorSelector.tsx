/**
 * The building's floor selector.
 *
 * One office building, many organisations, one floor each. Selecting a floor is
 * not a filter over a single company - it swaps the entire context (people,
 * skills, money, pipelines, runs) because that is what an organisation *is*
 * here. The server answers `selectWorkspace` with a fresh `office.updated`, so
 * every panel changes together.
 */

import { useOffice, useStore } from '../app/StoreContext';

export function FloorSelector() {
  const store = useStore();
  const office = useOffice();

  const workspaces = office?.workspaces ?? [];
  const activeId = office?.activeWorkspaceId ?? '';
  const active = workspaces.find((workspace) => workspace.id === activeId);
  if (workspaces.length === 0) return null;

  return (
    <div className="floors">
      <span className="floor-caption" aria-hidden="true">
        Floor
      </span>
      <span className="floor-dot" style={{ background: active?.color ?? '#a78bfa' }} aria-hidden="true" />
      <select
        className="floor-select"
        value={activeId}
        onChange={(event) => store.send({ type: 'selectWorkspace', workspaceId: event.target.value })}
        aria-label="Floor (organisation)"
        title={active ? `${active.name} · ${active.path}` : undefined}
        disabled={workspaces.length === 1}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            F{workspace.floor} · {workspace.name}
            {workspace.activeRuns > 0 ? ` · ${workspace.activeRuns} running` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
