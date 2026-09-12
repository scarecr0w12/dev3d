/**
 * A plugin's settings, generated from its manifest.
 *
 * The manifest declares the schema (`PluginSettingField[]`), the record carries
 * the current values already merged over the declared defaults, so this panel
 * renders one control per field and nothing else. A field the manifest does not
 * describe cannot be edited here, on purpose: the manifest is the contract, and
 * a settings form that invented keys would be writing values nothing reads.
 *
 * Save goes over HTTP so a refused value comes back with the server's reason.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type { PluginRecord, PluginSettingField } from '@dev3d/core';

import { Badge, Empty, Panel } from '../ui';
import { Field, SaveRow, useSaver } from '../SettingsPanel';
import { statusCopy } from './format';

export interface PluginSettingsProps {
  record: PluginRecord | null;
  onSave: (pluginId: string, settings: Record<string, unknown>) => Promise<{ ok: boolean; error: string | null }>;
}

/** The value a control should show: what is set, else the declared default. */
function seedValue(field: PluginSettingField, settings: Record<string, unknown>): unknown {
  const current = settings[field.key];
  return current === undefined ? field.default : current;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function PluginSettings({ record, onSave }: PluginSettingsProps) {
  const settings = record?.settings ?? {};
  const fields = useMemo(() => record?.manifest.settings ?? [], [record]);
  const selectedId = record?.manifest.id ?? null;

  const [draft, setDraft] = useState<Record<string, unknown>>({});

  // Seeding happens when the selected plugin changes - a different record - so
  // an event arriving mid-edit cannot overwrite what has been typed.
  useEffect(() => {
    if (!record) {
      setDraft({});
      return;
    }
    const seed: Record<string, unknown> = {};
    for (const field of record.manifest.settings ?? []) {
      seed[field.key] = seedValue(field, record.settings);
    }
    setDraft(seed);
  }, [record]);

  const saver = useSaver<Record<string, unknown>>(async (value) => {
    if (selectedId === null) return { ok: false, error: 'no plugin is selected' };
    return onSave(selectedId, value);
  });

  if (!record) {
    return (
      <Panel title="Plugin settings" subtitle="nothing selected">
        <Empty
          title="Pick a plugin"
          hint="Choose a plugin in the list above to configure it. A plugin with no settings of its own will say so."
        />
      </Panel>
    );
  }

  const manifest = record.manifest;
  const status = statusCopy(record.status);

  return (
    <Panel
      title="Plugin settings"
      subtitle={`${manifest.name} · ${manifest.id}`}
      actions={
        <>
          <Badge tone={status.tone} title={status.hint}>
            {status.label}
          </Badge>
          <Badge tone={record.hasCode ? 'warn' : 'ok'}>{record.hasCode ? 'runs code' : 'data only'}</Badge>
        </>
      }
    >
      {fields.length === 0 ? (
        <Empty
          title="This plugin declares no settings"
          hint={
            <>
              Its manifest carries no <span className="mono">settings</span> array, so there is nothing to configure
              here — whatever it contributes is fixed by the version you installed.
            </>
          }
        />
      ) : (
        <form
          className="settings-section plugin-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void saver.run(draft);
          }}
        >
          <div className="dim small">
            Saved values merge over the defaults the manifest declares, so clearing a field does not have to mean
            something different from never having touched it.
          </div>

          {fields.map((field) => {
            const value = draft[field.key] === undefined ? seedValue(field, settings) : draft[field.key];
            return (
              <Field
                key={field.key}
                label={field.label}
                hint={
                  <>
                    {field.description !== undefined && field.description !== '' && (
                      <span className="plugin-setting-desc">{field.description}</span>
                    )}
                    <span className="mono">
                      {field.key} · {field.type}
                      {field.type === 'number' && (field.min !== undefined || field.max !== undefined)
                        ? ` · ${field.min ?? '−∞'}…${field.max ?? '∞'}`
                        : ''}
                      {field.type === 'select' && field.options !== undefined
                        ? ` · ${field.options.join(' | ')}`
                        : ''}
                    </span>
                  </>
                }
              >
                <SettingControl
                  field={field}
                  value={value}
                  disabled={saver.busy}
                  onChange={(next) => setDraft((current) => ({ ...current, [field.key]: next }))}
                />
              </Field>
            );
          })}

          <SaveRow
            busy={saver.busy}
            saved={saver.saved}
            error={saver.error}
            label={`Save ${fields.length} setting${fields.length === 1 ? '' : 's'}`}
            onSave={() => void saver.run(draft)}
          />
        </form>
      )}
    </Panel>
  );
}

function SettingControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PluginSettingField;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
}): ReactNode {
  switch (field.type) {
    case 'boolean':
      return (
        <label className="settings-check">
          <input
            type="checkbox"
            checked={asBoolean(value, asBoolean(field.default, false))}
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
          />
          <span>
            <span className="strong">{asBoolean(value, false) ? 'on' : 'off'}</span>
            <span className="dim small">Default is {asBoolean(field.default, false) ? 'on' : 'off'}.</span>
          </span>
        </label>
      );

    case 'number': {
      const current = asNumber(value, asNumber(field.default, 0));
      return (
        <input
          type="number"
          className="mono"
          value={current}
          min={field.min}
          max={field.max}
          step="any"
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : current);
          }}
        />
      );
    }

    case 'select': {
      const options = field.options ?? [];
      const current = asText(value, asText(field.default, ''));
      // A stored value the manifest no longer lists still has to be visible,
      // otherwise the form would silently rewrite it on the next save. And an
      // empty string must not become an `<option>` of its own: the browser then
      // shows the placeholder instead of the field's default.
      const values = current !== '' && !options.includes(current) ? [current, ...options] : options;
      return (
        <select
          value={current}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        >
          {values.length === 0 && <option value="">no options declared</option>}
          {values.map((option) => (
            <option key={option} value={option}>
              {option}
              {!options.includes(option) ? ' (not declared)' : ''}
            </option>
          ))}
        </select>
      );
    }

    case 'string':
    default:
      return (
        <input
          type="text"
          className="mono"
          value={asText(value, asText(field.default, ''))}
          spellCheck={false}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      );
  }
}
