import { mkdir, readFile, writeFile, rename, rm, open, stat, link, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { ProjectFileStore } from '@asciidocollab/domain';
import { ProjectId, FilePath, FileConflictError } from '@asciidocollab/domain';
import { Result } from '@asciidocollab/domain';

/**
 * Path segments that are reserved for platform-internal metadata and must never be reachable
 * through the project file API: `.git` (working-tree metadata) and `.collab` (Yjs blob store).
 * Matched as a whole path segment only, so `.gitignore` and a folder named `mygit` are unaffected.
 */
const HIDDEN_METADATA_SEGMENTS = new Set(['.git', '.collab']);

/** Filesystem implementation of ProjectFileStore. Files are stored under storageRoot/<projectId>/. */
export class FilesystemProjectFileStore implements ProjectFileStore {
  /** Initializes the store with the root directory for all project files. */
  constructor(private readonly storageRoot: string) {}

  private projectDirectory(projectId: ProjectId): string {
    return path.resolve(this.storageRoot, projectId.value);
  }

  private resolveSafe(projectId: ProjectId, filePath: FilePath): string {
    const projectDirectory = this.projectDirectory(projectId);
    const resolved = path.resolve(projectDirectory, filePath.value.slice(1));
    if (!resolved.startsWith(projectDirectory + '/') && resolved !== projectDirectory) {
      throw new Error(`Path traversal detected: ${filePath.value}`);
    }
    // .git (working-tree metadata) and .collab (Yjs blob store) are internal siblings of the
    // tracked project tree, not project content — reject any path that resolves into either of
    // them as a whole path SEGMENT, anywhere. A segment must match exactly: 'mygit' and
    // '.gitignore' are ordinary names and stay allowed.
    const relative = path.relative(projectDirectory, resolved);
    if (relative.split(path.sep).some((segment) => HIDDEN_METADATA_SEGMENTS.has(segment))) {
      throw new Error(`Path traversal detected: ${filePath.value}`);
    }
    return resolved;
  }

  /** Reads and returns the file bytes, or null if the file does not exist. */
  async read(projectId: ProjectId, filePath: FilePath): Promise<Buffer | null> {
    const absPath = this.resolveSafe(projectId, filePath);
    try {
      return await readFile(absPath);
    } catch (error: unknown) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  /** Atomically overwrites the file at filePath, creating intermediate directories as needed. */
  async write(projectId: ProjectId, filePath: FilePath, content: Buffer): Promise<void> {
    const absPath = this.resolveSafe(projectId, filePath);
    const temporaryPath = `${absPath}.tmp`;
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, absPath);
  }

  /** Creates the file only if it does not yet exist, returning FileConflictError if it is already present. */
  async createExclusive(projectId: ProjectId, filePath: FilePath, content: Buffer): Promise<Result<void, FileConflictError>> {
    const absPath = this.resolveSafe(projectId, filePath);
    await mkdir(path.dirname(absPath), { recursive: true });
    let fh;
    try {
      fh = await open(absPath, 'wx');
      await fh.writeFile(content);
      return { success: true, value: undefined };
    } catch (error: unknown) {
      if (isEexist(error)) {
        return { success: false, error: new FileConflictError(`File already exists at ${filePath.value}`) };
      }
      throw error;
    } finally {
      await fh?.close();
    }
  }

  /** Deletes the file, performing a no-op if the file is already absent. */
  async remove(projectId: ProjectId, filePath: FilePath): Promise<void> {
    const absPath = this.resolveSafe(projectId, filePath);
    try {
      await rm(absPath, { force: true });
    } catch {
      // no-op if missing
    }
  }

  /** Moves a file or directory to toPath; returns FileConflictError if toPath already exists. */
  async move(projectId: ProjectId, fromPath: FilePath, toPath: FilePath): Promise<Result<void, FileConflictError>> {
    const absFrom = this.resolveSafe(projectId, fromPath);
    const absTo = this.resolveSafe(projectId, toPath);

    await mkdir(path.dirname(absTo), { recursive: true });

    // Determine if the source is a directory to choose the appropriate move strategy.
    const sourceStat = await stat(absFrom);

    if (sourceStat.isDirectory()) {
      // For directories, use stat + rename.
      // A narrow TOCTOU window remains but is acceptable: directory conflicts
      // are protected at the DB layer (FileNode path uniqueness).
      try {
        await stat(absTo);
        return { success: false, error: new FileConflictError(`File already exists at ${toPath.value}`) };
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error;
      }
      await rename(absFrom, absTo);
    } else {
      // For regular files, use link(2) + unlink(2).
      // link(2) is atomic: fails with EEXIST if the destination already exists,
      // eliminating the TOCTOU race that existed with stat → rename.
      try {
        await link(absFrom, absTo);
      } catch (error: unknown) {
        if (isEexist(error)) {
          return { success: false, error: new FileConflictError(`File already exists at ${toPath.value}`) };
        }
        throw error;
      }
      await unlink(absFrom);
    }

    return { success: true, value: undefined };
  }

  /** Creates the directory and all intermediate directories; no-op if it already exists. */
  async createDirectory(projectId: ProjectId, directoryPath: FilePath): Promise<void> {
    const absPath = this.resolveSafe(projectId, directoryPath);
    await mkdir(absPath, { recursive: true });
  }

  /** Recursively removes the directory and all its contents. */
  async removeDirectory(projectId: ProjectId, directoryPath: FilePath): Promise<void> {
    const absPath = this.resolveSafe(projectId, directoryPath);
    await rm(absPath, { recursive: true, force: true });
  }

  /** Removes the entire project directory tree, called on project deletion. */
  async removeProject(projectId: ProjectId): Promise<void> {
    const projectDirectory = this.projectDirectory(projectId);
    await rm(projectDirectory, { recursive: true, force: true });
  }

  /** Returns a readable stream for the file, or null if the file does not exist. */
  async readStream(projectId: ProjectId, filePath: FilePath): Promise<Readable | null> {
    const absPath = this.resolveSafe(projectId, filePath);
    try {
      await stat(absPath);
      return createReadStream(absPath);
    } catch (error: unknown) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }
}

function hasCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof Reflect.get(error, 'code') === 'string';
}

function isEnoent(error: unknown): boolean {
  return hasCode(error) && error.code === 'ENOENT';
}

function isEexist(error: unknown): boolean {
  return hasCode(error) && error.code === 'EEXIST';
}
