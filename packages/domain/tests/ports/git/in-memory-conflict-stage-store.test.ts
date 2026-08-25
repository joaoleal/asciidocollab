import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { ConflictStages, ConflictUndoSnapshot } from '../../../src/ports/git/conflict-stage-store';
import { InMemoryConflictStageStore } from './in-memory-conflict-stage-store';

const OPERATION_A = GitOperationId.create('550e8400-e29b-41d4-a716-446655440100');
const OPERATION_B = GitOperationId.create('550e8400-e29b-41d4-a716-446655440101');

const STAGES: ConflictStages = {
  base: Buffer.from('base\n'),
  ours: Buffer.from('ours\n'),
  theirs: Buffer.from('theirs\n'),
  isBinary: false,
};

const SNAPSHOT: ConflictUndoSnapshot = { preOpHead: 'a'.repeat(40), branch: 'main' };

describe('InMemoryConflictStageStore', () => {
  it('round-trips a written snapshot and records the call', async () => {
    const store = new InMemoryConflictStageStore();

    const written = await store.writeSnapshot(OPERATION_A, SNAPSHOT);
    expect(written).toEqual({ success: true, value: undefined });

    const read = await store.readSnapshot(OPERATION_A);
    expect(read).toEqual({ success: true, value: SNAPSHOT });
    expect(store.recordedSnapshots).toEqual([{ operationId: OPERATION_A, snapshot: SNAPSHOT }]);
  });

  it('returns null reading a snapshot for an operation with none recorded', async () => {
    const store = new InMemoryConflictStageStore();

    const read = await store.readSnapshot(OPERATION_A);

    expect(read).toEqual({ success: true, value: null });
  });

  it('round-trips written stages per (operation, path) and records the call', async () => {
    const store = new InMemoryConflictStageStore();

    await store.writeStages(OPERATION_A, 'chapters/intro.adoc', STAGES);

    const read = await store.readStages(OPERATION_A, 'chapters/intro.adoc');
    expect(read).toEqual({ success: true, value: STAGES });
    expect(store.recordedStages).toEqual([{ operationId: OPERATION_A, path: 'chapters/intro.adoc', stages: STAGES }]);

    // A different operation (or path) sees nothing.
    expect(await store.readStages(OPERATION_B, 'chapters/intro.adoc')).toEqual({ success: true, value: null });
    expect(await store.readStages(OPERATION_A, 'other.adoc')).toEqual({ success: true, value: null });
  });

  it('round-trips written merged bytes per (operation, path) and records the call', async () => {
    const store = new InMemoryConflictStageStore();
    const content = Buffer.from('resolved content\n');

    await store.writeMerged(OPERATION_A, 'chapters/intro.adoc', content);

    expect(await store.readMerged(OPERATION_A, 'chapters/intro.adoc')).toEqual({ success: true, value: content });
    expect(store.recordedMerged).toEqual([{ operationId: OPERATION_A, path: 'chapters/intro.adoc', content }]);
  });

  it('seed helpers populate readable state without recording a write call', async () => {
    const store = new InMemoryConflictStageStore();

    store.seedSnapshot(OPERATION_A, SNAPSHOT);
    store.seedStages(OPERATION_A, 'a.adoc', STAGES);
    store.seedMerged(OPERATION_A, 'a.adoc', Buffer.from('merged\n'));

    expect(await store.readSnapshot(OPERATION_A)).toEqual({ success: true, value: SNAPSHOT });
    expect(await store.readStages(OPERATION_A, 'a.adoc')).toEqual({ success: true, value: STAGES });
    expect(await store.readMerged(OPERATION_A, 'a.adoc')).toEqual({ success: true, value: Buffer.from('merged\n') });
    expect(store.recordedSnapshots).toEqual([]);
    expect(store.recordedStages).toEqual([]);
    expect(store.recordedMerged).toEqual([]);
  });

  it('clear removes everything recorded for an operation, leaving other operations untouched', async () => {
    const store = new InMemoryConflictStageStore();
    await store.writeSnapshot(OPERATION_A, SNAPSHOT);
    await store.writeStages(OPERATION_A, 'a.adoc', STAGES);
    await store.writeMerged(OPERATION_A, 'a.adoc', Buffer.from('merged\n'));
    await store.writeSnapshot(OPERATION_B, SNAPSHOT);

    const cleared = await store.clear(OPERATION_A);

    expect(cleared).toEqual({ success: true, value: undefined });
    expect(await store.readSnapshot(OPERATION_A)).toEqual({ success: true, value: null });
    expect(await store.readStages(OPERATION_A, 'a.adoc')).toEqual({ success: true, value: null });
    expect(await store.readMerged(OPERATION_A, 'a.adoc')).toEqual({ success: true, value: null });
    expect(store.clearedOperationIds).toEqual([OPERATION_A]);
    // The other operation's snapshot survives.
    expect(await store.readSnapshot(OPERATION_B)).toEqual({ success: true, value: SNAPSHOT });
  });
});
