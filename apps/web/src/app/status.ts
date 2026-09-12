/**
 * Employee status vocabulary for the UI.
 *
 * Kept free of three.js so console panels can colour a status dot without
 * pulling the renderer into their module graph. The 3D avatars use exactly the
 * same table, so a dot in the org chart and a body in the office always agree.
 */

import type { EmployeeStatus } from '@dev3d/core';

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
