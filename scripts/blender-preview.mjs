/**
 * Render the block kit contact sheet, wherever Blender happens to be installed.
 *
 * `blender` is not on PATH after a default Windows install, and custom install
 * directories are not uniform across machines, so the binary is resolved here in
 * one place instead of being pinned in `package.json`:
 *
 *   1. `DEV3D_BLENDER`      - full path to the executable.
 *   2. `DEV3D_BLENDER_DIR`  - the directory holding it.
 *   3. `blender` on PATH    - the normal case on macOS and Linux, and on Windows
 *                             when the installer's optional PATH entry was taken.
 *   4. Default install locations only, newest release first.
 *
 * The resolution logic is exported and free of side effects so it can be tested
 * without a Blender present; building the argument list is separated for the
 * same reason.
 *
 * Blender runs with stdio inherited rather than captured: it is chatty, its
 * output is worth seeing, and capturing a child's output through a pipe is the
 * one thing a confined sandbox refuses.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HELP = [
  'Could not find Blender.',
  '',
  'Point at your install in one of these ways:',
  '',
  '  DEV3D_BLENDER      full path to the executable',
  '  DEV3D_BLENDER_DIR  the directory containing it',
  '',
  'For example:',
  '  $env:DEV3D_BLENDER = "D:\\Blender\\blender.exe"                # PowerShell',
  '  export DEV3D_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender',
].join('\n');

/** The executable's name on this platform. */
export function blenderExeName(platform = process.platform) {
  return platform === 'win32' ? 'blender.exe' : 'blender';
}

/** True when a bare `blender` can be run, letting the OS search PATH for it. */
export function onPath() {
  const result = spawnSync('blender', ['--version'], { stdio: 'ignore', shell: false });
  return result.error === undefined && result.status === 0;
}

/**
 * Where Blender installs itself when the installer is left on its defaults.
 *
 * Only default locations are guessed. A custom install is not searched for:
 * sweeping a filesystem for an executable is slow and surprising, so the two
 * environment overrides above are the way to point at one.
 */
export function defaultCandidates(env = process.env, platform = process.platform) {
  const exe = blenderExeName(platform);
  const found = [];

  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    ].filter(Boolean);
    for (const root of roots) {
      const base = path.join(root, 'Blender Foundation');
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        // Install directories are named for the release: "Blender 4.2".
        const candidate = path.join(base, entry, exe);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  } else if (platform === 'darwin') {
    // The .app bundle, which is what a macOS install produces.
    const apps = ['/Applications/Blender.app', env.HOME && path.join(env.HOME, 'Applications/Blender.app')];
    for (const app of apps.filter(Boolean)) {
      const candidate = path.join(app, 'Contents', 'MacOS', 'Blender');
      if (existsSync(candidate)) found.push(candidate);
    }
  }

  // "Blender 4.10" must not sort below "Blender 4.9", so compare numerically.
  return found.sort((a, b) => versionOf(b) - versionOf(a));
}

/** A comparable number from a path naming a release, for ordering candidates. */
export function versionOf(exe) {
  const match = /Blender[^\d]*(\d+(?:\.\d+)*)/i.exec(exe);
  if (match === null) return 0;
  return match[1].split('.').reduce((acc, part) => acc * 100 + Number(part), 0);
}

/**
 * The Blender to run, or a reason there isn't one.
 *
 * `spawnSync` is injected so the PATH probe can be stubbed in a test; every
 * other input is an explicit argument, which keeps this a decision rather than a
 * set of environment reads buried in a function body.
 */
export function resolveBlender({
  env = process.env,
  platform = process.platform,
  probe = onPath,
  candidates = defaultCandidates,
} = {}) {
  const explicit = env.DEV3D_BLENDER;
  if (explicit) {
    if (!existsSync(explicit)) {
      return { error: `DEV3D_BLENDER points at "${explicit}", which does not exist.\n\n${HELP}` };
    }
    return { blender: explicit };
  }

  const dir = env.DEV3D_BLENDER_DIR;
  if (dir) {
    const candidate = path.join(dir, blenderExeName(platform));
    if (!existsSync(candidate)) {
      return { error: `DEV3D_BLENDER_DIR is "${dir}", which holds no ${blenderExeName(platform)}.\n\n${HELP}` };
    }
    return { blender: candidate };
  }

  if (probe()) return { blender: 'blender' };

  const found = candidates(env, platform);
  if (found.length > 0) return { blender: found[0] };

  return { error: HELP };
}

/**
 * The full Blender argument list for a render.
 *
 * Blender passes everything after a bare `--` to the script, and the render
 * script reads its own options from there, so the separator is required even
 * when there are no options.
 */
export function blenderArgs(passthrough = []) {
  const script = path.join(REPO_ROOT, 'blender', 'scripts', '04_preview_blocks.py');
  return ['--background', '--factory-startup', '--python', script, '--', ...passthrough];
}

function main() {
  const { blender, error } = resolveBlender();
  if (blender === undefined) {
    console.error(error);
    process.exit(1);
  }

  console.log(`blender: ${blender}`);
  const result = spawnSync(blender, blenderArgs(process.argv.slice(2)), { stdio: 'inherit' });

  if (result.error) {
    console.error(`Could not run Blender: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Importable without side effects, so the checks above can be tested directly.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
