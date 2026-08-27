import {
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';
import type { HistoryCommit } from '@asciidocollab/domain';
import { mapGitRepositoryToWire, mapHistoryCommitsToWire, mapOperationId } from '../src/git-wire-mappers.js';

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
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally testing JSON.stringify wire serialization (no {_value} leaking through), not a deep clone; structuredClone would not exercise the same semantics.
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

describe('mapGitRepositoryToWire', () => {
  // The regression this closes: GitRepositoryId/ProjectId/GitProvider/UserId are value objects with
  // no toJSON, so handing a domain GitRepository straight to JSON.stringify would serialize each as
  // {"_value": "..."} instead of a plain string — malformed for the API route/client. This exercises
  // the REAL mapping over a REAL GitRepository entity, then round-trips it through JSON exactly as
  // the wire response would.
  it('serializes a real GitRepository as plain strings, not {_value}, in the wire-mapped envelope', () => {
    const repository = new GitRepository(
      GitRepositoryId.create('990e8400-e29b-41d4-a716-446655440020'),
      ProjectId.create('990e8400-e29b-41d4-a716-446655440021'),
      GitProvider.create('github'),
      'https://github.com/example/repo.git',
      '990e8400-e29b-41d4-a716-446655440021',
      'main',
      'UP_TO_DATE',
      'main',
      null,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      UserId.create('990e8400-e29b-41d4-a716-446655440022'),
    );

    const mapped = mapGitRepositoryToWire(repository);
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally testing JSON.stringify wire serialization (no {_value} leaking through), not a deep clone; structuredClone would not exercise the same semantics.
    const roundTripped = JSON.parse(JSON.stringify({ ok: true, data: { repository: mapped } }));

    expect(roundTripped).toEqual({
      ok: true,
      data: {
        repository: {
          id: '990e8400-e29b-41d4-a716-446655440020',
          projectId: '990e8400-e29b-41d4-a716-446655440021',
          provider: 'github',
          remoteUrl: 'https://github.com/example/repo.git',
          currentBranch: 'main',
          defaultBranch: 'main',
          syncStatus: 'UP_TO_DATE',
          lastSyncAt: '2026-01-01T00:00:00.000Z',
          connectedByUserId: '990e8400-e29b-41d4-a716-446655440022',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      },
    });
    expect(JSON.stringify(roundTripped)).not.toContain('_value');
  });

  it('maps a null lastSyncAt/connectedByUserId through unchanged', () => {
    const repository = new GitRepository(
      GitRepositoryId.create('990e8400-e29b-41d4-a716-446655440023'),
      ProjectId.create('990e8400-e29b-41d4-a716-446655440024'),
      GitProvider.create('gitlab'),
      'https://gitlab.com/example/repo.git',
      '990e8400-e29b-41d4-a716-446655440024',
    );

    const mapped = mapGitRepositoryToWire(repository);

    expect(mapped.lastSyncAt).toBeNull();
    expect(mapped.connectedByUserId).toBeNull();
  });
});

describe('mapHistoryCommitsToWire', () => {
  it('maps an empty commit list to an empty array', () => {
    expect(mapHistoryCommitsToWire([])).toEqual([]);
  });

  it('serializes each commit to plain strings, resolving authorUserId to its .value and authoredAt to ISO-8601', () => {
    const commits: readonly HistoryCommit[] = [
      {
        hash: 'a1b2c3d',
        message: 'Add chapter one',
        authorUserId: UserId.create('990e8400-e29b-41d4-a716-446655440040'),
        authoredAt: new Date('2026-01-03T04:05:06.000Z'),
      },
    ];

    const mapped = mapHistoryCommitsToWire(commits);
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally testing JSON.stringify wire serialization (no {_value} leaking through), not a deep clone; structuredClone would not exercise the same semantics.
    const roundTripped = JSON.parse(JSON.stringify(mapped));

    expect(roundTripped).toEqual([
      {
        hash: 'a1b2c3d',
        message: 'Add chapter one',
        authorUserId: '990e8400-e29b-41d4-a716-446655440040',
        authoredAt: '2026-01-03T04:05:06.000Z',
      },
    ]);
    expect(JSON.stringify(roundTripped)).not.toContain('_value');
  });

  it('omits authorUserId entirely when the author is unmapped', () => {
    const commits: readonly HistoryCommit[] = [
      {
        hash: 'e4f5a6b',
        message: 'Fix typo',
        authoredAt: new Date('2026-02-14T09:00:00.000Z'),
      },
    ];

    const mapped = mapHistoryCommitsToWire(commits);

    expect(mapped).toEqual([
      { hash: 'e4f5a6b', message: 'Fix typo', authoredAt: '2026-02-14T09:00:00.000Z' },
    ]);
    expect(Object.prototype.hasOwnProperty.call(mapped[0], 'authorUserId')).toBe(false);
  });

  it('preserves the given order across multiple commits', () => {
    const commits: readonly HistoryCommit[] = [
      { hash: 'first', message: 'newest', authoredAt: new Date('2026-03-03T00:00:00.000Z') },
      {
        hash: 'second',
        message: 'oldest',
        authorUserId: UserId.create('990e8400-e29b-41d4-a716-446655440041'),
        authoredAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ];

    const mapped = mapHistoryCommitsToWire(commits);

    expect(mapped.map((commit) => commit.hash)).toEqual(['first', 'second']);
    expect(mapped[1].authorUserId).toBe('990e8400-e29b-41d4-a716-446655440041');
  });
});
