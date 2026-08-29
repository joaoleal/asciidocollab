import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GitCommandFailedError,
  type ConflictStageStore,
  type ConflictStages,
  type ConflictUndoSnapshot,
  type GitOperationId,
  type Result,
} from '@asciidocollab/domain';

const SNAPSHOT_FILE_NAME = 'snapshot.json';
const FILES_DIRECTORY_NAME = 'files';
const META_FILE_NAME = 'meta.json';
const BASE_FILE_NAME = 'base';
const OURS_FILE_NAME = 'ours';
const THEIRS_FILE_NAME = 'theirs';
const MERGED_FILE_NAME = 'merged';

/** The JSON shape persisted at `<root>/<operationId>/files/<key>/meta.json`. */
interface StoredFileMeta {
  readonly path: string;
  readonly isBinary: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrows a parsed `meta.json` payload to {@link StoredFileMeta}, without an unchecked cast. */
function isStoredFileMeta(value: unknown): value is StoredFileMeta {
  return isRecord(value) && typeof value.path === 'string' && typeof value.isBinary === 'boolean';
}

/**
 * Narrows a parsed `snapshot.json` payload to {@link ConflictUndoSnapshot}, without an unchecked
 * cast. `wipCommit` is OPTIONAL: present as a string on a snapshot written since the never-lose-work
 * backup ref landed, and simply ABSENT on an older snapshot (which stays valid, deserializing with
 * it undefined) — so any present-but-non-string `wipCommit` is the only rejectable shape.
 */
function isConflictUndoSnapshot(value: unknown): value is ConflictUndoSnapshot {
  if (!isRecord(value) || typeof value.preOpHead !== 'string' || typeof value.branch !== 'string') return false;
  return value.wipCommit === undefined || typeof value.wipCommit === 'string';
}

/** A safe, generic failure — carries no path, operation id, or filesystem detail. */
function storeFailure(): GitCommandFailedError {
  return new GitCommandFailedError('The conflict stage store could not complete the requested operation.');
}

/** Narrows a caught value to a filesystem "no such file" error. */
function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Reads a stage file, returning null ONLY when it is genuinely absent (a null base = add/add; a null
 * ours/theirs = that side deleted the file). Any other read error propagates, so a real I/O failure
 * is never silently reinterpreted as a deletion — which would let a later resolution drop a file
 * whose content was actually present on disk.
 */
async function readStageFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

/**
 * Encodes a conflicting file's workspace-relative path into a filesystem-safe, reversible
 * directory name: no `/`, no `.`/`..` segment, so the encoded name itself can never escape the
 * directory it is joined under.
 */
function encodeFileKey(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

/** Reverses {@link encodeFileKey} — used only for the defensive re-validation below. */
function decodeFileKey(key: string): string {
  return Buffer.from(key, 'base64url').toString('utf8');
}

/**
 * Reports whether `relativePath` resolves to a location inside `root` once joined to it — the
 * same escape check the git-worker adapter already applies to a commit/merge/checkout flush path
 * (`staysInsideWorkingTree`), applied here to a conflicting file's path as a defensive
 * re-validation of the decoded {@link encodeFileKey} round-trip, even though the encoded key
 * itself (no `/`, no `..`) cannot escape by construction.
 */
function staysInside(root: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const resolved = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, resolved);
  return !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
}

/**
 * Filesystem-backed `ConflictStageStore`: one directory per operation under a configured root,
 * one subdirectory per conflicting file keyed by a reversible, slash-free encoding of its path.
 * The on-disk layout is diagrammed below.
 *
 * ```
 * <root>/<operationId>/
 *   snapshot.json                       # { preOpHead, branch, wipCommit? } — undo target
 *   files/<base64url(path)>/
 *     meta.json                         # { path, isBinary } — path is authoritative for reads
 *     base                              # absent when the file had no merge base (add/add)
 *     ours                              # absent when "ours" deleted the file (modify/delete)
 *     theirs                            # absent when "theirs" deleted the file (modify/delete)
 *     merged                            # present only after a 'merged' resolution is recorded
 * ```
 *
 * The caller (composition root) MUST root this store OUTSIDE every project's working tree — see
 * the port's class docs for why.
 */
export class FilesystemConflictStageStore implements ConflictStageStore {
  /** @param root - The configured root directory this store's per-operation directories live under. */
  constructor(private readonly root: string) {}

  private operationDirectory(operationId: GitOperationId): string {
    return path.join(this.root, operationId.value);
  }

  /**
   * Resolves one conflicting file's directory: encodes `relativePath` into its on-disk key, then
   * decodes that key straight back and re-validates the decoded path with {@link staysInside} —
   * defensive re-validation of the round trip, even though the encoded key itself (no `/`, no
   * `..`) cannot escape `root` by construction. Returns null when that re-validation fails.
   */
  private fileDirectory(operationId: GitOperationId, relativePath: string): string | null {
    const key = encodeFileKey(relativePath);
    const decodedPath = decodeFileKey(key);
    if (!staysInside(this.root, decodedPath)) return null;
    return path.join(this.operationDirectory(operationId), FILES_DIRECTORY_NAME, key);
  }

