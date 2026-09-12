/**
 * Console primitives.
 *
 * A dense operations console needs a small, consistent vocabulary: panels with
 * a header, honest loading/empty/error states, status pills, tabular metric
 * rows. Everything here is presentational and has no data dependencies, so the
 * panels stay about data and this file stays about looking right.
 */

import type { ReactNode } from 'react';

import type { EmployeeStatus } from '@dev3d/core';

import { STATUS_COLOR, STATUS_LABEL } from '../app/status';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

// ------------------------------------------------------------------- panel

export interface PanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** `warn`/`danger` tint the border: used for pending approvals and errors. */
  tone?: 'default' | 'warn' | 'danger';
  /** Removes body padding for flush lists and tables. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ title, subtitle, actions, tone = 'default', flush = false, className, bodyClassName, children }: PanelProps) {
  return (
    <section className={cx('panel', tone !== 'default' && `panel-${tone}`, className)}>
      <header className="panel-head">
        <div className="panel-heading">
          <h2 className="panel-title">{title}</h2>
          {subtitle !== undefined && <div className="panel-sub">{subtitle}</div>}
        </div>
        {actions !== undefined && <div className="panel-actions">{actions}</div>}
      </header>
      <div className={cx('panel-body', flush && 'panel-body-flush', bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------- state messages

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <div className="state-title">{title}</div>
      {hint !== undefined && <div className="state-hint">{hint}</div>}
      {action !== undefined && <div className="state-action">{action}</div>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status">
      <span className="spinner spinner-sm" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title, detail, onRetry }: { title: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <div className="state-title danger">{title}</div>
      {detail !== undefined && detail !== null && detail.length > 0 && <div className="state-hint mono">{detail}</div>}
      {onRetry !== undefined && (
        <div className="state-action">
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- bits

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'accent';

export function Badge({ children, tone = 'neutral', mono = false, title }: { children: ReactNode; tone?: Tone; mono?: boolean; title?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`, mono && 'mono')} title={title}>
      {children}
    </span>
  );
}

export function StatusPill({ status, label }: { status: EmployeeStatus; label?: string }) {
  return (
    <span className={cx('pill', `pill-${status}`)}>
      <span className="dot" style={{ background: STATUS_COLOR[status] }} aria-hidden="true" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return <span className={cx('dot', pulse && 'pulse')} style={{ background: color }} aria-hidden="true" />;
}

export function Metric({ label, value, hint, mono = true }: { label: string; value: ReactNode; hint?: ReactNode; mono?: boolean }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={cx('metric-value', mono && 'mono')}>{value}</div>
      {hint !== undefined && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Bar({ value, max, tone = 'accent' }: { value: number; max: number; tone?: 'accent' | 'warn' | 'danger' | 'ok' }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={cx('bar', `bar-${tone}`)} role="presentation">
      <div className="bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  );
}

export function KeyValue({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className={cx('kv-value', mono && 'mono')}>{children}</div>
    </div>
  );
}

export function Chips({ values, tone = 'neutral', empty }: { values: readonly string[]; tone?: Tone; empty?: string }) {
  if (values.length === 0) return <span className="dim">{empty ?? '—'}</span>;
  return (
    <span className="chips">
      {values.map((value) => (
        <Badge key={value} tone={tone} mono>
          {value}
        </Badge>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------- tabs

export interface TabItem<T extends string> {
  id: T;
  label: string;
  badge?: number | string | null;
  tone?: Tone;
}

export function Tabs<T extends string>({ items, active, onChange }: { items: Array<TabItem<T>>; active: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === active}
          className={cx('tab', item.id === active && 'tab-active')}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.badge !== undefined && item.badge !== null && item.badge !== 0 && (
            <span className={cx('tab-badge', item.tone === 'warn' && 'tab-badge-warn', item.tone === 'danger' && 'tab-badge-danger')}>
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- tool calls

export function ToolStatusBadge({ status }: { status: 'ok' | 'error' | 'denied' | 'running' }) {
  const tone: Tone = status === 'ok' ? 'ok' : status === 'running' ? 'info' : status === 'denied' ? 'warn' : 'danger';
  return <Badge tone={tone}>{status}</Badge>;
}
