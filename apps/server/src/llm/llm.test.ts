/**
 * Model-layer tests. No network, no randomness: routing fixtures and the
 * scripted provider are fully deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelPolicy, ModelSpec, ModelTier, ChatMessage, ToolCallRequest } from '@dev3d/core';
import { blendedCostPerKTok, computeCost, formatUsd } from './pricing.ts';
import { routeModel } from '../router/modelRouter.ts';
import { createMockProvider } from './mock.ts';
import { createProviderRegistry } from './registry.ts';
import { loadConfig } from '../config.ts';
import type { ProviderConfig } from '../config.ts';

function makeModel(
  o: Partial<ModelSpec> & Pick<ModelSpec, 'id' | 'providerId' | 'tier'>,
): ModelSpec {
  return {
    id: o.id,
    providerId: o.providerId,
    label: o.label ?? o.id,
    tier: o.tier,
    contextWindow: o.contextWindow ?? 128_000,
    maxOutputTokens: o.maxOutputTokens ?? 4_096,
    costPerMTokIn: o.costPerMTokIn ?? 1,
    costPerMTokOut: o.costPerMTokOut ?? 1,
    capabilities: o.capabilities ?? { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: o.strengths ?? [],
    ...(o.defaultEffort !== undefined ? { defaultEffort: o.defaultEffort } : {}),
  };
}

function makePolicy(o: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    defaultTier: o.defaultTier ?? 'standard',
    maxTier: o.maxTier ?? 'max',
    minTier: o.minTier ?? 'nano',
    byTaskClass: o.byTaskClass,
    escalateAtComplexity: o.escalateAtComplexity,
    escalateTo: o.escalateTo,
    maxOutputTokens: o.maxOutputTokens,
    pin: o.pin,
  };
}

test('computeCost computes USD from per-MTok rates', () => {
  const m = makeModel({
    id: 'm',
    providerId: 'p',
    tier: 'standard',
    costPerMTokIn: 2,
    costPerMTokOut: 8,
  });
  // 1M in @ $2/M = $2; 500k out @ $8/M = $4; total $6.
  assert.equal(computeCost(m, 1_000_000, 500_000), 6);
  assert.equal(computeCost(m, 0, 0), 0);
});

test('blendedCostPerKTok and formatUsd', () => {
  const m = makeModel({ id: 'm', providerId: 'p', tier: 'standard', costPerMTokIn: 2, costPerMTokOut: 8 });
  assert.equal(blendedCostPerKTok(m), 0.005);
  assert.equal(formatUsd(0.0123), '$0.0123');
  assert.equal(formatUsd(0.00005), '< $0.0001');
  assert.equal(formatUsd(0), '$0.0000');
});

test('a nano-policy intake picks the cheapest cheap model', () => {
  const models: ModelSpec[] = [
    makeModel({ id: 'nano-pricier', providerId: 'b', tier: 'nano', costPerMTokIn: 0.2, costPerMTokOut: 0.2 }),
    makeModel({ id: 'nano-cheap', providerId: 'a', tier: 'nano', costPerMTokIn: 0.1, costPerMTokOut: 0.1 }),
    makeModel({ id: 'small', providerId: 'a', tier: 'small', costPerMTokIn: 0.5, costPerMTokOut: 0.5 }),
  ];
  const d = routeModel(
    {
      taskClass: 'intake',
      complexity: 0.1,
      policy: makePolicy({ defaultTier: 'nano', minTier: 'nano', maxTier: 'nano' }),
    },
    { models },
  );
  assert.equal(d.modelId, 'nano-cheap');
  assert.equal(d.providerId, 'a');
  assert.equal(d.tier, 'nano');
});

test('a coding task escalates past the escalation threshold', () => {
  const models: ModelSpec[] = [
    makeModel({ id: 'std', providerId: 'a', tier: 'standard', costPerMTokIn: 1, costPerMTokOut: 1 }),
    makeModel({ id: 'strong', providerId: 'b', tier: 'strong', costPerMTokIn: 5, costPerMTokOut: 5 }),
  ];
  const d = routeModel(
    {
      taskClass: 'coding',
      complexity: 0.9,
      policy: makePolicy({
        defaultTier: 'standard',
        minTier: 'nano',
        maxTier: 'max',
        escalateAtComplexity: 0.7,
        escalateTo: 'strong',
      }),
    },
    { models },
  );
  assert.equal(d.modelId, 'strong');
  assert.equal(d.tier, 'strong');
  assert.ok(d.reason.includes('escalated'));
});

test("posture 'cheap' never picks above minTier", () => {
  const models: ModelSpec[] = [
    makeModel({ id: 'strong', providerId: 'b', tier: 'strong', costPerMTokIn: 5, costPerMTokOut: 5 }),
    makeModel({ id: 'nano', providerId: 'a', tier: 'nano', costPerMTokIn: 0.1, costPerMTokOut: 0.1 }),
  ];
  const d = routeModel(
    {
      taskClass: 'coding',
      complexity: 0.1,
      policy: makePolicy({ defaultTier: 'strong', minTier: 'nano', maxTier: 'max' }),
      posture: 'cheap',
    },
    { models },
  );
  assert.equal(d.modelId, 'nano');
  assert.equal(d.tier, 'nano');
});

test('a requiresTools request never selects a tools-incapable model', () => {
  const noTools = makeModel({
    id: 'no-tools',
    providerId: 'a',
    tier: 'nano',
    costPerMTokIn: 0.1,
    costPerMTokOut: 0.1,
    capabilities: { tools: false, vision: false, reasoning: false, streaming: false },
  });
  const withTools = makeModel({
    id: 'with-tools',
    providerId: 'b',
    tier: 'nano',
    costPerMTokIn: 0.5,
    costPerMTokOut: 0.5,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
  });
  const d = routeModel(
    {
      taskClass: 'summarize',
      complexity: 0.1,
      policy: makePolicy({ defaultTier: 'nano', minTier: 'nano', maxTier: 'nano' }),
      requiresTools: true,
    },
    { models: [noTools, withTools] },
  );
  assert.equal(d.modelId, 'with-tools');
  assert.equal(d.providerId, 'b');
});

test('an empty catalog returns an empty decision instead of throwing', () => {
  const d = routeModel(
    { taskClass: 'intake', complexity: 0, policy: makePolicy() },
    { models: [] },
  );
  assert.equal(d.providerId, '');
  assert.equal(d.modelId, '');
  assert.ok(d.reason.toLowerCase().includes('empty'));
});

test('fallbacks never include the chosen model', () => {
  const chosen = makeModel({ id: 'm1', providerId: 'p1', tier: 'standard', costPerMTokIn: 1, costPerMTokOut: 1 });
  const others: ModelSpec[] = [
    makeModel({ id: 'm2', providerId: 'p2', tier: 'standard', costPerMTokIn: 2, costPerMTokOut: 2 }),
    makeModel({ id: 'm3', providerId: 'p3', tier: 'standard', costPerMTokIn: 3, costPerMTokOut: 3 }),
    makeModel({ id: 'm4', providerId: 'p1', tier: 'strong', costPerMTokIn: 10, costPerMTokOut: 10 }),
  ];
  const d = routeModel(
    {
      taskClass: 'planning',
      complexity: 0.3,
      policy: makePolicy({ defaultTier: 'standard', minTier: 'nano', maxTier: 'max' }),
    },
    { models: [chosen, ...others] },
  );
  assert.equal(d.modelId, 'm1');
  assert.ok(d.fallbacks.length >= 1);
  for (const f of d.fallbacks) {
    assert.notEqual(`${f.providerId}/${f.modelId}`, `${d.providerId}/${d.modelId}`);
  }
  assert.equal(d.fallbacks.length <= 3, true);
});

test('mock provider streams text in multiple deltas that reconstruct exactly', async () => {
  const cfg: ProviderConfig = { id: 'mock', label: 'Mock', kind: 'mock', baseUrl: 'http://localhost', apiKey: null, hint: '' };
  const model = makeModel({ id: 'mock-model', providerId: 'mock', tier: 'small' });
  const provider = createMockProvider(cfg, [model]);

  const deltas: string[] = [];
  const res = await provider.chat({
    model,
    messages: [
      { role: 'system', content: 'You are a planner for the dev3d office.' },
      { role: 'user', content: 'Plan the build of a model router for dev3d, breaking it into workstreams and milestones.' },
    ],
    onDelta: (t) => {
      deltas.push(t);
    },
  });

  assert.ok(deltas.length > 1, `expected multiple deltas, got ${deltas.length}`);
  assert.equal(deltas.join(''), res.text);
  assert.ok(res.text.length > 0);
});

test('an implementation request with tools returns a write_file call', async () => {
  const cfg: ProviderConfig = { id: 'mock', label: 'Mock', kind: 'mock', baseUrl: 'http://localhost', apiKey: null, hint: '' };
  const model = makeModel({ id: 'mock-model', providerId: 'mock', tier: 'small' });
  const provider = createMockProvider(cfg, [model]);

  const res = await provider.chat({
    model,
    messages: [
      { role: 'system', content: 'You are a backend engineer. Use tools to write files into the workspace.' },
      { role: 'user', content: 'Implement a cost calculator module for the dev3d model layer.' },
    ],
    tools: [{ name: 'write_file', description: 'Write a file', parameters: { type: 'object' } }],
  });

  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.toolCalls.length, 1);
  const call: ToolCallRequest = res.toolCalls[0]!;
  assert.equal(call.name, 'write_file');
  const args = JSON.parse(call.argumentsJson) as { path: string; content: string };
  assert.equal(typeof args.path, 'string');
  assert.equal(typeof args.content, 'string');
  assert.ok(args.path.startsWith('src/'));
});

test('mock provider is deterministic for the same input', async () => {
  const cfg: ProviderConfig = { id: 'mock', label: 'Mock', kind: 'mock', baseUrl: 'http://localhost', apiKey: null, hint: '' };
  const model = makeModel({ id: 'mock-model', providerId: 'mock', tier: 'small' });
  const provider = createMockProvider(cfg, [model]);
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Research prior art for a 3D office agent orchestrator.' },
  ];
  const a = await provider.chat({ model, messages });
  const b = await provider.chat({ model, messages });
  assert.equal(a.text, b.text);
});

/**
 * A planning conversation is not a stage, so the scripted provider has to
 * recognise it from the prompt's own words. Without that it reads "our checkout
 * retries double-charge" as an implementation request and answers a planning
 * question with a diff - which makes the scripted office look broken to anyone
 * trying the Plan page without API keys.
 */
