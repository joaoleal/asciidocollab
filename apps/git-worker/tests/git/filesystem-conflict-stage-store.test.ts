import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitOperationId } from '@asciidocollab/domain';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';

const OPERATION_A = GitOperationId.create('550e8400-e29b-41d4-a716-446655440200');
const OPERATION_B = GitOperationId.create('550e8400-e29b-41d4-a716-446655440201');

async function createStore(): Promise<{ root: string; store: FilesystemConflictStageStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return { root, store: new FilesystemConflictStageStore(root) };
}

describe('FilesystemConflictStageStore', () => {
  it('round-trips a written snapshot', async () => {
    const { store } = await createStore();
    const snapshot = { preOpHead: 'a'.repeat(40), branch: 'main' };

    const written = await store.writeSnapshot(OPERATION_A, snapshot);
    expect(written).toEqual({ success: true, value: undefined });

    expect(await store.readSnapshot(OPERATION_A)).toEqual({ success: true, value: snapshot });
  });

  it('returns null reading a snapshot for an operation with none recorded', async () => {
    const { store } = await createStore();

    expect(await store.readSnapshot(OPERATION_A)).toEqual({ success: true, value: null });
  });

  it('round-trips written stages, including a binary file and an absent base (add/add)', async () => {
    const { store } = await createStore();
    const binaryBase = Buffer.from([0x00, 0x01, 0x02]);
    const binaryOurs = Buffer.from([0x03, 0x04, 0x05]);
    const binaryTheirs = Buffer.from([0x06, 0x07, 0x08]);

    await store.writeStages(OPERATION_A, 'chapters/intro.adoc', {
      base: Buffer.from('base\n'),
      ours: Buffer.from('ours\n'),
      theirs: Buffer.from('theirs\n'),
      isBinary: false,
    });
    await store.writeStages(OPERATION_A, 'assets/logo.png', {
      base: binaryBase,
      ours: binaryOurs,
      theirs: binaryTheirs,
      isBinary: true,
    });
    await store.writeStages(OPERATION_A, 'new-both-sides.adoc', {
      base: null,
      ours: Buffer.from('local\n'),
      theirs: Buffer.from('remote\n'),
      isBinary: false,
    });

    expect(await store.readStages(OPERATION_A, 'chapters/intro.adoc')).toEqual({
      success: true,
      value: { base: Buffer.from('base\n'), ours: Buffer.from('ours\n'), theirs: Buffer.from('theirs\n'), isBinary: false },
    });
    expect(await store.readStages(OPERATION_A, 'assets/logo.png')).toEqual({
      success: true,
      value: { base: binaryBase, ours: binaryOurs, theirs: binaryTheirs, isBinary: true },
    });
    expect(await store.readStages(OPERATION_A, 'new-both-sides.adoc')).toEqual({
      success: true,
      value: { base: null, ours: Buffer.from('local\n'), theirs: Buffer.from('remote\n'), isBinary: false },
    });
  });

  it('round-trips a null "ours"/"theirs" (a modify/delete conflict) back as null, distinct from an empty string', async () => {
    const { store } = await createStore();

    // "ours" deleted the file, "theirs" modified it: a null ours must NOT be conflated with a real
    // empty-ish payload ('' — how a binary conflict's sides are stored).
    await store.writeStages(OPERATION_A, 'deleted-by-ours.adoc', {
      base: Buffer.from('base\n'),
      ours: null,
      theirs: Buffer.from('theirs modified\n'),
      isBinary: false,
    });
    // "theirs" deleted the file, "ours" modified it.
    await store.writeStages(OPERATION_A, 'deleted-by-theirs.adoc', {
      base: Buffer.from('base\n'),
      ours: Buffer.from('ours modified\n'),
      theirs: null,
      isBinary: false,
    });
    // An empty-string side (as a binary conflict records) round-trips as '' — never as null.
    await store.writeStages(OPERATION_A, 'binary-empty-sides.png', {
      base: null,
      ours: Buffer.alloc(0),
      theirs: Buffer.alloc(0),
      isBinary: true,
    });

    expect(await store.readStages(OPERATION_A, 'deleted-by-ours.adoc')).toEqual({
      success: true,
      value: { base: Buffer.from('base\n'), ours: null, theirs: Buffer.from('theirs modified\n'), isBinary: false },
    });
    expect(await store.readStages(OPERATION_A, 'deleted-by-theirs.adoc')).toEqual({
      success: true,
      value: { base: Buffer.from('base\n'), ours: Buffer.from('ours modified\n'), theirs: null, isBinary: false },
    });
    expect(await store.readStages(OPERATION_A, 'binary-empty-sides.png')).toEqual({
      success: true,
      value: { base: null, ours: Buffer.alloc(0), theirs: Buffer.alloc(0), isBinary: true },
    });
  });

  it('returns null reading stages for a path that was never captured', async () => {
    const { store } = await createStore();

    expect(await store.readStages(OPERATION_A, 'never-written.adoc')).toEqual({ success: true, value: null });
  });

  it('round-trips written merged bytes', async () => {
    const { store } = await createStore();
    const content = Buffer.from('resolved content\n');

    await store.writeMerged(OPERATION_A, 'chapters/intro.adoc', content);

    expect(await store.readMerged(OPERATION_A, 'chapters/intro.adoc')).toEqual({ success: true, value: content });
  });

  it('keeps files independent per operation id', async () => {
    const { store } = await createStore();
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('a-ours'),
      theirs: Buffer.from('a-theirs'),
      isBinary: false,
    });

    expect(await store.readStages(OPERATION_B, 'a.adoc')).toEqual({ success: true, value: null });
  });

  it('on-disk key is base64url of the path (no "/", no "..") and reversible', async () => {
    const { root, store } = await createStore();
    const relativePath = 'chapters/intro.adoc';
    await store.writeStages(OPERATION_A, relativePath, {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });

    const filesDirectory = path.join(root, OPERATION_A.value, 'files');
    const entries = await readdir(filesDirectory);
    expect(entries).toHaveLength(1);
    const [key] = entries;

    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
    expect(Buffer.from(key, 'base64url').toString('utf8')).toBe(relativePath);
  });

  it('rejects a crafted path that would escape the store root, via the staysInside guard', async () => {
    const { root, store } = await createStore();

    const written = await store.writeStages(OPERATION_A, '../../etc/escape.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });

    expect(written.success).toBe(false);
    // Nothing was created for this (rejected) write.
    await expect(stat(path.join(root, OPERATION_A.value))).rejects.toThrow();
  });

  it('clear removes the whole operation directory, leaving other operations untouched', async () => {
    const { root, store } = await createStore();
    await store.writeSnapshot(OPERATION_A, { preOpHead: 'a'.repeat(40), branch: 'main' });
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    await store.writeSnapshot(OPERATION_B, { preOpHead: 'b'.repeat(40), branch: 'main' });

    const cleared = await store.clear(OPERATION_A);

    expect(cleared).toEqual({ success: true, value: undefined });
    await expect(stat(path.join(root, OPERATION_A.value))).rejects.toThrow();
    expect(await store.readSnapshot(OPERATION_A)).toEqual({ success: true, value: null });
    // The other operation survives untouched.
    expect(await store.readSnapshot(OPERATION_B)).toEqual({
      success: true,
      value: { preOpHead: 'b'.repeat(40), branch: 'main' },
    });
  });

  it('clear on an operation with nothing recorded is a harmless success', async () => {
    const { store } = await createStore();

    expect(await store.clear(OPERATION_A)).toEqual({ success: true, value: undefined });
  });

  it('rejects an absolute path on every path-keyed operation', async () => {
    // An absolute path is refused outright rather than being resolved against the store root, so
    // no read or write can ever be aimed at a location the store does not own.
    const { root, store } = await createStore();
    const absolutePath = path.join(tmpdir(), 'outside-the-store.adoc');

    const written = await store.writeStages(OPERATION_A, absolutePath, {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    const mergedWritten = await store.writeMerged(OPERATION_A, absolutePath, Buffer.from('merged'));
    const stagesRead = await store.readStages(OPERATION_A, absolutePath);
    const mergedRead = await store.readMerged(OPERATION_A, absolutePath);

    expect(written.success).toBe(false);
    expect(mergedWritten.success).toBe(false);
    expect(stagesRead.success).toBe(false);
    expect(mergedRead.success).toBe(false);
    await expect(stat(path.join(root, OPERATION_A.value))).rejects.toThrow();
  });

  it('returns null reading merged bytes for a path that has no resolution recorded', async () => {
    const { store } = await createStore();
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });

    expect(await store.readMerged(OPERATION_A, 'a.adoc')).toEqual({ success: true, value: null });
  });

  it('fails reading stages whose meta.json parses but is not the recorded shape', async () => {
    // A truncated or foreign meta.json must not be trusted into a ConflictStages value — the
    // caller would otherwise resolve a conflict against a path/binary flag that is not the file's.
    const { root, store } = await createStore();
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    const fileDirectory = path.join(root, OPERATION_A.value, 'files', Buffer.from('a.adoc').toString('base64url'));
    await writeFile(path.join(fileDirectory, 'meta.json'), JSON.stringify({ path: 'a.adoc' }), 'utf8');

    const read = await store.readStages(OPERATION_A, 'a.adoc');

    expect(read.success).toBe(false);
  });

  it('fails reading stages whose meta.json is not valid JSON at all', async () => {
    const { root, store } = await createStore();
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    const fileDirectory = path.join(root, OPERATION_A.value, 'files', Buffer.from('a.adoc').toString('base64url'));
    await writeFile(path.join(fileDirectory, 'meta.json'), 'not json at all', 'utf8');

    const read = await store.readStages(OPERATION_A, 'a.adoc');

    expect(read.success).toBe(false);
  });

  it('fails reading stages when a stage read fails for a reason other than absence', async () => {
    // Only a genuinely missing stage file means "that side deleted the file". A real I/O failure
    // must surface as a failure, never be reinterpreted as a deletion that drops the file.
    const { root, store } = await createStore();
    await store.writeStages(OPERATION_A, 'a.adoc', {
      base: Buffer.from('base'),
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    const fileDirectory = path.join(root, OPERATION_A.value, 'files', Buffer.from('a.adoc').toString('base64url'));
    await rm(path.join(fileDirectory, 'base'));
    await mkdir(path.join(fileDirectory, 'base'));

    const read = await store.readStages(OPERATION_A, 'a.adoc');

    expect(read.success).toBe(false);
  });

  it('fails reading a snapshot that parses but is not the recorded shape', async () => {
    const { root, store } = await createStore();
    await store.writeSnapshot(OPERATION_A, { preOpHead: 'a'.repeat(40), branch: 'main' });
    await writeFile(path.join(root, OPERATION_A.value, 'snapshot.json'), JSON.stringify({ branch: 'main' }), 'utf8');

    const read = await store.readSnapshot(OPERATION_A);

    expect(read.success).toBe(false);
  });

  it('fails reading a snapshot that is not valid JSON at all', async () => {
    const { root, store } = await createStore();
    await store.writeSnapshot(OPERATION_A, { preOpHead: 'a'.repeat(40), branch: 'main' });
    await writeFile(path.join(root, OPERATION_A.value, 'snapshot.json'), '{ truncated', 'utf8');

    const read = await store.readSnapshot(OPERATION_A);

    expect(read.success).toBe(false);
  });

  it('reports a generic failure, never a filesystem detail, when the store root cannot hold a directory', async () => {
    // The root being unusable (here, a regular file where the directory belongs) must degrade into
    // this port's opaque failure — no path, operation id, or errno may reach the caller.
    const parent = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
    const rootAsFile = path.join(parent, 'root');
    await writeFile(rootAsFile, 'not a directory');
    const store = new FilesystemConflictStageStore(rootAsFile);

    const snapshotWritten = await store.writeSnapshot(OPERATION_A, { preOpHead: 'a'.repeat(40), branch: 'main' });
    const stagesWritten = await store.writeStages(OPERATION_A, 'a.adoc', {
      base: null,
      ours: Buffer.from('ours'),
      theirs: Buffer.from('theirs'),
      isBinary: false,
    });
    const mergedWritten = await store.writeMerged(OPERATION_A, 'a.adoc', Buffer.from('merged'));

    expect(snapshotWritten.success).toBe(false);
    expect(stagesWritten.success).toBe(false);
    expect(mergedWritten.success).toBe(false);
    if (snapshotWritten.success) throw new Error('expected failure');
    expect(snapshotWritten.error.message).toBe(
      'The conflict stage store could not complete the requested operation.',
    );
  });
});
