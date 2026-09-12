/**
 * Routing and cost telemetry.
 *
 * Answers the questions that decide whether this office is affordable: which
 * providers are actually reachable, what each employee has spent, what the
 * model catalog costs per million tokens, and which routing posture the office
 * is tuned to. The `llmMode` is badged loudly - in `mock` nothing is billed and
 * nobody should be misled into thinking otherwise.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { ClientCommand, DiscoveryReport, ModelSpec, ModelTier, RoutingPosture } from '@dev3d/core';

import { api, type HealthRecordView } from '../app/api';
import { formatAgo, formatDuration, formatInt, formatTokens, formatUsd, formatUsdExact, tierClassName } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useStore } from '../app/StoreContext';
import { Badge, Bar, Empty, Loading, Metric, Panel, type Tone } from './ui';

const TIERS: readonly ModelTier[] = ['nano', 'small', 'standard', 'strong', 'max'];
const POSTURES: readonly RoutingPosture[] = ['cheap', 'balanced', 'quality'];

const POSTURE_HINT: Record<RoutingPosture, string> = {
  cheap: 'always take the cheapest model that satisfies the turn',
  balanced: 'honour each role policy, escalate only when complexity demands it',
  quality: 'bias every turn one tier up',
};

/**
 * How a provider's model list was obtained, in words.
 *
 * The distinction is the whole point of discovery, so it is never left to a
 * colour: `discovered` means the vendor told us, `seed` means we never asked,
 * and `degraded` means we asked and got nothing - which is a different situation
 * from a provider that genuinely serves no models.
 */
const SOURCE_LABEL: Record<string, string> = {
  discovered: 'from the provider',
  seed: 'curated catalog',
  degraded: 'unreachable — curated catalog standing in',
};

