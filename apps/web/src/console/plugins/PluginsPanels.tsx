/**
 * Plugins: the marketplace home, and the consent surface for what is installed.
 *
 * `console/pages.tsx` owns the route and the page's `Single` wrapper, alongside
 * every other page; this module is the stack of panels it renders.
 *
 * The page is deliberately ordered the way an operator has to think:
 *
 *   1. what the host is - API version, where plugins live, whether installing
 *      from a marketplace is permitted at all;
 *   2. what is installed, with what each plugin asked to be allowed to do;
 *   3. the settings of the one you picked;
 *   4. where plugins can come from, and what a marketplace is currently offering.
 *
 * State comes from the socket (`OfficeState.plugins`, pushed as `plugins.updated`)
 * and actions go over HTTP, so a refusal is shown as the server worded it. The
 * `usePlugins` hook falls back to `GET /api/plugins` only when the socket has not
 * delivered plugin state - a stale server build, or a socket that is down while
 * the operator still wants to look.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PluginRecord, UiPanelContribution } from '@dev3d/core';

import { api } from '../../app/api';
import { formatInt } from '../../app/format';
import { useConnection, usePlugins, useStore } from '../../app/StoreContext';
import { Badge, ErrorState, Loading, Panel } from '../ui';
import { Marketplace } from './Marketplace';
import { PluginList } from './PluginList';
import { PluginSettings } from './PluginSettings';

/** Where a contributed panel actually shows up, in the operator's words. */
const PLACEMENT_COPY: Record<UiPanelContribution['placement'], string> = {
  inspector: 'the Inspector popout, on the Agent tab',
  runs: 'the Runs page, under the transcript',
  settings: 'the Settings page, under the sections',
  'office-overlay': 'over the office, bottom left',
};

/**
 * An index of the panels plugins declare.
 *
 * The panels themselves render in their declared homes, which is the point of a
 * placement - so this is an inventory rather than a second copy: it tells an
 * operator that a panel exists and where to look, including for a tab they
 * might never have opened.
 */
