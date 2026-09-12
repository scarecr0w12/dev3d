/**
 * Thin HTTP client for the orchestrator's read-only endpoints.
 *
 * The WebSocket is the primary source of truth - this module exists for the two
 * cold-start jobs the socket cannot do on its own:
 *
 *  - `/api/state` when the socket has not delivered `hello` yet, so the console
 *    is not blank while the server is still coming up.
 *  - the skills catalogue and a run's full turn history, which are not pushed.
 *
 * Every call is wrapped: a failure is returned, never thrown, so a panel can
 * show a real error state instead of taking the whole console down.
 */

import type {
  Artifact,
  ChatTurnInput,
  DirectMessage,
  ModelSpec,
  OfficeSettings,
  OfficeState,
  PanelWidget,
  PluginCatalog,
  PluginRecord,
  PluginSourceRecord,
  PluginSystemState,
  Role,
  Run,
  SkillSummary,
  TurnRecord,
  Workspace,
  WorkspaceBudget,
  WorkspaceSummary,
} from '@dev3d/core';

/** What `GET /api/plugins/:id/panels/:panelId` answers with. */
export interface PluginPanelRead {
  ok: boolean;
  pluginId: string;
  panelId: string;
  title: string;
  live: boolean;
  widgets: PanelWidget[];
  fetchedAt: number;
  error?: string;
}

/** One tool an employee could be granted. */
export interface ToolSummary {
  name: string;
  description: string;
  /** The plugin that registered it, or null for a built-in tool. */
  pluginId: string | null;
}

/** A role a plugin offers as a starting point for a hire. */
export interface RoleTemplate {
  pluginId: string;
  role: Role;
}

export interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  status: number | null;
}

export interface HealthResponse {
  ok: boolean;
  llmMode: 'mock' | 'live' | string;
  version: string;
}

/** `GET /api/runs/:id` returns the run plus its turns (and artifacts when known). */
export interface RunDetailResponse extends Run {
  turns?: TurnRecord[];
  artifacts?: Artifact[];
}

const DEFAULT_TIMEOUT_MS = 8000;

