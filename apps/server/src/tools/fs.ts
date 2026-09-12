/**
 * Filesystem tools: the ones that let the office actually read, search, and
 * produce files inside the workspace.
 *
 * Every tool returns a `ToolResult` - even for bad input - so the model gets an
 * actionable message instead of a thrown exception. The only thing that throws
 * is the path-escape guard, and the `guarded` wrapper converts that to
 * `ok: false` as well.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { resolveInWorkspace, toWorkspaceRelative } from './paths.ts';
import { SKIPPED_DIRS, globMatches } from './match.ts';

const MAX_LIST_ENTRIES = 200;
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 1024 * 1024; // 1 MB
const MAX_SEARCH_FILE_BYTES = 512 * 1024; // 512 KB
const MAX_SEARCH_MATCHES = 120;
const MAX_LINE_DISPLAY = 300;
const LIST_MAX_DEPTH = 4;

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

function guarded(run: Tool['run']): Tool['run'] {
  return async (args, ctx) => {
    try {
      return await run(args, ctx);
    } catch (e) {
      return fail(`Tool error: ${errMsg(e)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

interface WalkState {
  lines: string[];
  truncated: boolean;
}

function walkDir(dir: string, prefix: string, depth: number, state: WalkState): void {
  if (state.lines.length >= MAX_LIST_ENTRIES) {
    state.truncated = true;
    return;
  }
  if (depth > LIST_MAX_DEPTH) {
    state.lines.push(`${prefix}…/`);
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.lines.push(`${prefix}(unreadable)/`);
    return;
  }
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
  for (const entry of entries) {
    if (state.lines.length >= MAX_LIST_ENTRIES) {
      state.truncated = true;
      return;
    }
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      state.lines.push(`${prefix}${entry.name}/`);
      walkDir(full, `${prefix}  `, depth + 1, state);
    } else {
      state.lines.push(`${prefix}${entry.name}`);
    }
  }
}

const listDirTool: Tool = {
  name: 'list_dir',
  description:
    'List the contents of a directory inside the workspace as a small tree. ' +
    'Directories are marked with a trailing slash. Skips node_modules and .git, ' +
    'and caps at 200 entries.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory to list. Defaults to "." (the workspace root).',
      },
    },
    additionalProperties: false,
  },
  run: guarded(async (args, ctx) => {
    const raw = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
    const target = resolveInWorkspace(ctx.workspaceRoot, raw);
    if (!existsSync(target)) return fail(`Directory does not exist: ${raw}`);
    if (!statSync(target).isDirectory()) return fail(`Not a directory: ${raw}`);
    const state: WalkState = { lines: [], truncated: false };
    walkDir(target, '', 0, state);
    let content = state.lines.join('\n');
    if (content === '') content = '(empty directory)';
    if (state.truncated) content += `\n(truncated at ${MAX_LIST_ENTRIES} entries)`;
    return { ok: true, content, preview: `Listed ${state.lines.length} entries`, affectsPaths: [] };
  }),
};

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace with 1-based line numbers. ' +
    'Shows up to 400 lines per call; use startLine/endLine to page through a longer file. ' +
    'Refuses binary files and files larger than 1 MB.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      startLine: { type: 'number', description: 'First line to show (1-based, default 1).' },
      endLine: { type: 'number', description: 'Last line to show (1-based, default startLine + 399).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  run: guarded(async (args, ctx) => {
    if (typeof args.path !== 'string' || args.path === '') {
      return fail('read_file requires a non-empty "path" string.');
    }
    const target = resolveInWorkspace(ctx.workspaceRoot, args.path);
    if (!existsSync(target)) return fail(`File does not exist: ${args.path}`);
    const st = statSync(target);
    if (st.isDirectory()) return fail(`"${args.path}" is a directory; use list_dir to see its contents.`);
    if (st.size > MAX_READ_BYTES) {
      return fail(
        `"${args.path}" is ${st.size} bytes; refusing to read files larger than 1 MB.`,
      );
    }
    const buf = readFileSync(target);
    if (isBinary(buf)) {
      return fail(`"${args.path}" looks like a binary file; refusing to read it.`);
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const total = lines.length;

    let start = toInt(args.startLine, 1);
    if (start < 1) start = 1;
    const rawEnd = args.endLine === undefined ? -1 : toInt(args.endLine, -1);
    let end = rawEnd;
    if (end !== -1 && end < start) end = start;
    if (end === -1 || end - start + 1 > MAX_READ_LINES) {
      end = Math.min(total, start + MAX_READ_LINES - 1);
    }

    const out: string[] = [];
    for (let i = start; i <= end && i <= total; i += 1) {
      out.push(`${String(i).padStart(4, ' ')}| ${lines[i - 1] ?? ''}`);
    }
    let content = out.join('\n');
    if (content === '') content = '(no lines in range)';
    if (total > end) {
      content += `\n... ${total - end} more line(s). To read further, call read_file with startLine: ${end + 1}.`;
    }
    return {
      ok: true,
      content,
      preview: `Read lines ${start}-${Math.min(end, total)} of ${args.path}`,
      affectsPaths: [],
    };
  }),
};

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

function walkFiles(dir: string, onFile: (full: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walkFiles(join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(join(dir, entry.name));
    }
  }
}

function capLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search text files under a directory for lines matching a JavaScript regular expression. ' +
    'Optionally filter files with a simple glob (`*` and `**`, e.g. `*.ts`). ' +
    'Skips node_modules, .git and files over 512 KB. Returns up to 120 matches.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to match against each line.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional `*`/`**` glob to filter file paths.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  run: guarded(async (args, ctx) => {
    if (typeof args.pattern !== 'string' || args.pattern === '') {
      return fail('search_files requires a non-empty "pattern" string.');
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      return fail(`Invalid regular expression "${args.pattern}": ${errMsg(e)}`);
    }
    const rawPath = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
    const glob = typeof args.glob === 'string' ? args.glob : '';
    const target = resolveInWorkspace(ctx.workspaceRoot, rawPath);
    if (!existsSync(target)) return fail(`Path does not exist: ${rawPath}`);
    if (!statSync(target).isDirectory()) return fail(`Not a directory: ${rawPath}`);

    const matches: string[] = [];
    let scanned = 0;
    walkFiles(target, (full) => {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      const rel = toWorkspaceRelative(ctx.workspaceRoot, full);
      if (!globMatches(glob, rel)) return;
      let st;
      try {
        st = statSync(full);
      } catch {
        return;
      }
      if (st.size > MAX_SEARCH_FILE_BYTES) return;
      let buf;
      try {
        buf = readFileSync(full);
      } catch {
        return;
      }
      if (isBinary(buf)) return;
      scanned += 1;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        const line = lines[i]!;
        if (re.test(line)) {
          matches.push(`${rel}:${i + 1}: ${capLine(line.trim(), MAX_LINE_DISPLAY)}`);
        }
      }
    });

    let content = matches.join('\n');
    if (content === '') content = `No matches for /${args.pattern}/ (scanned ${scanned} files).`;
    else if (matches.length >= MAX_SEARCH_MATCHES) content += '\n(truncated at 120 matches)';
    return { ok: true, content, preview: `${matches.length} match(es) for /${args.pattern}/`, affectsPaths: [] };
  }),
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file in the workspace, creating parent ' +
    'directories as needed. This is the tool that makes the office actually produce files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to write.' },
      content: { type: 'string', description: 'Full UTF-8 text content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  run: guarded(async (args, ctx) => {
    if (typeof args.path !== 'string' || args.path === '') {
      return fail('write_file requires a non-empty "path" string.');
    }
    if (typeof args.content !== 'string') {
      return fail('write_file requires a string "content".');
    }
    const target = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const rel = toWorkspaceRelative(ctx.workspaceRoot, target);
    mkdirSync(join(target, '..'), { recursive: true });
    const bytes = Buffer.byteLength(args.content, 'utf8');
    writeFileSync(target, args.content, 'utf8');
    ctx.writtenPaths.add(rel);
    ctx.log('debug', `write_file wrote ${rel} (${bytes} bytes)`);
    return {
      ok: true,
      content: `Wrote ${rel} (${bytes} bytes, UTF-8).`,
      preview: `Wrote ${rel} (${bytes} bytes)`,
      affectsPaths: [rel],
    };
  }),
};

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact literal string in a UTF-8 text file. Fails with a clear ' +
    'message if the oldString is absent or appears more than once (unless replaceAll ' +
    'is true) - that is the whole safety property of the tool.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to edit.' },
      oldString: { type: 'string', description: 'Exact literal text to replace.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  run: guarded(async (args, ctx) => {
    if (typeof args.path !== 'string' || args.path === '') {
      return fail('edit_file requires a non-empty "path" string.');
    }
    if (typeof args.oldString !== 'string' || args.oldString === '') {
      return fail('edit_file requires a non-empty "oldString".');
    }
    if (typeof args.newString !== 'string') {
      return fail('edit_file requires a string "newString".');
    }
    const target = resolveInWorkspace(ctx.workspaceRoot, args.path);
    if (!existsSync(target)) return fail(`File does not exist: ${args.path}`);
    const st = statSync(target);
    if (st.isDirectory()) return fail(`"${args.path}" is a directory; edit_file works on files.`);
    const buf = readFileSync(target);
    if (isBinary(buf)) return fail(`"${args.path}" looks like a binary file; refusing to edit it.`);
    const text = buf.toString('utf8');

    const count = text.split(args.oldString).length - 1;
    if (count === 0) {
      return fail(
        `edit_file: oldString was not found in ${args.path}. It must match the file exactly (no partial lines).`,
        'No match to edit',
      );
    }
    const replaceAll = args.replaceAll === true;
    if (count > 1 && !replaceAll) {
      return fail(
        `edit_file: oldString occurs ${count} times in ${args.path}. ` +
          `Provide more surrounding context to make it unique, or pass replaceAll: true to replace all ${count}.`,
        'Ambiguous match',
      );
    }

    const firstIndex = text.indexOf(args.oldString);
    const lineNumber = text.slice(0, firstIndex).split('\n').length;
    const newText = replaceAll ? text.split(args.oldString).join(args.newString) : text.replace(args.oldString, args.newString);
    writeFileSync(target, newText, 'utf8');
    const rel = toWorkspaceRelative(ctx.workspaceRoot, target);
    ctx.writtenPaths.add(rel);
    const summary = replaceAll ? `replaced ${count} occurrence(s)` : 'replaced 1 occurrence';
    return {
      ok: true,
      content: `Edited ${rel}: ${summary} at line ${lineNumber}.`,
      preview: `Edited ${rel} (${summary})`,
      affectsPaths: [rel],
    };
  }),
};

export function createFsTools(): Tool[] {
  return [listDirTool, readFileTool, searchFilesTool, writeFileTool, editFileTool];
}
