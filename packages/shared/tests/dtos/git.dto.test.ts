import {
  GIT_PROVIDERS,
  isGitProvider,
  GIT_SYNC_STATUSES,
  isGitSyncStatus,
  PENDING_CHANGE_TYPES,
  isPendingChangeType,
  FILE_GIT_STATUSES,
  isFileGitStatus,
  CONFLICT_RESOLUTIONS,
  isConflictResolution,
} from '../../src/dtos/git.dto';
import type {
  GitProvider,
  GitSyncStatus,
  GitRepositoryDto,
  BranchDto,
  CommitDto,
  PendingChangeType,
  PendingChangeDto,
  FileGitStatus,
  ConflictResolution,
  ConflictDto,
} from '../../src/dtos/git.dto';

describe('git provider', () => {
  test('the supported set is exhaustive and lowercase', () => {
    expect(GIT_PROVIDERS).toEqual(['github', 'gitlab', 'bitbucket']);
  });

  test('type guard accepts members and rejects non-members', () => {
    expect(isGitProvider('github')).toBe(true);
    expect(isGitProvider('GITHUB')).toBe(false);
    expect(isGitProvider('svn')).toBe(false);
  });
});

describe('git sync status', () => {
  test('the status set is exhaustive', () => {
    expect(GIT_SYNC_STATUSES).toEqual([
      'UP_TO_DATE',
      'AHEAD',
      'BEHIND',
      'DIVERGED',
      'CONFLICTED',
      'DISCONNECTED',
    ]);
  });

  test('type guard accepts members and rejects non-members', () => {
    expect(isGitSyncStatus('AHEAD')).toBe(true);
    expect(isGitSyncStatus('ahead')).toBe(false);
  });
});

describe('GitRepositoryDto', () => {
  test('takes the documented shape, with nullable sync fields', () => {
    const provider: GitProvider = 'github';
    const syncStatus: GitSyncStatus = 'UP_TO_DATE';
    const dto: GitRepositoryDto = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      provider,
      remoteUrl: 'https://github.com/acme/handbook.git',
      currentBranch: 'main',
      defaultBranch: 'main',
      syncStatus,
      lastSyncAt: '2026-08-24T00:00:00.000Z',
      connectedByUserId: '550e8400-e29b-41d4-a716-446655440002',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    expect(dto.provider).toBe('github');
    expect(dto.syncStatus).toBe('UP_TO_DATE');

    const neverSynced: GitRepositoryDto = { ...dto, lastSyncAt: null, defaultBranch: null, connectedByUserId: null };
    expect(neverSynced.lastSyncAt).toBeNull();
  });
});

describe('BranchDto', () => {
  test('carries a name and whether it is the current branch', () => {
    const current: BranchDto = { name: 'main', isCurrent: true };
    const other: BranchDto = { name: 'feature/x', isCurrent: false };
    expect(current.isCurrent).toBe(true);
    expect(other.isCurrent).toBe(false);
  });
});

describe('CommitDto', () => {
  test('takes the documented shape; authorUserId is optional for unmapped authors', () => {
    const mapped: CommitDto = {
      hash: 'a1b2c3d',
      message: 'Fix typo',
      authorUserId: '550e8400-e29b-41d4-a716-446655440003',
      authoredAt: '2026-08-20T12:00:00.000Z',
    };
    const unmapped: CommitDto = {
      hash: 'e4f5a6b',
      message: 'Imported from remote',
      authoredAt: '2026-08-19T12:00:00.000Z',
    };
    expect(mapped.authorUserId).toBeDefined();
    expect(unmapped.authorUserId).toBeUndefined();
  });
});

describe('pending change type', () => {
  test('the change-type set is exhaustive (renamed is the canonical label for moves)', () => {
    expect(PENDING_CHANGE_TYPES).toEqual(['added', 'modified', 'removed', 'renamed', 'copied']);
  });

  test('type guard accepts members and rejects non-members', () => {
    expect(isPendingChangeType('renamed')).toBe(true);
    expect(isPendingChangeType('moved')).toBe(false);
  });
});

describe('PendingChangeDto', () => {
  test('takes the documented shape', () => {
    const type: PendingChangeType = 'modified';
    const dto: PendingChangeDto = { path: 'docs/intro.adoc', changeType: type, staged: false };
    expect(dto.staged).toBe(false);
    expect(dto.changeType).toBe('modified');
  });
});

describe('file git status', () => {
  test('the status set is exhaustive', () => {
    expect(FILE_GIT_STATUSES).toEqual([
      'unchanged',
      'modified',
      'staged',
      'untracked',
      'removed',
      'conflicted',
    ]);
  });

  test('type guard accepts members and rejects non-members', () => {
    const status: FileGitStatus = 'conflicted';
    expect(isFileGitStatus(status)).toBe(true);
    expect(isFileGitStatus('unknown')).toBe(false);
  });
});

describe('conflict resolution', () => {
  test('the resolution set is exhaustive', () => {
    expect(CONFLICT_RESOLUTIONS).toEqual(['ours', 'theirs', 'merged']);
  });

  test('type guard accepts members and rejects non-members', () => {
    expect(isConflictResolution('merged')).toBe(true);
    expect(isConflictResolution('mine')).toBe(false);
  });
});

describe('ConflictDto', () => {
  test('carries the three-way content and a null resolution while unresolved', () => {
    const dto: ConflictDto = {
      path: 'docs/intro.adoc',
      isBinary: false,
      resolution: null,
      base: 'original text',
      ours: 'our edit',
      theirs: 'their edit',
    };
    expect(dto.resolution).toBeNull();
    expect(dto.base).toBe('original text');
  });

  test('records the chosen resolution once resolved', () => {
    const resolution: ConflictResolution = 'theirs';
    const dto: ConflictDto = {
      path: 'docs/intro.adoc',
      isBinary: false,
      resolution,
      base: null,
      ours: 'our edit',
      theirs: 'their edit',
    };
    expect(dto.resolution).toBe('theirs');
    expect(dto.base).toBeNull();
  });
});
