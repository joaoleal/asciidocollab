import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  NonFastForwardError,
  ProjectId,
  ProjectMember,
  Role,
  RepositoryUnreachableError,
  UserId,
} from '@asciidocollab/domain';
import type { Logger } from '@asciidocollab/domain';
import {
  createPushHandler,
  PUSH_CREDENTIAL_NOT_FOUND_ERROR_CODE,
  PUSH_REPOSITORY_NOT_FOUND_ERROR_CODE,
} from '../../src/dispatch/push-handler.js';
import { InMemoryProjectMemberRepository } from '../helpers/in-memory-project-member-repository.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { InMemoryAuditLogRepository } from '../helpers/in-memory-audit-log-repository.js';
import { FakePushCredentialSource } from '../helpers/fake-push-credential-source.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const CURRENT_BRANCH = 'main';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
const NEW_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** A spying fake for the domain `Logger` port: records every call so a test can assert on it. */
class SpyLogger implements Logger {
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

function buildHarness() {
  const projectMemberRepository = new InMemoryProjectMemberRepository();
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const auditLogRepository = new InMemoryAuditLogRepository();
  const credentialSource = new FakePushCredentialSource();
  const logger = new SpyLogger();

  const handler = createPushHandler({
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    commandRunner,
    credentialSource,
    logger,
  });

  return {
    handler,
    projectMemberRepository,
    gitRepositoryRepository,
    commandRunner,
    auditLogRepository,
    credentialSource,
    logger,
  };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued push. */
function buildPushOperation(projectId: ProjectId): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'PUSH', 'RUNNING', ACTOR_ID, null);
}

/**
 * Seeds the fakes with exactly what a prior CONNECT/COMMIT already put in place before the route
 * enqueued a PUSH operation: a connected `GitRepository` link, an editor membership, and a
 * decryptable stored credential.
 */
async function seedPendingPush(harness: ReturnType<typeof buildHarness>, projectId: ProjectId): Promise<void> {
  await harness.projectMemberRepository.addMember(new ProjectMember(projectId, ACTOR_ID, Role.create('editor')));
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
      'previous-head-commit-hash',
      null,
      new Date('2024-01-01T00:00:00.000Z'),
      ACTOR_ID,
    ),
  );
  harness.credentialSource.seed(projectId, TOKEN);
}

describe('createPushHandler', () => {
  test('happy path: succeeds and pushes with the decrypted token', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPush(harness, projectId);
    harness.commandRunner.seedPush(projectId, { headCommit: NEW_HEAD });

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(harness.commandRunner.pushCalls).toEqual([
      { projectId, input: { remoteUrl: REMOTE_URL, token: TOKEN, branch: CURRENT_BRANCH } },
    ]);

    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.lastKnownRemoteHead).toBe(NEW_HEAD);
  });

  test('non-fast-forward rejection fails with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPush(harness, projectId);
    harness.commandRunner.seedPushFailure(projectId, new NonFastForwardError());

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'non_fast_forward' });
  });

  test('unreachable remote fails with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPush(harness, projectId);
    harness.commandRunner.seedPushFailure(projectId, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
  });

  test('rejected credential fails with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPush(harness, projectId);
    harness.commandRunner.seedPushFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
  });

  test('missing GitRepository row fails without throwing, and never attempts a push', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    // No seedPendingPush call: the GitRepository row a route/prior CONNECT should have created is absent.

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PUSH_REPOSITORY_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.pushCalls).toHaveLength(0);
  });

  test('missing stored credential fails without throwing, and never attempts a push', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await harness.projectMemberRepository.addMember(new ProjectMember(projectId, ACTOR_ID, Role.create('editor')));
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
        'previous-head-commit-hash',
        null,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
    // No credentialSource.seed call: the stored credential a route should have written is absent.

    const outcome = await harness.handler(buildPushOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PUSH_CREDENTIAL_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.pushCalls).toHaveLength(0);
  });

  test('the decrypted token never appears in any logged output', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPush(harness, projectId);
    harness.commandRunner.seedPush(projectId, { headCommit: NEW_HEAD });

    await harness.handler(buildPushOperation(projectId));

    for (const warning of harness.logger.warnings) {
      expect(warning.message).not.toContain(TOKEN);
      expect(JSON.stringify(warning.meta ?? {})).not.toContain(TOKEN);
    }
  });
});
