/**
 * The tabbed pages.
 *
 * Each one is a composition of panels that already existed - the pages are about
 * giving each area of the office enough room to be read properly, now that the
 * 3D view owns the default viewport instead of sharing it with three columns of
 * everything at once.
 */

import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useOffice } from '../app/StoreContext';
import { ActivityFeed } from './ActivityFeed';
import { ApprovalsPanel } from './ApprovalsPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { MemoryPanel } from './MemoryPanel';
import { OrgChart } from './OrgChart';
import { PluginsPanels } from './plugins/PluginsPanels';
import { PluginPanels } from './plugins/PluginPanels';
import { ProjectsPanel } from './ProjectsPanel';
import { RunList } from './RunList';
import { RunTranscript } from './RunTranscript';
import { SettingsPanel } from './SettingsPanel';
import { SkillsPanel } from './SkillsPanel';
import { Telemetry } from './Telemetry';
import { VendorsBayPanel } from './VendorsPanel';

/** Two independently scrolling columns, which is what a dense page wants. */
function Columns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="sheet-columns">
      <div className="sheet-column">{left}</div>
      <div className="sheet-column">{right}</div>
    </div>
  );
}

function Single({ children }: { children: ReactNode }) {
  return <div className="sheet-single">{children}</div>;
}

export function ProjectsPage() {
  return (
    <Single>
      <ProjectsPanel />
    </Single>
  );
}

export function OrgPage({ seatIds }: { seatIds: string[] }) {
  const office = useOffice();
  /**
   * The seat picker offers the union of two sources, because neither is complete
   * on its own: the model knows the core's anchors as soon as it loads, and the
   * server knows the seats its generated modules add even before the 3D view has
   * caught up. Missing seats here would mean an employee who cannot be seated.
   */
  const seats = useMemo(() => {
    const set = new Set(seatIds);
    for (const seat of office?.floor.seatIds ?? []) set.add(seat);
    return [...set].sort();
  }, [seatIds, office?.floor.seatIds]);

  return (
    <Single>
      {office && (
        <div className="dept-strip">
          {office.departments.map((department) => {
            const count = office.roles.filter((role) => role.departmentId === department.id).length;
            return (
              <span className="dept-chip" key={department.id} title={department.mission}>
                <span className="dot" style={{ background: department.color }} aria-hidden="true" />
                <span className="strong">{department.name}</span>
                <span className="dim small mono">{count}</span>
              </span>
            );
          })}
        </div>
      )}
      <OrgChart seatIds={seats} />
    </Single>
  );
}

export function RunsPage() {
  return (
    <Columns
      left={
        <>
          <ApprovalsPanel />
          <RunList />
        </>
      }
      right={
        <>
          <RunTranscript />
          <ArtifactsPanel />
          <PluginPanels placement="runs" />
        </>
      }
    />
  );
}

export function ActivityPage() {
  return (
    <Single>
      <ActivityFeed />
    </Single>
  );
}

export function OpsPage() {
  return (
    <Single>
      <Telemetry />
    </Single>
  );
}

export function SkillsPage() {
  return (
    <Single>
      <SkillsPanel />
    </Single>
  );
}

/**
 * Memory gets a page of its own rather than a panel on another one.
 *
 * Writing a fact down is an editorial act about the whole office - it changes what
 * every employee is told - so it deserves room to read what is already there before
 * adding to it. The ledger tab in particular needs the width.
 */
export function MemoryPage() {
  return (
    <Single>
      <MemoryPanel />
    </Single>
  );
}

/**
 * Vendors: the third-party harnesses this office has engaged.
 *
 * A page rather than a section of Settings, because a vendor is a *roster* - the
 * same kind of thing the Org tab is - and because the capability table that says
 * whether read-only is enforced or merely requested needs width to be read rather
 * than skimmed.
 */
export function VendorsPage() {
  return (
    <Single>
      <VendorsBayPanel />
    </Single>
  );
}

export function SettingsPage() {
  return (
    <Single>
      <SettingsPanel />
      <PluginPanels placement="settings" />
    </Single>
  );
}

/**
 * The marketplace home. It stacks panels rather than splitting into columns,
 * because consent for what is installed has to read before the settings of one
 * plugin, which has to read before where plugins come from.
 */
export function PluginsPage() {
  return (
    <Single>
      <PluginsPanels />
    </Single>
  );
}
