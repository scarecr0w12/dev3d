/**
 * Marketplaces: where plugins can come from, and what one is offering.
 *
 * A *source* is a catalog URL the operator has registered; browsing is a
 * separate, deliberately looser act - you can look at any catalog without
 * registering it, which is how you decide whether to trust it in the first
 * place. Installing is the one thing gated by the installation's policy:
 * `allowInstall` is the operator's opt-in, and when it is off the Install
 * buttons say so rather than failing after a download starts.
 *
 * A catalog entry is a proposal, not a promise: the host verifies the published
 * sha256 against the bundle it downloads, so the row says whether a digest is
 * published at all rather than pretending every marketplace provides one.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';

import { apiCompatible } from '@dev3d/core';
import type { PluginCatalog, PluginCatalogEntry, PluginRecord, PluginSourceRecord } from '@dev3d/core';

import { api } from '../../app/api';
import { formatAgo, formatInt, truncate } from '../../app/format';
import { useNow } from '../../app/hooks';
import { Badge, Empty, ErrorState, Loading, Panel, cx } from '../ui';
import { formatBytes, isCatalogUrl, shortenDigest } from './format';

export interface MarketplaceProps {
  sources: readonly PluginSourceRecord[];
  records: readonly PluginRecord[];
  allowInstall: boolean;
  /** Re-reads the plugin state, so a source's counts and last error catch up. */
  onRefresh: () => void;
}

type Request<T> =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'ready'; data: T }
  | { phase: 'failed'; error: string };

