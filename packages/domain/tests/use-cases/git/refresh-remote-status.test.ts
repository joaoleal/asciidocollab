import { RefreshRemoteStatusUseCase } from '../../../src/use-cases/git/refresh-remote-status';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitSyncStatus } from '../../../src/types/git-sync-status';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
const REPO_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'main';
const TOKEN = 'ghp_super-secret-token-value';
const REMOTE_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';

interface Harness {
  useCase: RefreshRemoteStatusUseCase;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
}

async function buildHarness(options: {
  connected?: boolean;
  initialSyncStatus?: GitSyncStatus;
} = {}): Promise<Harness> {
  const { connected = true, initialSyncStatus = 'UP_TO_DATE' } = options;

  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        REPO_ID,
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        CURRENT_BRANCH,
        initialSyncStatus,
        'main',
        'previous-head-commit-hash',
        new Date('2024-01-01T00:00:00.000Z'),
      ),
    );
  }

  const useCase = new RefreshRemoteStatusUseCase(gitRepositoryRepo, commandRunner);

  return { useCase, gitRepositoryRepo, commandRunner };
}

function refreshInput() {
  return { projectId: PROJECT_ID, token: TOKEN };
}

describe('RefreshRemoteStatusUseCase', () => {
  test('(0,0) derives UP_TO_DATE, updates the row, and returns the counts', async () => {
    const harness = await buildHarness({ initialSyncStatus: 'BEHIND' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 0 });

    const before = new Date();
    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      syncStatus: 'UP_TO_DATE',
      behind: 0,
      ahead: 0,
      lastKnownRemoteHead: REMOTE_HEAD,
    });

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
    expect(saved?.lastSyncAt).not.toBeNull();
    expect((saved?.lastSyncAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Untouched fields carry over.
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
    expect(saved?.remoteUrl).toBe(REMOTE_URL);
  });

  test('(behind>0, 0) derives BEHIND', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 4, ahead: 0 });

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      syncStatus: 'BEHIND',
      behind: 4,
      ahead: 0,
      lastKnownRemoteHead: REMOTE_HEAD,
    });
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('BEHIND');
  });

  test('(0, ahead>0) derives AHEAD', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 2 });

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      syncStatus: 'AHEAD',
      behind: 0,
      ahead: 2,
      lastKnownRemoteHead: REMOTE_HEAD,
    });
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('AHEAD');
  });

  test('(behind>0, ahead>0) derives DIVERGED', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 5, ahead: 3 });

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      syncStatus: 'DIVERGED',
      behind: 5,
      ahead: 3,
      lastKnownRemoteHead: REMOTE_HEAD,
    });
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('DIVERGED');
  });

  test('a CONFLICTED row is preserved: syncStatus stays CONFLICTED though counts and remote head refresh', async () => {
    const harness = await buildHarness({ initialSyncStatus: 'CONFLICTED' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 0 });

    const before = new Date();
    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The returned counts/head are the derived/refreshed values, but syncStatus stays CONFLICTED.
    expect(result.value).toEqual({
      syncStatus: 'CONFLICTED',
      behind: 0,
      ahead: 0,
      lastKnownRemoteHead: REMOTE_HEAD,
    });

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('CONFLICTED');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
    expect(saved?.lastSyncAt).not.toBeNull();
    expect((saved?.lastSyncAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  test('a concurrent pull marking the row CONFLICTED between load and save is not overwritten', async () => {
    // Simulate the race: a pull commits CONFLICTED while this refresh is mid-flight (after it has
    // loaded the UP_TO_DATE row, before it writes back its derived status). The fetch/behind-ahead
    // say (0,0) → derived UP_TO_DATE, which must NOT clobber the concurrently written conflict.
    const harness = await buildHarness({ initialSyncStatus: 'UP_TO_DATE' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 0 });

    // getBehindAhead runs after the use case's load and before its save — inject the concurrent
    // pull's CONFLICTED write there.
    const originalGetBehindAhead = harness.commandRunner.getBehindAhead.bind(harness.commandRunner);
    harness.commandRunner.getBehindAhead = async (projectId, branch) => {
      const current = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
      if (current) {
        await harness.gitRepositoryRepo.save(
          new GitRepository(
            current.id,
            current.projectId,
            current.provider,
            current.remoteUrl,
            current.credentialReference,
            current.currentBranch,
            'CONFLICTED',
            current.defaultBranch,
            current.lastKnownRemoteHead,
            current.lastSyncAt,
            current.createdAt,
            current.connectedByUserId,
          ),
        );
      }
      return originalGetBehindAhead(projectId, branch);
    };

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The returned status reflects what was actually persisted: because the conditional save was
    // blocked (0 rows affected) by the concurrently written conflict, the use case reports
    // CONFLICTED, not the derived UP_TO_DATE it tried and failed to write.
    expect(result.value.syncStatus).toBe('CONFLICTED');
    // The row the concurrent pull wrote survives — the background refresh does not clear the conflict.
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('CONFLICTED');
  });

  test('a conflict resolved between load and save is not re-asserted CONFLICTED by the refresh', async () => {
    // The refresh loads a CONFLICTED row (so it intends to preserve CONFLICTED), then during its
    // multi-second fetch a concurrent complete-merge RESOLVES the conflict (CONFLICTED → UP_TO_DATE).
    // The observed-status guard must stop the refresh from re-asserting CONFLICTED over the resolved
    // row: the write is blocked (stored status no longer matches the observed CONFLICTED), the use
    // case re-reads, finds a non-conflicted row, and reports the derived status instead.
    const harness = await buildHarness({ initialSyncStatus: 'CONFLICTED' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 0 });

    // getBehindAhead runs after the use case's load and before its save — inject the concurrent
    // resolve there.
    const originalGetBehindAhead = harness.commandRunner.getBehindAhead.bind(harness.commandRunner);
    harness.commandRunner.getBehindAhead = async (projectId, branch) => {
      const current = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
      if (current) {
        await harness.gitRepositoryRepo.save(
          new GitRepository(
            current.id,
            current.projectId,
            current.provider,
            current.remoteUrl,
            current.credentialReference,
            current.currentBranch,
            'UP_TO_DATE',
            current.defaultBranch,
            current.lastKnownRemoteHead,
            current.lastSyncAt,
            current.createdAt,
            current.connectedByUserId,
          ),
        );
      }
      return originalGetBehindAhead(projectId, branch);
    };

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The stale CONFLICTED re-assert was dropped; the use case re-read and reported derived UP_TO_DATE.
    expect(result.value.syncStatus).toBe('UP_TO_DATE');
    // The concurrently resolved row survives — the refresh did not stomp it back to CONFLICTED.
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
  });

  test('a repository disconnected mid-refresh (row gone at save) does NOT report CONFLICTED', async () => {
    // The refresh loads the connected row, then during its multi-second fetch the repository is
    // disconnected/deleted. Its conditional save now matches no row and returns false — but that
    // false means "row gone", not "a concurrent conflict blocked the write". The use case must
    // re-read, find no row, and report the derived status, NOT misreport a DISCONNECTED repo as
    // CONFLICTED.
    const harness = await buildHarness({ initialSyncStatus: 'UP_TO_DATE' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 4, ahead: 0 });

    // getBehindAhead runs after the use case's load and before its save — delete the row there to
    // simulate a concurrent disconnect.
    const originalGetBehindAhead = harness.commandRunner.getBehindAhead.bind(harness.commandRunner);
    harness.commandRunner.getBehindAhead = async (projectId, branch) => {
      await harness.gitRepositoryRepo.delete(REPO_ID);
      return originalGetBehindAhead(projectId, branch);
    };

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Derived from (4, 0) → BEHIND, reported honestly; NOT CONFLICTED.
    expect(result.value.syncStatus).toBe('BEHIND');
    expect(result.value.syncStatus).not.toBe('CONFLICTED');
    // The row really is gone — the disconnect stands, and the refresh did not resurrect it.
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved).toBeNull();
  });

  test('a concurrent branch switch between load and save is not clobbered by the refresh', async () => {
    // The refresh loads the row (currentBranch 'main'), then during its multi-second fetch a user
    // switches the branch to 'develop'. The refresh must persist ONLY its observed sync fields and
    // leave currentBranch as the concurrently written 'develop' — never revert it to the stale
    // 'main' it loaded.
    const harness = await buildHarness({ initialSyncStatus: 'UP_TO_DATE' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(PROJECT_ID, { behind: 2, ahead: 0 });

    // getBehindAhead runs after the use case's load and before its save — inject the concurrent
    // branch switch there.
    const originalGetBehindAhead = harness.commandRunner.getBehindAhead.bind(harness.commandRunner);
    harness.commandRunner.getBehindAhead = async (projectId, branch) => {
      const current = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
      if (current) {
        await harness.gitRepositoryRepo.save(
          new GitRepository(
            current.id,
            current.projectId,
            current.provider,
            current.remoteUrl,
            current.credentialReference,
            'develop',
            current.syncStatus,
            current.defaultBranch,
            current.lastKnownRemoteHead,
            current.lastSyncAt,
            current.createdAt,
            current.connectedByUserId,
          ),
        );
      }
      return originalGetBehindAhead(projectId, branch);
    };

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(true);
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    // The concurrent branch switch survives, and the refresh's own sync fields still landed.
    expect(saved?.currentBranch).toBe('develop');
    expect(saved?.syncStatus).toBe('BEHIND');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
  });

  test('a fetch failure propagates; getBehindAhead is never called and the row is not updated', async () => {
    const harness = await buildHarness({ initialSyncStatus: 'UP_TO_DATE' });
    harness.commandRunner.seedFetchFailure(PROJECT_ID, new RepositoryUnreachableError());

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(harness.commandRunner.behindAheadCalls).toHaveLength(0);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
    expect(saved?.lastKnownRemoteHead).toBe('previous-head-commit-hash');
  });

  test('a getBehindAhead failure propagates', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    const failure = new GitCommandFailedError('git rev-list failed');
    harness.commandRunner.seedBehindAheadFailure(PROJECT_ID, failure);

    const result = await harness.useCase.execute(refreshInput());

    expect(result).toEqual({ success: false, error: failure });
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError before any git call', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute(refreshInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
    expect(harness.commandRunner.behindAheadCalls).toHaveLength(0);
  });

  test('fetch is called with the row\'s remoteUrl and branch and the passed token', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });

    await harness.useCase.execute(refreshInput());

    expect(harness.commandRunner.fetchCalls).toHaveLength(1);
    expect(harness.commandRunner.fetchCalls[0].input).toEqual({
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: CURRENT_BRANCH,
    });
  });
});