test('a planning turn asks a question rather than emitting a change list', async () => {
  const cfg: ProviderConfig = { id: 'mock', label: 'Mock', kind: 'mock', baseUrl: 'http://localhost', apiKey: null, hint: '' };
  const model = makeModel({ id: 'mock-model', providerId: 'mock', tier: 'small' });
  const provider = createMockProvider(cfg, [model]);

  const res = await provider.chat({
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are the CEO at dev3d Labs.',
          'The operator is shaping a brief with you before any work starts.',
          'When the operator asks you to draft the brief, reply with the brief itself.',
        ].join('\n'),
      },
      { role: 'user', content: 'Our checkout retries double-charge on timeout. I want it to be safe to retry.' },
    ],
  });

  assert.ok(!res.text.includes('## Changes'), `expected a question, got: ${res.text}`);
  assert.ok(res.text.toLowerCase().includes('done'), `expected a question about done, got: ${res.text}`);
  assert.equal(res.finishReason, 'stop');
});

test('asking for the brief in a planning turn yields an objective and a done-list', async () => {
  const cfg: ProviderConfig = { id: 'mock', label: 'Mock', kind: 'mock', baseUrl: 'http://localhost', apiKey: null, hint: '' };
  const model = makeModel({ id: 'mock-model', providerId: 'mock', tier: 'small' });
  const provider = createMockProvider(cfg, [model]);

  const res = await provider.chat({
    model,
    messages: [
      {
        role: 'system',
        content: 'The operator is shaping a brief with you before any work starts. When the operator asks you to draft the brief, reply with the brief itself.',
      },
      { role: 'user', content: 'Our checkout retries double-charge on timeout.' },
      { role: 'assistant', content: 'What does done look like?' },
      { role: 'user', content: 'Draft the brief now. One paragraph stating the objective, then a short bulleted list.' },
    ],
  });

  assert.ok(res.text.includes('**Objective:**'), `expected an objective, got: ${res.text}`);
  assert.ok(res.text.includes('Done means:'), `expected a definition of done, got: ${res.text}`);
  assert.ok(!res.text.includes('## Changes'));
  // The objective is the operator's idea, not the instruction to draft it.
  assert.ok(
    res.text.includes('Our checkout retries double-charge on timeout.'),
    `expected the objective to quote the idea, got: ${res.text}`,
  );
  assert.ok(
    !res.text.includes('Draft the brief now'),
    `expected the instruction to be skipped, got: ${res.text}`,
  );
});

