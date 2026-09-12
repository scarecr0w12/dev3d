/**
 * dev3d orchestrator - the process that is the company.
 *
 * Boot order matters and is deliberate: configuration, then persistence, then
 * the skills on disk, then the model providers, then the runtime that owns the
 * org chart, and only then the engine that needs all of them. The HTTP and
 * WebSocket surfaces are opened last, so a client can never connect to an office
 * that is not finished standing up.
 *
 * The transport is one WebSocket for everything live (the `ServerEvent` /
 * `ClientCommand` protocol in `@dev3d/core`) plus a small read-only HTTP API for
 * cold loads, health, and scripted use. `GET /api/health` is the only endpoint
 * that is safe to expose; nothing here authenticates, so bind it to localhost.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent, SkillSummary } from '@dev3d/core';
import { toSkillSummary } from '@dev3d/core';
import { loadConfig } from './config.ts';
import type { ProviderConfig } from './config.ts';
import { createRunEngine } from './engine/runEngine.ts';
import type { ChatTurn } from './engine/runEngine.ts';
import { createProviderRegistry } from './llm/registry.ts';
import { createPluginHost, type PluginHost } from './plugins/host.ts';
import { createRuntime, type LogFn, type Runtime } from './server/runtime.ts';
import { loadSkills, loadSkillsWithReport } from './skills/loader.ts';
import { openStore } from './store/store.ts';
import { createDefaultTools, createToolRegistry } from './tools/registry.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function makeLogger(min: keyof typeof LEVELS): LogFn {
  const threshold = LEVELS[min];
  return (level, scope, message) => {
    if (LEVELS[level] < threshold) return;
    const stamp = new Date().toISOString().slice(11, 23);
    const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** How much conversation a single planning turn will carry back to the model. */
const HISTORY_LIMIT = 40;
const HISTORY_TURN_CHARS = 4000;

/**
 * Validates the replayed history of a planning conversation.
 *
 * This is untrusted client input on its way into a prompt, so it is *filtered*
 * rather than trusted: unknown roles are dropped, text is coerced to a string
 * and truncated, and the whole thing is capped. The client could only ever send
 * `user` and `assistant` anyway, but the server does not rely on that.
 */
function normalizeHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of value.slice(-HISTORY_LIMIT)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { role?: unknown; text?: unknown };
    if (candidate.role !== 'user' && candidate.role !== 'assistant') continue;
    if (typeof candidate.text !== 'string') continue;
    const text = candidate.text.trim();
    if (text.length === 0) continue;
    turns.push({ role: candidate.role, text: text.slice(0, HISTORY_TURN_CHARS) });
  }
  return turns;
}

