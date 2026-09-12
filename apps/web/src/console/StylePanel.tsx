/**
 * The floor's look, as something a person can change.
 *
 * One panel, two kinds of control: a preset to start from, and the handful of
 * values worth reaching for afterwards. It deliberately does not expose all
 * fourteen roles at full precision - a wall of forty numeric inputs is a config
 * file with worse ergonomics. It exposes the six surfaces a person actually
 * notices, plus the rig, and every one of them can be returned to the preset.
 *
 * Two behaviours worth knowing:
 *
 *  - **A change is sent whole.** The server takes a complete style rather than a
 *    patch, because the editor holds a resolved one: sending a value with no
 *    context would let a field this panel never rendered be silently reset by
 *    the stale value the client happened to hold.
 *
 *  - **Changes are paced, not sent per pixel.** A colour input fires on every
 *    pointer move, and each send is a round trip that empties and re-dresses a
 *    floor. So the panel keeps its own copy and pushes it on a short timer -
 *    which also means the sliders stay responsive while the office catches up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OfficeStyle, StyleMaterial, StylePattern, StyleRole } from '@dev3d/core';
import {
  STYLE_PRESETS,
  STYLE_PRESET_ORDER,
  STYLE_PATTERNS,
  STYLE_ROLE_LABEL,
  describeStyle,
  resolveStyle,
  stylePatternLabel,
} from '@dev3d/core';

import { useOffice, useStore } from '../app/StoreContext';

/** How long after the last change a style is pushed to the server. */
const COMMIT_DELAY_MS = 260;

/**
 * The surfaces worth a control.
 *
 * The full role list is fourteen; these are the ones a person can point at in
 * the viewport. Everything else follows the preset, and a preset is one click.
 */
const EDITABLE: readonly StyleRole[] = ['wall', 'accent', 'floor', 'carpet', 'desk', 'glass', 'plant', 'soft'];

/** The numeric rig controls, with the range each one is useful over. */
const RIG: ReadonlyArray<{ key: 'keyIntensity' | 'fillIntensity' | 'rimIntensity' | 'ambientIntensity' | 'exposure'; label: string; min: number; max: number; step: number }> = [
  { key: 'keyIntensity', label: 'Key light', min: 0, max: 3, step: 0.05 },
  { key: 'fillIntensity', label: 'Warm fill', min: 0, max: 1.5, step: 0.05 },
  { key: 'rimIntensity', label: 'Rim', min: 0, max: 1.5, step: 0.05 },
  { key: 'ambientIntensity', label: 'Ambient', min: 0, max: 2, step: 0.05 },
  { key: 'exposure', label: 'Exposure', min: 0.4, max: 1.8, step: 0.02 },
];

/** The scene colours worth a swatch: the backdrop and the grid on the ground. */
const SCENE_COLORS: ReadonlyArray<{ key: 'background' | 'gridColor'; label: string }> = [
  { key: 'background', label: 'Backdrop' },
  { key: 'gridColor', label: 'Ground grid' },
];

