/**
 * Plugin bundles: a `.tar.gz` of a plugin directory.
 *
 * dev3d has no dependencies, and it is not going to gain a zip library for this.
 * Node ships zlib, and the tar format has been stable since 1988, so the reader
 * below is written against POSIX ustar directly.
 *
 * It is written as an *untrusted* input parser: an archive that arrives from a
 * marketplace is attacker-controlled data. So absolute paths, `..`, links and
 * device nodes are refused, and there are hard caps on the number of entries and
 * the total unpacked size, because a 4 KB archive can otherwise expand into
 * gigabytes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
/** A plugin is code and a manifest; anything past this is not a plugin bundle. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2_048;

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ExtractOptions {
  maxBytes?: number;
  maxFiles?: number;
}

export interface ExtractResult {
  /** Paths written, relative to the destination, forward-slashed. */
  files: string[];
  bytes: number;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Octal fields are NUL- or space-terminated; some writers use base-256. */
function readSize(block: Buffer, offset: number): number {
  const slice = block.subarray(offset, offset + 12);
  if ((slice[0] ?? 0) & 0x80) {
    // base-256: not something a well-formed bundle needs.
    throw new BundleError('base-256 tar sizes are not supported.');
  }
  const text = readString(block, offset, 12).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new BundleError(`tar entry has an unreadable size field (${JSON.stringify(text)}).`);
  }
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Strip the leading `./` and any single wrapping directory tar writers add.
 *
 * Normalisation is POSIX, not `node:path`, on purpose. An archive path is
 * always forward-slashed, and using the platform normaliser here would rewrite
 * `/etc/passwd` into a drive-relative path on Windows - quietly turning an
 * absolute path that must be refused into one that looks relative.
 */
function cleanEntryPath(name: string): string {
  return posix.normalize(name.replace(/\\/g, '/')).replace(/^\.\//, '');
}

/**
 * Refuse anything that could write outside `destDir`. A plugin bundle is data
 * from the network; this is the boundary that keeps it from being a filesystem
 * primitive.
 */
function safeJoin(destDir: string, entryPath: string): string {
  if (entryPath === '' || entryPath === '.') throw new BundleError('archive contains an empty path.');
  if (entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) {
    throw new BundleError(`archive entry "${entryPath}" is an absolute path.`);
  }
  if (entryPath.split('/').includes('..')) {
    throw new BundleError(`archive entry "${entryPath}" escapes the plugin directory.`);
  }
  const target = resolve(destDir, entryPath);
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new BundleError(`archive entry "${entryPath}" escapes the plugin directory.`);
  }
  return target;
}

/**
 * Unpack a `.tar.gz` into `destDir`. Returns the files written, so the caller can
 * find the manifest.
 */
export function extractTarGz(archive: Buffer, destDir: string, options: ExtractOptions = {}): ExtractResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    throw new BundleError(`the bundle is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files: string[] = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const typeFlag = readString(header, 156, 1) || '0';
    const size = readSize(header, 124);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;

    if (typeFlag === 'L' || typeFlag === 'K') {
      // GNU long-name extension: rare, and refusing it is safer than guessing.
      throw new BundleError('GNU long-name tar extensions are not supported; repack with ustar names.');
    }
    if (typeFlag === '1' || typeFlag === '2') {
      throw new BundleError(`archive entry "${fullName}" is a link, which bundles may not contain.`);
    }
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '5') {
      throw new BundleError(`archive entry "${fullName}" has unsupported type "${typeFlag}".`);
    }

    const entryPath = cleanEntryPath(fullName);
    const target = safeJoin(destDir, entryPath);

    if (typeFlag === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }

    totalBytes += size;
    if (totalBytes > maxBytes) {
      throw new BundleError(`the bundle expands past the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }
    files.push(entryPath);
    if (files.length > maxFiles) {
      throw new BundleError(`the bundle contains more than ${maxFiles} files.`);
    }

    if (offset + size > tar.length) {
      throw new BundleError(`archive entry "${entryPath}" is truncated.`);
    }
    const body = tar.subarray(offset, offset + size);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    // Entry data is padded to the next 512-byte boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  if (files.length === 0) throw new BundleError('the bundle contained no files.');
  return { files, bytes: totalBytes };
}

/**
 * Where the manifest actually lives inside an unpacked bundle.
 *
 * Marketplaces package both ways: `plugin.json` at the archive root, or one
 * wrapping directory (as `tar czf x.tar.gz my-plugin/` produces). Both are
 * accepted; anything deeper is not, because then the bundle is not a plugin.
 */
export function findPluginRoot(destDir: string, manifestName = 'plugin.json'): string | null {
  if (existsSync(join(destDir, manifestName))) return destDir;

  // The other common shape is one wrapping directory, which is what
  // `tar czf bundle.tar.gz my-plugin/` produces.
  let entries;
  try {
    entries = readdirSync(destDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  const only = directories[0];
  if (directories.length === 1 && only !== undefined) {
    const nested = join(destDir, only.name);
    if (existsSync(join(nested, manifestName))) return nested;
  }
  return null;
}