/**
 * Read a JSON body, answering 400 rather than throwing when it is malformed.
 * A client sending the wrong shape is a client error, not a server fault, and
 * "Internal error" tells the person holding the curl command nothing.
 */
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 413, { error: e instanceof Error ? e.message : 'The request body could not be read.' });
    return null;
  }
  try {
    return JSON.parse(raw === '' ? '{}' : raw) as T;
  } catch {
    sendJson(res, 400, { error: 'The request body was not valid JSON.' });
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);

  const store = openStore(config.dbPath, log);
  // Reported rather than thrown: a malformed skill is a typo in a markdown file,
  // and it must not be the reason the office refuses to open. The loader logs
  // each file it skips with its reason; this is the one-line summary.
  const { skills, skipped: skippedSkills } = await loadSkillsWithReport(config.skillsDir, log);
  if (skippedSkills.length > 0) {
    log('warn', 'skills', `${skippedSkills.length} skill file(s) skipped — see the warnings above`);
  }

  // The plugin host and the runtime need each other: the host reads settings and
  // broadcasts through the runtime, and the runtime reports the host's state.
  // Two holders break the cycle without either owning the other.
  let pluginHostRef: PluginHost | null = null;
  let runtimeRef: Runtime | null = null;

  const registry = createProviderRegistry(config, {
    // Read on every use, so enabling a plugin changes routing immediately.
    extraModels: () => pluginHostRef?.contributions().models ?? [],
    disabledModelIds: () => runtimeRef?.settings().disabledModelIds ?? [],
    // A corrected price or tier is read on every use, so an edit on the Settings
    // page changes routing and reporting from the next turn.
    modelOverrides: () => runtimeRef?.settings().modelOverrides ?? {},
    /**
     * Whole providers from plugins. The credential is looked up in the
     * environment by the name the manifest declared, so a marketplace bundle
     * never carries a secret and the operator's `.env` stays the only place a
     * key lives.
     */
    extraProviders: () =>
      (pluginHostRef?.contributions().providers ?? []).map(({ pluginId, provider }) => {
        const keyVar = provider.keyEnvVar;
        const key = keyVar === undefined ? '' : (process.env[keyVar] ?? '').trim();
        const entry: ProviderConfig = {
          id: provider.id,
          label: provider.label,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: key === '' ? null : key,
          hint: keyVar === undefined
            ? `Contributed by ${pluginId}; needs no key.`
            : `Contributed by ${pluginId}. Set ${keyVar} to use it.`,
          pluginId,
        };
        if (provider.keyless === true) entry.keyless = true;
        if (provider.extraHeaders !== undefined) entry.extraHeaders = { ...provider.extraHeaders };
        return entry;
      }),
    log,
  });

  const tools = createToolRegistry();
  for (const tool of createDefaultTools()) tools.register(tool);

  const runtime = createRuntime({
    config,
    store,
    registry,
    skills,
    log,
    // The runtime filters a tool grant against this, so an unknown name is
    // dropped at the door instead of becoming a grant that never resolves.
    toolNames: () => tools.names(),
  });
  runtimeRef = runtime;

  const pluginHost = createPluginHost({
    config,
    tools,
    log,
    subscribe: (fn) => runtime.subscribe(fn),
    onChange: () => {
      // A plugin can contribute a whole provider, and an adapter is a built
      // object rather than an overlay, so the registry is rebuilt before the
      // change is announced - the console must never be told about a provider
      // the router cannot yet reach.
      registry.refreshProviders();
      runtime.announcePlugins();
    },
  });
  pluginHostRef = pluginHost;
  // The operator's enable/disable decisions and plugin settings live in the
  // office document, not on disk, so they survive a re-scan.
  pluginHost.hydrate(runtime.office().plugins);
  runtime.attachPlugins(pluginHost);
  // `load()` announces the set through onChange, which is what pushes plugin
  // providers into the registry, so there is no separate boot announcement.
  await pluginHost.load();

  const engine = createRunEngine({
    // The runtime owns the settings, and folds them into the config the engine
    // reads, so a change on the Settings page takes effect on the next turn.
    config: runtime.engineConfig(),
    registry,
    tools,
    // Skills come from the runtime, which merges the markdown on disk with
    // whatever enabled plugins contribute.
    skills: () => runtime.skills(),
    org: runtime.org,
    pipelines: runtime.pipelines,
    routingHints: () => pluginHost.contributions().routingHints,
    employees: runtime.employees,
    sink: runtime.sink,
    approvals: runtime.approvals,
  });
  runtime.attachEngine({
    runs: () => engine.runs().sort((a, b) => b.createdAt - a.createdAt).slice(0, 25),
    activeRunIds: () => engine.activeRunIds(),
  });

  // Bridge engine/runtime log events to the console so an operator watching the
  // server sees what the office is doing without opening the browser.
  runtime.subscribe((event) => {
    if (event.type === 'log') log(event.level, event.scope, event.message);
  });

  // ------------------------------------------------------------------ websocket
  const clients = new Set<WebSocket>();

  function push(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (e) {
      log('warn', 'ws', `send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        /* a broken socket is removed by its close handler */
      }
    }
  }

  runtime.subscribe((event) => {
    broadcast(event);
    // Keep whole-office snapshots fresh at the moments the roster, the floor
    // list or the run list actually changes, rather than polling on a timer.
    if (
      event.type === 'run.created' ||
      (event.type === 'run.updated' && (event.run.status === 'done' || event.run.status === 'failed' || event.run.status === 'cancelled')) ||
      event.type === 'settings.updated' ||
      event.type === 'org.updated'
    ) {
      broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
    }
  });

  async function handleCommand(ws: WebSocket, raw: string): Promise<void> {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw) as ClientCommand;
    } catch {
      push(ws, { type: 'error', message: 'Malformed command: not valid JSON.', at: Date.now() });
      return;
    }

    try {
      switch (cmd.type) {
        case 'submit': {
          const run = engine.submit({
            brief: cmd.brief,
            ...(cmd.pipelineId !== undefined ? { pipelineId: cmd.pipelineId } : {}),
            ...(cmd.budgetUsd !== undefined ? { budgetUsd: cmd.budgetUsd } : {}),
            ...(cmd.workspaceId !== undefined ? { workspaceId: cmd.workspaceId } : {}),
            submittedBy: null,
          });
          log(
            'info',
            'run',
            `accepted ${run.id} on pipeline "${run.pipelineId}" in ${run.workspacePath}`,
          );
          return;
        }

        case 'cancel': {
          const ok = engine.cancel(cmd.runId);
          if (!ok) push(ws, { type: 'error', message: `Run "${cmd.runId}" is not running.`, at: Date.now() });
          return;
        }

        case 'chat': {
          const messages = await engine.directMessage(
            cmd.employeeId,
            cmd.text,
            cmd.workspaceId ?? runtime.activeWorkspaceId(),
          );
          runtime.emit({ type: 'direct.message', employeeId: cmd.employeeId, messages, at: Date.now() });
          return;
        }

        case 'plan': {
          // Answer only to the socket that asked. A plan is a private draft, so
          // it deliberately does not go through `runtime.emit`, which would
          // broadcast something nobody else commissioned or asked to see.
          const reply = await engine.planMessage(
            cmd.employeeId,
            cmd.text,
            normalizeHistory(cmd.history),
            cmd.workspaceId ?? runtime.activeWorkspaceId(),
          );
          push(ws, {
            type: 'plan.reply',
            employeeId: cmd.employeeId,
            requestId: cmd.requestId ?? null,
            text: reply.text,
            route: reply.route,
            at: Date.now(),
          });
          return;
        }

        case 'selectWorkspace': {
          const result = runtime.setActiveWorkspace(cmd.workspaceId);
          if (!result.ok) {
            push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
            return;
          }
          // Every client follows the operator, so the whole console moves floor
          // together rather than one tab drifting out of step.
          broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
          return;
        }

        case 'updateSettings': {
          const result = runtime.updateSettings(cmd.patch);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'setWorkspaceSkills': {
          const result = runtime.setWorkspaceSkills(
            cmd.workspaceId ?? runtime.activeWorkspaceId(),
            cmd.skillIds,
          );
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          else broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
          return;
        }

        case 'setWorkspaceBudget': {
          const result = runtime.setWorkspaceBudget(
            cmd.workspaceId ?? runtime.activeWorkspaceId(),
            cmd.budget,
          );
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          else broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
          return;
        }

        case 'setWorkspaceDetails': {
          const result = runtime.setWorkspaceDetails(cmd.workspaceId ?? runtime.activeWorkspaceId(), {
            ...(cmd.name !== undefined ? { name: cmd.name } : {}),
            ...(cmd.description !== undefined ? { description: cmd.description } : {}),
            ...(cmd.color !== undefined ? { color: cmd.color } : {}),
          });
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          else broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
          return;
        }

        case 'approve': {
          const ok = runtime.decideApproval(cmd.approvalId, cmd.approved);
          if (!ok) {
            push(ws, {
              type: 'error',
              message: `Approval "${cmd.approvalId}" is no longer pending.`,
              at: Date.now(),
            });
          }
          return;
        }

        case 'setModelPolicy': {
          const result = runtime.setModelPolicy(cmd.roleId, cmd.policy);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'setSeat': {
          const result = runtime.setSeat(cmd.employeeId, cmd.seatId, cmd.roomId);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'setRoleGrants': {
          const result = runtime.setRoleGrants(
            cmd.roleId,
            {
              ...(cmd.allowedTools !== undefined ? { allowedTools: cmd.allowedTools } : {}),
              ...(cmd.skillIds !== undefined ? { skillIds: cmd.skillIds } : {}),
            },
            cmd.workspaceId,
          );
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'hire': {
          const result = runtime.hire(cmd.role);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'fire': {
          const result = runtime.fire(cmd.roleId);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'setRoutingPosture': {
          runtime.setRoutingPosture(cmd.posture);
          return;
        }

        case 'addRoom': {
          const result = runtime.addRoom(cmd.workspaceId);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'removeRoom': {
          const result = runtime.removeRoom(cmd.workspaceId);
          if (!result.ok) push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          return;
        }

        case 'createWorkspace': {
          const result = runtime.createWorkspace({
            name: cmd.name,
            ...(cmd.description !== undefined ? { description: cmd.description } : {}),
            ...(cmd.color !== undefined ? { color: cmd.color } : {}),
            ...(cmd.folder !== undefined ? { folder: cmd.folder } : {}),
            ...(cmd.path !== undefined ? { path: cmd.path } : {}),
          });
          if (!result.ok) {
            push(ws, { type: 'error', message: result.error, at: Date.now() });
            return;
          }
          // `org.updated` already carries the new list; the feed gets its own line.
          runtime.emit({
            type: 'log',
            level: 'info',
            scope: 'workspaces',
            message: `Project "${result.workspace.name}" is ready at ${result.workspace.path}.`,
            at: Date.now(),
          });
          return;
        }

        case 'removeWorkspace': {
          const result = runtime.removeWorkspace(cmd.workspaceId);
          if (!result.ok) {
            push(ws, { type: 'error', message: result.error ?? 'Failed.', at: Date.now() });
          }
          return;
        }

        case 'loadRun': {
          const run = engine.getRun(cmd.runId) ?? store.loadRun(cmd.runId);
          if (!run) {
            push(ws, { type: 'error', message: `No run "${cmd.runId}".`, at: Date.now() });
            return;
          }
          // Replaying the persisted events rebuilds the transcript exactly as it
          // was streamed the first time, with no extra protocol surface.
          const entries = store.eventsForRun(cmd.runId);
          for (const entry of entries) {
            try {
              push(ws, JSON.parse(entry.payloadJson) as ServerEvent);
            } catch {
              /* skip an unreadable row rather than aborting the replay */
            }
          }
          log('debug', 'ws', `replayed ${entries.length} event(s) for ${cmd.runId}`);
          return;
        }

        case 'resync': {
          push(ws, { type: 'hello', state: runtime.state(), at: Date.now() });
          return;
        }

        case 'ping': {
          push(ws, { type: 'office.updated', state: runtime.state(), at: Date.now() });
          return;
        }

        default: {
          const never = cmd as { type: string };
          push(ws, {
            type: 'error',
            message: `Unknown command "${never.type}".`,
            at: Date.now(),
          });
          return;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log('error', 'ws', `command "${cmd.type}" failed: ${message}`);
      push(ws, { type: 'error', message, at: Date.now() });
    }
  }

  // ----------------------------------------------------------------- http + ws
  const webDist = resolve(config.repoRoot, 'apps/web/dist');
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.glb': 'model/gltf-binary',
    '.map': 'application/json; charset=utf-8',
  };

  function serveStatic(res: ServerResponse, urlPath: string): boolean {
    if (!existsSync(webDist)) return false;
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
    const target = resolve(webDist, rel === '' ? 'index.html' : rel);
    if (!target.startsWith(webDist)) return false;
    const file = existsSync(target) && !target.endsWith('index.html') ? target : join(webDist, 'index.html');
    if (!existsSync(file)) return false;
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      // The UI talks to the orchestrator from a different origin in dev (Vite on
      // 5273), so the read API has to be reachable cross-origin.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (path === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          llmMode: registry.mock ? 'mock' : 'live',
          version: config.version,
          store: store.backend,
          uptimeMs: Date.now() - runtime.startedAt,
          activeRuns: engine.activeRunIds().length,
          pendingApprovals: runtime.pendingApprovals().length,
        });
        return;
      }

      if (path === '/api/state') {
        sendJson(res, 200, runtime.state());
        return;
      }

      if (path === '/api/runs') {
        sendJson(res, 200, engine.runs().sort((a, b) => b.createdAt - a.createdAt));
        return;
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
      if (runMatch?.[1] !== undefined) {
        const runId = runMatch[1];
        const run = engine.getRun(runId) ?? store.loadRun(runId);
        if (!run) {
          sendJson(res, 404, { error: `No run "${runId}".` });
          return;
        }
        sendJson(res, 200, {
          ...run,
          turns: store.turnsForRun(runId),
          artifacts: store.artifactsForRun(runId),
          approvals: runtime.approvalsForRun(runId),
        });
        return;
      }

      if (path === '/api/skills') {
        const summaries: SkillSummary[] = skills.map(toSkillSummary);
        sendJson(res, 200, summaries);
        return;
      }

      if (path === '/api/tools') {
        // Every tool an employee could be granted, with the plugin that
        // registered it - which is what makes a plugin's tool grantable from
        // the Org tab instead of only by hand-building a role.
        const owners = new Map(
          pluginHost.contributions().toolOwners.map((entry) => [entry.toolName, entry.pluginId]),
        );
        sendJson(
          res,
          200,
          tools.names().map((name) => ({
            name,
            description: tools.get(name)?.description ?? '',
            pluginId: owners.get(name) ?? null,
          })),
        );
        return;
      }

      if (path === '/api/plugins/role-templates' && req.method === 'GET') {
        sendJson(res, 200, runtime.roleTemplates());
        return;
      }

      if (path === '/api/plugins/pipelines' && req.method === 'GET') {
        sendJson(res, 200, runtime.pluginPipelines());
        return;
      }

      if (path === '/api/workspaces' && req.method === 'POST') {
        const body = await readJson<{
          name?: unknown;
          description?: unknown;
          color?: unknown;
          folder?: unknown;
          path?: unknown;
          skillIds?: unknown;
        }>(req, res);
        if (body === null) return;
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          sendJson(res, 400, { error: 'A non-empty "name" is required.' });
          return;
        }
        const result = runtime.createWorkspace({
          name: body.name,
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.color === 'string' ? { color: body.color } : {}),
          ...(typeof body.folder === 'string' ? { folder: body.folder } : {}),
          ...(typeof body.path === 'string' ? { path: body.path } : {}),
          ...(Array.isArray(body.skillIds) ? { skillIds: body.skillIds as string[] } : {}),
        });
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        runtime.emit({
          type: 'log',
          level: 'info',
          scope: 'workspaces',
          message: `Project "${result.workspace.name}" is ready at ${result.workspace.path}.`,
          at: Date.now(),
        });
        sendJson(res, 201, result.workspace);
        return;
      }

      const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(path);

      if (workspaceMatch?.[1] !== undefined && (req.method === 'PUT' || req.method === 'PATCH')) {
        const workspaceId = decodeURIComponent(workspaceMatch[1]);
        const body = await readJson<{
          skillIds?: unknown;
          budget?: unknown;
          name?: unknown;
          description?: unknown;
          color?: unknown;
        }>(req, res);
        if (body === null) return;

        // Applied in order so a bad value anywhere leaves the organisation as it
        // was rather than half-updated.
        const steps: Array<{ ok: boolean; error?: string }> = [];
        if (Array.isArray(body.skillIds)) {
          steps.push(runtime.setWorkspaceSkills(workspaceId, body.skillIds as string[]));
        }
        if (typeof body.budget === 'object' && body.budget !== null) {
          steps.push(runtime.setWorkspaceBudget(workspaceId, body.budget as Record<string, number>));
        }
        if (typeof body.name === 'string' || typeof body.description === 'string' || typeof body.color === 'string') {
          steps.push(
            runtime.setWorkspaceDetails(workspaceId, {
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(typeof body.description === 'string' ? { description: body.description } : {}),
              ...(typeof body.color === 'string' ? { color: body.color } : {}),
            }),
          );
        }
        if (steps.length === 0) {
          sendJson(res, 400, { error: 'Nothing to update: send skillIds, budget, name, description or color.' });
          return;
        }
        const failed = steps.find((step) => !step.ok);
        if (failed) {
          sendJson(res, 400, { error: failed.error ?? 'Failed.' });
          return;
        }
        broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
        const summary = runtime.summaries().find((entry) => entry.id === workspaceId) ?? null;
        sendJson(res, 200, summary);
        return;
      }

      if (workspaceMatch?.[1] !== undefined && req.method === 'DELETE') {
        const result = runtime.removeWorkspace(decodeURIComponent(workspaceMatch[1]));
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        // Closing a floor changes the list, which no single event carries.
        broadcast({ type: 'office.updated', state: runtime.state(), at: Date.now() });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/workspaces') {
        sendJson(res, 200, runtime.summaries());
        return;
      }

      if (path === '/api/settings' && req.method !== 'POST' && req.method !== 'PUT') {
        sendJson(res, 200, runtime.settings());
        return;
      }

      if (path === '/api/settings' && (req.method === 'POST' || req.method === 'PUT')) {
        const patch = await readJson<Record<string, unknown>>(req, res);
        if (patch === null) return;
        const result = runtime.updateSettings(patch as Parameters<typeof runtime.updateSettings>[0]);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        sendJson(res, 200, runtime.settings());
        return;
      }

      if (path === '/api/models') {
        sendJson(res, 200, registry.models());
        return;
      }

      if (path === '/api/providers') {
        sendJson(res, 200, registry.status());
        return;
      }

      // ------------------------------------------------------------------ plugins
      // Specific paths are matched before the `:id` pattern, or "sources" would
      // be read as a plugin id.
      if (path === '/api/plugins' && req.method === 'GET') {
        sendJson(res, 200, pluginHost.state());
        return;
      }

      if (path === '/api/plugins/refresh' && req.method === 'POST') {
        const result = await pluginHost.refresh();
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        sendJson(res, 200, pluginHost.state());
        return;
      }

      if (path === '/api/plugins/updates' && req.method === 'POST') {
        const result = await pluginHost.checkForUpdates();
        // 200 even when a marketplace was unreachable: the others were still
        // checked, and the failure is reported per source in the state.
        sendJson(res, 200, { ...result, state: pluginHost.state() });
        return;
      }

      if (path === '/api/plugins/install' && req.method === 'POST') {
        const body = await readJson<{ catalogUrl?: unknown; pluginId?: unknown; upgrade?: unknown }>(req, res);
        if (body === null) return;
        if (typeof body.catalogUrl !== 'string' || typeof body.pluginId !== 'string') {
          sendJson(res, 400, { error: '"catalogUrl" and "pluginId" strings are required.' });
          return;
        }
        const result = await pluginHost.install(body.catalogUrl, body.pluginId, body.upgrade === true);
        if (!result.ok || !result.record) {
          sendJson(res, 400, { error: result.error ?? 'Install failed.' });
          return;
        }
        sendJson(res, 201, result.record);
        return;
      }

      if (path === '/api/plugins/catalog' && req.method === 'GET') {
        const catalogUrl = url.searchParams.get('url') ?? '';
        const result = await pluginHost.fetchCatalog(catalogUrl);
        if (!result.ok || !result.catalog) {
          sendJson(res, 400, { error: result.error ?? 'Could not read that catalog.' });
          return;
        }
        sendJson(res, 200, result.catalog);
        return;
      }

      if (path === '/api/plugins/sources' && req.method === 'GET') {
        sendJson(res, 200, pluginHost.state().sources);
        return;
      }

      if (path === '/api/plugins/sources' && req.method === 'POST') {
        const body = await readJson<{ label?: unknown; url?: unknown }>(req, res);
        if (body === null) return;
        if (typeof body.url !== 'string') {
          sendJson(res, 400, { error: 'A "url" string is required.' });
          return;
        }
        const result = pluginHost.addSource(typeof body.label === 'string' ? body.label : '', body.url);
        if (!result.ok || !result.source) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        sendJson(res, 201, result.source);
        return;
      }

      const pluginSourceMatch = /^\/api\/plugins\/sources\/([^/]+)$/.exec(path);
      if (pluginSourceMatch?.[1] !== undefined && req.method === 'DELETE') {
        const result = pluginHost.removeSource(decodeURIComponent(pluginSourceMatch[1]));
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const pluginEnableMatch = /^\/api\/plugins\/([^/]+)\/enable$/.exec(path);
      if (pluginEnableMatch?.[1] !== undefined && req.method === 'POST') {
        const pluginId = decodeURIComponent(pluginEnableMatch[1]);
        const body = await readJson<{ enabled?: unknown }>(req, res);
        if (body === null) return;
        if (typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'An "enabled" boolean is required.' });
          return;
        }
        const result = await pluginHost.enable(pluginId, body.enabled);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        const record = pluginHost.records().find((entry) => entry.manifest.id === pluginId);
        sendJson(res, 200, record ?? { ok: true });
        return;
      }

      const pluginSettingsMatch = /^\/api\/plugins\/([^/]+)\/settings$/.exec(path);
      if (pluginSettingsMatch?.[1] !== undefined && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = await readJson<{ settings?: unknown }>(req, res);
        if (body === null) return;
        if (typeof body.settings !== 'object' || body.settings === null) {
          sendJson(res, 400, { error: 'A "settings" object is required.' });
          return;
        }
        const pluginId = decodeURIComponent(pluginSettingsMatch[1]);
        const result = await pluginHost.configure(pluginId, body.settings as Record<string, unknown>);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        const record = pluginHost.records().find((entry) => entry.manifest.id === pluginId);
        sendJson(res, 200, record ?? { ok: true });
        return;
      }

      // A contributed panel, resolved server-side. The console asks us; we ask
      // the plugin. The plugin's endpoint URL never reaches the browser, and the
      // only thing that comes back is a closed set of widget shapes.
      const pluginPanelMatch = /^\/api\/plugins\/([^/]+)\/panels\/([^/]+)$/.exec(path);
      if (pluginPanelMatch?.[1] !== undefined && pluginPanelMatch[2] !== undefined && req.method === 'GET') {
        const panel = await pluginHost.readPanel(
          decodeURIComponent(pluginPanelMatch[1]),
          decodeURIComponent(pluginPanelMatch[2]),
        );
        // 200 even when the upstream endpoint failed: "this panel could not be
        // read" is a panel state the console renders, not a client error.
        sendJson(res, panel.ok || panel.widgets.length > 0 ? 200 : 404, panel);
        return;
      }

      const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
      if (pluginMatch?.[1] !== undefined && req.method === 'DELETE') {
        const result = await pluginHost.remove(decodeURIComponent(pluginMatch[1]));
        if (!result.ok) {
          sendJson(res, 400, { error: result.error ?? 'Failed.' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/submit' && req.method === 'POST') {
        const body = await readJson<{
          brief?: unknown;
          pipelineId?: unknown;
          budgetUsd?: unknown;
          workspaceId?: unknown;
        }>(req, res);
        if (body === null) return;
        if (typeof body.brief !== 'string' || body.brief.trim() === '') {
          sendJson(res, 400, { error: 'A non-empty "brief" string is required.' });
          return;
        }
        // A submission the office refuses - an unknown project, a pipeline this
        // floor cannot staff - is a client error with a reason, not a server
        // fault. Reporting it as "Internal error" throws away the one thing the
        // operator needs to fix it.
        let run;
        try {
          run = engine.submit({
            brief: body.brief,
            ...(typeof body.pipelineId === 'string' ? { pipelineId: body.pipelineId } : {}),
            ...(typeof body.budgetUsd === 'number' ? { budgetUsd: body.budgetUsd } : {}),
            ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
            submittedBy: 'http',
          });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'The brief was refused.' });
          return;
        }
        sendJson(res, 202, run);
        return;
      }

      if (path === '/api/chat' && req.method === 'POST') {
        const body = await readJson<{
          employeeId?: unknown;
          text?: unknown;
        }>(req, res);
        if (body === null) return;
        if (typeof body.employeeId !== 'string' || typeof body.text !== 'string') {
          sendJson(res, 400, { error: '"employeeId" and "text" strings are required.' });
          return;
        }
        const messages = await engine.directMessage(body.employeeId, body.text);
        sendJson(res, 200, messages);
        return;
      }

      // The planning conversation, for a console whose socket is down. Same
      // shape and same validation as the `plan` command, so the two paths cannot
      // drift into answering differently.
      if (path === '/api/plan' && req.method === 'POST') {
        const body = await readJson<{
          employeeId?: unknown;
          text?: unknown;
          history?: unknown;
          workspaceId?: unknown;
        }>(req, res);
        if (body === null) return;
        if (typeof body.employeeId !== 'string' || typeof body.text !== 'string' || body.text.trim() === '') {
          sendJson(res, 400, { error: '"employeeId" and a non-empty "text" string are required.' });
          return;
        }
        try {
          const reply = await engine.planMessage(
            body.employeeId,
            body.text,
            normalizeHistory(body.history),
            typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
          );
          sendJson(res, 200, reply);
        } catch (error) {
          // An unknown employee or an empty building is the caller's problem,
          // and the reason is the only useful thing to return.
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'The planning turn was refused.' });
        }
        return;
      }

      if (path.startsWith('/api/')) {
        sendJson(res, 404, { error: `No such endpoint: ${path}` });
        return;
      }

      if (!serveStatic(res, path)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        // This is what a person sees when they hit the orchestrator's port and
        // the built UI is not there yet, so it should say what to do rather than
        // just what exists.
        res.end(
          'dev3d orchestrator is running.\n\n' +
            'The office UI is not built into this checkout yet.\n' +
            '  development: pnpm dev:web   (Vite serves the UI and proxies /api and /ws here)\n' +
            '  or build it: node apps/web/node_modules/vite/bin/vite.js build\n' +
            '               then reload this page - the orchestrator serves apps/web/dist.\n\n' +
            'Read API: /api/health, /api/state, /api/runs, /api/skills, /api/models.\n' +
            'Live protocol: ws://' +
            `${config.host}:${config.port}/ws\n`,
        );
      }
    })().catch((e: unknown) => {
      log('error', 'http', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    log('debug', 'ws', `client connected (${clients.size} total)`);
    push(ws, { type: 'hello', state: runtime.state(), at: Date.now() });

    ws.on('message', (data) => {
      void handleCommand(ws, data.toString());
    });
    ws.on('close', () => {
      clients.delete(ws);
      log('debug', 'ws', `client disconnected (${clients.size} remaining)`);
    });
    ws.on('error', (err) => {
      log('warn', 'ws', `socket error: ${err.message}`);
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        rejectListen(
          new Error(
            `Port ${config.port} on ${config.host} is already in use. ` +
              'Another dev3d orchestrator is probably still running - stop it, or set PORT to something else.',
          ),
        );
        return;
      }
      rejectListen(err);
    };
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  // ------------------------------------------------------------------- banner
  const configured = registry.status().filter((p) => p.configured);
  log('info', 'boot', `dev3d ${config.version} - ${runtime.org.chart().company.name}`);
  log('info', 'boot', `http://${config.host}:${config.port}  ws://${config.host}:${config.port}/ws`);
  log('info', 'boot', `mode: ${registry.mock ? 'mock (scripted, no billing)' : 'live'} | routing: ${config.routingPosture}`);
  const activeWorkspace = runtime.workspace(runtime.activeWorkspaceId());
  const buildings = runtime.workspaces();
  log(
    'info',
    'boot',
    `building: ${buildings.length} organisation${buildings.length === 1 ? '' : 's'} on ${buildings.length} floor${buildings.length === 1 ? '' : 's'}`,
  );
  log(
    'info',
    'boot',
    `active: "${activeWorkspace?.name ?? '?'}" — ${activeWorkspace?.org.roles.length ?? 0} roles, ` +
      `${activeWorkspace?.org.departments.length ?? 0} departments, ${activeWorkspace?.skillIds.length ?? 0} skills`,
  );
  log('info', 'boot', `skills: ${skills.length} | tools: ${tools.names().length} | models: ${registry.models().length}`);
  log('info', 'boot', `providers configured: ${configured.length > 0 ? configured.map((p) => p.id).join(', ') : 'none'}`);
  log('info', 'boot', `workspace: ${config.workspace}`);
  log('info', 'boot', `store: ${store.backend}`);
  if (config.dotEnvCount > 0) log('info', 'boot', `loaded ${config.dotEnvCount} value(s) from .env`);
  if (config.autoApproveShell) {
    log('warn', 'boot', 'DEV3D_AUTO_APPROVE_SHELL is on: employees may run shell commands without asking.');
  }
  if (registry.mock) {
    log('info', 'boot', 'no provider keys found - the office runs its scripted employees end to end.');
  }

  runtime.emit({
    type: 'log',
    level: 'info',
    scope: 'office',
    message:
      `${runtime.org.chart().company.name} is open for business. ` +
      `${runtime.org.chart().roles.length} employees at their desks, ` +
      `${registry.mock ? 'running on scripted employees (no API keys configured)' : 'live model providers connected'}.`,
    at: Date.now(),
  });

  // ----------------------------------------------------------------- shutdown
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log('info', 'boot', `${signal} received; closing the office`);
    for (const ws of clients) ws.close(1001, 'server shutting down');
    wss.close();
    server.close(() => {
      runtime.close();
      store.close();
      log('info', 'boot', 'stopped');
      process.exit(0);
    });
    // Do not let a wedged socket keep the process alive forever.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`dev3d failed to start: ${message}`);
  process.exit(1);
});
