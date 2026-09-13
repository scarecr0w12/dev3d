/**
 * Panel reader: turns a declarative panel into widgets the console can draw.
 *
 * The trust model is the whole point of this file. A plugin's panel is *data*:
 * either a `body` fixed in the manifest, or a `source` URL that **this server**
 * fetches and validates. The browser never learns that URL and never receives
 * anything but a closed set of widget shapes, so a marketplace plugin cannot
 * reach the page, the socket or the operator's session - the worst it can do is
 * render an ugly table.
 *
 * Two consequences worth naming:
 *
 *  - Fetching server-side keeps a plugin endpoint out of the browser, and a dead
 *    endpoint costs one panel rather than the console. It does **not** mean the
 *    plugin cannot probe the machine — the server is the one probing, and the
 *    answer is rendered on the operator's screen. So the fetch is guarded: a panel
 *    source may not point at a loopback, private or link-local address unless the
 *    operator says so, and it may not redirect. That sentence used to claim the
 *    first half of this without doing it, which is worse than not claiming it.
 *  - Because the fetch happens here, a hostile or merely broken source could
 *    otherwise turn every console into a request amplifier, so responses are
 *    cached for at least the panel's `refreshMs`, concurrent requests for the
 *    same panel are coalesced onto one fetch, and there is a hard ceiling on how
 *    many live panels may be fetched at all.
 */

import type { PanelWidget, UiPanelContribution } from '@dev3d/core';
import { checkHostIsPublic, fetchGuarded } from '../security/webGuard.ts';
import { validatePanelWidgets } from './manifest.ts';

export interface PanelReadResult {
  ok: boolean;
  pluginId: string;
  panelId: string;
  title: string;
  /** True when the widgets came from the plugin's endpoint rather than the manifest. */
  live: boolean;
  widgets: PanelWidget[];
  fetchedAt: number;
  error?: string;
}

const DEFAULT_REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * A ceiling on distinct live panels. Panels are decoration, and an installation
 * with fifty plugins should not be able to aim fifty upstream fetches at a
 * console that is merely open.
 */
const MAX_LIVE_PANELS = 12;

interface CacheEntry {
  at: number;
  widgets: PanelWidget[];
  error: string | null;
}

export interface PanelReader {
  read(pluginId: string, panelId: string): Promise<PanelReadResult>;
  /** Forget every cached response, e.g. because plugins changed. */
  invalidate(): void;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPanelReader(options: {
  panels: () => Array<{ pluginId: string; panel: UiPanelContribution }>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  /**
   * Whether a panel may be served from a private address. Off by default: see
   * `allowPrivatePanelHosts` in the config for why this is an explicit opt-in.
   */
  allowPrivateHosts?: boolean;
}): PanelReader {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PanelReadResult>>();
  /** Hosts already logged, so one endpoint is named once rather than every refresh. */
  const loggedHosts = new Set<string>();

  function find(pluginId: string, panelId: string): UiPanelContribution | null {
    const entry = options.panels().find(
      (candidate) => candidate.pluginId === pluginId && candidate.panel.id === panelId,
    );
    return entry?.panel ?? null;
  }

  function result(
    pluginId: string,
    panelId: string,
    title: string,
    widgets: PanelWidget[],
    live: boolean,
    error?: string,
  ): PanelReadResult {
    const out: PanelReadResult = { ok: error === undefined, pluginId, panelId, title, live, widgets, fetchedAt: Date.now() };
    if (error !== undefined) out.error = error;
    return out;
  }

  /** Fetch and validate one source. Never throws: a failure is a panel state. */
  async function fetchSource(
    pluginId: string,
    panel: UiPanelContribution,
  ): Promise<{ widgets: PanelWidget[]; error: string | null }> {
    const source = panel.source;
    if (source === undefined) return { widgets: panel.body ?? [], error: null };

    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return { widgets: [], error: 'the panel endpoint is not a URL.' };
    }

    // Named once per host, so an operator can see where a panel's data comes from
    // without the console refreshing it into their log every thirty seconds.
    if (!loggedHosts.has(url.host)) {
      loggedHosts.add(url.host);
      options.log('info', `plugin:${pluginId}`, `panel "${panel.id}" is served by ${url.host}.`);
    }

    try {
      // No redirects: the URL in the manifest is meant to be the endpoint, and a
      // redirect is how a source that passed the host check reaches an address the
      // check refused. Host-guarded unless the operator opted in to private ones,
      // because *this server* is the one probing and the answer is drawn on the
      // operator's screen.
      const attempt = await fetchGuarded(url, {
        headers: { accept: 'application/json' },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxRedirects: 0,
        ...(options.allowPrivateHosts === true
          ? { check: async () => ({ ok: true, reason: '', addresses: [] }) }
          : { check: checkHostIsPublic }),
      });
      if (!attempt.ok) {
        return {
          widgets: [],
          error: attempt.refused
            ? `the panel endpoint was refused: ${attempt.reason}`
            : `could not reach the panel endpoint: ${attempt.error}`,
        };
      }

      const response = attempt.response;
      if (!response.ok) return { widgets: [], error: `the panel endpoint returned HTTP ${response.status}.` };
      const raw = (await response.json()) as unknown;
      const container =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)['widgets']
          : raw;
      const { widgets, dropped } = validatePanelWidgets(container);
      if (widgets.length === 0) {
        return { widgets: [], error: 'the panel endpoint returned nothing renderable.' };
      }
      if (dropped > 0) {
        options.log('warn', `plugin:${pluginId}`, `panel "${panel.id}": ${dropped} widget(s) were not renderable.`);
      }
      return { widgets, error: null };
    } catch (error) {
      return { widgets: [], error: `could not reach the panel endpoint: ${errMsg(error)}` };
    }
  }

  async function readUncached(pluginId: string, panelId: string): Promise<PanelReadResult> {
    const panel = find(pluginId, panelId);
    if (panel === null) {
      return result(pluginId, panelId, panelId, [], false, `no panel "${panelId}" is contributed by "${pluginId}".`);
    }

    // A manifest body is free and cannot fail, so it is never cached.
    if (panel.source === undefined) {
      return result(pluginId, panelId, panel.title, panel.body ?? [], false);
    }

    const key = `${pluginId}/${panelId}`;
    const cached = cache.get(key);
    const ttl = panel.source.refreshMs ?? DEFAULT_REFRESH_MS;
    if (cached !== undefined && Date.now() - cached.at < ttl) {
      return result(pluginId, panelId, panel.title, cached.widgets, true, cached.error ?? undefined);
    }

    if (cache.size >= MAX_LIVE_PANELS && !cache.has(key)) {
      const message = `this installation already reads ${MAX_LIVE_PANELS} live panels; this one was not fetched.`;
      return result(pluginId, panelId, panel.title, [], true, message);
    }

    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<PanelReadResult> => {
      const { widgets, error } = await fetchSource(pluginId, panel);
      cache.set(key, { at: Date.now(), widgets, error });
      return result(pluginId, panelId, panel.title, widgets, true, error ?? undefined);
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, pending);
    return pending;
  }

  return {
    read: readUncached,
    invalidate() {
      cache.clear();
    },
  };
}
