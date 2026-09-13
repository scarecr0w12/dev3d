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
  onClose: () => void;
  children: ReactNode;
}

/**
 * `actions` and `closeLabel` used to be props here. The only call site
 * (`App.tsx`) never passed either, so `actions` rendered an empty
 * `.sheet-actions` flex item and `closeLabel` always fell through to its
 * default — an extension point nobody had extended, presented as if it were in
 * use. Removed rather than kept "just in case": the accessible label and the
 * close control are this component's business, and a caller that wants
 * something else in the header can pass it as part of `subtitle`.
 */
export function PageSheet({ title, subtitle, onClose, children }: PageSheetProps) {
  return (
    <section className="sheet" aria-label={title}>
      <header className="sheet-head">
        <div className="sheet-heading">
          <h2 className="sheet-title">{title}</h2>
          {subtitle !== undefined && <div className="sheet-sub">{subtitle}</div>}
        </div>
        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Back to the office"
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
