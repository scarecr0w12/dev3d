/**
 * Settings.
 *
 * Two kinds of thing live behind these tabs, and the difference matters:
 *
 *  - **Installation settings** (General, Models, Safety) apply to the whole
 *    office: providers, the model catalog, concurrency, approval policy, where
 *    new floors are created.
 *  - **Organisation settings** (Skills, Budget) apply to the floor you are
 *    standing on. Changing them changes one organisation, not the building.
 *
 * Both go over HTTP rather than the socket so a form gets the server's exact
 * reason when a value is refused, instead of silently doing nothing.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type { ModelOverride, ModelSpec, ModelTier, OfficeSettings, RoutingPosture } from '@dev3d/core';

import { api } from '../app/api';
import { formatInt, formatUsd } from '../app/format';
import { useOffice, useSkills, useStore } from '../app/StoreContext';
import { Badge, Empty, Loading, Panel, Tabs, cx } from './ui';

type SettingsTab = 'general' | 'models' | 'skills' | 'budget' | 'safety';

const POSTURES: readonly RoutingPosture[] = ['cheap', 'balanced', 'quality'];
const TIERS: readonly ModelTier[] = ['nano', 'small', 'standard', 'strong', 'max'];

/**
 * Shared save plumbing: every form here is draft -> save -> report.
 *
 * Exported because a plugin's generated settings form is the same shape of
 * problem - a draft, one request, the server's exact reason on refusal - and a
 * second copy of this would drift from this one.
 */
export function useSaver<T>(save: (value: T) => Promise<{ ok: boolean; error: string | null }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const run = useCallback(
    async (value: T): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setSaved(false);
      const result = await save(value);
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? 'the request failed');
        return false;
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      return true;
    },
    [save],
  );

  return { busy, error, saved, run };
}