test('an operator correction changes what the router sees, not just what the UI shows', () => {
  const config = { ...loadConfig(), llmMode: 'mock' as const };
  const base = createProviderRegistry(config);
  const model = base.models().find((candidate) => candidate.providerId === 'deepseek');
  assert.ok(model, 'the fixture catalog should have a deepseek model');

  // Read live, so a price edited on the Settings page is in force on the next turn.
  let overrides: Record<string, { tier?: ModelTier; costPerMTokIn?: number }> = {};
  const registry = createProviderRegistry(config, { modelOverrides: () => overrides });

  const before = registry.models().find((candidate) => candidate.id === model.id);
  assert.equal(before?.tier, model.tier, 'with no override the catalog is the truth');

  overrides = { [model.id]: { tier: 'max', costPerMTokIn: 7.5 } };
  const after = registry.models().find((candidate) => candidate.id === model.id);
  assert.equal(after?.tier, 'max', 'the correction is applied');
  assert.equal(after?.costPerMTokIn, 7.5);
  // A patch leaves the fields it does not mention alone.
  assert.equal(after?.costPerMTokOut, model.costPerMTokOut);
  // And the blended cost the router actually ranks on follows from it.
  assert.equal(after ? blendedCostPerKTok(after) : null, model.costPerMTokOut === undefined ? null : blendedCostPerKTok({ ...model, costPerMTokIn: 7.5 }));

  overrides = {};
  assert.equal(
    registry.models().find((candidate) => candidate.id === model.id)?.tier,
    model.tier,
    'clearing the override restores the catalog',
  );
});

