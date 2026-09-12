/**
 * Installed plugins.
 *
 * One card per plugin, and the card is a consent surface as much as a listing:
 * whether the thing ships code that runs inside the orchestrator, what it asked
 * to be allowed to touch, and which plugin API it was built against all appear
 * before anything else. Removing one deletes its directory, which is worth a
 * confirmation step because nothing here archives anything.
 *
 * Every action goes over HTTP so the server's refusal is what the operator
 * reads; the list itself is redrawn from the `plugins.updated` event.
 */

import { useState } from 'react';

import type { PluginRecord } from '@dev3d/core';

import { formatAgo } from '../../app/format';
import { useNow } from '../../app/hooks';
import { Badge, Empty, Panel, cx } from '../ui';
import { checkApiVersion, contributionLine, contributionRows, describePermissions, sourceCopy, statusCopy } from './format';

export interface PluginListProps {
  records: readonly PluginRecord[];
  /** Where plugins are loaded from; shown so a path can be inspected on disk. */
  pluginsRoot: string;
  /** The plugin API this host implements, for the compatibility check. */
  hostApiVersion: string;
  /** Plugin ids with a request in flight. */
  busy: ReadonlySet<string>;
  onToggle: (record: PluginRecord, next: boolean) => void;
  onRemove: (record: PluginRecord) => void;
  /** Install the newer version a marketplace is offering. */
  onUpdate: (record: PluginRecord) => void;
  selectedId: string | null;
  onSelect: (pluginId: string) => void;
  onRefresh: () => void;
  /** Ask the marketplaces what they have; slower than a rescan and can partly fail. */
  onCheckUpdates: () => void;
  checking: boolean;
}