function ContributedPanels({ records }: { records: readonly PluginRecord[] }) {
  const declared = useMemo(() => {
    const out: Array<{ pluginId: string; panel: UiPanelContribution }> = [];
    for (const record of records) {
      if (record.status !== 'loaded' || !record.enabled) continue;
      for (const panel of record.manifest.contributes?.uiPanels ?? []) {
        out.push({ pluginId: record.manifest.id, panel });
      }
    }
    return out.sort((a, b) => a.panel.title.localeCompare(b.panel.title));
  }, [records]);

  return (
    <Panel
      title="Contributed panels"
      subtitle="where plugins add their own surfaces, without shipping any code to your browser"
      actions={<Badge tone={declared.length > 0 ? 'info' : 'neutral'}>{declared.length} declared</Badge>}
    >
      {declared.length === 0 ? (
        <div className="dim small">
          No loaded plugin declares a panel. A plugin can contribute one as manifest data — it is rendered from a
          closed set of widgets, so nothing a plugin ships ever runs in this page.
        </div>
      ) : (
        <div className="list-rows">
          {declared.map(({ pluginId, panel }) => (
            <div className="list-row" key={`${pluginId}/${panel.id}`}>
              <span className="strong">{panel.title}</span>
              <span className="dim small">{panel.summary}</span>
              <span className="stage-spacer" />
              <span className="dim small mono">{pluginId}</span>
              <Badge tone="neutral">{panel.source === undefined ? 'from the manifest' : 'live endpoint'}</Badge>
              <span className="dim small">shows in {PLACEMENT_COPY[panel.placement]}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function PluginsPanels() {
  const store = useStore();
  const connection = useConnection();
  const { state, loading, error, origin, reload } = usePlugins();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const records = useMemo(() => state?.records ?? [], [state]);
  const sources = useMemo(() => state?.sources ?? [], [state]);

  // Keep a selection that still exists. A plugin can vanish under the cursor -
  // removed here, or its directory deleted by hand and picked up by a rescan.
  useEffect(() => {
    if (selectedId !== null && records.some((record) => record.manifest.id === selectedId)) return;
    setSelectedId(records.length > 0 ? (records[0]?.manifest.id ?? null) : null);
  }, [records, selectedId]);

  const selected = useMemo(
    () => records.find((record) => record.manifest.id === selectedId) ?? null,
    [records, selectedId],
  );

  const mark = useCallback((pluginId: string, running: boolean) => {
    setBusy((current) => (running ? [...current, pluginId] : current.filter((id) => id !== pluginId)));
  }, []);

  const toggleEnabled = useCallback(
    (record: PluginRecord, next: boolean) => {
      const pluginId = record.manifest.id;
      setActionError(null);
      mark(pluginId, true);
      void api.setPluginEnabled(pluginId, next).then((result) => {
        mark(pluginId, false);
        if (!result.ok) setActionError(`${record.manifest.name}: ${result.error ?? 'the request failed'}`);
        // On success the server broadcasts `plugins.updated`, which redraws the
        // list - so nothing is guessed at here.
      });
    },
    [mark],
  );

  const removePlugin = useCallback(
    (record: PluginRecord) => {
      const pluginId = record.manifest.id;
      setActionError(null);
      mark(pluginId, true);
      void api.removePlugin(pluginId).then((result) => {
        mark(pluginId, false);
        if (!result.ok) setActionError(`${record.manifest.name}: ${result.error ?? 'the request failed'}`);
      });
    },
    [mark],
  );

  const saveSettings = useCallback(
    async (pluginId: string, settings: Record<string, unknown>) => {
      const result = await api.configurePlugin(pluginId, settings);
      return { ok: result.ok, error: result.error };
    },
    [],
  );

  /**
   * Install the version a marketplace is offering over the installed one.
   *
   * The plugin's own settings live in the office document, not in the directory
   * being replaced, so an update keeps them - which is the whole reason an
   * operator can update without re-configuring.
   */
  const updatePlugin = useCallback(
    (record: PluginRecord) => {
      const update = record.update;
      if (update === undefined) return;
      const pluginId = record.manifest.id;
      setActionError(null);
      // The server's install takes a **catalog** URL — it fetches the document and
      // then looks the plugin up inside it. `update.downloadUrl` is the bundle
      // archive, so passing it here made every Update fail with the marketplace
      // being blamed for a client-side URL mistake: the server fetched a
      // `.tar.gz` and reported "is not valid JSON". The catalog URL is the
      // source's own `url`, which the panel already holds.
      const catalogUrl = sources.find((source) => source.id === update.sourceId)?.url;
      if (catalogUrl === undefined) {
        setActionError(
          `${record.manifest.name}: its marketplace source is no longer configured, so the update ` +
            'cannot be fetched. Add the source back, or install the plugin by hand.',
        );
        return;
      }
      mark(pluginId, true);
      void api.installPlugin(catalogUrl, pluginId, true).then((result) => {
        mark(pluginId, false);
        if (!result.ok) setActionError(`${record.manifest.name}: ${result.error ?? 'the update failed'}`);
        else if (result.data) setSelectedId(pluginId);
      });
    },
    [mark, sources],
  );

  const refresh = useCallback(() => {
    setActionError(null);
    void api.refreshPlugins().then((result) => {
      if (!result.ok) setActionError(`rescan failed: ${result.error ?? 'the request failed'}`);
      else reload();
      // A successful rescan is also broadcast as `plugins.updated`; `reload`
      // only matters for the HTTP fallback path where no event will arrive.
    });
  }, [reload]);

  /**
   * Ask the marketplaces what they have. Slower than a rescan and it can partly
   * fail, so a source that could not be reached is reported rather than hidden -
   * "no updates" and "could not check" must not look the same.
   */
  const checkUpdates = useCallback(() => {
    setActionError(null);
    setChecking(true);
    void api.checkPluginUpdates().then((result) => {
      setChecking(false);
      if (!result.ok) {
        setActionError(`could not check for updates: ${result.error ?? 'the request failed'}`);
        return;
      }
      const partial = result.data?.error;
      if (partial !== undefined && partial !== null) setActionError(`some marketplaces could not be reached — ${partial}`);
      else if ((result.data?.found ?? 0) === 0) setActionError(null);
    });
  }, [reload]);

  const busySet = useMemo(() => new Set(busy), [busy]);

  // The socket is the source of truth, so "disconnected" is only worth saying
  // when there is no state to show at all - a stale snapshot beats a blank page.
  const disconnected = !store.connected && state === null;

  if (loading && state === null) return <Loading label="loading the plugin system" />;

  if (state === null) {
    return (
      <Panel title="Plugins" subtitle="no state yet">
        <ErrorState
          title={disconnected ? 'The orchestrator is not connected' : 'The plugin system could not be read'}
          detail={
            disconnected
              ? `the socket is ${connection.status}${connection.error !== null ? ` — ${connection.error}` : ''}`
              : error
          }
          onRetry={reload}
        />
      </Panel>
    );
  }

  const loaded = records.filter((record) => record.status === 'loaded').length;
  const errored = records.filter((record) => record.status === 'error').length;
  const disabled = records.filter((record) => record.status === 'disabled').length;
  const codePlugins = records.filter((record) => record.hasCode).length;

  return (
    <>
      <Panel
        title="Plugin host"
        subtitle={`plugin API ${state.apiVersion} · ${
          origin === 'socket' ? 'state pushed over the socket' : 'state read over HTTP — the socket has not sent plugins'
        }`}
        tone={errored > 0 ? 'danger' : 'default'}
        actions={
          <>
            <Badge tone={state.allowInstall ? 'warn' : 'ok'}>
              {state.allowInstall ? 'marketplace installs allowed' : 'installs disabled'}
            </Badge>
            <button
              type="button"
              className="btn btn-sm"
              onClick={refresh}
              title="Re-scan the plugins directory on the server"
            >
              Refresh
            </button>
          </>
        }
      >
        <div className="plugin-header">
          <span className="plugin-head-item">
            <span className="field-label">Host plugin API</span>
            <span className="mono strong">{state.apiVersion}</span>
          </span>

          <span className="plugin-head-item plugin-head-root">
            <span className="field-label">Plugins root</span>
            <span className="mono plugin-path" title={state.pluginsRoot}>
              {state.pluginsRoot}
            </span>
          </span>

          <span className="plugin-head-item">
            <span className="field-label">Installed</span>
            <span className="mono">{formatInt(records.length)}</span>
          </span>

          <span className="plugin-head-item">
            <span className="field-label">Enabled</span>
            <span className="plugin-count">
              <span className="plugin-dot plugin-dot-ok" aria-hidden="true" />
              <span className="mono">{formatInt(loaded)}</span>
            </span>
          </span>

          <span className="plugin-head-item">
            <span className="field-label">Disabled</span>
            <span className="plugin-count">
              <span className="plugin-dot plugin-dot-dim" aria-hidden="true" />
              <span className="mono">{formatInt(disabled)}</span>
            </span>
          </span>

          <span className="plugin-head-item">
            <span className="field-label">Errored</span>
            <span className="plugin-count">
              <span className={errored > 0 ? 'plugin-dot plugin-dot-danger' : 'plugin-dot plugin-dot-dim'} aria-hidden="true" />
              <span className="mono">{formatInt(errored)}</span>
            </span>
          </span>

          <span className="plugin-head-item">
            <span className="field-label">Shipping code</span>
            <span className="plugin-count">
              <span className="mono">{formatInt(codePlugins)}</span>
              {codePlugins > 0 && <span className="plugin-mismatch small">runs in the orchestrator</span>}
            </span>
          </span>
        </div>

        <div className="dim small plugin-head-note">
          {state.allowInstall
            ? 'Marketplace installs are permitted. Every download is unpacked into the plugins root above and is not enabled automatically.'
            : 'Marketplace installs are refused by the server, so the Install buttons below are disabled. Hand-placed directories in the plugins root still load.'}{' '}
          A plugin that ships code runs in the orchestrator's process and is marked as such everywhere it appears.
        </div>
      </Panel>

      {!store.connected && (
        <div className="alert alert-warn small" role="status">
          The socket is {connection.status === 'open' ? 'open' : connection.status}
          {connection.error !== null ? ` (${connection.error})` : ''}. Showing the last known plugin state; actions still
          go to the server over HTTP and the list will not move until the socket is back.
        </div>
      )}

      {error !== null && (
        <div className="alert alert-warn small" role="status">
          The last read of <span className="mono">/api/plugins</span> failed: {error}
        </div>
      )}

      {actionError !== null && (
        <div className="alert alert-danger small" role="alert">
          {actionError}{' '}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <PluginList
        records={records}
        pluginsRoot={state.pluginsRoot}
        hostApiVersion={state.apiVersion}
        busy={busySet}
        onToggle={toggleEnabled}
        onRemove={removePlugin}
        onUpdate={updatePlugin}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onRefresh={refresh}
        onCheckUpdates={checkUpdates}
        checking={checking}
      />

      <PluginSettings record={selected} onSave={saveSettings} />

      <ContributedPanels records={records} />

      <Marketplace sources={sources} records={records} allowInstall={state.allowInstall} onRefresh={reload} />
    </>
  );
}
