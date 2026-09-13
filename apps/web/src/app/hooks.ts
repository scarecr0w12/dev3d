/**
 * Small React hooks shared by the console panels.
 *
 * These are deliberately tiny: a ticking clock for elapsed times, a
 * reduced-motion query so the 3D office and CSS animations can calm down, a
 * sticky-scroll helper so a streaming transcript follows the tail without
 * fighting the user, and a localStorage-backed draft so a long brief survives a
 * refresh.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefCallback, RefObject } from 'react';

/** Re-renders on an interval so live elapsed times stay honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** A live `matchMedia` result, for layout decisions the CSS alone cannot make. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export interface AutoScroll {
  ref: RefCallback<HTMLDivElement>;
  pinned: boolean;
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll container pinned to its tail while `dep` changes, but only
 * when the user has not scrolled away to read something.
 *
 * ## Why a callback ref and not `useRef` + an effect
 *
 * The listener used to be attached in a `useEffect` keyed on `measure`, which is
 * stable — so the effect ran **once**, on mount. But the callers render their
 * scroll container conditionally: `RunTranscript` returns a "No run selected"
 * panel before the transcript exists. On a cold load the first commit therefore
 * had `ref.current === null`, the effect bailed, and the scroll listener was
 * never attached at all. `pinned` stayed at its initial `true` forever, so every
 * streamed delta yanked the container back to the bottom and the operator could
 * not scroll up to read an earlier turn — and the panel's own "Jump to live"
 * affordance was unreachable, because `pinned` could never become false.
 *
 * A callback ref attaches when the node actually appears and detaches when it
 * goes, which is the lifetime the listener wants. It also keeps working for any
 * other caller that mounts its container late.
 */
export function useAutoScroll(dep: unknown, threshold = 160): AutoScroll {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  const measure = useCallback(() => {
    const node = el;
    if (!node) return;
    setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < threshold);
  }, [el, threshold]);

  // `measure` changes when the node does, so this runs on attach and re-attaches
  // rather than being a one-shot that can miss its node.
  useEffect(() => {
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
  }, [el, measure]);

  useLayoutEffect(() => {
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [dep, pinned, el]);

  const scrollToBottom = useCallback(() => {
    setEl((node) => {
      if (node) node.scrollTop = node.scrollHeight;
      return node;
    });
    setPinned(true);
  }, []);

  return { ref: setEl, pinned, scrollToBottom };
}

/**
 * A numeric form field's new value, or the previous one when the box was cleared.
 *
 * A controlled `<input type="number">` reports `''` when the operator selects all
 * and deletes, and `Number('') === 0`. Passing that straight through meant
 * clearing a box silently wrote a zero — which for the soft-spend threshold means
 * "never ask a human before spending", and for a run budget means "no ceiling".
 * So an accidental keystroke quietly weakened a spend control, with no error and
 * no visible difference in the form.
 *
 * Non-numeric text (which a number input can still produce via a paste or a
 * locale-odd decimal separator) is treated the same way rather than becoming
 * `NaN`, which would reach the server as `null`.
 */
export function numericDraft(
  raw: string,
  previous: number | undefined,
  fallback: number,
): number | undefined {
  if (raw.trim() === '') return previous ?? fallback;
  const next = Number(raw);
  return Number.isFinite(next) ? next : previous;
}

/**
 * A stored number, or null when the string is not wholly a number.
 *
 * `Number.parseFloat` is the wrong tool: it stops at the first character it
 * cannot use and returns what it has, so `"420px"` reads as `420` and
 * `"420.5.5"` as `420.5`. A corrupted preference then looks like a deliberate
 * one. `Number()` is strict about the whole string — with the one exception of
 * whitespace, which `trim` handles — and anything else is reported as unreadable.
 */
export function parseStoredNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A string state that survives a page refresh, when storage is available. */export function useStoredState(key: string, initial: string): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : stored;
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        if (next.length === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, next);
      } catch {
        /* storage is a nice-to-have; ignore quota/private-mode failures */
      }
    },
    [key],
  );

  return [value, update];
}

