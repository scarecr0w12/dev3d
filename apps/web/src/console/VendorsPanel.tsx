/**
 * Third-party vendors, in the console.
 *
 * Two surfaces, matching how employees are handled: `VendorsBayPanel` is the
 * roster - everyone on retainer, on one page, with the policy that governs them -
 * and `VendorPanel` is the inspector view of the one the operator clicked.
 *
 * The design brief for both is **honesty about what a vendor is**. dev3d confines
 * its own tools through a single path choke point and can prove what they
 * touched; it cannot do that to somebody else's process. So the panel always
 * answers three questions plainly, in this order:
 *
 *  1. *Is it working?* - the status, and its reason when it is not.
 *  2. *What did we actually promise?* - the capability table, drawn so that
 *     "read-only, enforced" and "read-only, requested" do not look alike.
 *  3. *Whose machine, and whose bill?* - the operator, the command, and the auth
 *     note, because a vendor bills and authenticates itself and an operator who
 *     expects a dev3d key to work will conclude the integration is broken.
 *
 * That ordering is the panel. Everything below is presentation.
 */

import { useState } from 'react';

import type { ReadOnlyEnforcement, VendorState, VendorStatus } from '@dev3d/core';

import { api } from '../app/api';
import { formatInt } from '../app/format';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { VENDOR_STATUS_COLOR, VENDOR_STATUS_LABEL, VENDOR_STATUS_ORDER } from '../app/status';
import { Badge, Empty, KeyValue, Metric, Panel } from './ui';

/**
 * The three-way read-only disclosure, as words.
 *
 * Written out rather than derived, because the whole point is that a reader
 * understands which guarantee they have without decoding a term of art. The
 * `requested` sentence names the consequence - it is the only level the office
 * cannot bound, so it is the one that asks a human first.
 */
const ENFORCEMENT_SHORT: Record<ReadOnlyEnforcement, string> = {
  sandbox: 'sandboxed',
  client: 'mediated',
  requested: 'requested',
};

const ENFORCEMENT_TITLE: Record<ReadOnlyEnforcement, string> = {
  sandbox: 'Read-only is enforced by the harness',
  client: 'Read-only is enforced by dev3d',
  requested: 'Read-only is requested, not enforced',
};

const ENFORCEMENT_DETAIL: Record<ReadOnlyEnforcement, (label: string) => string> = {
  sandbox: (label) =>
    `${label} is pinned to a read-only sandbox by the command the office runs, so it cannot write to your workspace ` +
    'at all. This is the strongest guarantee available, because it holds for everything the process does rather than ' +
    'only for what the office mediates.',
  client: (label) =>
    `dev3d drives ${label} over the Agent Client Protocol and answers for it: write access is refused, every read is ` +
    'confined to this run\u2019s workspace by the office itself, and every tool call it reports is put to a human ' +
    'first. Strong over that path \u2014 and it is dev3d\u2019s own code doing the refusing \u2014 but ' +
    `${label} is still a local process, so this constrains what it can do through dev3d rather than what it can do ` +
    'to the machine.',
  requested: (label) =>
    `${label} exposes no sandbox flag the office can set and speaks no protocol the office can mediate, so read-only ` +
    'is asked for in the task text and nothing enforces it. Each delegation is therefore held for human approval ' +
    'before it starts.',
};

/** How severe a vendor status is, for badge tone. */
function toneFor(status: VendorStatus): 'ok' | 'warn' | 'danger' | 'neutral' | 'info' {
  switch (status) {
    case 'engaged':
      return 'ok';
    case 'docked':
      return 'info';
    case 'unreachable':
      return 'warn';
    case 'errored':
      return 'danger';
    case 'offsite':
    default:
      return 'neutral';
  }
}

function VendorDot({ status }: { status: VendorStatus }) {
  return <span className="dot" style={{ background: VENDOR_STATUS_COLOR[status] }} aria-hidden="true" />;
}

/**
 * One vendor as a row: who it is, whether it is here, and what it is doing.
 *
 * A button rather than a div, because clicking it selects the vendor - the same
 * interaction an org-chart row has, and the reason the 3D terminal is clickable
 * at all.
 */
