/**
 * Renders a plugin's panel body.
 *
 * Everything here comes from `PanelWidget` — a closed set of shapes the host
 * defines. No plugin code is involved: the widget list was validated and capped
 * on the server, so these components can index into rows and columns without a
 * bounds check and cannot be made to render an unbounded structure.
 *
 * That closed set is a deliberate limitation, not an oversight. It is what lets
 * a marketplace plugin have a presence in the console without the console
 * having to trust it.
 */

import type { PanelWidget } from '@dev3d/core';

import { Bar, Badge, Metric } from '../ui';

function WidgetLabel({ label }: { label: string }) {
  return <div className="panel-widget-label">{label}</div>;
}

function Widget({ widget }: { widget: PanelWidget }) {
  switch (widget.kind) {
    case 'metric':
      return (
        <div className="panel-widget panel-widget-metric">
          <Metric label={widget.label} value={widget.unit === undefined ? widget.value : `${widget.value} ${widget.unit}`} hint={widget.hint} />
        </div>
      );

    case 'keyValue':
      return (
        <div className="panel-widget">
          <WidgetLabel label={widget.label} />
          <dl className="panel-kv">
            {widget.rows.map((row) => (
              <div className="panel-kv-row" key={row.key}>
                <dt className="dim small">{row.key}</dt>
                <dd className="mono small">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      );

    case 'table':
      return (
        <div className="panel-widget">
          <WidgetLabel label={widget.label} />
          <table className="table table-plugin-panel">
            <thead>
              <tr>
                {widget.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {widget.rows.map((row, index) => (
                // Panel rows have no identity of their own, and the list is
                // bounded and re-fetched whole, so the index is the key.
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'list':
      return (
        <div className="panel-widget">
          <WidgetLabel label={widget.label} />
          {widget.items.length === 0 ? (
            <div className="dim small">nothing to list</div>
          ) : (
            <ul className="panel-list">
              {widget.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'bars': {
      const ceiling = Math.max(1, ...widget.bars.map((bar) => bar.max ?? bar.value));
      return (
        <div className="panel-widget">
          <WidgetLabel label={widget.label} />
          <div className="panel-bars">
            {widget.bars.map((bar) => (
              <div className="panel-bar-row" key={bar.label}>
                <span className="dim small panel-bar-label" title={bar.label}>
                  {bar.label}
                </span>
                <Bar value={bar.value} max={bar.max ?? ceiling} />
                <span className="mono small">{bar.value}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'note':
      return <div className="panel-widget dim small panel-note">{widget.text}</div>;

    default: {
      // Exhaustive over the union: a new widget kind fails the typecheck rather
      // than rendering as nothing.
      const never: never = widget;
      return <div className="dim small">Unsupported widget {JSON.stringify(never)}</div>;
    }
  }
}

export function PanelWidgets({ widgets }: { widgets: readonly PanelWidget[] }) {
  if (widgets.length === 0) return <div className="dim small">This panel returned nothing to show.</div>;
  return (
    <div className="panel-widgets">
      {widgets.map((widget, index) => (
        <Widget widget={widget} key={index} />
      ))}
    </div>
  );
}

/** The badge a panel's source state earns. */
export function PanelSourceBadge({ live, stale }: { live: boolean; stale: boolean }) {
  if (!live) return <Badge tone="neutral">from the manifest</Badge>;
  if (stale) return <Badge tone="warn">endpoint unreachable</Badge>;
  return <Badge tone="info">live</Badge>;
}