async function request<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS, init?: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      method: init?.method ?? 'GET',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      // The orchestrator explains refusals in a JSON `error` field - a rejected
      // workspace path, for instance - and that text is far more useful to show
      // than "HTTP 400 Bad Request".
      const detail = await response.text().catch(() => '');
      let message = `HTTP ${response.status} ${response.statusText}`.trim();
      if (detail.length > 0) {
        try {
          const parsed = JSON.parse(detail) as { error?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.length > 0) message = parsed.error;
        } catch {
          /* not JSON; the status line is all we have */
        }
      }
      return { ok: false, data: null, error: message, status: response.status };
    }
    const text = await response.text();
    if (text.length === 0) {
      return { ok: false, data: null, error: 'empty response body', status: response.status };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, data: null, error: 'response was not JSON', status: response.status };
    }
    return { ok: true, data: parsed as T, error: null, status: response.status };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      data: null,
      error: aborted ? `timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
      status: null,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  health: () => request<HealthResponse>('/api/health', 4000),
  state: () => request<OfficeState>('/api/state'),
  runs: () => request<Run[]>('/api/runs'),
  run: (runId: string) => request<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`),
  skills: () => request<SkillSummary[]>('/api/skills'),
  models: () => request<ModelSpec[]>('/api/models'),
  /**
   * Fallback path for a direct chat when the socket is not open. Normally the
   * `chat` command goes over the WebSocket and the reply arrives as a
   * `direct.message` event.
   */
  chat: (employeeId: string, text: string) =>
    request<DirectMessage[]>('/api/chat', 90_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId, text }),
    }),

  /**
   * Fallback path for a planning turn, used when the socket is not open. The
   * socket `plan` command is the normal route; both land in the same shape.
   */
  plan: (input: { employeeId: string; text: string; history: ChatTurnInput[]; workspaceId?: string }) =>
    request<{ text: string; employeeId: string }>('/api/plan', 120_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  workspaces: () => request<WorkspaceSummary[]>('/api/workspaces'),
  settings: () => request<OfficeSettings>('/api/settings'),
  /**
   * Installation settings. Over HTTP rather than the socket so the form gets the
   * server's exact reason when a value is refused.
   */
  updateSettings: (patch: Partial<OfficeSettings>) =>
    request<OfficeSettings>('/api/settings', 15_000, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /**
   * Creating a project goes over HTTP rather than the socket so the form gets a
   * real answer: the server either returns the workspace or explains exactly why
   * the path was refused. The list itself still updates from the `org.updated`
   * event that the server broadcasts either way.
   */
  createWorkspace: (input: { name: string; description?: string; folder?: string; path?: string }) =>
    request<Workspace>('/api/workspaces', 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /** Skills, budget and identity of one organisation, in a single request. */
  updateWorkspace: (
    workspaceId: string,
    patch: { skillIds?: string[]; budget?: Partial<WorkspaceBudget>; name?: string; description?: string; color?: string },
  ) =>
    request<WorkspaceSummary>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, 15_000, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeWorkspace: (workspaceId: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, 15_000, {
      method: 'DELETE',
    }),

  // ------------------------------------------------------------------ plugins
  //
  // The socket carries the plugin system's *state* (`hello`, `office.updated`
  // and `plugins.updated` all hand over a whole `PluginSystemState`). These calls
  // exist for *actions*, because a form deserves the server's exact reason when
  // an action is refused rather than a silent no-op.
  //
  // Note the deliberate asymmetry with the socket: the console reads state from
  // the socket and acts over HTTP, so `ClientCommand`'s plugin variants stay
  // unused on this side.

  plugins: () => request<PluginSystemState>('/api/plugins'),
  /** Turns an installed plugin on or off. Disabling unloads what it contributed. */
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    request<PluginRecord>(`/api/plugins/${encodeURIComponent(pluginId)}/enable`, 20_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  /**
   * A plugin's settings, merged over its manifest defaults. The whole object is
   * sent rather than a patch: the manifest is the schema, and a field the form
   * never rendered should not silently keep a stale value.
   */
  configurePlugin: (pluginId: string, settings: Record<string, unknown>) =>
    request<PluginRecord>(`/api/plugins/${encodeURIComponent(pluginId)}/settings`, 20_000, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
  /** Re-scans the plugins directory, picking up directories added by hand. */
  refreshPlugins: () => request<PluginSystemState>('/api/plugins/refresh', 30_000, { method: 'POST' }),
  /**
   * Asks every registered marketplace what it is offering. Slower than a rescan:
   * it reaches out to each source in turn, and a dead one is reported rather than
   * failing the whole check.
   */
  checkPluginUpdates: () =>
    request<{ ok: boolean; checked: number; found: number; error?: string; state: PluginSystemState }>(
      '/api/plugins/updates',
      60_000,
      { method: 'POST' },
    ),
  /** Fetches a plugin bundle and unpacks it into the install root. */
  installPlugin: (catalogUrl: string, pluginId: string, upgrade = false) =>
    request<PluginRecord>('/api/plugins/install', 120_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogUrl, pluginId, upgrade }),
    }),
  /** Deletes the plugin's directory. Nothing is archived; this is a real delete. */
  removePlugin: (pluginId: string) =>
    request<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(pluginId)}`, 30_000, { method: 'DELETE' }),

  pluginSources: () => request<PluginSourceRecord[]>('/api/plugins/sources'),
  addPluginSource: (label: string, url: string) =>
    request<PluginSourceRecord>('/api/plugins/sources', 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, url }),
    }),
  removePluginSource: (sourceId: string) =>
    request<{ ok: boolean }>(`/api/plugins/sources/${encodeURIComponent(sourceId)}`, 15_000, {
      method: 'DELETE',
    }),
  /**
   * Browses a marketplace's catalog document without installing anything. The
   * URL need not be registered as a source - this is for looking before leaping.
   */
  pluginCatalog: (url: string) =>
    request<PluginCatalog>(`/api/plugins/catalog?url=${encodeURIComponent(url)}`, 20_000),
  /**
   * One contributed panel's widgets, already validated by the server. The
   * plugin's own endpoint is never called from here - that is the point.
   */
  pluginPanel: (pluginId: string, panelId: string) =>
    request<PluginPanelRead>(
      `/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}`,
      20_000,
    ),
  /** Every tool that exists, with the plugin that registered it. */
  tools: () => request<ToolSummary[]>('/api/tools'),
  /** Role templates plugins offer, for the hire form. */
  roleTemplates: () => request<RoleTemplate[]>('/api/plugins/role-templates'),
};

/** Narrows an unknown JSON payload to an array without trusting its contents. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