function VendorRow({ vendor, selected, onSelect }: { vendor: VendorState; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`vendor-row${selected ? ' vendor-row-selected' : ''}`}
        onClick={onSelect}
        aria-pressed={selected}
      >
        <VendorDot status={vendor.status} />
        <span className="strong">{vendor.label}</span>
        <span className={`status status-${vendor.status}`}>{VENDOR_STATUS_LABEL[vendor.status]}</span>
        <span className="dim small">{vendor.operator}</span>
        <span className="vendor-row-tail dim small mono">
          {vendor.activity !== null
            ? vendor.activity
            : vendor.detail !== null
              ? vendor.detail
              : `${formatInt(vendor.engagements)} engagement${vendor.engagements === 1 ? '' : 's'}`}
        </span>
      </button>
    </li>
  );
}

/**
 * The vendor bay: every third-party harness this office has engaged.
 *
 * A page of its own rather than a section of Settings, because a vendor is a
 * *roster* - the same kind of thing the Org tab is - and because the capability
 * table needs width to be read rather than skimmed.
 */
export function VendorsBayPanel() {
  const office = useOffice();
  const selection = useSelection();
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bay = office?.vendorBay ?? null;

  const recheck = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await api.refreshVendors();
    setBusy(false);
    if (!result.ok) setError(result.error ?? 'the refresh failed');
  };

  if (bay === null) {
    return (
      <Panel title="Vendors" subtitle="third-party agent harnesses this office may engage">
        <Empty title="Waiting for office state" hint="The vendor bay arrives with the office snapshot." />
      </Panel>
    );
  }

  if (!bay.enabled) {
    return (
      <Panel title="Vendors" subtitle="third-party agent harnesses this office may engage">
        <Empty
          title="Vendor delegation is switched off"
          hint="DEV3D_VENDOR_DELEGATION=false. The office will not launch any external harness."
        />
      </Panel>
    );
  }

  if (bay.vendors.length === 0) {
    return (
      <Panel title="Vendors" subtitle="third-party agent harnesses this office may engage">
        <Empty
          title="No vendors configured"
          hint={
            'Name one in DEV3D_VENDORS (for example "codex;dsh;hermes"), or add an entry to vendors.json ' +
            'for anything that needs a custom command.'
          }
        />
      </Panel>
    );
  }

  const counts = new Map<VendorStatus, number>();
  for (const vendor of bay.vendors) counts.set(vendor.status, (counts.get(vendor.status) ?? 0) + 1);

  return (
    <Panel
      title="Vendors"
      subtitle="third-party agent harnesses this office may engage — they run off-site, bill themselves, and are not on the payroll"
      actions={
        <button type="button" className="btn btn-sm" onClick={recheck} disabled={busy}>
          {busy ? 'Re-checking…' : 'Re-check'}
        </button>
      }
    >
      <div className="vendor-legend">
        {VENDOR_STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => (
          <span className="legend-item" key={status}>
            <VendorDot status={status} />
            <span className="dim small">
              {VENDOR_STATUS_LABEL[status]} {counts.get(status)}
            </span>
          </span>
        ))}
      </div>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          <span className="strong">Could not re-check</span>
          <span className="small mono">{error}</span>
        </div>
      )}

      <ul className="vendor-list">
        {bay.vendors.map((vendor) => (
          <VendorRow
            key={vendor.id}
            vendor={vendor}
            selected={selection.vendorId === vendor.id}
            onSelect={() => store.selectVendor(vendor.id)}
          />
        ))}
      </ul>

      <div className="role-section">
        <div className="role-section-title">Who may engage them</div>
        <div className="small">
          {bay.grantRoles.length === 0 ? (
            <span className="dim">nobody — no role grant matches</span>
          ) : bay.grantRoles.includes('*') ? (
            <span>every role</span>
          ) : bay.grantRoles.length === 1 && bay.grantRoles[0] === 'delegate-roles' ? (
            <span>
              every employee marked <span className="mono">canDelegate</span> in the org chart
            </span>
          ) : (
            <span className="mono">{bay.grantRoles.join(', ')}</span>
          )}
          {bay.requireCanDelegate && <span className="dim"> · and only where canDelegate is on</span>}
        </div>
        {bay.configPath !== null && (
          <div className="dim small mono" style={{ marginTop: '4px' }}>
            {bay.configPath}
          </div>
        )}
      </div>

      <div className="role-section">
        <div className="role-section-title">What a delegation is</div>
        <div className="small dim">
          An employee with a vendor granted calls it like any other tool. The vendor runs in that run&rsquo;s
          workspace with its own tools and returns a written answer; it cannot see the conversation, the plan, or
          anything another employee wrote. Read-only is the only mode in this release, so a vendor investigates and
          reports rather than changing files.
        </div>
      </div>
    </Panel>
  );
}