export function Marketplace({ sources, records, allowInstall, onRefresh }: MarketplaceProps) {
  const now = useNow(1000);

  // `PluginSourceRecord[]` has its own endpoint, and the source list is the one
  // part of the plugin system a source can be added to and removed from without
  // anything else changing. Reading it here means the panel is complete when the
  // socket has not carried plugin state yet.
  const [fetchedSources, setFetchedSources] = useState<readonly PluginSourceRecord[] | null>(null);

  const [label, setLabel] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [confirmingSource, setConfirmingSource] = useState<string | null>(null);

  const [catalogUrl, setCatalogUrl] = useState('');
  const [catalog, setCatalog] = useState<Request<{ url: string; document: PluginCatalog }>>({ phase: 'idle' });
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  const installedIds = new Set(records.map((record) => record.manifest.id));

  const readSources = useCallback(() => {
    void api.pluginSources().then((result) => {
      if (result.ok && result.data) setFetchedSources(result.data);
    });
  }, []);

  useEffect(() => {
    if (sources.length > 0) return;
    readSources();
  }, [sources.length, readSources]);

  // The socket's list wins whenever it has one; the fetch is a fallback, not a
  // second opinion, so the two can never disagree on screen.
  const sourceList = sources.length > 0 ? sources : (fetchedSources ?? []);

  const addSource = useCallback(async () => {
    const trimmedLabel = label.trim();
    const trimmedUrl = sourceUrl.trim();
    if (trimmedLabel === '') {
      setSourceError('Give the source a label so it is recognisable later.');
      return;
    }
    if (!isCatalogUrl(trimmedUrl)) {
      setSourceError('A catalog must be an absolute http(s) URL, e.g. https://plugins.example.com/catalog.json');
      return;
    }
    setSourceBusy(true);
    setSourceError(null);
    const result = await api.addPluginSource(trimmedLabel, trimmedUrl);
    setSourceBusy(false);
    if (!result.ok) {
      setSourceError(result.error ?? 'the request failed');
      return;
    }
    setLabel('');
    setSourceUrl('');
    readSources();
    onRefresh();
  }, [label, sourceUrl, onRefresh, readSources]);

  const removeSource = useCallback(
    async (sourceId: string) => {
      setSourceBusy(true);
      setSourceError(null);
      const result = await api.removePluginSource(sourceId);
      setSourceBusy(false);
      setConfirmingSource(null);
      if (!result.ok) {
        setSourceError(result.error ?? 'the request failed');
        return;
      }
      readSources();
      onRefresh();
    },
    [onRefresh, readSources],
  );

  const browse = useCallback(async () => {
    const trimmed = catalogUrl.trim();
    if (!isCatalogUrl(trimmed)) {
      setCatalog({
        phase: 'failed',
        error: 'A catalog must be an absolute http(s) URL, e.g. https://plugins.example.com/catalog.json',
      });
      return;
    }
    setCatalog({ phase: 'busy' });
    setInstallError(null);
    setInstalled(null);
    const result = await api.pluginCatalog(trimmed);
    if (!result.ok || !result.data) {
      setCatalog({ phase: 'failed', error: result.error ?? 'the request failed' });
      return;
    }
    setCatalog({ phase: 'ready', data: { url: trimmed, document: result.data } });
  }, [catalogUrl]);

  const install = useCallback(
    async (entry: PluginCatalogEntry) => {
      const source = catalog.phase === 'ready' ? catalog.data.url : '';
      if (source === '') {
        setInstallError('Fetch the catalog again before installing from it.');
        return;
      }
      setInstalling(entry.manifest.id);
      setInstallError(null);
      setInstalled(null);
      const result = await api.installPlugin(source, entry.manifest.id);
      setInstalling(null);
      if (!result.ok || !result.data) {
        setInstallError(result.error ?? 'the request failed');
        return;
      }
      setInstalled(result.data.manifest.id);
      onRefresh();
    },
    [catalog, onRefresh],
  );

  return (
    <>
      <Panel
        title="Marketplaces"
        subtitle={
          sourceList.length === 0
            ? 'no catalogs registered'
            : `${sourceList.length} registered · ${formatInt(sourceList.reduce((total, source) => total + source.pluginCount, 0))} plugins offered`
        }
        actions={
          <button type="button" className="btn btn-sm" onClick={onRefresh}>
            Re-read
          </button>
        }
      >
        <section className="plugin-catalog-form">
          <div className="field">
            <label className="field-label" htmlFor="plugin-source-label">
              Label
            </label>
            <input
              id="plugin-source-label"
              type="text"
              value={label}
              maxLength={60}
              placeholder="Internal plugins"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setLabel(event.target.value)}
            />
          </div>
          <div className="field plugin-catalog-field-wide">
            <label className="field-label" htmlFor="plugin-source-url">
              Catalog URL
            </label>
            <input
              id="plugin-source-url"
              type="text"
              className="mono"
              value={sourceUrl}
              spellCheck={false}
              placeholder="https://plugins.example.com/catalog.json"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSourceUrl(event.target.value)}
            />
          </div>
        </section>

        <div className="project-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void addSource()} disabled={sourceBusy}>
            {sourceBusy ? 'working…' : 'Add marketplace'}
          </button>
          <span className="dim small">
            A marketplace is anything that serves the catalog JSON at that URL. Registering one does not install
            anything from it.
          </span>
        </div>

        {sourceError !== null && (
          <div className="alert alert-danger small" role="alert">
            {sourceError}
          </div>
        )}

        {sourceList.length === 0 ? (
          <Empty
            title="No marketplaces registered"
            hint="Add a catalog URL above, or browse one below without registering it."
          />
        ) : (
          <div className="plugin-list">
            {sourceList.map((source) => (
              <article className="project-card plugin-source-card" key={source.id}>
                <div className="plugin-card-head">
                  <span className="project-card-name">{source.label}</span>
                  <Badge tone={source.enabled ? 'ok' : 'neutral'}>{source.enabled ? 'enabled' : 'disabled'}</Badge>
                  {source.lastError !== null && <Badge tone="danger">last fetch failed</Badge>}
                  <span className="plugin-id mono small" title="catalog URL">
                    {source.url}
                  </span>
                  <span className="stage-spacer" />
                  <span className="dim small mono">
                    {formatInt(source.pluginCount)} plugin{source.pluginCount === 1 ? '' : 's'}
                  </span>
                  <span className="dim small">
                    {source.lastFetchedAt === null ? 'never fetched' : `fetched ${formatAgo(source.lastFetchedAt, now)}`}
                  </span>
                  <span className="dim small mono">{source.id}</span>
                </div>

                {source.lastError !== null && (
                  <div className="alert alert-danger small" role="alert">
                    <span className="mono plugin-error-text">{source.lastError}</span>
                  </div>
                )}

                <div className="plugin-card-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setCatalogUrl(source.url);
                      setInstalled(null);
                      setInstallError(null);
                    }}
                  >
                    Browse
                  </button>
                  <span className="stage-spacer" />
                  {confirmingSource === source.id ? (
                    <>
                      <span className="dim small">stop offering this catalog? Nothing installed from it is removed.</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void removeSource(source.id)}
                        disabled={sourceBusy}
                      >
                        Yes, remove it
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmingSource(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmingSource(source.id)}
                      disabled={sourceBusy}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Browse a catalog"
        subtitle="fetch and read any catalog document — registering it is a separate decision"
        actions={!allowInstall ? <Badge tone="warn">installs disabled</Badge> : <Badge tone="ok">installs allowed</Badge>}
      >
        <section className="plugin-catalog-form">
          <div className="field plugin-catalog-field-wide">
            <label className="field-label" htmlFor="plugin-catalog-url">
              Catalog URL
            </label>
            <input
              id="plugin-catalog-url"
              type="text"
              className="mono"
              value={catalogUrl}
              spellCheck={false}
              placeholder="https://plugins.example.com/catalog.json"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setCatalogUrl(event.target.value)}
            />
          </div>
        </section>

        <div className="project-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void browse()}
            disabled={catalog.phase === 'busy'}
          >
            {catalog.phase === 'busy' ? 'fetching…' : 'Fetch catalog'}
          </button>
          {catalog.phase === 'ready' && (
            <span className="dim small">
              read from <span className="mono">{catalog.data.url}</span>
            </span>
          )}
        </div>

        {!allowInstall && (
          <div className="alert alert-warn small" role="alert">
            Installing is turned off for this installation, so the Install buttons below are disabled. The orchestrator
            refuses installs unless the operator opts in — set <span className="mono">DEV3D_ALLOW_PLUGIN_INSTALL</span>{' '}
            (or the equivalent setting) and restart before anything can be downloaded.
          </div>
        )}

        {installError !== null && (
          <div className="alert alert-danger small" role="alert">
            {installError}
          </div>
        )}
        {installed !== null && (
          <div className="alert small" role="status">
            installed <span className="mono">{installed}</span> — its card is in the list above. Enable it there.
          </div>
        )}

        {catalog.phase === 'idle' && (
          <Empty
            title="Nothing fetched yet"
            hint="Paste a catalog URL and fetch it to see what a marketplace offers before installing anything."
          />
        )}

        {catalog.phase === 'busy' && <Loading label="fetching the catalog" />}

        {catalog.phase === 'failed' && (
          <ErrorState title="The catalog could not be read" detail={catalog.error} onRetry={() => void browse()} />
        )}

        {catalog.phase === 'ready' && (
          <CatalogView
            document={catalog.data.document}
            sourceUrl={catalog.data.url}
            installedIds={installedIds}
            installing={installing}
            allowInstall={allowInstall}
            onInstall={(entry) => void install(entry)}
          />
        )}
      </Panel>
    </>
  );
}

function CatalogView({
  document,
  sourceUrl,
  installedIds,
  installing,
  allowInstall,
  onInstall,
}: {
  document: PluginCatalog;
  sourceUrl: string;
  installedIds: ReadonlySet<string>;
  installing: string | null;
  allowInstall: boolean;
  onInstall: (entry: PluginCatalogEntry) => void;
}) {
  const entries = document.plugins;

  return (
    <section className="plugin-catalog">
      <div className="plugin-catalog-head">
        <span className="strong">{document.name}</span>
        <span className="dim small">catalog format v{document.version}</span>
        {document.homepage !== undefined && document.homepage !== '' && (
          <a className="link small" href={document.homepage} target="_blank" rel="noreferrer noopener">
            {document.homepage}
          </a>
        )}
        <span className="stage-spacer" />
        <span className="dim small mono">
          {formatInt(entries.length)} entr{entries.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {entries.length === 0 ? (
        <Empty title="This catalog is empty" hint="It parsed correctly but lists no plugins." />
      ) : (
        <div className="plugin-list">
          {entries.map((entry) => (
            <CatalogRow
              key={entry.manifest.id}
              entry={entry}
              sourceUrl={sourceUrl}
              isInstalled={installedIds.has(entry.manifest.id)}
              installing={installing === entry.manifest.id}
              allowInstall={allowInstall}
              onInstall={() => onInstall(entry)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CatalogRow({
  entry,
  sourceUrl,
  isInstalled,
  installing,
  allowInstall,
  onInstall,
}: {
  entry: PluginCatalogEntry;
  sourceUrl: string;
  isInstalled: boolean;
  installing: boolean;
  allowInstall: boolean;
  onInstall: () => void;
}) {
  const manifest = entry.manifest;
  const tags = entry.tags ?? [];
  const disabledReason = !allowInstall
    ? 'This installation does not permit downloads: installs are refused until the operator opts in.'
    : isInstalled
      ? 'Already installed.'
      : '';

  return (
    <article className="project-card plugin-catalog-row">
      <div className="plugin-card-head">
        <span className="project-card-name">{manifest.name}</span>
        <span className="plugin-id mono small">{manifest.id}</span>
        <span className="dim small mono">v{manifest.version}</span>
        {manifest.author !== undefined && manifest.author !== '' && (
          <span className="dim small">by {manifest.author}</span>
        )}
        {isInstalled && <Badge tone="ok">installed</Badge>}
        <span className="stage-spacer" />
        <span className="dim small mono">{formatBytes(entry.sizeBytes)}</span>
      </div>

      {manifest.description !== '' && <div className="project-card-desc small">{manifest.description}</div>}

      <div className="plugin-meta">
        <span className="inline-gap">
          <span className="dim small">download</span>
          <span className="mono small plugin-path" title={entry.downloadUrl}>
            {entry.downloadUrl}
          </span>
        </span>

        <span className="inline-gap">
          <span className="dim small">checksum</span>
          {entry.sha256 !== undefined && entry.sha256 !== '' ? (
            <span className="mono small" title={entry.sha256}>
              sha256 {shortenDigest(entry.sha256)} — verified against the download
            </span>
          ) : (
            <span className="plugin-mismatch small">none published — nothing to verify against</span>
          )}
        </span>

        <span className="inline-gap">
          <span className="dim small">plugin API</span>
          <span className="mono small">
            {manifest.apiVersion}
            {!apiCompatible(manifest.apiVersion) ? ' — check compatibility before installing' : ''}
          </span>
        </span>

        {tags.length > 0 && (
          <span className="inline-gap">
            <span className="dim small">tags</span>
            <span className="chips">
              {tags.map((tag) => (
                <Badge key={tag} tone="neutral" mono>
                  {tag}
                </Badge>
              ))}
            </span>
          </span>
        )}
      </div>

      {entry.readme !== undefined && entry.readme !== '' && (
        <div className="dim small plugin-readme">{truncate(entry.readme, 400)}</div>
      )}

      <div className="plugin-card-actions">
        <button
          type="button"
          className={cx('btn', 'btn-sm', 'btn-primary')}
          onClick={onInstall}
          disabled={!allowInstall || isInstalled || installing}
          title={disabledReason === '' ? `Download and unpack into the plugins root from ${sourceUrl}` : disabledReason}
        >
          {installing ? 'installing…' : isInstalled ? 'already installed' : 'Install'}
        </button>
        {disabledReason !== '' && <span className="plugin-mismatch small">{disabledReason}</span>}
        {disabledReason === '' && (
          <span className="dim small">
            Downloads the bundle into the plugins root. It is not enabled automatically.
          </span>
        )}
      </div>
    </article>
  );
}
