/**
 * @file Maps a {@link ProjectSnapshot} into the in-memory `/project` VFS tree the Ruby VM sees, and
 * reads the produced PDF back out of `/out`. It programs against a narrow, injected write/read port
 * (a subset of the WASI bridge) so it stays unit-testable with an in-memory fake and never pulls the
 * real interop libraries into the graph.
 *
 * Every snapshot key is expected to have already passed the project's sandbox path resolver. This
 * module re-validates each one as defense in depth: a residual traversal, absolute, remote-looking,
 * or NUL-bearing path is rejected (never silently normalized) and surfaced as data rather than thrown
 * across the worker boundary.
 */

import type { ProjectSnapshot } from '../protocol';

/**
 * The narrow VFS surface population depends on — a structural subset of the typed WASI bridge. Kept
 * minimal so tests can supply an in-memory fake and production can pass the real bridge unchanged.
 */
export interface VfsWritePort {
  /**
   * Write bytes to an absolute path under a writable mount, creating parent dirs.
   *
   * @param path - The absolute mount path to write to.
   * @param data - The bytes to store at that path.
   */
  writeFile(path: string, data: Uint8Array): void;
  /**
   * Read bytes from an absolute path under a writable mount.
   *
   * @param path - The absolute mount path to read.
   * @returns The bytes currently stored at that path.
   */
  readFile(path: string): Uint8Array;
  /**
   * List the immediate entry names of a directory under a writable mount.
   *
   * @param path - The absolute directory path to enumerate.
   * @returns The immediate child entry names, without their parent path.
   */
  readdir(path: string): string[];
  /**
   * Remove a file if present (no-op when absent).
   *
   * @param path - The absolute mount path to delete.
   */
  removeFile(path: string): void;
  /**
   * Whether a file or directory exists at the given absolute path.
   *
   * @param path - The absolute mount path to probe.
   * @returns True when a file or directory is present at that path.
   */
  exists(path: string): boolean;
}

/** The writable, in-memory mount that holds the project sources the VM converts. */
export const PROJECT_ROOT = '/project';
/** The writable, in-memory mount that holds the produced PDF, cleared per render. */
export const OUT_ROOT = '/out';

/**
 * VFS path where the include-resolve stage writes the assembly line→source provenance for PREVIEW renders
 * (a JSON array: index `i` is the origin `{ path, sourceLine }` of assembled line `i + 1`). The render-time
 * source-map hook reads it to stamp each block's exact source location onto its map entry. Written as `[]`
 * for exports so a warm VM never leaks a prior preview's provenance into an export.
 */
export const SOURCE_PROVENANCE_PATH = `${PROJECT_ROOT}/.asciidocollab-source-provenance.json`;

const PATH_SEPARATOR = '/';
const TRAVERSAL_SEGMENT = '..';
const NUL_CHARACTER = '\u0000';
/** A leading `scheme://` marks a remote target that must never reach the VFS. */
const REMOTE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The reasons a snapshot key can be rejected during population. */
export const PATH_REJECTION_REASONS = ['empty', 'nul', 'remote', 'absolute', 'traversal'] as const;

/** Why a snapshot key was refused entry into `/project`. */
export type PathRejectionReason = (typeof PATH_REJECTION_REASONS)[number];

/** Which part of the snapshot a rejected key came from. */
export type RejectedPathKind = 'text' | 'binary' | 'root';

/** A snapshot key that failed defense-in-depth validation and was not written. */
export interface RejectedPath {
  /** The offending project-relative key, verbatim. */
  readonly path: string;
  /** Why it was refused. */
  readonly reason: PathRejectionReason;
  /** The snapshot section it came from. */
  readonly kind: RejectedPathKind;
}

/** The outcome of populating `/project` from a snapshot. */
export interface PopulateResult {
  /** Absolute `/project` paths that were written, in encounter order. */
  readonly written: readonly string[];
  /** Keys rejected by validation, in encounter order; none of these were written. */
  readonly rejected: readonly RejectedPath[];
  /** Whether the snapshot's root document exists under `/project` after population. */
  readonly rootPresent: boolean;
}

