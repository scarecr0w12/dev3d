/**
 * The Node surface the verification harness uses.
 *
 * `@types/node` is not a dependency of `apps/web` — the browser app has no
 * business needing it — so the harness's `import ... from 'node:fs'` had no types
 * and `.verify/tsconfig.json` could never typecheck it. Rather than add the whole
 * Node type package to a browser project, this declares exactly the handful of
 * functions the harness calls. If it needs more, add them here deliberately: the
 * narrowness is the point, and it keeps the check honest about what it depends on.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

/**
 * `import.meta.url`, which `cssContrast.ts` uses to locate the stylesheet.
 *
 * The verify project compiles as ESNext, so `import.meta` exists at runtime and
 * `lib` already gives it a type — but this keeps the declaration explicit next to
 * the module shims rather than depending on which lib is configured.
 */
interface ImportMeta {
  readonly url: string;
}