export function Telemetry() {
  const store = useStore();
  const office = useOffice();
  const now = useNow(1000);

  const [tierFilter, setTierFilter] = useState<'all' | ModelTier>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  /** Which provider is being asked right now, or 'all', or null when idle. */
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoveryNote, setDiscoveryNote] = useState<{ tone: Tone; text: string } | null>(null);
  /** Which signal refresh is running, or null. */
  const [signalsBusy, setSignalsBusy] = useState<string | null>(null);
  const [signalsNote, setSignalsNote] = useState<{ tone: Tone; text: string } | null>(null);
  /** Uptime readings from the last health refresh, which is the only place the
   *  console can see them: uptime is a per-model lookup, not part of the spec. */
  const [healthRecords, setHealthRecords] = useState<HealthRecordView[]>([]);

  const employees = office?.employees ?? [];
  const providers = office?.providers ?? [];
  const models = office?.models ?? [];
  /**
   * Signal coverage, with a fallback for a server that predates it.
   *
   * The field is required on `OfficeState`, but a console can outlive the
   * orchestrator it is talking to during a rebuild, and a panel that throws on a
   * missing field takes the whole page with it.
   */
  const signals = office?.modelSignals ?? {
    benchmarks: {
      enabled: false,
      entries: 0,
      models: 0,
      measured: 0,
      fetchedAt: null,
      attribution: '',
      detail: 'the orchestrator did not report signal coverage',
    },
    health: { enabled: false, known: 0, fetchedAt: null },
    learned: { models: 0, samples: 0 },
  };

  const totals = useMemo(() => {
    let turns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    for (const employee of employees) {
      turns += employee.lifetime.turns;
      tokensIn += employee.lifetime.tokensIn;
      tokensOut += employee.lifetime.tokensOut;
      cost += employee.lifetime.costUsd;
    }
    return { turns, tokensIn, tokensOut, cost };
  }, [employees]);

  const bySpend = useMemo(
    () => employees.slice().sort((a, b) => b.lifetime.costUsd - a.lifetime.costUsd || b.lifetime.turns - a.lifetime.turns),
    [employees],
  );

  const catalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models
      .filter((model) => (tierFilter === 'all' ? true : model.tier === tierFilter))
      .filter((model) => (providerFilter === 'all' ? true : model.providerId === providerFilter))
      .filter((model) =>
        needle.length === 0 ? true : `${model.id} ${model.label} ${model.providerId} ${model.strengths.join(' ')}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.costPerMTokOut - b.costPerMTokOut || a.id.localeCompare(b.id));
  }, [models, tierFilter, providerFilter, query]);

  const setPosture = useCallback(
    (posture: RoutingPosture) => {
      const command: ClientCommand = { type: 'setRoutingPosture', posture };
      store.send(command);
    },
    [store],
  );

  /**
   * Ask a provider, or all of them, what they serve.
   *
   * The server broadcasts `office.updated` when the catalog changes, so the list
   * below corrects itself; the local note exists only to report a provider that
   * could not be reached, which the state alone cannot distinguish from one that
   * has simply never been asked.
   */
  const discover = useCallback(async (providerId?: string) => {
    setDiscovering(providerId ?? 'all');
    setDiscoveryNote(null);
    const result = await api.discoverModels(providerId);
    setDiscovering(null);
    if (!result.ok || result.data === null) {
      setDiscoveryNote({ tone: 'danger', text: result.error ?? 'Discovery failed.' });
      return;
    }
    const reports: DiscoveryReport[] = result.data.reports;
    if (result.data.note !== undefined) {
      setDiscoveryNote({ tone: 'neutral', text: result.data.note });
      return;
    }
    const failed = reports.filter((report) => !report.ok);
    const found = reports.reduce((sum, report) => sum + report.models.length, 0);
    if (failed.length === 0) {
      setDiscoveryNote({
        tone: 'ok',
        text: `${reports.length} provider${reports.length === 1 ? '' : 's'} answered · ${found} model${found === 1 ? '' : 's'} reported`,
      });
      return;
    }
    setDiscoveryNote({
      tone: 'warn',
      text: failed.map((report) => `${report.providerId}: ${report.error ?? 'no answer'}`).join(' · '),
    });
  }, []);

  /**
   * Refresh both pooled quality and endpoint uptime.
   *
   * They are one action because they answer one question - "what do we actually
   * know about these models" - and a reader who wants one almost always wants
   * the other. Both degrade to a note rather than an error when their source is
   * unavailable, because neither is something the office depends on.
   */
  const refreshSignals = useCallback(async () => {
    setSignalsNote(null);

    setSignalsBusy('benchmarks…');
    const bench = await api.refreshBenchmarks();
    if (!bench.ok || bench.data === null) {
      setSignalsBusy(null);
      setSignalsNote({ tone: 'danger', text: bench.error ?? 'The benchmark refresh failed.' });
      return;
    }
    const benchText = bench.data.ok
      ? `benchmarks: ${bench.data.entries} rows`
      : `benchmarks unavailable — ${bench.data.error ?? 'unknown reason'}`;

    setSignalsBusy('uptime…');
    const health = await api.refreshHealth(20);
    setSignalsBusy(null);

    if (!health.ok || health.data === null) {
      setSignalsNote({ tone: 'warn', text: `${benchText} · uptime: ${health.error ?? 'failed'}` });
      return;
    }
    setHealthRecords(health.data.records ?? []);
    const healthText = health.data.ok
      ? `uptime: ${health.data.fetched ?? 0} of ${health.data.considered ?? 0} models sampled`
      : `uptime unavailable — ${health.data.error ?? 'unknown reason'}`;

    setSignalsNote({
      tone: bench.data.ok && health.data.ok ? 'ok' : 'warn',
      text: `${benchText} · ${healthText}`,
    });
  }, []);

  if (!office) {
    return (
      <Panel title="Routing & cost" subtitle="providers, catalog, posture">
        <Loading label="waiting for office state…" />
      </Panel>
    );
  }

  const maxSpend = bySpend.length > 0 ? bySpend[0]?.lifetime.costUsd ?? 0 : 0;

  return (
    <Panel
      title="Routing & cost"
      subtitle={`${office.version} · started ${formatDuration(Math.max(0, now - office.startedAt))} ago · ${office.llmMode}`}
      flush
      actions={
        office.llmMode === 'mock' ? (
          <Badge
            tone={typeof office.configStale === 'string' && office.configStale !== '' ? 'danger' : 'warn'}
            title={office.llmModeReason}
          >
            mock — no spend
          </Badge>
        ) : (
          <Badge tone="ok" title={office.llmModeReason}>
            live — spending
          </Badge>
        )
      }
    >
      <div className="pad">
        {/*
          The mode, with its reason. A bare "mock" badge is what makes a stale
          process look like a configuration bug: it reads identically whether no
          key was found, an operator forced it, or the process simply predates the
          key being added.
        */}
        <div className="small" style={{ marginBottom: '8px' }}>
          <span className="dim">
            {office.llmModeReason ??
              (office.llmMode === 'mock'
                ? 'scripted employees — this orchestrator did not report why'
                : 'live providers — this orchestrator did not report why')}
          </span>
        </div>
        {typeof office.configStale === 'string' && office.configStale !== '' && (
          <div className="alert alert-warn small" role="status" style={{ marginBottom: '8px' }}>
            <strong>The environment has changed since this orchestrator started.</strong> {office.configStale}
          </div>
        )}
        <div className="metrics-grid">
          <Metric label="Lifetime spend" value={formatUsd(totals.cost)} hint={`${formatUsdExact(totals.cost)} exact`} />
          <Metric label="Turns" value={formatInt(totals.turns)} />
          <Metric label="Tokens" value={formatTokens(totals.tokensIn, totals.tokensOut)} />
          <Metric label="Runs" value={`${office.runs.length} · ${office.activeRunIds.length} active`} />
        </div>

        <div className="role-section">
          <div className="role-section-title">Routing posture</div>
          <div className="segmented" role="group" aria-label="Routing posture">
            {POSTURES.map((posture) => (
              <button
                key={posture}
                type="button"
                className={posture === office.routingPosture ? 'segment segment-active' : 'segment'}
                aria-pressed={posture === office.routingPosture}
                onClick={() => setPosture(posture)}
                title={POSTURE_HINT[posture]}
              >
                {posture}
              </button>
            ))}
          </div>
          <div className="dim small" style={{ marginTop: '4px' }}>
            {POSTURE_HINT[office.routingPosture]} · sends <span className="mono">setRoutingPosture</span>
          </div>
        </div>
      </div>

      <div className="role-section padded">
        <div className="role-section-title">
          Quality signals
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: '8px' }}
            disabled={signalsBusy !== null}
            onClick={() => void refreshSignals()}
            title="Ask OpenRouter for benchmark scores and upstream endpoint uptime"
          >
            {signalsBusy ?? 'Refresh signals'}
          </button>
        </div>
        {signalsNote !== null && (
          <div className="small" style={{ marginBottom: '6px' }}>
            <Badge tone={signalsNote.tone}>{signalsNote.text}</Badge>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th scope="col">signal</th>
              <th scope="col">source</th>
              <th scope="col">coverage</th>
              <th scope="col">detail</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="strong">curated</td>
              <td className="small dim">shipped metadata table</td>
              <td className="mono">{formatInt(models.length)} models</td>
              <td className="small dim">tier, price and a derived baseline; always present</td>
            </tr>
            <tr>
              <td className="strong">learned</td>
              <td className="small dim">this office's own finished turns</td>
              <td className="mono">
                {formatInt(signals.learned.models)} models · {formatInt(signals.learned.samples)} turns
              </td>
              <td className="small dim">
                {signals.learned.models === 0
                  ? 'no turns observed yet — run something and this fills in'
                  : 'smoothed towards the prior, so one bad turn cannot condemn a model'}
              </td>
            </tr>
            <tr>
              <td className="strong">pooled</td>
              <td className="small dim">OpenRouter benchmarks</td>
              <td className="mono">
                {signals.benchmarks.enabled
                  ? `${formatInt(signals.benchmarks.measured)} of ${formatInt(signals.benchmarks.models)} models`
                  : '—'}
              </td>
              <td className="small dim">
                {signals.benchmarks.detail ??
                  (signals.benchmarks.fetchedAt === null
                    ? 'not fetched yet'
                    : `fetched ${formatAgo(signals.benchmarks.fetchedAt, now)}`)}
              </td>
            </tr>
            <tr>
              <td className="strong">uptime</td>
              <td className="small dim">OpenRouter endpoint lists</td>
              <td className="mono">
                {signals.health.enabled ? `${formatInt(signals.health.known)} models` : '—'}
              </td>
              <td className="small dim">
                {!signals.health.enabled
                  ? 'switched off'
                  : signals.health.known === 0
                    ? 'none sampled yet — looked up on demand as models are routed to'
                    : 'best upstream uptime; a demotion, never an exclusion'}
              </td>
            </tr>
          </tbody>
        </table>
        {signals.benchmarks.attribution !== '' && (
          <div className="dim small" style={{ marginTop: '6px' }}>
            Benchmark scores: {signals.benchmarks.attribution}. Ranked as a percentile of the benchmarked
            population, because the published index scale is not absolute.
          </div>
        )}
        {healthRecords.length > 0 && (
          <table className="table" style={{ marginTop: '8px' }}>
            <thead>
              <tr>
                <th scope="col">model</th>
                <th scope="col">best uptime</th>
                <th scope="col">endpoints</th>
              </tr>
            </thead>
            <tbody>
              {healthRecords.map((record) => (
                <tr key={record.modelId}>
                  <td className="mono small">{record.modelId}</td>
                  <td className="mono small">
                    {record.uptime === null ? (
                      <span className="dim">no reading</span>
                    ) : (
                      `${(record.uptime * 100).toFixed(1)}%`
                    )}
                  </td>
                  <td className="mono small">
                    {record.healthyCount}/{record.endpointCount}
                    {record.endpointCount > 0 && record.healthyCount === 0 && (
                      <span className="dim"> · none healthy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="role-section padded">
        <div className="role-section-title">
          Providers
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: '8px' }}
            disabled={discovering !== null}
            onClick={() => void discover()}
            title="Ask every provider what models it serves, from its own list endpoint"
          >
            {discovering === 'all' ? 'asking…' : 'Fetch all model lists'}
          </button>
        </div>
        {discoveryNote !== null && (
          <div className="small" style={{ marginBottom: '6px' }}>
            <Badge tone={discoveryNote.tone}>{discoveryNote.text}</Badge>
          </div>
        )}
        {providers.length === 0 ? (
          <Empty title="No providers reported" hint="The orchestrator did not send a provider list." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">provider</th>
                <th scope="col">configured</th>
                <th scope="col">model list</th>
                <th scope="col">models</th>
                <th scope="col">detail</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>
                    <div className="strong">{provider.label}</div>
                    <div className="mono small dim">{provider.id}</div>
                  </td>
                  <td>
                    <Badge tone={provider.configured ? 'ok' : 'warn'}>{provider.configured ? 'yes' : 'no keys'}</Badge>
                  </td>
                  <td>
                    <Badge
                      tone={
                        provider.modelSource === 'discovered'
                          ? 'ok'
                          : provider.modelSource === 'degraded'
                            ? 'danger'
                            : 'neutral'
                      }
                      title={
                        provider.discoveredAt === null
                          ? 'Never asked. The curated catalog is in use.'
                          : `Last obtained ${formatAgo(provider.discoveredAt, now)}`
                      }
                    >
                      {SOURCE_LABEL[provider.modelSource] ?? provider.modelSource}
                    </Badge>
                  </td>
                  <td className="mono">{formatInt(provider.modelCount)}</td>
                  <td className="small dim">
                    {provider.modelSourceDetail ?? (provider.configured ? '—' : 'no key: excluded from routing')}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={discovering !== null || !provider.configured}
                      onClick={() => void discover(provider.id)}
                      title={
                        provider.configured
                          ? `Ask ${provider.label} what it serves`
                          : 'This provider has no usable credential, so its model list cannot be read.'
                      }
                    >
                      {discovering === provider.id ? 'asking…' : 'fetch'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dim small" style={{ marginTop: '6px' }}>
          A provider's own model list decides which models exist; the curated table supplies tier, price and quality.
          A model the provider no longer serves is withdrawn from routing rather than left to fail a turn.
        </div>
      </div>

      <div className="role-section padded">
        <div className="role-section-title">Spend by employee</div>
        {bySpend.length === 0 ? (
          <Empty title="No employees" hint="Nothing has been spent because nobody is on the payroll." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">employee</th>
                <th scope="col">turns</th>
                <th scope="col">tokens</th>
                <th scope="col">spend</th>
                <th scope="col">share</th>
              </tr>
            </thead>
            <tbody>
              {bySpend.map((employee) => (
                <tr key={employee.id}>
                  <td>
                    <button type="button" className="link" onClick={() => store.selectEmployee(employee.id)}>
                      {employee.displayName}
                    </button>
                    <div className="dim small">{employee.title}</div>
                  </td>
                  <td className="mono">{formatInt(employee.lifetime.turns)}</td>
                  <td className="mono small">{formatTokens(employee.lifetime.tokensIn, employee.lifetime.tokensOut)}</td>
                  <td className="mono">{formatUsd(employee.lifetime.costUsd)}</td>
                  <td className="share-cell">
                    <Bar value={employee.lifetime.costUsd} max={maxSpend} tone="accent" />
                    <span className="dim small mono">
                      {maxSpend > 0 ? `${Math.round((employee.lifetime.costUsd / maxSpend) * 100)}%` : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="role-section padded">
        <div className="role-section-title">
          Model catalog <span className="dim small">({models.length})</span>
        </div>
        <div className="filter-row">
          <button type="button" className={tierFilter === 'all' ? 'chip chip-active' : 'chip'} onClick={() => setTierFilter('all')}>
            all tiers
          </button>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              className={tierFilter === tier ? 'chip chip-active' : 'chip'}
              onClick={() => setTierFilter(tier)}
            >
              {tier}
            </button>
          ))}
          <select value={providerFilter} onChange={(event: ChangeEvent<HTMLSelectElement>) => setProviderFilter(event.target.value)}>
            <option value="all">all providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="search models"
            aria-label="Search models"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </div>

        {catalog.length === 0 ? (
          <Empty title={models.length === 0 ? 'No models reported' : 'Nothing matches'} hint="Adjust the filters." />
        ) : (
          <table className="table table-models">
            <thead>
              <tr>
                <th scope="col">model</th>
                <th scope="col">tier</th>
                <th scope="col">quality</th>
                <th scope="col">context</th>
                <th scope="col">$/M in</th>
                <th scope="col">$/M out</th>
                <th scope="col">capabilities</th>
                <th scope="col">strengths</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((model) => (
                <ModelRow key={model.id} model={model} />
              ))}
            </tbody>
          </table>
        )}
        <div className="dim small" style={{ marginTop: '6px' }}>
          The router ranks on fitness for the turn's task class, then overall quality, then how close the tier is to
          the policy's, then price. A model with no rating is placed at the average of those that have one, so an
          unrated newcomer competes fairly instead of losing by default.
        </div>
      </div>
    </Panel>
  );
}

/** Where a model's numbers came from, named rather than left to a colour. */
function provenanceLabel(model: ModelSpec): string {
  const sources = [...new Set((model.quality?.opinions ?? []).map((opinion) => opinion.source))];
  if (sources.length === 0) return 'unrated';
  return sources.join(' + ');
}

function ModelRow({ model }: { model: ModelSpec }) {
  const capabilities = [
    model.capabilities.tools ? 'tools' : null,
    model.capabilities.vision ? 'vision' : null,
    model.capabilities.reasoning ? 'reasoning' : null,
    model.capabilities.streaming ? 'streaming' : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <tr>
      <td>
        <div className="strong">{model.label}</div>
        <div className="mono small dim">
          {model.id} · {model.providerId}
          {model.origin === 'discovered' && <span title="Reported by the provider's own model list"> · reported</span>}
        </div>
      </td>
      <td>
        <span className={tierClassName(model.tier)}>{model.tier}</span>
        {model.unrated === true && (
          <div className="dim small" title="No metadata table describes this model; its tier is inferred from its price or name.">
            inferred
          </div>
        )}
      </td>
      <td className="small">
        {model.quality === undefined ? (
          <span className="dim" title="Nothing has an opinion about this model yet.">
            —
          </span>
        ) : (
          <>
            <span className="mono">{model.quality.quality.toFixed(2)}</span>
            <div className="dim" style={{ fontSize: '0.85em' }} title="Which sources produced this score">
              {provenanceLabel(model)}
            </div>
          </>
        )}
      </td>
      <td className="mono small">
        {formatInt(model.contextWindow)}
        <div className="dim">out {formatInt(model.maxOutputTokens)}</div>
      </td>
      <td className="mono small">{formatUsdExact(model.costPerMTokIn)}</td>
      <td className="mono small">{formatUsdExact(model.costPerMTokOut)}</td>
      <td className="small">{capabilities.join(' · ') || '—'}</td>
      <td className="small dim">{model.strengths.join(', ') || '—'}</td>
    </tr>
  );
}