/** Options controlling how a snapshot is mapped into `/project`. */
export interface PopulateOptions {
  /**
   * Warm re-render delta: when present, only these keys are rewritten under `/project`; every other
   * file already in the VFS is left in place. Keys absent from the snapshot are ignored.
   */
  readonly changedPaths?: readonly string[];
}

/**
 * Validate a project-relative snapshot key. Returns the rejection reason, or `null` when the key is a
 * safe, project-confined relative path.
 */
function rejectionReason(path: string): PathRejectionReason | null {
  if (path.trim().length === 0) {
    return 'empty';
  }
  if (path.includes(NUL_CHARACTER)) {
    return 'nul';
  }
  if (REMOTE_SCHEME_PATTERN.test(path)) {
    return 'remote';
  }
  if (path.startsWith(PATH_SEPARATOR)) {
    return 'absolute';
  }
  const segments = path.split(PATH_SEPARATOR);
  if (segments.includes(TRAVERSAL_SEGMENT)) {
    return 'traversal';
  }
  return null;
}

/** Join a validated project-relative key onto the `/project` mount root. */
function projectPath(relativePath: string): string {
  return `${PROJECT_ROOT}${PATH_SEPARATOR}${relativePath}`;
}

const textEncoder = new TextEncoder();

/**
 * Map a {@link ProjectSnapshot} (text `files` + `binaryAssets` bytes) into the `/project` VFS tree.
 *
 * In cold mode every snapshot key is written; in delta mode (`options.changedPaths`) only the listed
 * keys are rewritten and untouched files stay in place. A delta requested against a VFS that does not
 * already hold the project is upgraded to a full population — see the check in the body. Each key is
 * re-validated as defense in depth: traversal/absolute/remote/NUL keys are rejected and reported
 * rather than written or thrown.
 */
export function populateProject(
  port: VfsWritePort,
  snapshot: ProjectSnapshot,
  options: PopulateOptions = {},
): PopulateResult {
  // A delta is only meaningful against a VFS that still holds the previous population. It does not
  // when the render is running in a VM instance that was booted for it — the instance carries a fresh,
  // empty filesystem, so writing only the changed files would leave the document's includes, images
  // and fonts missing, and the render would either fail on a root that is not there or silently
  // produce a document with holes in it. Detected by looking for the root, which every population
  // writes: absent means nothing has been populated here yet, so everything is written.
  const vfsRetainsProject =
    rejectionReason(snapshot.rootPath) === null && port.exists(projectPath(snapshot.rootPath));
  const changed =
    options.changedPaths && vfsRetainsProject ? new Set(options.changedPaths) : null;
  const written: string[] = [];
  const rejected: RejectedPath[] = [];

  const write = (path: string, data: Uint8Array, kind: RejectedPathKind): void => {
    if (changed !== null && !changed.has(path)) {
      return;
    }
    const reason = rejectionReason(path);
    if (reason !== null) {
      rejected.push({ path, reason, kind });
      return;
    }
    const absolute = projectPath(path);
    port.writeFile(absolute, data);
    written.push(absolute);
  };

  for (const [path, content] of Object.entries(snapshot.files)) {
    write(path, textEncoder.encode(content), 'text');
  }
  for (const [path, bytes] of Object.entries(snapshot.binaryAssets)) {
    write(path, bytes, 'binary');
  }

  const rootReason = rejectionReason(snapshot.rootPath);
  if (rootReason !== null) {
    rejected.push({ path: snapshot.rootPath, reason: rootReason, kind: 'root' });
  }
  const rootPresent = rootReason === null && port.exists(projectPath(snapshot.rootPath));

  return { written, rejected, rootPresent };
}

/** Read the produced PDF bytes back from `/out/<fileName>`. */
export function readOutput(port: VfsWritePort, fileName: string): Uint8Array {
  return port.readFile(`${OUT_ROOT}${PATH_SEPARATOR}${fileName}`);
}

/** Empty the `/out` mount so the next render starts from a clean output directory. */
export function clearOutput(port: VfsWritePort): void {
  if (!port.exists(OUT_ROOT)) {
    return;
  }
  for (const name of port.readdir(OUT_ROOT)) {
    port.removeFile(`${OUT_ROOT}${PATH_SEPARATOR}${name}`);
  }
}
