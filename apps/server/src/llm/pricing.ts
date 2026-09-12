/**
 * Cost arithmetic shared by every adapter and the router.
 *
 * Prices are stored per-million-tokens (the unit vendors quote); these helpers
 * convert to the two forms the rest of the engine cares about: a total USD for
 * a single call, and a blended per-1k-token rate for tie-breaking and display.
 */

import type { ModelSpec } from '@dev3d/core';

/** USD for a call of `tokensIn` input and `tokensOut` output tokens. */
export function computeCost(model: ModelSpec, tokensIn: number, tokensOut: number): number {
  return (model.costPerMTokIn * tokensIn + model.costPerMTokOut * tokensOut) / 1_000_000;
}

/**
 * Blended USD per 1k tokens: the average of the in/out per-million rates,
 * scaled down to a 1k basis. Used as the router's single ordering key.
 */
export function blendedCostPerKTok(model: ModelSpec): number {
  return (model.costPerMTokIn + model.costPerMTokOut) / 2 / 1000;
}

/** Human-readable USD, e.g. `$0.0123`; tiny non-zero amounts become `< $0.0001`. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.0001) return '< $0.0001';
  if (n < 0) return `-$${Math.abs(n).toFixed(4)}`;
  return `$${n.toFixed(4)}`;
}
