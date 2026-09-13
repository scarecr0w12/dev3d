/**
 * Code-navigation and patching tools: `glob`, `grep` and `apply_patch`.
 *
 * These exist because the first three filesystem tools answer narrow questions.
 * `list_dir` shows one directory, and `search_files` searches one directory root
 * for a regex — neither can answer "where is this file?" or "what calls this, and
 * what is around those lines?". `apply_patch` exists because a change spanning
 * several files as one reviewable unit is safer than a sequence of literal
 * string replacements that can half-apply.
 *
 * Every tool returns a `ToolResult` rather than throwing, so a model that gets
 * something wrong receives a message it can act on.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolResult } from './types.ts';
import { resolveInWorkspace, toWorkspaceRelative, assertNotGitControlPath } from './paths.ts';
import { SKIPPED_DIRS, globMatches, makeExcluder } from './match.ts';

const MAX_FILES = 300;
const MAX_GREP_MATCHES = 150;
const MAX_GREP_FILE_BYTES = 1024 * 1024; // 1 MB
const MAX_LINE_DISPLAY = 300;
const MAX_CONTEXT = 5;
const MAX_PATCH_FILES = 20;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(content: string, preview = 'Error'): ToolResult {
  return { ok: false, content, preview, affectsPaths: [] };
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function capLine(text: string, max = MAX_LINE_DISPLAY): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Walk a tree, calling `onFile` for every regular file.
 *
 * The callback always returns a boolean: `false` means "stop the walk", which is
 * how a caller enforces a result cap without walking the rest of a large tree.
 */
function walk(dir: string, onFile: (full: string) => boolean): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(full, onFile);
    } else if (entry.isFile()) {
      if (!onFile(full)) return;
    }
  }
}

// ---------------------------------------------------------------------------
// glob - find files by name pattern
// ---------------------------------------------------------------------------

