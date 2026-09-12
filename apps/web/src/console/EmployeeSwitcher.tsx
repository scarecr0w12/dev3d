/**
 * The compact employee chooser that sits above the agent detail.
 *
 * It exists so the Agent tab can be master-detail: a short, searchable list you
 * pick from, and a detail pane below it that owns the rest of the height. The
 * inspector is the entry point to per-person detail, so the chooser has to fit
 * in the pane without turning into a second full page.
 */

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import { STATUS_COLOR } from '../app/status';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { cx } from './ui';

export function EmployeeSwitcher() {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);

  const employees = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = [...(office?.employees ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (needle.length === 0) return list;
    return list.filter((employee) =>
      `${employee.displayName} ${employee.title} ${employee.status}`.toLowerCase().includes(needle),
    );
  }, [office?.employees, query]);

  const selected = selection.employeeId;

  return (
    <div className="chooser">
      <div className="chooser-head">
        <button
          type="button"
          className="chooser-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          title={open ? 'Collapse the employee list' : 'Expand the employee list'}
        >
          <span className="chooser-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          Employees
          <span className="dim small mono">{employees.length}</span>
        </button>
        {open && (
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="filter"
            aria-label="Filter employees"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        )}
      </div>

      {open && (
        <div className="chooser-list">
          {employees.length === 0 ? (
            <div className="dim small chooser-empty">no employee matches that</div>
          ) : (
            employees.map((employee) => (
              <button
                key={employee.id}
                type="button"
                className={cx('chooser-row', employee.id === selected && 'chooser-row-active')}
                aria-pressed={employee.id === selected}
                onClick={() => store.selectEmployee(employee.id)}
                title={employee.activity ?? employee.title}
              >
                <span className="dot" style={{ background: STATUS_COLOR[employee.status] }} aria-hidden="true" />
                <span className="chooser-row-name">{employee.displayName}</span>
                <span className="chooser-row-title dim small">{employee.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