test('a provider is classified as local or remote from its own endpoint', () => {
  // The classification only decides how loudly an unreachable provider is
  // reported, but getting it wrong makes every boot of an install with a local
  // runtime look like a fault. This reads `status()` only - no discovery runs, so
  // there is no network here.
  const config = { ...loadConfig(), llmMode: 'mock' as const };
  const contributed = (id: string, baseUrl: string): ProviderConfig => ({
    id,
    label: id,
    kind: 'openai-compat',
    baseUrl,
    apiKey: null,
    hint: 'contributed by the test',
    keyless: true,
  });

  const registry = createProviderRegistry(config, {
    extraProviders: () => [
      contributed('lmstudio', 'http://127.0.0.1:1234/v1'),
      contributed('remote-gateway', 'https://gateway.example.test/v1'),
      contributed('ipv6-local', 'http://[::1]:11434/v1'),
    ],
  });

  const local = (id: string): boolean | undefined =>
    registry.status().find((provider) => provider.id === id)?.local;

  assert.equal(local('lmstudio'), true, 'a loopback endpoint is local');
  assert.equal(local('ipv6-local'), true, 'an IPv6 loopback endpoint is local');
  assert.equal(local('remote-gateway'), false, 'a remote endpoint is not');
  // The built-in local runtime is loopback too, and the one remote default is not.
  assert.equal(local('local'), true);
  assert.equal(local('deepseek'), false);
});

test('a switched-off model stays visible in the catalog but leaves the routing pool', () => {
  // The regression this pins: `modelsFor` filtered disabled models out of the
  // catalog, and the console's model table renders from that catalog — so
  // clicking Disable removed the only row carrying the Enable button, and the
  // setting could only be undone by editing the settings file by hand.
  const config = { ...loadConfig(), llmMode: 'mock' as const };
  const off = ['deepseek-flash'];
  const registry = createProviderRegistry(config, { disabledModelIds: () => off });

  const inCatalog = registry.models().find((model) => model.id === 'deepseek-flash');
  assert.ok(inCatalog, 'the disabled model must still be listed, so it can be switched back on');
  assert.equal(inCatalog.disabled, true, 'and it must say that it is off');

  assert.equal(
    registry.routableModels().some((model) => model.id === 'deepseek-flash'),
    false,
    'but the router must not be able to pick it',
  );
  // A model that is not switched off is untouched.
  const other = registry.models().find((model) => model.id === 'deepseek-v4-pro');
  assert.ok(other);
  assert.notEqual(other.disabled, true);
});

test('a switched-off model cannot be called even when something still names it', async () => {
  // A stale pin or a route built before the setting changed would otherwise go
  // straight at it, because `chat` looks each candidate up in the catalog — and
  // the catalog now contains disabled models on purpose.
  const config = { ...loadConfig(), llmMode: 'mock' as const };
  const registry = createProviderRegistry(config, {
    disabledModelIds: () => ['deepseek-flash'],
  });
  await assert.rejects(
    () => registry.chat({ providerId: 'deepseek', modelId: 'deepseek-flash' }, [], { messages: [] }),
    /unavailable/,
  );
});
