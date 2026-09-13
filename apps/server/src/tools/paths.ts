/**
 * Workspace path confinement.
 *
 * Every filesystem/shell tool funnels its target path through
 * `resolveInWorkspace`, which is the single choke point that guarantees an
 * employee cannot touch anything outside the workspace root - not via `..`,
 * not via an absolute path, and not via Windows drive-relative tricks such as
 * `C:foo` or `D:bar`.
 *
 * ## Two checks, not one
 *
 * The first check is **lexical**: normalise the path and compare it to the root.
 * That catches `..`, absolute paths, and drive-relative spellings without
 * touching the filesystem, which matters because the target often does not exist
 * yet.
 *
 * The second check is **filesystem-real**, and it is not optional. A purely
 * lexical check is defeated by a symlink, a Windows directory junction, or any
 * other reparse point: `link/secret.txt` normalises to `<root>/link/secret.txt`,
 * which starts with the root, and then `node:fs` follows the link and reads a
 * file outside the workspace. Junctions are not exotic - a pnpm `node_modules`
 * is largely made of them - so this was reachable in an ordinary checkout, with
 * no attacker and no approval prompt.
 *
 * The real check therefore:
 *
 *   1. resolves the root's canonical path (`realpath`), so a workspace root that
 *      is itself reached through a link is compared against what it really is;
 *   2. resolves the canonical path of the **nearest existing ancestor** of the
 *      target, and re-appends the part that does not exist yet. This keeps the
 *      check honest for a file that is about to be created (whose parent may
 *      itself be a link), while still returning a usable path;
 *   3. confirms that canonical ancestor is contained by the canonical root;
 *   4. walks every component of the target that already exists and refuses the
 *      path if any of them **is a reparse point**, even one that points back
 *      inside the root. This is the belt to (3)'s braces: it is what stops a link
 *      being followed at all, so "the link appears between the check and the
 *      use" stops being a meaningful attack.
 *
 * The **lexical** path is what gets returned, deliberately. Returning the
 * canonical one would rewrite `C:\Users\...` to `\\?\C:\Users\...` on Windows and
 * would turn existing path round-trip tests into different strings; the security
 * property comes from refusing the path, not from changing the one that is
 * allowed through.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { parse, relative, resolve, sep } from 'node:path';

/** Matches a Windows drive-relative path like `C:foo` (drive + colon + non-separator). */
const DRIVE_RELATIVE_RE = /^[A-Za-z]:[^\\/]/;

/**
 * Names Windows maps to a device rather than to a file, with or without an
 * extension and with trailing dots or spaces stripped.
 *
 * `write_file('NUL')` "succeeds" while writing nothing, and `NUL` definitely is
 * the device through `run_shell`'s `cmd.exe`, so "wrote a file" becomes a lie and
 * `writtenPaths` records a path no later tool can read back. `sub\COM1` and
 * `CON\log.txt` are the same device reached through a directory, so **every**
 * component is checked rather than only the last one.
 */
const RESERVED_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i;

/** Whether a single path component names a Windows device. */
export function isReservedDeviceName(component: string): boolean {
  // Windows strips trailing spaces and dots before resolving a name, so `NUL ` and
  // `NUL.` reach the same device as `NUL`.
  return RESERVED_DEVICE_RE.test(component.replace(/[ .]+$/, ''));
}

/**
 * Lowercased, forward-slashed form used for the *lexical* pre-check.
 *
 * Deliberately case-insensitive: it runs before any filesystem call, where the
 * real spelling of the root is not yet known, and refusing `C:\WS\a.txt` because
 * the configured root was spelled `C:\ws` would be a new bug in place of an old
 * one. The canonical check below is the exact one.
 */
