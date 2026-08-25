import { GitOperationId } from '@asciidocollab/domain';
import { compositionRoot, mapOperationId } from '../src/composition-root.js';

describe('git-worker composition root', () => {
  it('constructs, starts, and cleanly shuts down without throwing', async () => {
    const app = await compositionRoot();

    expect(app.isRunning()).toBe(false);

    await app.start();
    expect(app.isRunning()).toBe(true);

    await app.shutdown();
    expect(app.isRunning()).toBe(false);
  });
});

describe('mapOperationId', () => {
  // The regression this closes: GitOperationId (a Uuid subclass) defines no toJSON, so handing a
  // domain result straight to JSON.stringify serializes operationId as {"_value": "<uuid>"} instead
  // of a plain string — malformed for the API route/client, which decode operationId as a string.
  // A prior version of this binding's own server test missed this because its doubles already used
  // pre-stringified fixtures; this exercises the REAL mapping over a REAL GitOperationId instance,
  // then round-trips it through JSON exactly as the wire response would.
  it('serializes a real GitOperationId as a plain string, not {_value}, in the wire-mapped envelope', () => {
    const uuid = '990e8400-e29b-41d4-a716-446655440099';
    const operationId = GitOperationId.create(uuid);

    const mapped = mapOperationId({ status: 'resolved' as const, operationId, headCommit: 'abc123' });
    const envelope = { ok: true, data: mapped };
    const roundTripped = JSON.parse(JSON.stringify(envelope));

    expect(typeof roundTripped.data.operationId).toBe('string');
    expect(roundTripped.data.operationId).toBe(uuid);
    expect(roundTripped.data.headCommit).toBe('abc123');
    expect(roundTripped.data.status).toBe('resolved');
  });

  it('preserves every other field unchanged, mapping only operationId', () => {
    const uuid = '990e8400-e29b-41d4-a716-446655440098';
    const operationId = GitOperationId.create(uuid);

    const mapped = mapOperationId({
      operationId,
      files: [{ path: 'a.adoc', isBinary: false, resolved: true }],
    });

    expect(mapped).toEqual({ operationId: uuid, files: [{ path: 'a.adoc', isBinary: false, resolved: true }] });
  });
});