export function PluginList({
  records,
  pluginsRoot,
  hostApiVersion,
  busy,
  onToggle,
  onRemove,
  onUpdate,
  selectedId,
  onSelect,
  onRefresh,
  onCheckUpdates,
  checking,
}: PluginListProps) {
  const now = useNow(1000);
  const [confirming, setConfirming] = useState<string | null>(null);

  const errored = records.filter((record) => record.status === 'error').length;

  return (
    <Panel
      title="Installed plugins"
      subtitle={
        records.length === 0
          ? 'nothing installed yet'
          : `${records.length} installed · ${records.filter((record) => record.status === 'loaded').length} loaded${
              errored > 0 ? ` · ${errored} errored` : ''
            }`
      }
      tone={errored > 0 ? 'danger' : 'default'}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRefresh}
            title="Re-scan the plugins directory, picking up directories added by hand"
          >
            Rescan directory
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onCheckUpdates}
            disabled={checking}
            title="Ask every registered marketplace whether it has a newer version of anything installed"
          >
            {checking ? 'checking…' : 'Check for updates'}
          </button>
        </>
      }
    >
      {records.length === 0 ? (
        <Empty
          title="No plugins installed"
          hint={
            <>
              Nothing is loaded from <span className="mono">{pluginsRoot === '' ? 'the plugins root' : pluginsRoot}</span>
              . Drop a directory containing a <span className="mono">plugin.json</span> there and rescan, or install
              one from a marketplace below.
            </>
          }
        />
      ) : (
        <div className="plugin-list">
          {records.map((record) => (
            <PluginCard
              key={record.manifest.id}
              record={record}
              now={now}
              hostApiVersion={hostApiVersion}
              busy={busy.has(record.manifest.id)}
              selected={selectedId === record.manifest.id}
              confirming={confirming === record.manifest.id}
              onSelect={() => onSelect(record.manifest.id)}
              onToggle={() => onToggle(record, record.status !== 'loaded')}
              onUpdate={() => onUpdate(record)}
              onAskRemove={() => setConfirming(record.manifest.id)}
              onCancelRemove={() => setConfirming(null)}
              onRemove={() => {
                setConfirming(null);
                onRemove(record);
              }}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function PluginCard({
  record,
  now,
  hostApiVersion,
  busy,
  selected,
  confirming,
  onSelect,
  onToggle,
  onUpdate,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  record: PluginRecord;
  now: number;
  hostApiVersion: string;
  busy: boolean;
  selected: boolean;
  confirming: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onUpdate: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const manifest = record.manifest;
  const status = statusCopy(record.status);
  const source = sourceCopy(record.source);
  const version = checkApiVersion(record, hostApiVersion);
  const contributions = contributionRows(record.contributions);
  const permissions = describePermissions(manifest.permissions);

  return (
    <article
      className={cx('project-card', 'plugin-card', selected && 'project-card-active')}
      title={`contributes ${contributionLine(record.contributions)}`}
    >
      <div
        className="plugin-card-head"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        title="Show this plugin's settings"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <span className="project-card-name">{manifest.name}</span>
        <span className="plugin-id mono small" title="manifest id">
          {manifest.id}
        </span>
        <span className="dim small mono">v{manifest.version}</span>
        <Badge tone={status.tone} title={status.hint}>
          {status.label}
        </Badge>
        <Badge
          tone={record.hasCode ? 'warn' : 'ok'}
          title={
            record.hasCode
              ? 'This plugin ships a module the orchestrator imports and runs in its own process.'
              : 'Declarative: data only, no module is loaded, so it can do nothing the manifest does not describe.'
          }
        >
          {record.hasCode ? 'runs code' : 'data only'}
        </Badge>
        <Badge tone={source.tone} title={source.hint}>
          {source.label}
        </Badge>
        {manifest.author !== undefined && manifest.author !== '' && (
          <span className="dim small">by {manifest.author}</span>
        )}
        {manifest.homepage !== undefined && manifest.homepage !== '' && (
          <a
            className="link small"
            href={manifest.homepage}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
          >
            homepage
          </a>
        )}
        <span className="stage-spacer" />
        {selected && <Badge tone="accent">settings below</Badge>}
      </div>

      {manifest.description !== '' && <div className="project-card-desc small">{manifest.description}</div>}

      {record.hasCode ? (
        <div className="alert alert-warn small plugin-code-note" role="note">
          <span className="strong">This plugin runs code.</span>
          <span>
            It ships <span className="mono">{manifest.entry ?? 'an entry module'}</span>, which the orchestrator imports
            into its own process. Every tool it registers and every event it observes runs there, with the
            orchestrator&apos;s own access — the manifest's permissions say what it asked for, not what it can reach.
          </span>
        </div>
      ) : (
        <div className="dim small plugin-code-note">
          Declarative: data only. No module is loaded, so it can contribute nothing beyond what its manifest lists.
        </div>
      )}

      {record.status === 'error' && (
        <div className="alert alert-danger small" role="alert">
          <span className="strong">This plugin did not load.</span>
          <span className="mono plugin-error-text">{record.error ?? 'the host reported an error without a message'}</span>
        </div>
      )}

      <div className="plugin-meta">
        <span className="inline-gap">
          <span className="dim small">plugin API</span>
          <span className={cx('mono', 'small', version.matches ? 'ok' : 'danger')} title={version.detail}>
            {version.plugin}
          </span>
          {version.matches ? (
            <span className="dim small">matches host {version.host}</span>
          ) : (
            <span className="plugin-mismatch small">host implements {version.host} — mismatch</span>
          )}
        </span>

        <span className="inline-gap">
          <span className="dim small">directory</span>
          <span className="mono small plugin-path" title={record.directory}>
            {record.directory}
          </span>
        </span>

        <span className="inline-gap">
          <span className="dim small">installed</span>
          <span className="small">{formatAgo(record.installedAt, now)}</span>
        </span>

        <span className="inline-gap">
          <span className="dim small">contributes</span>
          {contributions.length === 0 ? (
            <span className="dim small">nothing</span>
          ) : (
            <span className="chips">
              {contributions.map((row) => (
                <Badge key={row.label} tone="neutral" mono>
                  {`${row.count} ${row.label}`}
                </Badge>
              ))}
            </span>
          )}
        </span>
      </div>

      <div className="plugin-perms">
        <span className="dim small">permissions</span>
        {permissions.length === 0 ? (
          <span className="dim small">
            none requested — this plugin declared no permission, so it can only contribute what the manifest lists
          </span>
        ) : (
          <span className="plugin-perm-list">
            {permissions.map((permission) => (
              <span
                key={permission.label}
                className={cx('plugin-perm', permission.elevated && 'plugin-perm-elevated')}
                title={permission.detail}
              >
                <span className="mono">{permission.label}</span>
                <span className="plugin-perm-detail">{permission.detail}</span>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="plugin-card-actions">
        {record.update !== undefined && (
          <Badge
            tone="info"
            title={`${record.update.sourceLabel} offers ${record.update.latest}. Updating replaces the installed copy; its settings are kept.`}
          >
            {record.update.installed} → {record.update.latest} available
          </Badge>
        )}
        {record.update !== undefined && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onUpdate}
            disabled={busy}
            title={`Download ${record.update.latest} from ${record.update.sourceLabel} and replace this copy`}
          >
            Update
          </button>
        )}
        <button
          type="button"
          className={cx('btn', 'btn-sm', record.status === 'loaded' ? 'btn-ghost' : 'btn-primary')}
          onClick={onToggle}
          disabled={busy}
          title={
            record.status === 'loaded'
              ? 'Unload this plugin and everything it contributed'
              : 'Load this plugin and everything it contributes'
          }
        >
          {busy ? 'working…' : record.status === 'loaded' ? 'Disable' : 'Enable'}
        </button>
        {record.status === 'error' && (
          <span className="dim small">enabling retries the load and reports what fails</span>
        )}

        <span className="stage-spacer" />

        {confirming ? (
          <>
            <span className="plugin-confirm small">
              Delete <span className="mono">{record.directory}</span> and everything in it? Unlike removing a project,
              this really does delete files from disk, and nothing is archived.
            </span>
            <button type="button" className="btn btn-sm btn-danger" onClick={onRemove} disabled={busy}>
              Yes, delete it
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelRemove}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onAskRemove}
            disabled={busy}
            title="Delete this plugin's directory from disk"
          >
            Remove
          </button>
        )}
      </div>
    </article>
  );
}