export function StylePanel() {
  const store = useStore();
  const office = useOffice();
  const workspace = office?.workspaces.find((entry) => entry.id === office.activeWorkspaceId) ?? null;

  /** The server's value: what the panel falls back to when it has nothing local. */
  const committed = office?.style;
  /** The panel's own copy, so a slider does not wait for a round trip. */
  const [draft, setDraft] = useState<OfficeStyle | undefined>(committed);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const lastWorkspace = useRef<string>('');

  // Switching floors adopts that floor's style rather than keeping the draft the
  // previous one was mid-way through editing.
  const activeId = office?.activeWorkspaceId ?? '';
  useEffect(() => {
    if (lastWorkspace.current === activeId) return;
    lastWorkspace.current = activeId;
    setDraft(committed);
  }, [activeId, committed]);

  // And a style changed somewhere else - another tab, a reset - wins over a
  // draft that is not being edited. The timer being idle is what says that.
  useEffect(() => {
    if (timer.current !== null) return;
    setDraft(committed);
  }, [committed]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  /**
   * Push the draft, at most a few times a second.
   *
   * A colour input fires on every pixel of a drag; without this, one drag would
   * be sixty round trips and sixty re-dressings of the floor.
   */
  const commit = useCallback(
    (next: OfficeStyle) => {
      setDraft(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        store.send({ type: 'setWorkspaceStyle', style: next });
      }, COMMIT_DELAY_MS);
    },
    [store],
  );

  /** The values actually on screen: the draft, folded over its preset. */
  const resolved = useMemo(() => resolveStyle(draft), [draft]);
  const preset = resolved.preset;

  const setPreset = useCallback(
    (presetId: string) => {
      // A preset change drops the per-role overrides: keeping them would make
      // "Nordic" mean "Nordic except the four surfaces you happened to touch",
      // which is not what a preset is for.
      commit({ preset: presetId });
    },
    [commit],
  );

  const setSurface = useCallback(
    (role: StyleRole, patch: Partial<StyleMaterial>) => {
      if (draft === undefined) return;
      const materials = { ...(draft.materials ?? {}) };
      materials[role] = { ...(materials[role] ?? {}), ...patch };
      commit({ ...draft, materials });
    },
    [commit, draft],
  );

  const resetSurface = useCallback(
    (role: StyleRole) => {
      if (draft?.materials?.[role] === undefined) return;
      const materials = { ...draft.materials };
      delete materials[role];
      const next: OfficeStyle = { ...draft };
      if (Object.keys(materials).length > 0) next.materials = materials;
      else delete next.materials;
      commit(next);
    },
    [commit, draft],
  );

  const setLighting = useCallback(
    (key: string, value: number | boolean) => {
      if (draft === undefined) return;
      commit({ ...draft, lighting: { ...(draft.lighting ?? {}), [key]: value } });
    },
    [commit, draft],
  );

  const setEnvironment = useCallback(
    (key: string, value: number | string | boolean) => {
      if (draft === undefined) return;
      commit({ ...draft, environment: { ...(draft.environment ?? {}), [key]: value } });
    },
    [commit, draft],
  );

  const isOverridden = useCallback(
    (role: StyleRole): boolean => draft?.materials?.[role] !== undefined,
    [draft],
  );

  if (office === null || workspace === null) return null;

  return (
    <div className={`office-style ${open ? 'office-style-open' : ''}`}>
      <button
        type="button"
        className="btn btn-ghost btn-sm office-style-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="Change what this floor is made of"
      >
        <span
          className="office-style-swatch"
          style={{ background: `linear-gradient(135deg, ${preset.materials.wall.color} 0 50%, ${preset.materials.soft.color} 50% 100%)` }}
          aria-hidden="true"
        />
        Look · {preset.name}
      </button>

      {open && (
        <div className="office-style-body">
          <div className="office-style-head">
            <span className="strong">Floor {workspace.floor} look</span>
            <span className="dim small">{describeStyle(draft)}</span>
          </div>

          <div className="office-style-group">
            <span className="field-label">Preset</span>
            <div className="office-style-presets">
              {STYLE_PRESET_ORDER.map((presetId) => {
                const entry = STYLE_PRESETS[presetId];
                if (!entry) return null;
                return (
                  <button
                    key={presetId}
                    type="button"
                    className={`office-style-preset ${presetId === preset.id ? 'chip-active' : ''}`}
                    onClick={() => setPreset(presetId)}
                    title={entry.description}
                  >
                    <span className="office-style-preset-chips" aria-hidden="true">
                      {entry.swatch.map((colour) => (
                        <span key={colour} className="office-style-preset-chip" style={{ background: colour }} />
                      ))}
                    </span>
                    {entry.name}
                  </button>
                );
              })}
            </div>
            <span className="dim small">{preset.description}</span>
          </div>

          <div className="office-style-group">
            <span className="field-label">Surfaces</span>
            {EDITABLE.map((role) => {
              const surface = resolved.materials[role];
              return (
                <div className="office-style-surface" key={role}>
                  <input
                    type="color"
                    className="office-style-color"
                    value={surface.color}
                    aria-label={`${STYLE_ROLE_LABEL[role]} colour`}
                    onChange={(event) => setSurface(role, { color: event.target.value })}
                  />
                  <span className="office-style-surface-name">{STYLE_ROLE_LABEL[role]}</span>
                  <input
                    type="range"
                    className="office-style-range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={surface.roughness}
                    aria-label={`${STYLE_ROLE_LABEL[role]} roughness`}
                    title={`Roughness ${surface.roughness.toFixed(2)}`}
                    onChange={(event) => setSurface(role, { roughness: Number(event.target.value) })}
                  />
                  <select
                    className="input input-sm office-style-pattern"
                    value={surface.pattern ?? 'plain'}
                    aria-label={`${STYLE_ROLE_LABEL[role]} pattern`}
                    onChange={(event) => setSurface(role, { pattern: event.target.value as StylePattern })}
                  >
                    {STYLE_PATTERNS.map((pattern) => (
                      <option key={pattern} value={pattern}>
                        {stylePatternLabel(pattern)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!isOverridden(role)}
                    onClick={() => resetSurface(role)}
                    title="Back to the preset"
                  >
                    ↺
                  </button>
                </div>
              );
            })}
          </div>

          <div className="office-style-group">
            <span className="field-label">Light</span>
            {RIG.map((control) => (
              <div className="office-style-rig" key={control.key}>
                <span className="office-style-rig-name">{control.label}</span>
                <input
                  type="range"
                  className="office-style-range"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={resolved.lighting[control.key]}
                  aria-label={control.label}
                  onChange={(event) => setLighting(control.key, Number(event.target.value))}
                />
                <span className="mono dim small office-style-value">{resolved.lighting[control.key].toFixed(2)}</span>
              </div>
            ))}
            <label className="field-check">
              <input
                type="checkbox"
                checked={resolved.lighting.shadows}
                onChange={(event) => setLighting('shadows', event.target.checked)}
              />
              Cast shadows
            </label>
          </div>

          <div className="office-style-group">
            <span className="field-label">Scene</span>
            <div className="office-style-surface">
              {SCENE_COLORS.map((entry) => (
                <span className="office-style-scene" key={entry.key}>
                  <input
                    type="color"
                    className="office-style-color"
                    value={resolved.environment[entry.key]}
                    aria-label={entry.label}
                    onChange={(event) => setEnvironment(entry.key, event.target.value)}
                  />
                  <span className="office-style-surface-name">{entry.label}</span>
                </span>
              ))}
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={resolved.environment.grid}
                  onChange={(event) => setEnvironment('grid', event.target.checked)}
                />
                Ground grid
              </label>
            </div>
          </div>

          <div className="office-style-foot">
            <span className="dim small">
              Saved with the floor, so it is here when you come back.
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setDraft(undefined);
                if (timer.current !== null) window.clearTimeout(timer.current);
                timer.current = null;
                store.send({ type: 'setWorkspaceStyle', style: null });
              }}
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
