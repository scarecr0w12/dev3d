/**
 * Workspace path confinement.
 *
 * Every filesystem/shell tool funnels its target path through
 * `resolveInWorkspace`, which is the single choke point that guarantees an
 * employee cannot touch anything outside the workspace root - not via `..`,
 * not via an absolute path, and not via Windows drive-relative tricks such as
 * `C:foo` or `D:bar`.
 */

import { relative, resolve } from 'node:path';

/** Matches a Windows drive-relative path like `C:foo` (drive + colon + non-separator). */
const DRIVE_RELATIVE_RE = /^[A-Za-z]:[^\\/]/;

/** Lowercased, forward-slashed form used for case-insensitive containment checks. */
function key(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Resolve `candidate` against `workspaceRoot`, normalise it, and throw if the
 * result escapes the root. Comparison is case-insensitive so `C:\` and `c:\`
 * are treated as the same location on Windows.
 */
export function resolveInWorkspace(workspaceRoot: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new Error('Path argument must be a non-empty string.');
  }
  if (DRIVE_RELATIVE_RE.test(candidate)) {
    throw new Error(
      `Refusing drive-relative path ${JSON.stringify(candidate)}: it is not confined to the workspace.`,
    );
  }

  const root = resolve(workspaceRoot);
  const full = resolve(root, candidate);

  const rootKey = key(root);
  const fullKey = key(full);
  const boundary = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  if (fullKey !== rootKey && !fullKey.startsWith(boundary)) {
    throw new Error(
      `Refusing path ${JSON.stringify(candidate)}: it escapes the workspace root ${JSON.stringify(root)}.`,
    );
  }
  return full;
}

/**
 * Convert an absolute path inside the workspace to a workspace-relative path
 * with forward slashes (e.g. `docs/plan.md`). Used for `affectsPaths` and
 * `writtenPaths`, which must stay cross-platform and UI-safe.
 */
export function toWorkspaceRelative(workspaceRoot: string, absolute: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(absolute));
  const forward = rel.replace(/\\/g, '/');
  if (forward === '' || forward === '.') return '.';
  return forward;
}
