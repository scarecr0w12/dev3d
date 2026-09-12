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

import type { ClientCommand, ModelSpec, ModelTier, RoutingPosture } from '@dev3d/core';

import { formatDuration, formatInt, formatTokens, formatUsd, formatUsdExact, tierClassName } from '../app/format';
import { useNow } from '../app/hooks';
import { useOffice, useStore } from '../app/StoreContext';
import { Badge, Bar, Empty, Loading, Metric, Panel } from './ui';

const TIERS: readonly ModelTier[] = ['nano', 'small', 'standard', 'strong', 'max'];
const POSTURES: readonly RoutingPosture[] = ['cheap', 'balanced', 'quality'];

const POSTURE_HINT: Record<RoutingPosture, string> = {
  cheap: 'always take the cheapest model that satisfies the turn',
  balanced: 'honour each role policy, escalate only when complexity demands it',
  quality: 'bias every turn one tier up',
};

export function Telemetry() {
  const store = useStore();
  const office = useOffice();
  const now = useNow(1000);

  const [tierFilter, setTierFilter] = useState<'all' | ModelTier>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [query, setQuery] = useState('');

  const employees = office?.employees ?? [];
  const providers = office?.providers ?? [];
  const models = office?.models ?? [];

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
          <Badge tone="warn" title="Scripted deterministic provider: no API keys, no spend">
            mock — no spend
          </Badge>
        ) : (
          <Badge tone="ok" title="Live providers: turns bill real money">
            live — spending
          </Badge>
        )
      }
    >
      <div className="pad">
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
        <div className="role-section-title">Providers</div>
        {providers.length === 0 ? (
          <Empty title="No providers reported" hint="The orchestrator did not send a provider list." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">provider</th>
                <th scope="col">configured</th>
                <th scope="col">reachable</th>
                <th scope="col">models</th>
                <th scope="col">detail</th>
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
                    {provider.ok === null ? (
                      <Badge tone="neutral">not probed</Badge>
                    ) : (
                      <Badge tone={provider.ok ? 'ok' : 'danger'}>{provider.ok ? 'ok' : 'failing'}</Badge>
                    )}
                  </td>
                  <td className="mono">{formatInt(provider.modelCount)}</td>
                  <td className="small dim">{provider.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
      </div>
    </Panel>
  );
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
        </div>
      </td>
      <td>
        <span className={tierClassName(model.tier)}>{model.tier}</span>
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
