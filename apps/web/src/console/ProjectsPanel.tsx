/**
 * Projects: the workspaces the office can work in.
 *
 * A workspace is the confinement boundary for every tool call an employee
 * makes, so this panel is as much a permissions surface as it is a project
 * picker - it states plainly which directory agents will be able to read and
 * write, and refuses to hide that behind a form.
 *
 * Creation goes over HTTP rather than the socket so the form can show the
 * server's exact reason when a path is refused. The list itself still arrives as
 * an `org.updated` event, so it stays correct however it was changed.
 */

import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';

import { api } from '../app/api';
import { formatAgo, formatInt, formatUsd } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useStore } from '../app/StoreContext';
import { Badge, Empty, KeyValue, Panel, cx } from './ui';

interface FormState {
  name: string;
  folder: string;
  path: string;
  description: string;
}

const EMPTY_FORM: FormState = { name: '', folder: '', path: '', description: '' };

export function ProjectsPanel() {
  const store = useStore();
  const office = useOffice();
  const now = useNow(1000);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const workspaces = office?.workspaces ?? [];
  const root = office?.settings.workspacesRoot ?? '';
  const externalAllowed = office?.settings.allowExternalWorkspaces ?? false;

  // Per-organisation totals come from the server's summary, because a console
  // only ever holds the active organisation's runs.
  const activeId = office?.activeWorkspaceId ?? '';

  const set = (key: keyof FormState) => (event: ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const create = useCallback(async () => {
    const name = form.name.trim();
    if (name === '') {
      setError('Give the project a name.');
      return;
    }
    const folder = form.folder.trim();
    const explicitPath = form.path.trim();
    if (folder !== '' && explicitPath !== '') {
      setError('Give either a folder name or a full path, not both - they say the same thing twice.');
      return;
    }

    setBusy(true);
    setError(null);
    setCreated(null);
    const result = await api.createWorkspace({
      name,
      ...(form.description.trim() !== '' ? { description: form.description.trim() } : {}),
      ...(folder !== '' ? { folder } : {}),
      ...(explicitPath !== '' ? { path: explicitPath } : {}),
    });
    setBusy(false);

    if (!result.ok || !result.data) {
      setError(result.error ?? 'the request failed');
      return;
    }
    setCreated(result.data.path);
    setForm(EMPTY_FORM);
  }, [form]);

  const remove = useCallback(async (workspaceId: string) => {
    setBusy(true);
    setError(null);
    const result = await api.removeWorkspace(workspaceId);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) setError(result.error ?? 'the request failed');
  }, []);

  return (
    <Panel
      title="Projects"
      subtitle={
        workspaces.length === 0
          ? 'waiting for the orchestrator'
          : `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} · a run is confined to the project it was submitted to`
      }
      actions={
        root !== '' ? (
          <span className="dim small mono" title="New project folders are created here">
            root: {root}
          </span>
        ) : null
      }
    >
      <FloorSpace />

      <section className="project-form">
        <div className="field">
          <label className="field-label" htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            type="text"
            value={form.name}
            onChange={set('name')}
            placeholder="Customer portal"
            maxLength={60}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="project-folder">
            Folder name (optional)
          </label>
          <input
            id="project-folder"
            type="text"
            value={form.folder}
            onChange={set('folder')}
            placeholder="customer-portal"
            disabled={form.path.trim() !== ''}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="project-description">
            Description (optional)
          </label>
          <input
            id="project-description"
            type="text"
            value={form.description}
            onChange={set('description')}
            placeholder="the public marketing site"
          />
        </div>

        <div className="field project-field-wide">
          <label className="field-label" htmlFor="project-path">
            Existing directory (optional, absolute)
          </label>
          <input
            id="project-path"
            type="text"
            value={form.path}
            onChange={set('path')}
            placeholder="E:\\code\\existing-project"
            disabled={!externalAllowed || form.folder.trim() !== ''}
            spellCheck={false}
          />
        </div>
      </section>

      <div className="project-explain dim small">
        {form.path.trim() !== '' ? (
          <span className="project-warning">
            Employees will be able to read and write <strong>anything under that directory</strong>. Point this at a
            project the office should genuinely own.
          </span>
        ) : (
          <>
            A folder name is created under the workspaces root. Leaving it empty derives one from the name.
            {!externalAllowed && (
              <>
                {' '}
                <strong>External directories are disabled</strong> (DEV3D_ALLOW_EXTERNAL_WORKSPACES=false), so projects
                must live under the root.
              </>
            )}
          </>
        )}
      </div>

      <div className="project-actions">
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
          {busy ? 'working…' : 'Add project'}
        </button>
        {created !== null && (
          <span className="ok small">
            created · <span className="mono">{created}</span>
          </span>
        )}
      </div>

      {error !== null && (
        <div className="alert alert-danger small" role="alert">
          {error}
        </div>
      )}

      <div className="project-list">
        {workspaces.length === 0 ? (
          <Empty title="No projects yet" hint="Add one above, or wait for the orchestrator's state." />
        ) : (
          workspaces.map((workspace) => {
            const isConfirming = confirming === workspace.id;
            const viewing = workspace.id === activeId;
            return (
              <article className={cx('project-card', viewing && 'project-card-active')} key={workspace.id}>
                <div className="project-card-head">
                  <span className="floor-tag mono">F{workspace.floor}</span>
                  <span className="dot" style={{ background: workspace.color ?? '#a78bfa' }} aria-hidden="true" />
                  <span className="project-card-name">{workspace.name}</span>
                  {workspace.isDefault === true && <Badge tone="info">first office</Badge>}
                  {viewing && <Badge tone="accent">viewing</Badge>}
                  {workspace.activeRuns > 0 && <Badge tone="warn">{workspace.activeRuns} running</Badge>}
                  <span className="stage-spacer" />
                  <span className="dim small mono">
                    {formatInt(workspace.roleCount)} staff · {formatInt(workspace.skillCount)} skills ·{' '}
                    {formatUsd(workspace.spentUsd)}
                  </span>
                  <span className="dim small">added {formatAgo(workspace.createdAt, now)}</span>
                </div>

                <div className="project-card-path mono small" title={workspace.path}>
                  {workspace.path}
                </div>
                {workspace.description !== undefined && workspace.description !== '' && (
                  <div className="project-card-desc small">{workspace.description}</div>
                )}

                <div className="project-card-actions">
                  {!viewing && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => store.send({ type: 'selectWorkspace', workspaceId: workspace.id })}
                    >
                      View this floor
                    </button>
                  )}
                  <span className="dim small">
                    {workspace.budgetTotalUsd !== undefined
                      ? `budget ${formatUsd(workspace.budgetTotalUsd)} total`
                      : 'no total budget set'}
                  </span>
                  <span className="stage-spacer" />
                  {workspace.isDefault === true ? (
                    <span className="dim small">the fallback project cannot be removed</span>
                  ) : isConfirming ? (
                    <>
                      <span className="dim small">forget this project? its files and runs are kept.</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void remove(workspace.id)}
                        disabled={busy}
                      >
                        Yes, forget it
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirming(workspace.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </Panel>
  );
}

/**
 * The space a floor has, and the two controls that change it.
 *
 * A floor grows by itself when its roster outgrows its desks, which is the part
 * that matters day to day. These controls are the operator's hand on the same
 * machinery: a meeting room or a lounge that nobody is hired into still has to be
 * asked for, and a room built by mistake has to be removable.
 */
function FloorSpace() {
  const office = useOffice();
  const store = useStore();
  const [busy, setBusy] = useState(false);

  const floor = office?.floor;
  if (!floor) return null;

  const roles = office?.roles.length ?? 0;
  const spare = floor.capacity - roles;
  const rooms = floor.layout.blocks.length;
  const kinds = new Map(floor.modules.map((module) => [module.id, module.name]));

  const act = (command: 'addRoom' | 'removeRoom') => {
    setBusy(true);
    store.send({ type: command });
    // No acknowledgement to wait for here: the answer arrives as `org.updated`,
    // and the section re-renders from it. The button just stops double-firing.
    window.setTimeout(() => setBusy(false), 600);
  };

  return (
    <section className="settings-section floor-space">
      <div className="role-section-title">Floor space</div>

      {floor.problem !== null ? (
        <div className="alert alert-warn small" role="status">
          This installation has no block kit, so floors cannot grow: {floor.problem}
        </div>
      ) : null}

      <div className="floor-space-summary">
        <KeyValue label="Seats">
          <span className="mono">
            {floor.capacity} ({floor.coreSeats} in the core
            {rooms > 0 ? ` + ${floor.capacity - floor.coreSeats} built` : ''})
          </span>
        </KeyValue>
        <KeyValue label="Employees">
          <span className="mono">{roles}</span>
        </KeyValue>
        <KeyValue label="Room to spare">
          <span className={spare < 0 ? 'mono floor-space-short' : 'mono'}>
            {spare < 0 ? `${-spare} without a desk` : `${spare} seat${spare === 1 ? '' : 's'}`}
          </span>
        </KeyValue>
        <KeyValue label="Built">
          <span className="mono">{floor.describe}</span>
        </KeyValue>
      </div>

      {spare < 0 ? (
        <div className="dim small">
          This floor has run out of room to build. Every port is either used or blocked, so some employees are
          hot-desking.
        </div>
      ) : (
        <div className="dim small">
          A floor builds for itself when its roster outgrows its desks. Build by hand for a room nobody is hired
          into.
        </div>
      )}

      {rooms > 0 && (
        <ul className="floor-space-rooms">
          {floor.layout.blocks.map((block) => (
            <li key={block.id}>
              <span className="mono small">{block.id}</span>
              <span>{kinds.get(block.kind) ?? block.kind}</span>
              <span className="dim small mono">
                {block.x}, {block.z}
                {block.rotation !== 0 ? ` · ${block.rotation}°` : ''}
              </span>
              <span className="dim small">attached to {block.attachedTo}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="floor-space-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => act('addRoom')}
          disabled={busy || floor.problem !== null}
          title="Build the next module the planner would place"
        >
          Build a room
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => act('removeRoom')}
          disabled={busy || rooms === 0}
          title="Take the newest room back out. Never removes a room whose seats are in use."
        >
          Remove the newest room
        </button>
        <span className="dim small">
          {floor.modules.filter((module) => module.fitting !== true).length} module kinds available
        </span>
      </div>
    </section>
  );
}
