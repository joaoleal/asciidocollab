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
  GitStatusDto,
  FileGitStatus,
  ConflictSummaryDto,
  ConflictListDto,
  ConflictStagesDto,
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
  test('takes the documented shape (no staged flag — a change`s bucket on GitStatusDto is its state)', () => {
    const type: PendingChangeType = 'modified';
    const dto: PendingChangeDto = { path: 'docs/intro.adoc', changeType: type };
    expect(dto.changeType).toBe('modified');
    expect(Object.keys(dto).sort()).toEqual(['changeType', 'path']);
  });
});

describe('GitStatusDto', () => {
  test('takes the documented shape, bucketing pending changes by state', () => {
    const dto: GitStatusDto = {
      branch: 'main',
      syncStatus: 'UP_TO_DATE',
      ahead: 0,
      behind: 0,
      lastSyncAt: '2026-08-24T00:00:00.000Z',
      staged: [{ path: 'docs/intro.adoc', changeType: 'modified' }],
      unstaged: [{ path: 'docs/other.adoc', changeType: 'modified' }],
      untracked: [{ path: 'docs/new.adoc', changeType: 'added' }],
      conflicted: [],
    };
    expect(dto.staged).toHaveLength(1);
    expect(dto.conflicted).toEqual([]);

    const neverSynced: GitStatusDto = { ...dto, lastSyncAt: null };
    expect(neverSynced.lastSyncAt).toBeNull();
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

describe('ConflictSummaryDto / ConflictListDto', () => {
  test('summarizes a conflicting file with no content, just path/binary/resolved', () => {
    const summary: ConflictSummaryDto = {
      path: 'docs/intro.adoc',
      isBinary: false,
      resolved: false,
    };
    expect(summary.resolved).toBe(false);
  });

  test('lists every conflicting file under its operation id', () => {
    const list: ConflictListDto = {
      operationId: 'op-1',
      files: [
        { path: 'docs/intro.adoc', isBinary: false, resolved: false },
        { path: 'assets/logo.png', isBinary: true, resolved: true },
      ],
    };
    expect(list.files).toHaveLength(2);
    expect(list.files[1].isBinary).toBe(true);
  });
});

describe('ConflictStagesDto', () => {
  test('carries the three-way text content for a non-binary conflict', () => {
    const stages: ConflictStagesDto = {
      base: 'original text',
      ours: 'our edit',
      theirs: 'their edit',
      isBinary: false,
    };
    expect(stages.base).toBe('original text');
    expect(stages.isBinary).toBe(false);
  });

  test('carries empty content and isBinary:true for a binary conflict', () => {
    const stages: ConflictStagesDto = {
      base: null,
      ours: '',
      theirs: '',
      isBinary: true,
    };
    expect(stages.base).toBeNull();
    expect(stages.ours).toBe('');
    expect(stages.isBinary).toBe(true);
  });
});