function key(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Whether `candidate` is `root` itself or sits beneath it. Both must be absolute. */
function contains(root: string, candidate: string): boolean {
  const rootKey = key(root);
  const candidateKey = key(candidate);
  if (candidateKey === rootKey) return true;
  const boundary = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  return candidateKey.startsWith(boundary);
}

/**
 * Whether `candidate` is `root` itself or genuinely beneath it — **exactly**.
 *
 * Three properties, and the previous implementation did not have all three:
 *
 *  - **Boundary-aware.** `candidate.startsWith(root)` reports
 *    `C:\plugins\foo-evil\x.js` as inside `C:\plugins\foo`. The separator is part
 *    of the test here.
 *  - **Case-exact.** Lowercasing both sides is right on an ordinary Windows
 *    volume and wrong on NTFS with per-directory case sensitivity enabled
 *    (`fsutil file setCaseSensitiveInfo`), where `C:\WS` and `C:\ws` are two
 *    different directories. Callers pass *canonical* spellings — what
 *    `realpath` returns — so a lowercase copy would throw away the only
 *    information that can tell those two apart.
 *  - **Not a string prefix**, so a sibling sharing a prefix is outside.
 *
 * Because it is case-exact, both arguments should come from the same source: the
 * filesystem (`realpath`) where possible, or the caller's own spelling.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  if (candidateAbs === rootAbs) return true;
  const boundary = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`;
  return candidateAbs.startsWith(boundary);
}

/**
 * The real spelling of `p`, or `null` if the filesystem will not say.
 *
 * `realpathSync.native` is preferred where it exists: it asks the operating
 * system for the on-disk spelling rather than reconstructing one, which is what
 * makes the case-exact comparison above meaningful. Node's JavaScript
 * implementation is the fallback.
 */
function realSpelling(p: string): string | null {
  const native = (realpathSync as { native?: (path: string) => string }).native;
  const attempts = native === undefined ? [realpathSync] : [native, realpathSync];
  for (const attempt of attempts) {
    try {
      return attempt(p);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * The canonical form of `p`, or of its nearest existing ancestor with the
 * non-existent remainder re-appended.
 *
 * Needed because a write target usually does not exist yet: `realpath` throws on
 * a missing path, but the directory about to hold it may still be a link, and
 * that is exactly the case worth catching.
 *
 * Walks up one component at a time and stops as soon as an ancestor exists -
 * including the filesystem root, which always does. If `p` itself exists this is
 * just `realpathSync(p)`.
 */
function canonicalAllowMissing(p: string): string {
  const absolute = resolve(p);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    const real = realSpelling(current);
    if (real !== null) return missing.length === 0 ? real : resolve(real, ...missing);
    const parent = resolve(current, '..');
    const leaf = current.slice(parent.length).replace(/^[\\/]+/, '');
    // `parent === current` means we are at the filesystem root; a root that
    // cannot be resolved leaves nothing further to try.
    if (parent === current || leaf === '') return absolute;
    missing.unshift(leaf);
    current = parent;
  }
}

/**
 * Refuse if any component of `full` that exists is a reparse point (symlink,
 * junction, mount point).
 *
 * Walks from the root down, so a link anywhere along the way - not just the last
 * component - is caught. `lstatSync` is the only correct call here: `statSync`
 * follows the link, which is the bug this whole module exists to avoid.
 *
 * `what` names the directory being protected, because the same rule guards two of
 * them: a run's workspace, and a plugin's own directory. A *path* that is inside
 * its directory proves nothing when a component of it is a link to somewhere
 * else, and that is the case a string comparison cannot see.
 */
export function assertNoReparsePoint(root: string, full: string, what = 'the workspace'): void {
  const rel = relative(root, full);
  if (rel === '' || rel === '.') return;

  const parts = rel.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      // Does not exist yet, so nothing to follow. Any later component is also
      // absent by definition.
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing path ${JSON.stringify(full)}: "${part}" is a symbolic link or junction, ` +
          `and following it could leave ${what}. Refer to the real path instead.`,
      );
    }
  }
}

/**
 * Resolve `candidate` against `workspaceRoot`, normalise it, and throw if the
 * result escapes the root - lexically *or* through a link. Comparison is
 * case-insensitive so `C:\` and `c:\` are treated as the same location on
 * Windows.
 */
export function resolveInWorkspace(workspaceRoot: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new Error('Path argument must be a non-empty string.');
  }
  if (candidate.includes('\0')) {
    throw new Error('Path argument must not contain a NUL byte.');
  }
  if (DRIVE_RELATIVE_RE.test(candidate)) {
    throw new Error(
      `Refusing drive-relative path ${JSON.stringify(candidate)}: it is not confined to the workspace.`,
    );
  }
  // NTFS alternate data streams. `a.txt:hidden` writes a stream beside the visible
  // file: it survives inside the workspace (so it is not an escape), but
  // `readdirSync` does not list it and `glob`/`grep`/`list_dir` cannot see it — so
  // it is a place to stash content that the operator's own inspection tools will
  // never show, and it makes `affectsPaths` disagree with the tree the operator
  // can see. `a.txt::$DATA` is the default-stream spelling of the same trick.
  //
  // Scoped to the part *after* any volume prefix, because `C:` is a legitimate
  // colon: `parse().root` is what Windows itself considers the volume, so anything
  // left containing a colon is a stream rather than a drive.
  const volumeRoot = parse(candidate).root;
  const withoutVolume = volumeRoot === '' ? candidate : candidate.slice(volumeRoot.length);
  if (withoutVolume.includes(':')) {
    throw new Error(
      `Refusing path ${JSON.stringify(candidate)}: ":" names an NTFS alternate data stream, ` +
        'which is invisible to the directory tools and would not appear in what the run recorded writing.',
    );
  }

  const root = resolve(workspaceRoot);
  const full = resolve(root, candidate);

  // 0. No component may name a Windows device. Checked before the containment
  //    rules because it is not about escaping the workspace: `NUL` is inside it,
  //    and writing to it silently discards the write while `writtenPaths` records
  //    a file that no later tool can read.
  for (const part of full.split(/[\\/]/)) {
    if (part !== '' && isReservedDeviceName(part)) {
      throw new Error(
        `Refusing path ${JSON.stringify(candidate)}: "${part}" is a reserved Windows device name, ` +
          'not a file, so writing to it would not create anything.',
      );
    }
  }

  // 1. Lexical containment. Cheap, and the only check that works for a
  //    non-existent path on a filesystem we cannot resolve.
  if (!contains(root, full)) {
    throw new Error(
      `Refusing path ${JSON.stringify(candidate)}: it escapes the workspace root ${JSON.stringify(root)}.`,
    );
  }

  // 2. Canonical containment: does the path really land inside the real root?
  //    A root reached through a link is compared as its real self, and the
  //    comparison is case-exact because `C:\WS` and `C:\ws` can be two different
  //    directories on a case-sensitive NTFS tree.
  const rootReal = realSpelling(root);
  if (rootReal !== null) {
    const fullReal = canonicalAllowMissing(full);
    if (!isPathInside(rootReal, fullReal)) {
      throw new Error(
        `Refusing path ${JSON.stringify(candidate)}: it resolves outside the workspace root ` +
          `${JSON.stringify(root)} (to ${JSON.stringify(fullReal)}).`,
      );
    }
  }

  // 3. No reparse point on the way, even one that points back inside.
  assertNoReparsePoint(root, full);

  return full;
}

/**
 * Convert an absolute path inside the workspace to a workspace-relative path
 * with forward slashes (e.g. `docs/plan.md`). Used for `affectsPaths` and
 * `writtenPaths`, which must stay cross-platform and UI-safe.
 *
 * Throws for a path outside the root. It used to return `../...` instead, which
 * made every caller's "refuse anything outside" guard dead code and let an
 * outside path be recorded as something the run wrote.
 */
export function toWorkspaceRelative(workspaceRoot: string, absolute: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(absolute);
  if (!contains(root, target)) {
    throw new Error(
      `Refusing to describe ${JSON.stringify(absolute)} as workspace-relative: ` +
        `it is outside ${JSON.stringify(root)}.`,
    );
  }
  const rel = relative(root, target);
  const forward = rel.replace(/\\/g, '/');
  if (forward === '' || forward === '.') return '.';
  return forward;
}

/** Path segments that hold the repository's own control files. */
const GIT_DIR_SEGMENT = '.git';

/**
 * Refuse a **write** target that lives under a `.git` directory.
 *
 * `.git` is inside the workspace, so it passes containment, and the directory
 * walks skip it (`match.ts` `SKIPPED_DIRS`) while the *write* paths never did.
 * That gap was exploitable in a way the approval gate could not see:
 *
 *   1. `write_file('.git/hooks/pre-commit', '…')` — no approval, by design,
 *      because writing a file in your own workspace normally needs none;
 *   2. `git commit -m "save work"` — a human approves it, and the prompt shows
 *      only `git commit -m save work`;
 *   3. the planted hook runs, with the process environment — which
 *      `config.ts` has already loaded every provider key into.
 *
 * So an approval for an innocuous-looking commit silently became an approval for
 * arbitrary code. The same door opens `.git/config`, and through it
 * `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.fsmonitor` and
 * `alias.*`.
 *
 * The git tool refuses `--no-verify` precisely to keep hooks meaningful; this is
 * the other half of that promise. Reading `.git` is still allowed — it is how an
 * employee inspects a repository — and `git` itself remains available for the
 * things it is for.
 */
export function assertNotGitControlPath(workspaceRoot: string, absolute: string): void {
  const root = resolve(workspaceRoot);
  const rel = relative(root, resolve(absolute));
  if (rel === '' || rel === '.') return;
  const segments = rel.split(/[\\/]/);
  if (segments.includes(GIT_DIR_SEGMENT)) {
    throw new Error(
      `Refusing to write ${JSON.stringify(relative(root, resolve(absolute)).replace(/\\/g, '/'))}: ` +
        'it is inside the repository\u2019s .git directory, where a file can change what a later, ' +
        'separately-approved git command does. Use the git tool for repository changes.',
    );
  }
}
