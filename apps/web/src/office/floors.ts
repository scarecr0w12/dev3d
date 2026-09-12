/**
 * The building's arithmetic.
 *
 * Where each floor sits, which floor is on screen, and what is drawn for it.
 * This is deliberately free of three.js: the rules that decide whether the
 * office renders as a building at all are worth testing without a WebGL context,
 * and they are the part most likely to be quietly wrong.
 */

/** Vertical gap between floors. The office walls are 3 m tall. */
export const FLOOR_STEP = 4.2;

export interface FloorSlot {
  id: string;
  /** 1-based; floor 1 is the ground floor. */
  floor: number;
}

/**
 * World height of a floor. Floor 1 sits at ground level so a single-floor
 * building is exactly where it was before floors existed. A non-finite or
 * sub-1 floor number is clamped rather than producing a floor underground.
 */
export function floorOffset(floor: number): number {
  const safe = Number.isFinite(floor) ? Math.floor(floor) : 1;
  return (Math.max(1, safe) - 1) * FLOOR_STEP;
}

/**
 * Which floor to look at. An unknown id (a floor that was just closed, or state
 * that has not arrived yet) falls back to the lowest floor rather than showing
 * nothing at all.
 */
export function resolveFloorId(floors: readonly FloorSlot[], workspaceId: string): string | null {
  if (floors.some((entry) => entry.id === workspaceId)) return workspaceId;
  let lowest: FloorSlot | null = null;
  for (const entry of floors) {
    if (lowest === null || entry.floor < lowest.floor) lowest = entry;
  }
  return lowest?.id ?? null;
}

/**
 * What is drawn for a floor. The floor being looked at shows its walls; every
 * other floor shows only its coloured plate, which is what makes the stack
 * legible without paying for thousands of hidden wall meshes.
 *
 * The active floor's plate is hidden because the real model already has a slab
 * there and two coplanar surfaces z-fight.
 */
export function floorVisibility(floorId: string, activeId: string): { walls: boolean; plate: boolean } {
  const active = floorId === activeId;
  return { walls: active, plate: !active };
}
