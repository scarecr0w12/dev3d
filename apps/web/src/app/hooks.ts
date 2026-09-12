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
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

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
  ref: RefObject<HTMLDivElement>;
  pinned: boolean;
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll container pinned to its tail while `dep` changes, but only
 * when the user has not scrolled away to read something.
 */
export function useAutoScroll(dep: unknown, threshold = 160): AutoScroll {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, [threshold]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
  }, [measure]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [dep, pinned]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  return { ref, pinned, scrollToBottom };
}

/** A string state that survives a page refresh, when storage is available. */
export function useStoredState(key: string, initial: string): [string, (next: string) => void] {
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
      return stored === null ? initial : clamp(Number.parseFloat(stored));
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setValue(clamped);
      try {
        window.localStorage.setItem(key, String(Math.round(clamped)));
      } catch {
        /* storage is a nice-to-have; ignore quota/private-mode failures */
      }
    },
    [clamp, key],
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