/** One labelled form control, with its help text underneath. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="dim small">{hint}</span>}
    </label>
  );
}

/** A save button plus the two things a save can say: saved, or why not. */
export function SaveRow({
  busy,
  saved,
  error,
  label = 'Save',
  onSave,
}: {
  busy: boolean;
  saved: boolean;
  error: string | null;
  label?: string;
  onSave: () => void;
}) {
  return (
    <>
      <div className="settings-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={busy}>
          {busy ? 'saving…' : label}
        </button>
        {saved && <span className="ok small">saved</span>}
      </div>
      {error !== null && (
        <div className="alert alert-danger small" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------- general

function GeneralSettings() {
  const office = useOffice();
  const settings = office?.settings;
  const [draft, setDraft] = useState<Partial<OfficeSettings>>({});

  const saver = useSaver<Partial<OfficeSettings>>(async (patch) => {
    const result = await api.updateSettings(patch);
    return { ok: result.ok, error: result.error };
  });

  if (!settings || !office) return <Empty title="No settings" hint="Waiting for the orchestrator." />;

  const posture = draft.defaultRoutingPosture ?? settings.defaultRoutingPosture;
  const concurrency = draft.maxConcurrency ?? settings.maxConcurrency;
  const logLevel = draft.logLevel ?? settings.logLevel;

  return (
    <div className="settings-section">
      <div className="kv-grid">
        <div className="kv">
          <div className="kv-label">Orchestrator</div>
          <div className="kv-value mono">v{office.version}</div>
        </div>
        <div className="kv">
          <div className="kv-label">Providers</div>
          <div className="kv-value">
            <Badge tone={office.llmMode === 'mock' ? 'warn' : 'ok'}>{office.llmMode}</Badge>
          </div>
        </div>
        <div className="kv">
          <div className="kv-label">Floors</div>
          <div className="kv-value mono">{formatInt(office.workspaces.length)}</div>
        </div>
      </div>

      <Field
        label="Default routing posture"
        hint="What a new organisation starts with. Each floor can still choose its own."
      >
        <div className="segmented" role="group" aria-label="Default routing posture">
          {POSTURES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={cx('segment', posture === entry && 'segment-active')}
              aria-pressed={posture === entry}
              onClick={() => setDraft((current) => ({ ...current, defaultRoutingPosture: entry }))}
            >
              {entry}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Concurrency" hint="Max employees working at once inside one organisation (1–16).">
        <input
          type="number"
          min={1}
          max={16}
          value={concurrency}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setDraft((current) => ({ ...current, maxConcurrency: Number(event.target.value) }))
          }
        />
      </Field>

      <Field label="Log level" hint="How much the orchestrator writes to its console.">
        <select
          value={logLevel}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            setDraft((current) => ({ ...current, logLevel: event.target.value as OfficeSettings['logLevel'] }))
          }
        >
          {['debug', 'info', 'warn', 'error'].map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Workspaces root"
        hint="Where the Projects form creates new offices. Set by DEV3D_WORKSPACES_ROOT at boot, so it is read-only here."
      >
        <input type="text" value={settings.workspacesRoot} readOnly className="mono" />
      </Field>

      <SaveRow {...saver} onSave={() => void saver.run(draft)} />
    </div>
  );
}

// -------------------------------------------------------------------- models

function ModelSettings() {
  const office = useOffice();
  const settings = office?.settings;
  const [disabled, setDisabled] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const saver = useSaver<string[]>(async (ids) => {
    const result = await api.updateSettings({ disabledModelIds: ids });
    return { ok: result.ok, error: result.error };
  });

  /**
   * Corrections to the catalog, sent as a whole map rather than a patch per
   * model: the server validates the map against the live catalog, so a model that
   * has gone away is dropped rather than left behind in the settings document.
   */
  const overrides = settings?.modelOverrides ?? {};
  const overrideSaver = useSaver<Record<string, ModelOverride>>(async (next) => {
    const result = await api.updateSettings({ modelOverrides: next });
    return { ok: result.ok, error: result.error };
  });

  if (!office || !settings) return <Empty title="No models" hint="Waiting for the orchestrator." />;

  const off = disabled ?? settings.disabledModelIds;
  const editedModel = editing === null ? null : (office.models.find((model) => model.id === editing) ?? null);
  const byProvider = new Map<string, typeof office.models>();
  for (const model of office.models) {
    const list = byProvider.get(model.providerId) ?? [];
    list.push(model);
    byProvider.set(model.providerId, list);
  }

  return (
    <div className="settings-section">
      <div className="provider-list-standalone">
        {office.providers.map((provider) => (
          <span className="provider-chip" key={provider.id}>
            <span
              className="dot"
              style={{ background: provider.configured ? '#34d399' : '#475569' }}
              aria-hidden="true"
            />
            <span className="strong">{provider.label}</span>
            {provider.pluginId !== null && (
              <Badge tone="info" title={`Registered by the plugin "${provider.pluginId}". Its key still comes from the environment.`}>
                plugin
              </Badge>
            )}
            <Badge tone={provider.configured ? 'ok' : 'neutral'}>
              {provider.configured ? 'key set' : 'no key'}
            </Badge>
            <span className="dim small mono">{provider.modelCount} models</span>
          </span>
        ))}
      </div>
      <div className="dim small">
        Provider keys come from the environment (<span className="mono">.env</span>) and are never editable from
        here. Switching a model off removes it from routing everywhere.
      </div>

      <table className="table table-models">
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Tier</th>
            <th className="num">$/M in</th>
            <th className="num">$/M out</th>
            <th>Caps</th>
            <th>Routing</th>
            <th>Catalog</th>
          </tr>
        </thead>
        <tbody>
          {[...byProvider.entries()].map(([providerId, models]) =>
            models.map((model) => {
              const isOff = off.includes(model.id);
              return (
                <tr key={model.id} className={isOff ? 'row-off' : undefined}>
                  <td className="mono">{model.id}</td>
                  <td className="dim">{providerId}</td>
                  <td>
                    <span className={`tier-${model.tier}`}>{model.tier}</span>
                  </td>
                  <td className="num mono">{model.costPerMTokIn.toFixed(2)}</td>
                  <td className="num mono">{model.costPerMTokOut.toFixed(2)}</td>
                  <td className="dim small">
                    {[
                      model.capabilities.tools ? 'tools' : null,
                      model.capabilities.vision ? 'vision' : null,
                      model.capabilities.reasoning ? 'reasoning' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={cx('btn', 'btn-sm', isOff ? 'btn-ghost' : 'btn-danger')}
                      onClick={() => {
                        const next = isOff ? off.filter((id) => id !== model.id) : [...off, model.id];
                        setDisabled(next);
                        void saver.run(next);
                      }}
                      disabled={saver.busy}
                    >
                      {isOff ? 'Enable' : 'Disable'}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={cx('btn', 'btn-sm', editing === model.id ? 'btn-primary' : 'btn-ghost')}
                      onClick={() => setEditing(editing === model.id ? null : model.id)}
                      title="Correct this model's tier or prices for the whole installation"
                    >
                      {overrides[model.id] !== undefined ? 'Corrected' : 'Correct'}
                    </button>
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>

      {editedModel !== null && (
        <ModelOverrideEditor
          model={editedModel}
          override={overrides[editedModel.id]}
          busy={overrideSaver.busy}
          onApply={(next) => {
            const map: Record<string, ModelOverride> = { ...overrides };
            if (next === null) delete map[editedModel.id];
            else map[editedModel.id] = next;
            void overrideSaver.run(map);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {overrideSaver.error !== null && (
        <div className="alert alert-danger small" role="alert">
          {overrideSaver.error}
        </div>
      )}

      <div className="dim small">
        Prices are estimates used for routing and display, not billing truth. Tiers: {TIERS.join(' · ')}. A correction
        here changes routing and cost reporting from the next turn; the catalog in{' '}
        <span className="mono">llm/catalog.ts</span> stays as it shipped.
      </div>
      {saver.error !== null && (
        <div className="alert alert-danger small" role="alert">
          {saver.error}
        </div>
      )}
    </div>
  );
}

/**
 * Correct one catalog model for the whole installation.
 *
 * The fields are seeded from the *effective* values — the override if there is
 * one, otherwise what the catalog says — so the form always shows what the office
 * is actually using. Clearing a field means "leave the catalog's word alone"
 * rather than "set it to nothing", which is why a blank price is sent as absent
 * instead of zero.
 */
function ModelOverrideEditor({
  model,
  override,
  busy,
  onApply,
  onCancel,
}: {
  model: ModelSpec;
  override: ModelOverride | undefined;
  busy: boolean;
  onApply: (next: ModelOverride | null) => void;
  onCancel: () => void;
}) {
  const [tier, setTier] = useState<ModelTier>(override?.tier ?? model.tier);
  const [priceIn, setPriceIn] = useState(String(override?.costPerMTokIn ?? model.costPerMTokIn));
  const [priceOut, setPriceOut] = useState(String(override?.costPerMTokOut ?? model.costPerMTokOut));

  const price = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
  };

  const inValue = price(priceIn);
  const outValue = price(priceOut);
  const valid = !Number.isNaN(inValue) && !Number.isNaN(outValue);

  return (
    <div className="model-override">
      <div className="model-override-head">
        <span className="strong mono">{model.id}</span>
        <span className="dim small">
          shipped as {model.tier} · {model.costPerMTokIn.toFixed(2)} / {model.costPerMTokOut.toFixed(2)} per million
        </span>
      </div>

      <div className="model-override-fields">
        <label className="field">
          <span className="field-label">Tier</span>
          <select value={tier} onChange={(event) => setTier(event.target.value as ModelTier)}>
            {TIERS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">$/M tokens in</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={priceIn}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPriceIn(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">$/M tokens out</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={priceOut}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPriceOut(event.target.value)}
          />
        </label>
      </div>

      {!valid && (
        <div className="alert alert-warn small" role="status">
          A price has to be a number of dollars per million tokens, zero or more.
        </div>
      )}

      <div className="model-override-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !valid}
          onClick={() =>
            onApply({
              tier,
              ...(inValue === null ? {} : { costPerMTokIn: inValue }),
              ...(outValue === null ? {} : { costPerMTokOut: outValue }),
            })
          }
        >
          Save correction
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {override !== undefined && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onApply(null)}>
            Restore the catalog's values
          </button>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- skills
function SkillSettings() {
  const office = useOffice();
  const skills = useSkills();
  const [selection, setSelection] = useState<string[] | null>(null);

  const activeId = office?.activeWorkspaceId ?? '';
  const enabled = selection ?? office?.skillIds ?? [];

  const saver = useSaver<string[]>(async (ids) => {
    const result = await api.updateWorkspace(activeId, { skillIds: ids });
    return { ok: result.ok, error: result.error };
  });

  if (!office) return <Empty title="No office" hint="Waiting for the orchestrator." />;
  if (skills.loading && skills.skills === null) return <Loading label="loading the skill catalogue" />;

  const catalogue = skills.skills ?? [];
  const active = office.workspaces.find((workspace) => workspace.id === activeId);

  return (
    <div className="settings-section">
      <div className="dim small">
        These apply to <span className="strong">{active?.name ?? 'this organisation'}</span> only. Roles may only
        use skills enabled here, so switching one off also trims it from every role that held it.
      </div>

      {catalogue.length === 0 ? (
        <Empty title="No skills loaded" hint="The server found no skill documents on disk." />
      ) : (
        <>
          <div className="skill-grid">
            {catalogue.map((skill) => {
              const on = enabled.includes(skill.id);
              return (
                <label className={cx('skill-toggle', on && 'skill-toggle-on')} key={skill.id}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setSelection(on ? enabled.filter((id) => id !== skill.id) : [...enabled, skill.id])
                    }
                  />
                  <span className="skill-toggle-name">{skill.name}</span>
                  <span className="dim small">{skill.description}</span>
                </label>
              );
            })}
          </div>
          <SaveRow
            {...saver}
            label={`Save ${enabled.length} enabled`}
            onSave={() => void saver.run(enabled)}
          />
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- budget

function BudgetSettings() {
  const office = useOffice();
  const [draft, setDraft] = useState<{ defaultRunUsd?: number; totalUsd?: number | '' }>({});

  const activeId = office?.activeWorkspaceId ?? '';
  const saver = useSaver<{ defaultRunUsd?: number; totalUsd?: number }>(async (value) => {
    const result = await api.updateWorkspace(activeId, { budget: value });
    return { ok: result.ok, error: result.error };
  });

  if (!office) return <Empty title="No office" hint="Waiting for the orchestrator." />;

  const active = office.workspaces.find((workspace) => workspace.id === activeId);
  const defaultRunUsd = draft.defaultRunUsd ?? office.budget.defaultRunUsd;
  const totalUsd = draft.totalUsd ?? active?.budgetTotalUsd ?? '';

  return (
    <div className="settings-section">
      <div className="dim small">
        Money for <span className="strong">{active?.name ?? 'this organisation'}</span>. A run that does not name
        its own ceiling inherits the per-run default; the total is a ceiling on lifetime spend for this floor.
      </div>

      <div className="metrics-grid">
        <div className="metric">
          <div className="metric-label">Recorded spend</div>
          <div className="metric-value mono">{formatUsd(active?.spentUsd ?? 0)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Runs</div>
          <div className="metric-value mono">{formatInt(office.runs.length)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Active now</div>
          <div className="metric-value mono">{formatInt(office.activeRunIds.length)}</div>
        </div>
      </div>

      <Field label="Default budget per run (USD)">
        <input
          type="number"
          min={0}
          step={0.5}
          value={defaultRunUsd}
          onChange={(event) =>
            setDraft((current) => ({ ...current, defaultRunUsd: Number(event.target.value) }))
          }
        />
      </Field>

      <Field label="Total budget for this floor (USD)" hint="Leave empty for no ceiling.">
        <input
          type="number"
          min={0}
          step={5}
          value={totalUsd}
          placeholder="none"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              totalUsd: event.target.value === '' ? '' : Number(event.target.value),
            }))
          }
        />
      </Field>

      <SaveRow
        {...saver}
        onSave={() =>
          void saver.run({
            defaultRunUsd,
            ...(totalUsd === '' ? {} : { totalUsd: Number(totalUsd) }),
          })
        }
      />

      <div className="settings-section-title">Spend per employee</div>
      {office.employees.length === 0 ? (
        <div className="dim small">nobody on this floor yet</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="num">Turns</th>
              <th className="num">Tokens in</th>
              <th className="num">Tokens out</th>
              <th className="num">Spend</th>
            </tr>
          </thead>
          <tbody>
            {[...office.employees]
              .sort((a, b) => b.lifetime.costUsd - a.lifetime.costUsd)
              .map((employee) => (
                <tr key={employee.id}>
                  <td>
                    <span className="strong">{employee.displayName}</span>{' '}
                    <span className="dim small">{employee.title}</span>
                  </td>
                  <td className="num mono">{formatInt(employee.lifetime.turns)}</td>
                  <td className="num mono">{formatInt(employee.lifetime.tokensIn)}</td>
                  <td className="num mono">{formatInt(employee.lifetime.tokensOut)}</td>
                  <td className="num mono">{formatUsd(employee.lifetime.costUsd)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- safety

function SafetySettings() {
  const office = useOffice();
  const settings = office?.settings;
  const [draft, setDraft] = useState<Partial<OfficeSettings>>({});

  const saver = useSaver<Partial<OfficeSettings>>(async (patch) => {
    const result = await api.updateSettings(patch);
    return { ok: result.ok, error: result.error };
  });

  if (!settings) return <Empty title="No settings" hint="Waiting for the orchestrator." />;

  const autoApproveShell = draft.autoApproveShell ?? settings.autoApproveShell;
  const softSpend = draft.softSpendApprovalUsd ?? settings.softSpendApprovalUsd;
  const timeoutMs = draft.approvalTimeoutMs ?? settings.approvalTimeoutMs;
  const external = draft.allowExternalWorkspaces ?? settings.allowExternalWorkspaces;

  return (
    <div className="settings-section">
      <label className="settings-check">
        <input
          type="checkbox"
          checked={autoApproveShell}
          onChange={(event) => setDraft((current) => ({ ...current, autoApproveShell: event.target.checked }))}
        />
        <span>
          <span className="strong">Let employees run shell commands without asking</span>
          <span className="dim small">
            A shell is the most dangerous tool anyone here holds. Leave this off unless you are running
            unattended and accept that commands will execute unattended.
          </span>
        </span>
      </label>

      {autoApproveShell && (
        <div className="alert alert-danger small" role="alert">
          Shell commands will run without a human seeing them. Nothing else in the system is gated this way.
        </div>
      )}

      <Field
        label="Soft spend threshold (USD)"
        hint="Ask a human before a run crosses this. 0 disables the gate."
      >
        <input
          type="number"
          min={0}
          step={0.5}
          value={softSpend}
          onChange={(event) =>
            setDraft((current) => ({ ...current, softSpendApprovalUsd: Number(event.target.value) }))
          }
        />
      </Field>

      <Field
        label="Approval timeout (ms)"
        hint="How long an approval waits for a human before it counts as refused. A blocked run never waits forever."
      >
        <input
          type="number"
          min={1000}
          step={30_000}
          value={timeoutMs}
          onChange={(event) =>
            setDraft((current) => ({ ...current, approvalTimeoutMs: Number(event.target.value) }))
          }
        />
      </Field>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={external}
          onChange={(event) =>
            setDraft((current) => ({ ...current, allowExternalWorkspaces: event.target.checked }))
          }
        />
        <span>
          <span className="strong">Allow a floor to point outside the workspaces root</span>
          <span className="dim small">
            Needed to work on a project that already exists elsewhere on disk. The directory an organisation
            names becomes fully readable and writable to its employees.
          </span>
        </span>
      </label>

      <div className="dim small">
        An approval that is refused is never retried automatically: the employee is told and moves on.
      </div>

      <SaveRow {...saver} onSave={() => void saver.run(draft)} />
    </div>
  );
}

// ------------------------------------------------------------------- surface

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>('general');
  const store = useStore();
  const office = useOffice();

  const active = useMemo(
    () => office?.workspaces.find((workspace) => workspace.id === office.activeWorkspaceId) ?? null,
    [office],
  );

  return (
    <Panel
      title="Settings"
      subtitle={
        office
          ? `installation-wide on General, Models and Safety · ${active?.name ?? 'this floor'} on Skills and Budget`
          : 'waiting for the orchestrator'
      }
      actions={
        office ? (
          <Badge tone={office.llmMode === 'mock' ? 'warn' : 'ok'}>{office.llmMode} providers</Badge>
        ) : null
      }
    >
      <Tabs<SettingsTab>
        items={[
          { id: 'general', label: 'General' },
          { id: 'models', label: 'Models' },
          { id: 'skills', label: 'Skills' },
          { id: 'budget', label: 'Budget' },
          { id: 'safety', label: 'Safety' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {!office ? (
        <Empty
          title="No office state"
          hint="The settings load as soon as the orchestrator connects."
          action={
            <button type="button" className="btn btn-sm" onClick={() => store.send({ type: 'resync' })}>
              Resync
            </button>
          }
        />
      ) : (
        <>
          {tab === 'general' && <GeneralSettings />}
          {tab === 'models' && <ModelSettings />}
          {tab === 'skills' && <SkillSettings />}
          {tab === 'budget' && <BudgetSettings />}
          {tab === 'safety' && <SafetySettings />}
        </>
      )}
    </Panel>
  );
}