/**
 * A number that survives a refresh, clamped on the way in *and* on the way out.
 *
 * Clamping on read matters as much as on write: a width stored on a 4K monitor
 * is wrong on a laptop, and a pane that reopens wider than the viewport is worse
 * than one that forgot the preference entirely.
 *
 * Parsing is **strict**. `Number.parseFloat` was used here and accepts trailing
 * garbage — `"420px"` becomes `420`, `"420.5.5"` becomes `420.5` — so a
 * hand-edited or corrupted `localStorage` value was silently truncated into a
 * number that looked deliberate. Now anything that is not wholly a number falls
 * back to `initial`, and the stored value is rewritten so the corruption does not
 * persist.
 *
 * `initial` may be outside `[min, max]` and is then treated as an **unset
 * sentinel** — the inspector's height uses `-1` for "the operator has not chosen
 * one", which is only unambiguous if it cannot also be a legal value.
 */
export function useStoredNumber(
  key: string,
  initial: number,
  min: number,
  max: number,
): [number, (next: number) => void] {
  const clamp = useCallback(
    (value: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : initial),
    [initial, max, min],
  );

  const [value, setValue] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) return initial;
      const parsed = parseStoredNumber(stored);
      if (parsed === null) {
        // Unreadable: drop it rather than leaving it to be re-parsed every load.
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* storage is a nice-to-have */
        }
        return initial;
      }
      return clamp(parsed);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: number) => {
      // A value outside the range is the caller's "unset" sentinel, and it clears
      // the preference rather than being clamped into a real one. Clamping it was
      // a silent bug: resetting the inspector height meant storing `0`, so the
      // pane came back collapsed instead of room-sized.
      if (!Number.isFinite(next) || next < min || next > max) {
        setValue(initial);
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* storage is a nice-to-have; ignore quota/private-mode failures */
        }
        return;
      }
      setValue(next);
      try {
        window.localStorage.setItem(key, String(Math.round(next)));
      } catch {
        /* storage is a nice-to-have; ignore quota/private-mode failures */
      }
    },
    [initial, key, max, min],
  );

  return [value, update];
}

/** What a drag did, handed back so the caller can persist its final size. */
export interface PaneResizeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** True while a drag is in flight, so the pane can suppress transitions. */
  dragging: boolean;
}

/**
 * Drag either inner edge of a floating side pane to resize it.
 *
 * The pane is anchored to its own outer edge, so the geometry is inverted for
 * one on the right: dragging its left edge *left* makes it wider. `onCommit`
 * fires once on release rather than on every frame, because writing a stored
 * preference sixty times a second is a good way to make a drag stutter.
 */
export function usePaneResize({
  axis = 'x',
  invert = true,
  min,
  max,
  size,
  onChange,
  onCommit,
}: {
  axis?: 'x' | 'y';
  invert?: boolean;
  min: number;
  max: number;
  size: number;
  onChange: (next: number) => void;
  onCommit?: (next: number) => void;
}): PaneResizeHandlers {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ pointer: number; size: number } | null>(null);
  const latest = useRef(size);
  latest.current = size;

  // The live values live in refs so the listeners can be attached once for the
  // life of the component instead of being torn down and rebuilt per drag.
  const config = useRef({ axis, invert, min, max, onChange, onCommit });
  config.current = { axis, invert, min, max, onChange, onCommit };

  const end = useCallback(() => {
    if (origin.current === null) return;
    origin.current = null;
    setDragging(false);
    document.body.classList.remove('is-resizing');
    config.current.onCommit?.(latest.current);
  }, []);

  const move = useCallback((event: PointerEvent) => {
    const start = origin.current;
    if (start === null) return;
    const current = config.current;
    const position = current.axis === 'x' ? event.clientX : event.clientY;
    const delta = current.invert ? start.pointer - position : position - start.pointer;
    const next = Math.min(current.max, Math.max(current.min, start.size + delta));
    latest.current = next;
    current.onChange(next);
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [end, move]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const current = config.current;
    const position = current.axis === 'x' ? event.clientX : event.clientY;
    origin.current = { pointer: position, size: latest.current };
    setDragging(true);
    event.preventDefault();
    // Stops the browser turning the drag into a text selection or a native
    // window resize, which is what makes a panel drag feel broken.
    document.body.classList.add('is-resizing');
  }, []);

  return { onPointerDown, dragging };
}
