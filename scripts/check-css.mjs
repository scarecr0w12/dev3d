/**
 * Class-name contract check for the web app.
 *
 * A typecheck cannot tell you that `className="poput-left"` is a typo, and a
 * stylesheet quietly accumulates rules for components that no longer exist
 * (`styles.css` is over 2,000 lines). Neither failure shows up at compile time,
 * and neither is visible without a browser.
 *
 * So: collect every class selector the stylesheet defines, collect every class
 * token the source uses, and report the two ways they can disagree.
 *
 *   node scripts/check-css.mjs
 *
 * Two deliberate choices keep the signal clean:
 *
 *  - A literal is only treated as a class list when every one of its tokens is
 *    lowercase-and-hyphens *and* at least one is already a known class. Prose in
 *    a `title` or an error message otherwise reads as a list of missing classes,
 *    because English contains "state", "office", "panel" and "table".
 *  - Only hyphenated unknown tokens are reported. Every real class in this app
 *    is a compound (`chat-scroll`, `popout-left`), while stray prose words are
 *    not, so this trades a theoretical miss for a large drop in noise.
 *
 * That heuristic has a blind spot worth naming, because it hid a real typo: a
 * literal whose tokens are *all* unknown is skipped, so `className="poput-left"`
 * - the exact example above - was never reported. The second pass below closes it
 * by checking a static `className="..."` whole, where there is no prose to filter
 * and every token has to resolve.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const SRC = join(ROOT, 'apps/web/src');
const CSS = join(SRC, 'styles.css');

const CLASS_TOKEN_RE = /^[a-z][a-z0-9-]*$/;
const LITERAL_RE = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/**
 * Markup hooks that carry a class but deliberately have no rule of their own:
 * the base class beside them already does the work, and the extra name is there
 * so a future rule has something specific to target. They are listed rather
 * than ignored so that a *new* unknown class still fails this check.
 */
const KNOWN_HOOKS = new Set([
  'office-overlay-center', // .office-overlay already centres its contents
  'policy-editor', // sits under .role-section
  'state-empty', // sits under .state
  'table-models', // sits under .table
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- stylesheet
const defined = new Set();
for (const match of readFileSync(CSS, 'utf8').matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) {
  if (match[1] !== undefined) defined.add(match[1]);
}

// ------------------------------------------------------------------- sources
const files = walk(SRC);
const unknown = [];
let allSource = '';

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  allSource += `${text}\n`;

  for (const match of text.matchAll(LITERAL_RE)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? '';
    if (literal === '' || literal.length > 120) continue;

    // A template literal's static parts end mid-name, e.g. "chat-"; drop those
    // fragments rather than reporting them as missing classes.
    const tokens = literal
      .split(/\s+/)
      .map((token) => token.replace(/-$/, ''))
      .filter((token) => CLASS_TOKEN_RE.test(token));
    if (tokens.length === 0 || tokens.length > 10) continue;
    if (!tokens.some((token) => defined.has(token))) continue;
    if (tokens.length !== literal.split(/\s+/).filter(Boolean).length) continue;

    for (const token of tokens) {
      if (!defined.has(token) && token.includes('-') && !KNOWN_HOOKS.has(token)) {
        unknown.push({ file: relative(ROOT, file), literal, token });
      }
    }
  }
}

// ------------------------------------------------------- static class literals
// `className="a b"` is a class list and nothing else, so the whole literal is
// checked. No prose filter is needed here, which is what lets a literal whose
// tokens are *all* unknown be reported - the case the heuristic above misses.
const STATIC_CLASS_RE = /className\s*=\s*"([^"\n]*)"/g;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(STATIC_CLASS_RE)) {
    const literal = match[1] ?? '';
    const tokens = literal.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 12) continue;
    if (!tokens.every((token) => CLASS_TOKEN_RE.test(token))) continue;
    for (const token of tokens) {
      if (defined.has(token) || KNOWN_HOOKS.has(token)) continue;
      unknown.push({ file: relative(ROOT, file), literal, token });
    }
  }
}

// Dead CSS is decided by a whole-word search over all source, so classes that
// only ever appear inside a template literal (`notice notice-${level}`) count
// as used rather than being reported.
//
// A whole-word search cannot see the *value* of an interpolation, so any class
// built that way (`badge-${tone}`) is instead covered by its prefix: if the
// source constructs `foo-${...}`, every `.foo-*` rule is potentially live.
const dynamicPrefixes = new Set();
for (const match of allSource.matchAll(/(^|[^A-Za-z0-9_-])([a-z][a-z0-9-]*-)\$\{/g)) {
  if (match[2] !== undefined) dynamicPrefixes.add(match[2]);
}

const usedCache = new Map();
function isUsed(name) {
  const cached = usedCache.get(name);
  if (cached !== undefined) return cached;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`);
  const result = pattern.test(allSource) || [...dynamicPrefixes].some((prefix) => name.startsWith(prefix));
  usedCache.set(name, result);
  return result;
}

const unused = [...defined].filter((name) => !isUsed(name)).sort();

// --------------------------------------------------------------------- report
console.log(`stylesheet classes : ${defined.size}`);
console.log(`source files scanned: ${files.length}`);
console.log(`dynamic prefixes    : ${[...dynamicPrefixes].sort().join(' ')}`);

if (unknown.length > 0) {
  console.log(`\nUNKNOWN class names in source (${unknown.length}):`);
  for (const item of unknown) {
    console.log(`  ${item.file}: "${item.literal}" — no rule for .${item.token}`);
  }
} else {
  console.log('\nNo unknown class names in source.');
}

if (unused.length > 0) {
  console.log(`\nDead CSS — defined but never referenced (${unused.length}):`);
  for (const name of unused) console.log(`  .${name}`);
} else {
  console.log('\nNo dead CSS.');
}

process.exit(unknown.length === 0 ? 0 : 1);