  /** Records the pre-operation head/branch as `<root>/<operationId>/snapshot.json`. */
  async writeSnapshot(
    operationId: GitOperationId,
    snapshot: ConflictUndoSnapshot,
  ): Promise<Result<void, GitCommandFailedError>> {
    try {
      const directory = this.operationDirectory(operationId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, SNAPSHOT_FILE_NAME), JSON.stringify(snapshot), 'utf8');
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Writes one conflicting file's captured base/ours/theirs bytes and `meta.json` classification. */
  async writeStages(
    operationId: GitOperationId,
    filePath: string,
    stages: ConflictStages,
  ): Promise<Result<void, GitCommandFailedError>> {
    const directory = this.fileDirectory(operationId, filePath);
    if (!directory) return { success: false, error: storeFailure() };

    try {
      await mkdir(directory, { recursive: true });
      const meta: StoredFileMeta = { path: filePath, isBinary: stages.isBinary };
      await writeFile(path.join(directory, META_FILE_NAME), JSON.stringify(meta), 'utf8');
      // A null side (base absent = add/add; ours/theirs absent = that side deleted the file in a
      // modify/delete conflict) is persisted by writing NO file for it, exactly as a null base is —
      // so absence (null) round-trips back distinctly from a real empty-ish payload (`''`).
      if (stages.base !== null) {
        await writeFile(path.join(directory, BASE_FILE_NAME), stages.base);
      }
      if (stages.ours !== null) {
        await writeFile(path.join(directory, OURS_FILE_NAME), stages.ours);
      }
      if (stages.theirs !== null) {
        await writeFile(path.join(directory, THEIRS_FILE_NAME), stages.theirs);
      }
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Writes the user-edited merged bytes recorded for a `merged` resolution of one file. */
  async writeMerged(
    operationId: GitOperationId,
    filePath: string,
    content: Buffer,
  ): Promise<Result<void, GitCommandFailedError>> {
    const directory = this.fileDirectory(operationId, filePath);
    if (!directory) return { success: false, error: storeFailure() };

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, MERGED_FILE_NAME), content);
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Reads back one file's captured stages, validating the parsed `meta.json` shape. */
  async readStages(
    operationId: GitOperationId,
    filePath: string,
  ): Promise<Result<ConflictStages | null, GitCommandFailedError>> {
    const directory = this.fileDirectory(operationId, filePath);
    if (!directory) return { success: false, error: storeFailure() };

    try {
      const metaRaw = await readFile(path.join(directory, META_FILE_NAME), 'utf8').catch(() => null);
      if (metaRaw === null) return { success: true, value: null };
      const parsedMeta: unknown = JSON.parse(metaRaw);
      if (!isStoredFileMeta(parsedMeta)) return { success: false, error: storeFailure() };
      const meta = parsedMeta;

      const base = await readStageFileIfPresent(path.join(directory, BASE_FILE_NAME));
      const ours = await readStageFileIfPresent(path.join(directory, OURS_FILE_NAME));
      const theirs = await readStageFileIfPresent(path.join(directory, THEIRS_FILE_NAME));

      return { success: true, value: { base, ours, theirs, isBinary: meta.isBinary } };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Reads the merged bytes recorded for a `merged` resolution of one file, if any were written. */
  async readMerged(operationId: GitOperationId, filePath: string): Promise<Result<Buffer | null, GitCommandFailedError>> {
    const directory = this.fileDirectory(operationId, filePath);
    if (!directory) return { success: false, error: storeFailure() };

    try {
      const merged = await readFile(path.join(directory, MERGED_FILE_NAME)).catch(() => null);
      return { success: true, value: merged };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Reads the undo snapshot recorded for an operation, validating the parsed shape. */
  async readSnapshot(operationId: GitOperationId): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>> {
    try {
      const raw = await readFile(path.join(this.operationDirectory(operationId), SNAPSHOT_FILE_NAME), 'utf8').catch(
        () => null,
      );
      if (raw === null) return { success: true, value: null };
      const parsed: unknown = JSON.parse(raw);
      if (!isConflictUndoSnapshot(parsed)) return { success: false, error: storeFailure() };
      return { success: true, value: parsed };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }

  /** Removes everything recorded for an operation — its snapshot and every captured/merged file. */
  async clear(operationId: GitOperationId): Promise<Result<void, GitCommandFailedError>> {
    try {
      await rm(this.operationDirectory(operationId), { recursive: true, force: true });
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: storeFailure() };
    }
  }
}