const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by path pattern, newest first. Use this to answer "where is that ' +
    'file?" - for example `**/*.test.ts`, `src/**/router*.ts` or `*.json`. ' +
    'Directories are not returned. Skips node_modules and .git. Returns up to 300 paths.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob to match workspace-relative paths. `*` matches within a segment, ' +
          '`**` across segments. A pattern with no `/` matches at any depth, so ' +
          '`*.ts` finds `src/a/b.ts`.',
      },
      path: {
        type: 'string',
        description: 'Directory to search under. Defaults to the workspace root.',
      },
      exclude: { type: 'string', description: 'Optional glob of paths to skip, e.g. `**/dist/**`.' },
      limit: { type: 'number', description: `Maximum paths to return (default ${MAX_FILES}).` },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    try {
      if (typeof args.pattern !== 'string' || args.pattern === '') {
        return fail('glob requires a non-empty "pattern" string.');
      }
      const raw = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
      const root = resolveInWorkspace(ctx.workspaceRoot, raw);
      if (!existsSync(root)) return fail(`Path does not exist: ${raw}`);
      if (!statSync(root).isDirectory()) return fail(`Not a directory: ${raw}`);

      const exclude = typeof args.exclude === 'string' ? args.exclude : '';
      const isExcluded = makeExcluder(exclude);
      const limit = Math.max(1, Math.min(toInt(args.limit, MAX_FILES), MAX_FILES));

      const hits: Array<{ rel: string; mtime: number }> = [];
      const pattern = args.pattern;
      walk(root, (full) => {
        const rel = toWorkspaceRelative(ctx.workspaceRoot, full);
        if (isExcluded(rel)) return true;
        if (!globMatches(pattern, rel)) return true;
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          return true;
        }
        hits.push({ rel, mtime });
        return true;
      });

      // Newest first: the file being worked on is far more likely to be the one
      // that just changed than the one that has not moved in a year.
      hits.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
      const shown = hits.slice(0, limit);

      if (shown.length === 0) {
        return {
          ok: true,
          content: `No files match ${JSON.stringify(args.pattern)} under ${raw}.`,
          preview: '0 files matched',
          affectsPaths: [],
        };
      }
      const lines = shown.map((h) => h.rel);
      if (hits.length > shown.length) {
        lines.push(`(${hits.length - shown.length} more; raise "limit" or narrow the pattern)`);
      }
      return {
        ok: true,
        content: lines.join('\n'),
        preview: `${shown.length} file(s) match ${args.pattern}`,
        affectsPaths: [],
      };
    } catch (e) {
      return fail(`Tool error: ${errMsg(e)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// grep - search contents across a tree
// ---------------------------------------------------------------------------

interface GrepMatch {
  rel: string;
  line: number;
  /** The matched line and any context lines, already formatted. */
  block: string[];
  /** The matched line itself, for rendering `file:line: text` on a single hit. */
  text: string;
}

const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents across the workspace for a regular expression, with ' +
    'optional context lines. Use this to find where something is defined or used. ' +
    'Filter with `include` (e.g. `*.ts`) and `exclude`. Skips node_modules, .git, ' +
    'binary files and files over 1 MB. Returns up to 150 matches.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression to match per line.' },
      path: { type: 'string', description: 'Directory to search under. Defaults to the workspace root.' },
      include: { type: 'string', description: 'Glob of files to search, e.g. `*.ts` or `src/**/*.tsx`.' },
      exclude: { type: 'string', description: 'Glob of files to skip.' },
      context: {
        type: 'number',
        description: `Lines of context to show around each match, 0-${MAX_CONTEXT} (default 0).`,
      },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive matching (default false).' },
      filesOnly: {
        type: 'boolean',
        description:
          'Return just the paths that contain a match, one per line, instead of the matching ' +
          'lines. Use this to find which files mention something.',
      },
      limit: { type: 'number', description: `Maximum matches to return (default ${MAX_GREP_MATCHES}).` },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    try {
      if (typeof args.pattern !== 'string' || args.pattern === '') {
        return fail('grep requires a non-empty "pattern" string.');
      }
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, args.ignoreCase === true ? 'i' : '');
      } catch (e) {
        return fail(`Invalid regular expression ${JSON.stringify(args.pattern)}: ${errMsg(e)}`);
      }

      const raw = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
      const root = resolveInWorkspace(ctx.workspaceRoot, raw);
      if (!existsSync(root)) return fail(`Path does not exist: ${raw}`);
      if (!statSync(root).isDirectory()) return fail(`Not a directory: ${raw}`);

      const include = typeof args.include === 'string' ? args.include : '';
      const exclude = typeof args.exclude === 'string' ? args.exclude : '';
      const isExcluded = makeExcluder(exclude);
      const context = Math.max(0, Math.min(toInt(args.context, 0), MAX_CONTEXT));
      const limit = Math.max(1, Math.min(toInt(args.limit, MAX_GREP_MATCHES), MAX_GREP_MATCHES));

      const matches: GrepMatch[] = [];
      let scanned = 0;
      let truncated = false;

      walk(root, (full) => {
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
        const rel = toWorkspaceRelative(ctx.workspaceRoot, full);
        if (isExcluded(rel)) return true;
        if (include && !globMatches(include, rel)) return true;

        let st;
        try {
          st = statSync(full);
        } catch {
          return true;
        }
        if (st.size > MAX_GREP_FILE_BYTES) return true;

        let buf: Buffer;
        try {
          buf = readFileSync(full);
        } catch {
          return true;
        }
        if (isBinary(buf)) return true;
        scanned += 1;

        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (matches.length >= limit) {
            truncated = true;
            return false;
          }
          const line = lines[i]!;
          if (!re.test(line)) continue;

          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          const block: string[] = [];
          for (let j = from; j <= to; j += 1) {
            const marker = j === i ? ':' : '-';
            block.push(`${rel}${marker}${j + 1}${marker} ${capLine(lines[j]!)}`);
          }
          matches.push({ rel, line: i + 1, block, text: capLine(line.trim()) });
        }
        return true;
      });

      if (matches.length === 0) {
        return {
          ok: true,
          content: `No matches for /${args.pattern}/ (scanned ${scanned} files).`,
          preview: '0 matches',
          affectsPaths: [],
        };
      }

      const files = new Set(matches.map((m) => m.rel));
      if (args.filesOnly === true) {
        // A file list answers "which files mention this?" without the noise of
        // every matching line, which is the question behind most refactors.
        const listed = [...files].sort();
        const suffix = truncated ? `\n(truncated at ${limit} matches; narrow the pattern, path or include)` : '';
        return {
          ok: true,
          content: listed.join('\n') + suffix,
          preview: `${listed.length} file(s) match ${args.pattern}`,
          affectsPaths: [],
        };
      }

      // With context, hits are rendered as separated blocks; without it, the
      // usual `file:line: text` is far denser and easier to scan.
      const body =
        context > 0
          ? matches.map((m) => m.block.join('\n')).join('\n--\n')
          : matches.map((m) => `${m.rel}:${m.line}: ${m.text}`).join('\n');
      const suffix = truncated ? `\n(truncated at ${limit} matches; narrow the pattern, path or include)` : '';
      return {
        ok: true,
        content: body + suffix,
        preview: `${matches.length} match(es) in ${files.size} file(s)`,
        affectsPaths: [],
      };
    } catch (e) {
      return fail(`Tool error: ${errMsg(e)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// apply_patch - several files, one atomic change
// ---------------------------------------------------------------------------

interface StructuredEdit {
  path: string;
  find: string;
  replace: string;
}

/**
 * Parse the patch document.
 *
 * The format is deliberately small and explicit rather than a unified diff. A
 * unified diff carries line numbers and hunk offsets, and a model that miscounts
 * one of them produces a patch that either fails or - far worse - lands in the
 * wrong place. Here every edit names a literal block to find and what to put
 * there, which is the same contract `edit_file` already uses and is checkable
 * without arithmetic.
 */
export function parsePatch(text: string): { edits: StructuredEdit[]; error: string | null } {
  const edits: StructuredEdit[] = [];
  let path: string | null = null;
  let section: 'find' | 'replace' | null = null;
  let find: string[] = [];
  let replace: string[] = [];

  /** Commit the edit currently being accumulated, if it is complete. */
  const flush = (): string | null => {
    if (path === null || section === null) return null;
    if (find.length === 0) return `*** Update File: ${path} has a *** Find: block with no content.`;
    edits.push({ path, find: find.join('\n'), replace: replace.join('\n') });
    section = null;
    find = [];
    replace = [];
    return null;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('*** Begin Patch')) continue;
    if (trimmed.startsWith('*** End Patch')) break;

    if (trimmed.startsWith('*** Update File:')) {
      // A new file ends whatever edit was in progress, so the previous file's
      // last block is committed before the path changes underneath it.
      const err = flush();
      if (err) return { edits: [], error: err };
      path = trimmed.slice('*** Update File:'.length).trim();
      if (path === '') return { edits: [], error: 'A *** Update File line named no path.' };
      continue;
    }
    if (trimmed.startsWith('*** Find:')) {
      if (path === null) return { edits: [], error: '*** Find: appeared before any *** Update File:' };
      // Commit any completed edit first: a file may carry several, and dropping
      // an earlier one here would apply a patch the caller did not write.
      const err = flush();
      if (err) return { edits: [], error: err };
      section = 'find';
      continue;
    }
    if (trimmed.startsWith('*** Replace:')) {
      if (section !== 'find') return { edits: [], error: `*** Replace: in ${path ?? 'the patch'} has no matching *** Find:.` };
      section = 'replace';
      continue;
    }
    if (section === 'find') find.push(line);
    else if (section === 'replace') replace.push(line);
    else if (trimmed !== '') {
      return { edits: [], error: `Unexpected line outside any block: ${JSON.stringify(capLine(trimmed, 80))}` };
    }
  }

  const err = flush();
  if (err) return { edits: [], error: err };
  if (edits.length === 0) {
    return { edits: [], error: 'The patch contained no *** Update File: blocks.' };
  }
  return { edits, error: null };
}

const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply several exact-text edits across one or more files as a single atomic ' +
    'change. Every edit is validated first: if any block is missing or ambiguous, ' +
    'nothing is written and the report names the file and why. Prefer this over ' +
    'repeated edit_file calls when the change spans files.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          'The patch document. Format:\n' +
          '*** Begin Patch\n' +
          '*** Update File: src/a.ts\n' +
          '*** Find:\n' +
          '<exact existing text, one or more lines>\n' +
          '*** Replace:\n' +
          '<what to put there>\n' +
          '*** End Patch\n' +
          'Repeat *** Find:/*** Replace: for more edits, and *** Update File: for more files.',
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    try {
      if (typeof args.patch !== 'string' || args.patch.trim() === '') {
        return fail('apply_patch requires a non-empty "patch" string.');
      }
      const { edits, error } = parsePatch(args.patch);
      if (error !== null) return fail(`apply_patch: ${error}`, 'Malformed patch');
      if (edits.length > MAX_PATCH_FILES) {
        return fail(`apply_patch: ${edits.length} edits exceeds the limit of ${MAX_PATCH_FILES}.`);
      }

      // Phase 1: resolve and validate every edit against the files as they are
      // now. Nothing is written until the whole patch is known to apply, which
      // is the property that makes this safer than a sequence of edit_file calls.
      const planned: Array<{ rel: string; abs: string; before: string; after: string; line: number }> = [];
      const problems: string[] = [];

      for (const edit of edits) {
        let abs: string;
        try {
          abs = resolveInWorkspace(ctx.workspaceRoot, edit.path);
          assertNotGitControlPath(ctx.workspaceRoot, abs);
        } catch (e) {
          problems.push(`${edit.path}: ${errMsg(e)}`);
          continue;
        }
        const rel = toWorkspaceRelative(ctx.workspaceRoot, abs);
        if (!existsSync(abs)) {
          problems.push(`${edit.path}: file does not exist.`);
          continue;
        }
        const st = statSync(abs);
        if (st.isDirectory()) {
          problems.push(`${edit.path}: is a directory, not a file.`);
          continue;
        }
        const buf = readFileSync(abs);
        if (isBinary(buf)) {
          problems.push(`${edit.path}: looks like a binary file.`);
          continue;
        }
        const text = buf.toString('utf8');

        const count = countOccurrences(text, edit.find);
        if (count === 0) {
          problems.push(
            `${edit.path}: the *** Find: block was not found. It must match the file exactly, including indentation.`,
          );
          continue;
        }
        if (count > 1) {
          problems.push(
            `${edit.path}: the *** Find: block appears ${count} times. Include more surrounding lines so it is unique.`,
          );
          continue;
        }

        // A second edit to the same file applies to the result of the first, so
        // later Find blocks may target text an earlier one introduced.
        const existing = planned.filter((p) => p.rel === rel).pop();
        const baseText = existing ? existing.after : text;
        const baseCount = existing ? countOccurrences(baseText, edit.find) : count;
        if (existing && baseCount === 0) {
          problems.push(`${edit.path}: the *** Find: block was not found after an earlier edit to the same file.`);
          continue;
        }
        if (existing && baseCount > 1) {
          problems.push(`${edit.path}: the *** Find: block appears ${baseCount} times after an earlier edit.`);
          continue;
        }
        const index = baseText.indexOf(edit.find);
        planned.push({
          rel,
          abs,
          before: existing ? '' : text,
          after: baseText.replace(edit.find, edit.replace),
          line: baseText.slice(0, index).split('\n').length,
        });
      }

      if (problems.length > 0) {
        return fail(
          `apply_patch made no changes. ${problems.length} problem(s):\n- ${problems.join('\n- ')}`,
          'Patch did not apply',
        );
      }

      // Phase 2: collapse to the final content per file and write once each.
      const finalByFile = new Map<string, { abs: string; text: string }>();
      for (const p of planned) {
        finalByFile.set(p.rel, { abs: p.abs, text: p.after });
      }
      const written: string[] = [];
      for (const [rel, { abs, text }] of finalByFile) {
        writeFileSync(abs, text, 'utf8');
        ctx.writtenPaths.add(rel);
        written.push(rel);
      }

      const detail = planned.map((p) => `  ${p.rel}:${p.line}`).join('\n');
      return {
        ok: true,
        content: `Applied ${planned.length} edit(s) to ${written.length} file(s):\n${detail}`,
        preview: `Patched ${written.length} file(s), ${planned.length} edit(s)`,
        affectsPaths: written,
      };
    } catch (e) {
      return fail(`Tool error: ${errMsg(e)}`);
    }
  },
};

/** Count non-overlapping occurrences of a literal needle. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function createCodeTools(): Tool[] {
  return [globTool, grepTool, applyPatchTool];
}
