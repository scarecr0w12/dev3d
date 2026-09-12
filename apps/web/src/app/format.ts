/**
 * Formatting helpers for the console.
 *
 * Money, token counts, durations and clock times are rendered as tabular,
 * monospace-friendly strings so columns line up and nothing jitters while a run
 * streams.
 */

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdTiny = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
const int = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '$0.00';
  if (value === 0) return '$0.00';
  return Math.abs(value) < 0.01 ? usdTiny.format(value) : usd.format(value);
}

export function formatUsdExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '$0.0000';
  return usdTiny.format(value);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return int.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return compact.format(value);
}

export function formatTokens(tokensIn: number | null | undefined, tokensOut: number | null | undefined): string {
  return `${formatCompact(tokensIn ?? 0)} in / ${formatCompact(tokensOut ?? 0)} out`;
}

/** `1.4s`, `12.3s`, `4m 05s`, `1h 12m` - compact and stable width. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatElapsed(from: number | null | undefined, to: number): string {
  if (!from) return '—';
  return formatDuration(Math.max(0, to - from));
}

export function formatClock(at: number | null | undefined): string {
  if (!at) return '--:--:--';
  const date = new Date(at);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Relative age, coarse enough to stay readable: `4s`, `3m`, `2h`, `6d`. */
export function formatAgo(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 1000) return 'now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : '';
}

export function humaniseToken(token: string): string {
  return token
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/** Colour for a tier badge; keeps the routing story legible at a glance. */
export function tierClassName(tier: string | null | undefined): string {
  switch (tier) {
    case 'nano':
      return 'tier tier-nano';
    case 'small':
      return 'tier tier-small';
    case 'standard':
      return 'tier tier-standard';
    case 'strong':
      return 'tier tier-strong';
    case 'max':
      return 'tier tier-max';
    default:
      return 'tier';
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
