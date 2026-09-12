/**
 * Glob matching for the file tools.
 *
 * Hand-rolled rather than pulled in as a dependency, because the surface is tiny
 * and the semantics have to match how the tools describe themselves to a model:
 *
 *  - `*`  matches within one path segment
 *  - `**` matches across segments
 *  - `?`  matches one character, not a separator
 *  - a pattern with no `/` is treated as matching at any depth, so `*.ts` finds
 *    `src/deep/foo.ts` and not just `foo.ts`. That is what a person means by it.
 *
 * Matching is case-insensitive, because the filesystems this runs on mostly are.
 */

/** Directories never worth walking: huge, generated, or not the user's source. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** Compile a glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'; // `**/` matches zero or more leading segments
          i += 3;
        } else {
          out += '.*'; // `**` matches across separators
          i += 2;
        }
      } else {
        out += '[^/]*'; // `*` matches within one segment
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

/**
 * Does `relPath` (forward-slashed, workspace-relative) match this glob?
 *
 * An empty glob matches everything, which is what callers want as the default
 * for "no filter was given".
 */
export function globMatches(glob: string, relPath: string): boolean {
  if (!glob) return true;
  // A glob with no path separator is treated as matching at any depth.
  const effective = glob.includes('/') ? glob : `**/${glob}`;
  return globToRegExp(effective).test(relPath);
}

/**
 * A predicate for excluding paths, built from an `exclude` glob.
 *
 * Kept separate from `globMatches` because the two are asked different
 * questions: `include` selects what to look at, `exclude` vetoes it, and an
 * exclude is checked first.
 */
export function makeExcluder(exclude: string): (relPath: string) => boolean {
  if (!exclude) return () => false;
  const re = globToRegExp(exclude.includes('/') ? exclude : `**/${exclude}`);
  return (relPath: string) => re.test(relPath);
}
