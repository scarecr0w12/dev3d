/**
 * The 3D scene's change signature.
 *
 * Lives in its own `.ts` module rather than beside the canvas for a practical
 * reason: Node strips types but cannot parse `.tsx`, so anything the verification
 * harness needs to import has to live outside the component file.
 *
 * ## Why a signature at all
 *
 * The store hands out a **new array** on every `office` event — a turn started, a
 * budget tick, an artifact, a settings change, an employee's status. The sync
 * effect's dependency list was those arrays, so it re-ran for events that cannot
 * affect the 3D scene at all, and each run did a full `buildFloors` plus a walk
 * over every avatar and a fresh `parkedIds` array into `setParked`, forcing a
 * React render. With the client heartbeat on top, a busy office did that several
 * times a minute for changes that affected at most one person.
 *
 * Comparing this string first turns all of those into a no-op. It is built from
 * exactly the fields the scene consumes — identity, where someone sits, how they
 * look, what they are doing — so a real change still gets through and a change to
 * a run's budget does not.
 *
 * Built from **all** employees rather than only the visible floor's: switching
 * floors changes who is on screen, and the signature has to notice that.
 */

import type { EmployeeState, Role, VendorState, WorkspaceSummary } from '@dev3d/core';

export interface SceneSync {
  employees: EmployeeState[];
  roles: Role[];
  /** Every floor in the building, so the scene can build one per organisation. */
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  selectedId: string | null;
  /**
   * The third-party vendors docked on this floor.
   *
   * Installation-wide rather than per-organisation: a vendor is configured by the
   * operator with an environment variable, not by an org chart, so the same bay
   * appears on every floor.
   */
  vendors: VendorState[];
  selectedVendorId: string | null;
}

/** A cheap fingerprint of everything `syncScene` actually reads. */
export function sceneSignature(input: SceneSync): string {
  const roles = input.roles
    .map(
      (role) =>
        `${role.id}:${role.displayName}:${role.seatId ?? ''}:${role.appearance?.bodyColor ?? ''}:${role.appearance?.accentColor ?? ''}:${role.appearance?.height ?? ''}`,
    )
    .join(',');
  const employees = input.employees
    .map(
      (employee) =>
        `${employee.id}:${employee.roleId}:${employee.seatId ?? ''}:${employee.status}:${employee.displayName}:${employee.activity ?? ''}`,
    )
    .join(',');
  const vendors = input.vendors
    .map((vendor) => `${vendor.id}:${vendor.status}:${vendor.label ?? ''}`)
    .join(',');
  const floors = input.workspaces
    .map((workspace) => `${workspace.id}:${workspace.floor}:${workspace.layout?.updatedAt ?? ''}`)
    .join(',');
  return [
    input.activeWorkspaceId,
    input.selectedId ?? '',
    input.selectedVendorId ?? '',
    floors,
    roles,
    employees,
    vendors,
  ].join('|');
}
