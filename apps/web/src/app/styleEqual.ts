/**
 * Comparing two office styles by value.
 *
 * Lives outside `StylePanel.tsx` because the verification harness cannot import a
 * `.tsx` module — Node strips types but does not parse JSX.
 *
 * ## Why identity comparison does not work here
 *
 * The server hands out a **brand-new** `office.style` object on every full-state
 * frame, so `committed !== previousCommitted` is always true and an identity check
 * can never tell "the server agreed with what I sent" from "somebody else changed
 * this". The style editor needs that distinction to avoid snapping its draft back
 * to a stale server value while a change is still in flight — and getting it wrong
 * meant a just-sent change could be silently reverted on the next office event.
 *
 * An office style is a small flat object of primitives plus a map of per-role
 * material patches, so a two-level structural walk is exact and cheap.
 */

import type { OfficeStyle } from '@dev3d/core';

/**
 * Do two styles say the same thing?
 *
 * Recursive rather than fixed-depth. An office style is `{ preset, environment:
 * {…}, materials: { role: {…} } }` — three levels even in the shipped shape, and
 * a two-level walk compared each role's material *object* by identity, so it
 * reported "different" for two styles that said exactly the same thing. That
 * would have made the sent-echo unrecognisable, which is the very revert this
 * comparison exists to prevent.
 */
export function sameStyle(a: OfficeStyle | undefined, b: OfficeStyle | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const l = left[key];
    const r = right[key];
    if (l === r) continue;
    if (l === undefined || r === undefined) return false;
    if (typeof l !== 'object' || typeof r !== 'object' || l === null || r === null) return false;
    // Recurse: `materials[role]` is a patch object of its own, so the depth is
    // whatever the shape turns out to be rather than something assumed.
    if (!sameStyle(l as OfficeStyle, r as OfficeStyle)) return false;
  }
  return true;
}
