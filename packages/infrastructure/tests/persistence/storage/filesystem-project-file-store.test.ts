import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemProjectFileStore } from '../../../src/persistence/storage/filesystem-project-file-store';
import { ProjectId } from '@asciidocollab/domain';
import { FilePath } from '@asciidocollab/domain';
import { FileConflictError } from '@asciidocollab/domain';

describe('FilesystemProjectFileStore', () => {
  let storageRoot: string;
  let store: FilesystemProjectFileStore;
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440001');
  const filePath = FilePath.create('/hello.txt');
  const content = Buffer.from('Hello, world!');

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'asciidocollab-test-'));
    store = new FilesystemProjectFileStore(storageRoot);
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe('read/write roundtrip', () => {
    it('reads back the same bytes after write', async () => {
      await store.write(projectId, filePath, content);
      const result = await store.read(projectId, filePath);
      expect(result).toEqual(content);
    });

    it('returns null when file does not exist', async () => {
      const result = await store.read(projectId, filePath);
      expect(result).toBeNull();
    });
  });

  describe('write (atomic overwrite)', () => {
    it('overwrites existing file atomically', async () => {
      await store.write(projectId, filePath, Buffer.from('old'));
      await store.write(projectId, filePath, Buffer.from('new'));
      const result = await store.read(projectId, filePath);
      expect(result?.toString()).toBe('new');
    });

    it('creates intermediate directories', async () => {
      const nestedPath = FilePath.create('/a/b/c/file.txt');
      await store.write(projectId, nestedPath, content);
      const result = await store.read(projectId, nestedPath);
      expect(result).toEqual(content);
    });
  });

  describe('createExclusive', () => {
    it('creates file when path is free', async () => {
      const result = await store.createExclusive(projectId, filePath, content);
      expect(result.success).toBe(true);
      expect(await store.read(projectId, filePath)).toEqual(content);
    });

    it('returns FileConflictError when file already exists', async () => {
      await store.createExclusive(projectId, filePath, content);
      const result = await store.createExclusive(projectId, filePath, Buffer.from('other'));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(FileConflictError);
      }
    });
  });

  describe('move', () => {
    it('moves file to new path', async () => {
      await store.write(projectId, filePath, content);
      const newPath = FilePath.create('/moved.txt');
      const result = await store.move(projectId, filePath, newPath);
      expect(result.success).toBe(true);
      expect(await store.read(projectId, filePath)).toBeNull();
      expect(await store.read(projectId, newPath)).toEqual(content);
    });

    it('returns FileConflictError when destination exists', async () => {
      const newPath = FilePath.create('/other.txt');
      await store.write(projectId, filePath, content);
      await store.write(projectId, newPath, Buffer.from('existing'));
      const result = await store.move(projectId, filePath, newPath);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(FileConflictError);
      }
    });
  });

  describe('createDirectory', () => {
    it('creates directory structure', async () => {
      const directoryPath = FilePath.create('/mydir');
      await store.createDirectory(projectId, directoryPath);
      const filePath2 = FilePath.create('/mydir/file.txt');
      await store.write(projectId, filePath2, content);
      expect(await store.read(projectId, filePath2)).toEqual(content);
    });

    it('is a no-op when directory already exists', async () => {
      const directoryPath = FilePath.create('/existing');
      await store.createDirectory(projectId, directoryPath);
      await expect(store.createDirectory(projectId, directoryPath)).resolves.not.toThrow();
    });
  });

  describe('removeProject', () => {
    it('removes all files for a project', async () => {
      const path2 = FilePath.create('/other.txt');
      await store.write(projectId, filePath, content);
      await store.write(projectId, path2, Buffer.from('other'));
      await store.removeProject(projectId);
      expect(await store.read(projectId, filePath)).toBeNull();
      expect(await store.read(projectId, path2)).toBeNull();
    });
  });

  describe('path traversal protection', () => {
    it('rejects path traversal in FilePath', () => {
      expect(() => FilePath.create('/../etc/passwd')).toThrow();
    });

    it('resolves only within project dir', async () => {
      // This verifies the infrastructure resolveSafe rejects even if FilePath somehow
      // allowed it — in practice FilePath already blocks ../ sequences
      await expect(store.read(projectId, FilePath.create('/valid.txt'))).resolves.toBeNull();
    });

    it('rejects a leading double slash, which FilePath accepts but resolves outside the project', async () => {
      // FilePath's traversal check only looks for `.`/`..` segments, so `//etc/passwd` passes it.
      // After the leading-slash strip it is still absolute, so path.resolve discards the project
      // directory entirely — resolveSafe is the only thing standing between it and /etc/passwd.
      const escaping = FilePath.create('//etc/passwd');
      await expect(store.read(projectId, escaping)).rejects.toThrow('Path traversal detected: //etc/passwd');
      await expect(store.write(projectId, escaping, content)).rejects.toThrow('Path traversal detected: //etc/passwd');
      await expect(store.readStream(projectId, escaping)).rejects.toThrow('Path traversal detected: //etc/passwd');
    });

    it('allows the project root itself, which resolves to the project directory exactly', async () => {
      // The `resolved !== projectDirectory` arm of the guard: '/' strips to '' and resolves back to
      // the project directory, which is inside the project and must not be rejected.
      await expect(store.createDirectory(projectId, FilePath.create('/'))).resolves.toBeUndefined();
      await store.write(projectId, filePath, content);
      expect(await store.read(projectId, filePath)).toEqual(content);
    });
  });

  describe('hidden-metadata guard', () => {
    it('rejects a path whose first segment is exactly .git', async () => {
      await expect(store.read(projectId, FilePath.create('/.git'))).rejects.toThrow('Path traversal detected: /.git');
    });

    it('rejects a path whose first segment is exactly .collab', async () => {
      await expect(store.read(projectId, FilePath.create('/.collab'))).rejects.toThrow('Path traversal detected: /.collab');
    });

    it('rejects a path where .git appears as a nested segment', async () => {
      await expect(store.read(projectId, FilePath.create('/.git/config'))).rejects.toThrow('Path traversal detected: /.git/config');
    });

    it('rejects a path where .collab appears as a nested segment', async () => {
      await expect(store.read(projectId, FilePath.create('/.collab/state.bin'))).rejects.toThrow('Path traversal detected: /.collab/state.bin');
    });

    it('rejects .git/.collab segments across every mutating operation, not just read', async () => {
      await expect(store.write(projectId, FilePath.create('/.git/HEAD'), content)).rejects.toThrow('Path traversal detected');
      await expect(store.createExclusive(projectId, FilePath.create('/.git/HEAD'), content)).rejects.toThrow('Path traversal detected');
      await expect(store.remove(projectId, FilePath.create('/.git/HEAD'))).rejects.toThrow('Path traversal detected');
      await expect(store.createDirectory(projectId, FilePath.create('/.collab'))).rejects.toThrow('Path traversal detected');
      await expect(store.removeDirectory(projectId, FilePath.create('/.collab'))).rejects.toThrow('Path traversal detected');
      await expect(store.readStream(projectId, FilePath.create('/.git/HEAD'))).rejects.toThrow('Path traversal detected');
      await expect(store.move(projectId, FilePath.create('/valid.txt'), FilePath.create('/.git/dest'))).rejects.toThrow('Path traversal detected');
      await expect(store.move(projectId, FilePath.create('/.collab/src'), FilePath.create('/valid.txt'))).rejects.toThrow('Path traversal detected');
    });

    it('does NOT reject a file literally named mygit (not a .git segment)', async () => {
      await store.write(projectId, FilePath.create('/mygit'), content);
      expect(await store.read(projectId, FilePath.create('/mygit'))).toEqual(content);
    });

    it('does NOT reject a dotfile named .gitignore (not the .git directory)', async () => {
      await store.write(projectId, FilePath.create('/.gitignore'), content);
      expect(await store.read(projectId, FilePath.create('/.gitignore'))).toEqual(content);
    });

    it('does NOT reject a folder named .github (tracked dotfile directory, not .git)', async () => {
      const nested = FilePath.create('/.github/workflows.yml');
      await store.write(projectId, nested, content);
      expect(await store.read(projectId, nested)).toEqual(content);
    });

    it('does NOT reject a normal nested path containing "collaboration" as a segment (not .collab)', async () => {
      const nested = FilePath.create('/collaboration/notes.txt');
      await store.write(projectId, nested, content);
      expect(await store.read(projectId, nested)).toEqual(content);
    });

    it('still allows normal paths and still rejects the pre-existing leading-double-slash escape', async () => {
      await store.write(projectId, filePath, content);
      expect(await store.read(projectId, filePath)).toEqual(content);
      const escaping = FilePath.create('//etc/passwd');
      await expect(store.read(projectId, escaping)).rejects.toThrow('Path traversal detected: //etc/passwd');
    });
  });

  describe('non-ENOENT / non-EEXIST failures propagate instead of being swallowed', () => {
    // A 300-byte basename exceeds Linux's 255-byte NAME_MAX, so every syscall on it fails with
    // ENAMETOOLONG — a deterministic stand-in for "an I/O error that is not the expected one".
    const tooLong = FilePath.create(`/${'a'.repeat(300)}.txt`);

    beforeEach(async () => {
      // The kernel resolves a path component at a time, so a missing parent directory would fail
      // with ENOENT before the over-long basename is ever looked at. Materialise the project
      // directory so ENAMETOOLONG is genuinely what comes back.
      await store.createDirectory(projectId, FilePath.create('/'));
    });

    it('read rethrows rather than reporting the file as absent', async () => {
      await expect(store.read(projectId, tooLong)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
    });

    it('readStream rethrows rather than reporting the file as absent', async () => {
      await expect(store.readStream(projectId, tooLong)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
    });

    it('createExclusive rethrows rather than reporting a conflict', async () => {
      await expect(store.createExclusive(projectId, tooLong, content)).rejects.toMatchObject({
        code: 'ENAMETOOLONG',
      });
    });

    it('move of a file rethrows a link failure that is not a destination conflict', async () => {
      await store.write(projectId, filePath, content);
      await expect(store.move(projectId, filePath, tooLong)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
      // The source is left untouched: unlink only runs after a successful link.
      expect(await store.read(projectId, filePath)).toEqual(content);
    });

    it('move of a directory rethrows a destination stat failure that is not ENOENT', async () => {
      await store.write(projectId, FilePath.create('/dir/inner.txt'), content);
      await expect(store.move(projectId, FilePath.create('/dir'), tooLong)).rejects.toMatchObject({
        code: 'ENAMETOOLONG',
      });
      expect(await store.read(projectId, FilePath.create('/dir/inner.txt'))).toEqual(content);
    });
  });

  describe('remove', () => {
    it('removes an existing file', async () => {
      await store.write(projectId, filePath, content);
      await store.remove(projectId, filePath);
      expect(await store.read(projectId, filePath)).toBeNull();
    });

    it('is a no-op when the file is already absent', async () => {
      await expect(store.remove(projectId, FilePath.create('/never.txt'))).resolves.not.toThrow();
    });
  });

  describe('removeDirectory', () => {
    it('recursively removes a directory and its contents', async () => {
      await store.write(projectId, FilePath.create('/dir/inner.txt'), content);
      await store.removeDirectory(projectId, FilePath.create('/dir'));
      expect(await store.read(projectId, FilePath.create('/dir/inner.txt'))).toBeNull();
    });
  });

  describe('readStream', () => {
    it('returns a readable stream for an existing file', async () => {
      await store.write(projectId, filePath, content);
      const stream = await store.readStream(projectId, filePath);
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(content);
    });

    it('returns null when the file does not exist', async () => {
      expect(await store.readStream(projectId, FilePath.create('/missing.txt'))).toBeNull();
    });
  });

  describe('move — directories', () => {
    it('moves a directory to a new path', async () => {
      await store.write(projectId, FilePath.create('/src/a.txt'), content);
      const result = await store.move(projectId, FilePath.create('/src'), FilePath.create('/dst'));
      expect(result.success).toBe(true);
      expect(await store.read(projectId, FilePath.create('/dst/a.txt'))).toEqual(content);
      expect(await store.read(projectId, FilePath.create('/src/a.txt'))).toBeNull();
    });

    it('returns FileConflictError when the destination directory already exists', async () => {
      await store.write(projectId, FilePath.create('/from/a.txt'), content);
      await store.createDirectory(projectId, FilePath.create('/to'));
      const result = await store.move(projectId, FilePath.create('/from'), FilePath.create('/to'));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(FileConflictError);
      }
    });
  });

  describe('move — concurrent exclusive moves to the same destination', () => {
    it('when two moves race to the same destination, exactly one succeeds and one returns FileConflictError', async () => {
      await store.write(projectId, FilePath.create('/a.txt'), Buffer.from('a'));
      await store.write(projectId, FilePath.create('/b.txt'), Buffer.from('b'));

      const [r1, r2] = await Promise.all([
        store.move(projectId, FilePath.create('/a.txt'), FilePath.create('/dest.txt')),
        store.move(projectId, FilePath.create('/b.txt'), FilePath.create('/dest.txt')),
      ]);

      const successes = [r1, r2].filter((r) => r.success).length;
      const conflicts = [r1, r2].filter((r) => !r.success && r.error instanceof FileConflictError).length;

      expect(successes).toBe(1);
      expect(conflicts).toBe(1);
    });
  });
});
