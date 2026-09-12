/**
 * How tall the inspector pane may be.
 *
 * This is small, and it lives apart from the console component for one reason:
 * it was wrong, and the way it was wrong was invisible until something measured
 * the result. The pane is `position: absolute` inside the stage, and it was
 * positioned by `top` *and* `bottom` while a third, separately computed height
 * competed with both - three constraints for two degrees of freedom, which the
 * browser resolved into a pane that sat off its own top edge and stopped short
 * of the dock.
 *
 * The rule now is that the ceiling depends only on the stage and the dock, and
 * never on the pane itself. It used to depend on the pane, which closed a loop:
 * the pane's height set the dock's available width, the width set how many rows
 * the dock wrapped onto, that set the dock's height, and the dock's height came
 * back as the pane's ceiling. Measured in the browser, that loop settled
 * differently at every window size - the pane overran the dock by anywhere from
 * 130 to 270 pixels, depending only on which way the oscillation happened to
 * fall on that run.
 *
 * The CSS expresses this as `calc(100% - top - dock - gutter)`. This module is
 * the same arithmetic in one place, so it can be checked.
 */

/** A pane shorter than this is not worth showing, whatever the window says. */
export const MIN_INSPECTOR_HEIGHT = 280;
/** Breathing room between the pane's bottom edge and the dock's top edge. */
export const PANE_DOCK_GUTTER = 24;

export interface PaneCeiling {
  /** The tallest the pane may be, in pixels. */
  maxHeight: number;
  /** True when the window is too short for even the floor, so the pane overruns. */
  overruns: boolean;
}

/**
 * The pane's ceiling, given the room between the stage's top edge and the dock.
 *
 * `stageHeight` is the stage's own height in pixels, which is what CSS `100%`
 * resolves to inside the pane's containing block.
 */
export function paneCeiling({
  stageHeight,
  paneTop,
  dockHeight,
}: {
  stageHeight: number;
  /** The pane's own top inset inside the stage - `--popout-top`. */
  paneTop: number;
  dockHeight: number;
}): PaneCeiling {
  const available = stageHeight - paneTop - dockHeight - PANE_DOCK_GUTTER;
  // A floor rather than a fit: on a very short window the pane stays usable and
  // the dock overlaps its last lines, which is the trade the two full-width
  // surfaces have always made down there. Shrinking the pane to a sliver to
  // avoid it would be a worse answer than the overlap.
  return { maxHeight: Math.max(MIN_INSPECTOR_HEIGHT, available), overruns: available < MIN_INSPECTOR_HEIGHT };
}