/**
 * The selected vendor, in the inspector.
 *
 * Deliberately narrower than `EmployeePanel`: a vendor has no turns of its own, no
 * routing decision, no skills and no inbox, and inventing empty sections for them
 * would make it look like a person with missing data rather than a machine.
 */
export function VendorPanel() {
  const office = useOffice();
  const selection = useSelection();

  const vendor =
    office?.vendorBay.vendors.find((candidate) => candidate.id === selection.vendorId) ?? null;

  if (vendor === null) {
    return (
      <Panel title="Vendor" subtitle="a third-party harness this office can engage">
        <Empty
          title="No vendor selected"
          hint="Click a terminal in the office, or a row on the Vendors page."
        />
      </Panel>
    );
  }

  const caps = vendor.capabilities;

  return (
    <Panel
      title={
        <span className="inline-gap">
          {vendor.label}
          <Badge tone={toneFor(vendor.status)}>{VENDOR_STATUS_LABEL[vendor.status]}</Badge>
        </span>
      }
      subtitle={
        <span className="inline-gap">
          <span>third-party vendor</span>
          <span className="dim">· run by {vendor.operator}</span>
          <span className="mono dim">· {vendor.id}</span>
        </span>
      }
      actions={vendor.status === 'engaged' ? <Badge tone="ok">working now</Badge> : null}
    >
      <div className="employee-activity">
        <div className="field-label">Current activity</div>
        <div className="activity-line">{vendor.activity ?? <span className="dim">docked, nothing in flight</span>}</div>
        {vendor.detail !== null && <div className="dim small mono">{vendor.detail}</div>}
      </div>

      {vendor.lastError !== null && (
        <div className="alert alert-danger" role="alert">
          <span className="strong">Last failure</span>
          <span className="mono small">{vendor.lastError}</span>
        </div>
      )}

      <div className="metrics-grid">
        <Metric label="Engagements" value={formatInt(vendor.engagements)} />
        <Metric label="Read-only" value={ENFORCEMENT_SHORT[caps.readOnlyEnforcement]} />
        <Metric label="Reports files" value={caps.reportsFiles ? 'yes' : 'no'} />
        <Metric label="Reports cost" value={caps.reportsCost ? 'yes' : 'no'} />
      </div>

      {/*
        The disclosure that matters most, and the reason this field is three-valued
        rather than a boolean. "The harness sandboxes itself", "dev3d refuses every
        write it asks for", and "nothing enforces it" are three different
        guarantees, and an operator reading a badge is entitled to know which one
        they actually have. Rendering them as two would misdescribe the middle.
      */}
      <div className={`alert ${caps.readOnlyEnforcement === 'requested' ? 'alert-warn' : 'alert-info'}`} role="note">
        <span className="strong">{ENFORCEMENT_TITLE[caps.readOnlyEnforcement]}</span>
        <span className="small">{ENFORCEMENT_DETAIL[caps.readOnlyEnforcement](vendor.label)}</span>
      </div>

      {!caps.reportsCost && (
        <div className="alert alert-warn" role="note">
          <span className="strong">The run budget does not bound this</span>
          <span className="small">
            {vendor.label} bills on its own subscription, so the office sees no cost for a delegation and the run&rsquo;s
            spend ceiling cannot stop one. The real limit is the vendor&rsquo;s own timeout, which a delegation may
            lower but never raise.
          </span>
        </div>
      )}

      <div className="role-section">
        <div className="role-section-title">How it is run</div>
        <KeyValue label="Command" mono>
          {vendor.command}
        </KeyValue>
        <KeyValue label="Working directory" mono>
          the run&rsquo;s workspace
        </KeyValue>
      </div>

      {vendor.authNote !== null && (
        <div className="role-section">
          <div className="role-section-title">Authentication</div>
          <div className="small dim">{vendor.authNote}</div>
        </div>
      )}
    </Panel>
  );
}
