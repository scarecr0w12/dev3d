/**
 * Contrast checks over the real stylesheet.
 *
 * This reads `styles.css` rather than duplicating its palette, so the check cannot
 * drift from the thing it is checking. The defect it exists for: `--text-mute` was
 * `#6c7686`, which measured 4.36:1 on the body background, 4.03:1 on a panel and
 * 3.56:1 on surface-3 — below the 4.5:1 WCAG AA threshold for normal text on
 * *every* surface it is used on, at 28 sites, and on labels rather than decorative
 * chrome. Two consumers then multiplied it by `opacity`, compositing it back down
 * to roughly 2.6:1.
 *
 * Lives in `.verify/` because it is a build-time invariant, not runtime logic.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(HERE, '..', 'src', 'styles.css');

/** One sRGB channel, linearised. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every custom property declared in the sheet's `:root` block. */
export function readTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (root === null) return tokens;
  for (const line of (root[1] ?? '').split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) tokens.set(match[1], match[2]);
  }
  return tokens;
}

/**
 * The AA threshold. 4.5:1 is the requirement for normal-size text; the sheet's
 * secondary text runs at 9.5–12px, so large-text exemptions do not apply.
 */
export const AA_NORMAL_TEXT = 4.5;

/** The surfaces secondary text is actually drawn on. */
export const SURFACES = ['--bg', '--surface', '--surface-3'] as const;

export interface TokenContrast {
  text: string;
  surface: string;
  ratio: number;
  passes: boolean;
}

/** Contrast of one token against every surface. */
export function tokenAgainstSurfaces(
  tokens: Map<string, string>,
  textToken: string,
): TokenContrast[] {
  const text = tokens.get(textToken);
  if (text === undefined) return [];
  const out: TokenContrast[] = [];
  for (const surfaceToken of SURFACES) {
    const surface = tokens.get(surfaceToken);
    if (surface === undefined) continue;
    const ratio = contrast(text, surface);
    out.push({ text: textToken, surface: surfaceToken, ratio, passes: ratio >= AA_NORMAL_TEXT });
  }
  return out;
}

/** Read the sheet once, for the checks below. */
export function readStylesheet(): string {
  return readFileSync(CSS_PATH, 'utf8');
}

/**
 * Composite `text` over `surface` at `opacity`.
 *
 * `opacity` is not a colour, and a contrast checker that ignores it approves rules
 * a reader cannot read: `.fact-inactive` declared `opacity: .62` on a token that
 * passes AA on its own, which composited the text to 3.55:1 — below the threshold,
 * on text whose whole purpose is to be legible-but-historical.
 */
export function blendOver(text: string, surface: string, opacity: number): string {
  const parts = (hex: string): number[] => {
    const clean = hex.trim().replace('#', '');
    const full =
      clean.length === 3
        ? clean
            .split('')
            .map((c) => c + c)
            .join('')
        : clean;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [tr, tg, tb] = parts(text);
  const [sr, sg, sb] = parts(surface);
  const channel = (t: number | undefined, s: number | undefined): string =>
    Math.round((t ?? 0) * opacity + (s ?? 0) * (1 - opacity))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(tr, sr)}${channel(tg, sg)}${channel(tb, sb)}`;
}

/**
 * The `opacity` a rule **declares**, read from the sheet.
 *
 * Reading the declaration is the point: a check that hardcodes 0.8 would keep
 * passing after someone dimmed the rule back to 0.62.
 */
export function declaredOpacity(css: string, selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (block === null) return null;
  const match = /opacity\s*:\s*([0-9.]+)/.exec(block[1] ?? '');
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
