/**
 * Employee status vocabulary for the UI.
 *
 * Kept free of three.js so console panels can colour a status dot without
 * pulling the renderer into their module graph. The 3D avatars use exactly the
 * same table, so a dot in the org chart and a body in the office always agree.
 */

import type { EmployeeStatus, VendorStatus } from '@dev3d/core';

export const STATUS_LABEL: Record<EmployeeStatus, string> = {
  offline: 'offline',
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  talking: 'in a meeting',
  blocked: 'needs approval',
  error: 'error',
};

export const STATUS_COLOR: Record<EmployeeStatus, string> = {
  offline: '#64748b',
  idle: '#38bdf8',
  thinking: '#a78bfa',
  working: '#a3e635',
  talking: '#f0abfc',
  blocked: '#fbbf24',
  error: '#f87171',
};

export interface StatusStyle {
  color: string;
  intensity: number;
  /** How far an avatar's body colour is pulled toward grey. */
  grey: number;
}

export const STATUS_STYLE: Record<EmployeeStatus, StatusStyle> = {
  offline: { color: '#334155', intensity: 0.03, grey: 0.7 },
  idle: { color: '#38bdf8', intensity: 0.2, grey: 0 },
  thinking: { color: '#a78bfa', intensity: 0.55, grey: 0 },
  working: { color: '#a3e635', intensity: 0.45, grey: 0 },
  talking: { color: '#f0abfc', intensity: 0.4, grey: 0 },
  blocked: { color: '#fbbf24', intensity: 0.5, grey: 0 },
  error: { color: '#f87171', intensity: 0.7, grey: 0 },
};

/** Legend order: the states a user is most likely to look for come first. */
export const STATUS_ORDER: readonly EmployeeStatus[] = [
  'idle',
  'thinking',
  'working',
  'talking',
  'blocked',
  'error',
  'offline',
];

export function statusLabel(status: EmployeeStatus): string {
  return STATUS_LABEL[status];
}

export function statusColor(status: EmployeeStatus): string {
  return STATUS_COLOR[status];
}

/**
 * The third-party vendor vocabulary.
 *
 * A **separate** set of total maps rather than more keys in the ones above, and
 * the reason is the type system doing its job: `Record<EmployeeStatus, …>` will
 * refuse a `VendorStatus` key at compile time, so the two vocabularies cannot
 * drift into each other by accident. An employee is a person at a desk with a
 * mood; a vendor is a machine somebody else operates, and "on site" is not a
 * synonym for "idle".
 *
 * The *colours* are deliberately shared with the employee table where the meaning
 * is the same - lime for working, red for failed, slate for absent - because
 * reusing a colour for a new meaning is how a legend stops being readable. What
 * differs is the words, and the silhouette on the floor.
 */
export const VENDOR_STATUS_LABEL: Record<VendorStatus, string> = {
  offsite: 'off site',
  unreachable: 'no signal',
  docked: 'on site',
  engaged: 'engaged',
  errored: 'fault',
};

export const VENDOR_STATUS_COLOR: Record<VendorStatus, string> = {
  // Dimmer than an employee's `offline`, because a vendor that was never
  // configured and one that is switched off are both "not here", and neither
  // should draw the eye.
  offsite: '#475569',
  unreachable: '#f59e0b',
  docked: '#38bdf8',
  engaged: '#a3e635',
  errored: '#f87171',
};

export interface VendorStatusStyle {
  color: string;
  intensity: number;
}

export const VENDOR_STATUS_STYLE: Record<VendorStatus, VendorStatusStyle> = {
  offsite: { color: '#334155', intensity: 0.04 },
  unreachable: { color: '#f59e0b', intensity: 0.16 },
  docked: { color: '#38bdf8', intensity: 0.62 },
  engaged: { color: '#a3e635', intensity: 1.05 },
  errored: { color: '#f87171', intensity: 0.85 },
};

/**
 * Legend order for the vendor bay: what an operator is looking for first.
 *
 * `engaged` leads because a busy vendor is the thing worth noticing, then
 * availability, then the two ways one can be missing.
 */
export const VENDOR_STATUS_ORDER: readonly VendorStatus[] = [
  'engaged',
  'docked',
  'unreachable',
  'errored',
  'offsite',
];

export function vendorStatusLabel(status: VendorStatus): string {
  return VENDOR_STATUS_LABEL[status];
}

export function vendorStatusColor(status: VendorStatus): string {
  return VENDOR_STATUS_COLOR[status];
}
