/**
 * Contributed panels, mounted wherever a plugin asked for them.
 *
 * Discovery needs no request: a panel's declaration lives in the plugin
 * manifest, which the socket already delivered, so a manifest-bodied panel
 * renders with no HTTP at all. Only a panel with a `source` costs a request,
 * and that request goes to *our* server, which fetches and validates the plugin
 * endpoint. The browser never learns the plugin's URL.
 *
 * The component renders nothing when no plugin claims the placement, so it can
 * be dropped into an existing surface without a wrapper deciding anything.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PanelWidget, PluginRecord, UiPanelContribution } from '@dev3d/core';

import { api } from '../../app/api';
import { useOffice } from '../../app/StoreContext';
import { Badge } from '../ui';
import { PanelSourceBadge, PanelWidgets } from './PanelWidgets';
import { panelTokenStyle } from './panelTokens.ts';

interface PanelRead {
  widgets: PanelWidget[];
  live: boolean;
  error: string | null;
}

/**
 * Read one panel: straight from the manifest when it carries a body, otherwise
 * from the server, re-read on the interval the plugin asked for.
 */
function usePanelRead(pluginId: string, panel: UiPanelContribution): PanelRead {
  const body = panel.body;
  const source = panel.source;
  const [state, setState] = useState<PanelRead>(() =>
    body !== undefined ? { widgets: body, live: false, error: null } : { widgets: [], live: true, error: null },
  );
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (source === undefined) {
      setState({ widgets: body ?? [], live: false, error: null });
      return;
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await api.pluginPanel(pluginId, panel.id);
      if (cancelled || !alive.current) return;
      if (!result.ok || result.data === null) {
        setState((previous) => ({ ...previous, live: true, error: result.error ?? 'the panel could not be read' }));
        return;
      }
      setState({ widgets: result.data.widgets, live: true, error: result.data.error ?? null });
    };

    void load();
    // The server already floors this interval; the clamp here just keeps a
    // manifest from making every open console poll at an absurd rate.
    const period = Math.max(5_000, source.refreshMs ?? 30_000);
    const timer = window.setInterval(() => void load(), period);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pluginId, panel.id, source === undefined ? '' : source.url, body]);

  return state;
}

function PanelCard({ record, panel }: { record: PluginRecord; panel: UiPanelContribution }) {
  const pluginId = record.manifest.id;
  const read = usePanelRead(pluginId, panel);
  const stale = read.error !== null && read.widgets.length === 0;
  const style = panelTokenStyle(panel.tokens) as CSSProperties | undefined;

  return (
    <section className="plugin-panel" title={panel.summary} style={style}>
      <header className="plugin-panel-head">
        <span className="plugin-panel-title">{panel.title}</span>
        <PanelSourceBadge live={read.live} stale={stale} />
        <span className="stage-spacer" />
        <span className="dim small mono" title={`Contributed by ${pluginId}`}>
          {pluginId}
        </span>
      </header>
      {panel.summary !== '' && <div className="dim small plugin-panel-summary">{panel.summary}</div>}
      {read.error !== null && <div className="dim small alert alert-warn plugin-panel-error">{read.error}</div>}
      {read.widgets.length > 0 ? (
        <PanelWidgets widgets={read.widgets} />
      ) : (
        stale && <div className="dim small">Nothing to show until its endpoint answers.</div>
      )}
    </section>
  );
}

export function PluginPanels({
  placement,
  className,
}: {
  placement: UiPanelContribution['placement'];
  className?: string;
}) {
  const office = useOffice();

  const panels = useMemo(() => {
    const records = office?.plugins.records ?? [];
    const out: Array<{ record: PluginRecord; panel: UiPanelContribution }> = [];
    for (const record of records) {
      // Only a loaded plugin is contributing anything: a disabled one keeps its
      // record so the operator can turn it back on, but nothing it declared is
      // in the office, and a panel is no exception.
      if (record.status !== 'loaded' || !record.enabled) continue;
      for (const panel of record.manifest.contributes?.uiPanels ?? []) {
        if (panel.placement === placement) out.push({ record, panel });
      }
    }
    return out.sort((a, b) => a.panel.title.localeCompare(b.panel.title));
  }, [office?.plugins.records, placement]);

  if (panels.length === 0) return null;

  return (
    <div className={className === undefined ? 'plugin-panels' : `plugin-panels ${className}`}>
      <div className="plugin-panels-head">
        <span className="popout-section-title">From plugins</span>
        <Badge tone="neutral">
          {panels.length} panel{panels.length === 1 ? '' : 's'}
        </Badge>
      </div>
      {panels.map(({ record, panel }) => (
        <PanelCard record={record} panel={panel} key={`${record.manifest.id}/${panel.id}`} />
      ))}
    </div>
  );
}
