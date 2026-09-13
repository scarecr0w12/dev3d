/**
 * Tests for the cost arithmetic and its sign guarantee.
 *
 * The bug this exists for: a plugin manifest could declare a negative
 * `costPerMTokIn`/`costPerMTokOut`, and nothing checked the sign — not the
 * manifest reader, not `computeCost`, not the engine. `computeCost` multiplied
 * the rate by the token count, so the "cost" of a turn came out negative and
 * *subtracted* from `run.budget.spentUsd`. The engine's only budget guard is an
 * upper bound (`spentUsd >= limitUsd`), so a negative-priced model refunded the
 * budget on every turn and the spend ceiling — the control the README says
 * "always halts the run" — could never be reached.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSpec } from '@dev3d/core';
import { blendedCostPerKTok, computeCost, formatUsd } from './pricing.ts';

function spec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: 'test-model',
    providerId: 'test',
    label: 'Test',
    tier: 'standard',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 1,
    costPerMTokOut: 2,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: [],
    ...overrides,
  };
}

test('cost is tokens times rate, per million', () => {
  assert.equal(computeCost(spec(), 1_000_000, 1_000_000), 3);
  assert.equal(computeCost(spec({ costPerMTokIn: 0.14, costPerMTokOut: 0.28 }), 51_184, 3_338), 0.0081004);
  assert.equal(computeCost(spec({ costPerMTokIn: 0, costPerMTokOut: 0 }), 10_000, 10_000), 0);
});

test('a negative rate cannot produce a negative cost, which would refund the budget', () => {
  // Both rates negative: the case a manifest could previously declare.
  assert.equal(computeCost(spec({ costPerMTokIn: -5, costPerMTokOut: -5 }), 10_000, 1_000), 0);
  // One negative rate large enough to outweigh the other must still not go below 0.
  assert.equal(computeCost(spec({ costPerMTokIn: -1_000, costPerMTokOut: 1 }), 1_000_000, 1), 0);
  // And a genuinely positive result is unaffected by the clamp.
  assert.ok(computeCost(spec({ costPerMTokIn: 1, costPerMTokOut: 2 }), 1_000_000, 0) > 0);
});

test('a non-finite rate cannot produce a non-finite cost', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const cost = computeCost(spec({ costPerMTokIn: bad }), 1_000, 1_000);
    assert.ok(Number.isFinite(cost), `cost must stay finite for rate ${String(bad)}`);
  }
});

test('the display formatter never claims a negative bill', () => {
  // formatUsd still renders a negative it is handed (it is a formatter, not a
  // guard), but computeCost no longer produces one, which is the actual fix.
  assert.equal(formatUsd(0), '$0.0000');
  assert.equal(formatUsd(0.01234), '$0.0123');
  assert.equal(formatUsd(0.00001), '< $0.0001');
});

test('blended cost stays finite for extreme but legal rates', () => {
  assert.ok(Number.isFinite(blendedCostPerKTok(spec({ costPerMTokIn: 0, costPerMTokOut: 0 }))));
  assert.equal(blendedCostPerKTok(spec({ costPerMTokIn: 1000, costPerMTokOut: 3000 })), 2);
});
