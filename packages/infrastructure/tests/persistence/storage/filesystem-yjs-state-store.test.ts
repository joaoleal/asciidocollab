import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemYjsStateStore } from '../../../src/persistence/storage/filesystem-yjs-state-store';
import { ProjectId, YjsStateId } from '@asciidocollab/domain';

describe('FilesystemYjsStateStore', () => {
  let storageRoot: string;
  let store: FilesystemYjsStateStore;
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440001');
  const yjsStateId = YjsStateId.create('660e8400-e29b-41d4-a716-446655440002');
  const state = Buffer.from([1, 2, 3, 4, 5]);

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'asciidocollab-yjs-test-'));
    store = new FilesystemYjsStateStore(storageRoot);
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('load returns null when file does not exist', async () => {
    const result = await store.load(projectId, yjsStateId);
    expect(result).toBeNull();
  });

  it('load rethrows a non-ENOENT read failure instead of reporting "no state"', async () => {
    // A directory sitting where the state file belongs makes readFile fail with EISDIR. Only ENOENT
    // means "nothing persisted yet"; swallowing any other errno would hand the collab server an
    // empty document and silently discard the stored history on the next save.
    await mkdir(path.join(storageRoot, projectId.value, '.collab', yjsStateId.value), { recursive: true });

    const outcome = await store.load(projectId, yjsStateId).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    // `toBeInstanceOf(Error)` cannot be used: fs rejects with an Error built in node's realm, which
    // is a different constructor from the test sandbox's `Error`.
    const error = outcome.error as NodeJS.ErrnoException;
    expect(error.code).toBe('EISDIR');
    expect(error.syscall).toBe('read');
  });

  it('save then load roundtrip', async () => {
    await store.save(projectId, yjsStateId, state);
    const result = await store.load(projectId, yjsStateId);
    expect(result).toEqual(state);
  });

  it('save creates .collab/ directory on first use', async () => {
    await expect(store.save(projectId, yjsStateId, state)).resolves.not.toThrow();
    const result = await store.load(projectId, yjsStateId);
    expect(result).not.toBeNull();
  });

  it('delete removes the file', async () => {
    await store.save(projectId, yjsStateId, state);
    await store.delete(projectId, yjsStateId);
    const result = await store.load(projectId, yjsStateId);
    expect(result).toBeNull();
  });

  it('deleteAllForProject removes .collab/ dir', async () => {
    const yjsStateId2 = YjsStateId.create('770e8400-e29b-41d4-a716-446655440003');
    await store.save(projectId, yjsStateId, state);
    await store.save(projectId, yjsStateId2, Buffer.from([6, 7, 8]));
    await store.deleteAllForProject(projectId);
    expect(await store.load(projectId, yjsStateId)).toBeNull();
    expect(await store.load(projectId, yjsStateId2)).toBeNull();
  });
});
