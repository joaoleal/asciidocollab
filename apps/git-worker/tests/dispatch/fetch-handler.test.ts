import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  type GitSyncStatus,
  ProjectId,
  RepositoryUnreachableError,
  UserId,
} from '@asciidocollab/domain';
import {
  createFetchHandler,
  FETCH_CREDENTIAL_NOT_FOUND_ERROR_CODE,
  FETCH_FAILED_ERROR_CODE,
  FETCH_REPOSITORY_NOT_FOUND_ERROR_CODE,
} from '../../src/dispatch/fetch-handler.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { FakePushCredentialSource } from '../helpers/fake-push-credential-source.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const CURRENT_BRANCH = 'main';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
const REMOTE_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** A spying fake for the domain `Logger` port: records every call so a test can assert on it. */
class SpyLogger {
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

function buildHarness() {
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const credentialSource = new FakePushCredentialSource();
  const logger = new SpyLogger();

  const handler = createFetchHandler({
    gitRepositoryRepository,
    commandRunner,
    credentialSource,
    logger,
  });

  return { handler, gitRepositoryRepository, commandRunner, credentialSource, logger };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued background FETCH. */
function buildFetchOperation(projectId: ProjectId): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'FETCH', 'RUNNING', ACTOR_ID, null);
}

/** Seeds a connected `GitRepository` link and its decryptable stored credential (what CONNECT left behind). */
async function seedConnected(
  harness: ReturnType<typeof buildHarness>,
  projectId: ProjectId,
  syncStatus: GitSyncStatus = 'UP_TO_DATE',
): Promise<void> {
  await harness.gitRepositoryRepository.save(
    new GitRepository(
      GitRepositoryId.create(randomUUID()),
      projectId,
      GitProvider.create('github'),
      REMOTE_URL,
      projectId.value,
      CURRENT_BRANCH,
      syncStatus,
      'main',
      'previous-remote-head-commit-hash',
      null,
      new Date('2024-01-01T00:00:00.000Z'),
      ACTOR_ID,
    ),
  );
  harness.credentialSource.seed(projectId, TOKEN);
}

describe('createFetchHandler', () => {
  test('a successful refresh succeeds and advances the stored sync status', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(projectId, { behind: 2, ahead: 0 });

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(harness.commandRunner.fetchCalls).toEqual([
      { projectId, input: { remoteUrl: REMOTE_URL, token: TOKEN, branch: CURRENT_BRANCH } },
    ]);
    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.syncStatus).toBe('BEHIND');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
  });

  test('missing GitRepository row fails without throwing, and never attempts a fetch', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: FETCH_REPOSITORY_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });

  test('missing stored credential fails without throwing, and never attempts a fetch', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await harness.gitRepositoryRepository.save(
      new GitRepository(
        GitRepositoryId.create(randomUUID()),
        projectId,
        GitProvider.create('github'),
        REMOTE_URL,
        projectId.value,
        CURRENT_BRANCH,
        'UP_TO_DATE',
        'main',
        'previous-remote-head-commit-hash',
        null,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
    // No credentialSource.seed call.

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: FETCH_CREDENTIAL_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });

  test('an unreachable remote fails the fetch with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
  });

  test('a rejected credential fails the fetch with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
  });

  test('a rejected credential marks the repository NEEDS_REAUTH so the sweep skips it until it is rotated', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.syncStatus).toBe('NEEDS_REAUTH');
  });

  test('a non-auth failure leaves the stored sync status untouched', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
  });

  test('an auth failure never overrides a CONFLICTED repository — the conflict outranks a re-auth prompt', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId, 'CONFLICTED');
    harness.commandRunner.seedFetchFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.syncStatus).toBe('CONFLICTED');
  });

  test('a rejected credential while the repository row is deleted mid-fetch does not throw and never recreates the row', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new AuthenticationFailedError());
    // Simulates the row being disconnected/deleted during the multi-second `fetch` call: by the
    // time the handler's post-failure write runs, there is no row left to mark. It must not throw
    // and — being a conditional `updateMany`-style write, never an upsert — must not recreate one.
    const originalFetch = harness.commandRunner.fetch.bind(harness.commandRunner);
    jest.spyOn(harness.commandRunner, 'fetch').mockImplementationOnce(async (id, input) => {
      const stored = await harness.gitRepositoryRepository.findByProjectId(id);
      await harness.gitRepositoryRepository.delete(stored!.id);
      return originalFetch(id, input);
    });

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved).toBeNull();
  });

  test('a generic fetch failure falls back to the stable failure code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new GitCommandFailedError('fetch failed'));

    const outcome = await harness.handler(buildFetchOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: FETCH_FAILED_ERROR_CODE });
  });

  test('the decrypted token reaches the fetch call but never appears in any logged output', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedConnected(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedBehindAhead(projectId, { behind: 0, ahead: 0 });

    await harness.handler(buildFetchOperation(projectId));

    expect(harness.commandRunner.fetchCalls[0]?.input.token).toBe(TOKEN);
    for (const warning of harness.logger.warnings) {
      expect(warning.message).not.toContain(TOKEN);
      expect(JSON.stringify(warning.meta ?? {})).not.toContain(TOKEN);
    }
  });
});
