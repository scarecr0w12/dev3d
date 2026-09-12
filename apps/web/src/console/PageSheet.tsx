/**
 * A page sheet: one tab's worth of content, floated over the office.
 *
 * The office never unmounts behind a sheet, so switching tabs is instant and the
 * camera, the avatars and the WebSocket keep their state. A sheet is *not* a
 * modal dialog - the office stays live and clickable around it - so it declares
 * itself as a labelled region rather than trapping focus. Escape closes it.
 */

import type { ReactNode } from 'react';

export interface PageSheetProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Rendered on the close control's accessible label. */
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}

export function PageSheet({ title, subtitle, actions, closeLabel, onClose, children }: PageSheetProps) {
  return (
    <section className="sheet" aria-label={title}>
      <header className="sheet-head">
        <div className="sheet-heading">
          <h2 className="sheet-title">{title}</h2>
          {subtitle !== undefined && <div className="sheet-sub">{subtitle}</div>}
        </div>
        <div className="sheet-actions">
          {actions}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label={closeLabel ?? 'Back to the office'}
            title="Back to the office (Esc)"
          >
            ✕
          </button>
        </div>
      </header>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
