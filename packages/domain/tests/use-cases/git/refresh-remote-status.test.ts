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
