import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  ProjectMember,
  RemoteAlreadyInitializedError,
  RepositoryUnreachableError,
  Role,
  UserId,
} from '@asciidocollab/domain';
import type { GitInitializeOutcome, Logger } from '@asciidocollab/domain';
import {
  createInitializeHandler,
  INITIALIZE_CREDENTIAL_NOT_FOUND_ERROR_CODE,
  INITIALIZE_FAILED_ERROR_CODE,
  INITIALIZE_REPOSITORY_NOT_FOUND_ERROR_CODE,
} from '../../src/dispatch/initialize-handler.js';
import { InMemoryProjectMemberRepository } from '../helpers/in-memory-project-member-repository.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryGitOperationRepository } from '../helpers/in-memory-git-operation-repository.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { InMemoryAuditLogRepository } from '../helpers/in-memory-audit-log-repository.js';
import { FakeInitializeCredentialSource } from '../helpers/fake-initialize-credential-source.js';

const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

const PUBLISH_OUTCOME: GitInitializeOutcome = {
  headCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  defaultBranch: 'main',
};

/** A spying fake for the domain `Logger` port: records every call so a test can assert on it. */
class SpyLogger implements Logger {
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

function buildHarness() {
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepository = new InMemoryGitOperationRepository();
  const projectMemberRepository = new InMemoryProjectMemberRepository();
  const auditLogRepository = new InMemoryAuditLogRepository();
  const credentialSource = new FakeInitializeCredentialSource();
  const logger = new SpyLogger();

  const handler = createInitializeHandler({
    gitRepositoryRepository,
    commandRunner,
    gitOperationRepository,
    projectMemberRepository,
    auditLogRepository,
    credentialSource,
    logger,
  });

  return {
    handler,
    gitRepositoryRepository,
    commandRunner,
    gitOperationRepository,
    projectMemberRepository,
    auditLogRepository,
    credentialSource,
    logger,
  };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued initialize. */
function buildInitializeOperation(projectId: ProjectId, branch: string | null = null): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'INITIALIZE', 'RUNNING', OWNER_ID, branch);
}

/** Builds the placeholder `GitRepository` link a route would have pre-created before enqueuing. */
function buildPlaceholderRepository(projectId: ProjectId): GitRepository {
  return new GitRepository(
    GitRepositoryId.create(randomUUID()),
    projectId,
    GitProvider.create('github'),
    REMOTE_URL,
    projectId.value,
    'main',
    'DISCONNECTED',
    null,
    null,
    null,
    new Date(),
    OWNER_ID,
  );
}

/**
 * Seeds the fakes with exactly what a route allocates synchronously before enqueuing an
 * INITIALIZE operation: the actor's OWNER membership, the pre-created `GitRepository`
 * placeholder link, and a decryptable stored credential.
 */
async function seedPendingInitialize(
  harness: ReturnType<typeof buildHarness>,
  projectId: ProjectId,
): Promise<GitRepository> {
  await harness.projectMemberRepository.addMember(
    new ProjectMember(projectId, OWNER_ID, Role.create('owner'), new Date()),
  );
  const placeholder = buildPlaceholderRepository(projectId);
  await harness.gitRepositoryRepository.save(placeholder);
  harness.credentialSource.seed(projectId, TOKEN);
  return placeholder;
}

describe('createInitializeHandler', () => {
  test('happy path: publishes, and the repository link is completed in place', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    const placeholder = await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublish(projectId, PUBLISH_OUTCOME);

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'succeeded' });

    const repository = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(repository?.id.value).toBe(placeholder.id.value);
    expect(repository?.syncStatus).toBe('UP_TO_DATE');
    expect(repository?.lastKnownRemoteHead).toBe(PUBLISH_OUTCOME.headCommit);
    expect(repository?.defaultBranch).toBe(PUBLISH_OUTCOME.defaultBranch);

    expect(harness.commandRunner.initializeAndPublishCalls).toEqual([
      { projectId, input: { remoteUrl: REMOTE_URL, token: TOKEN, branch: undefined } },
    ]);
    // Nothing was deleted on a successful run.
    expect(harness.credentialSource.deleteCalls).toHaveLength(0);
  });

  test('remote already has commits: fails with the mapped code, and removes the placeholder row and credential', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublishFailure(projectId, new RemoteAlreadyInitializedError());

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'remote_already_initialized' });
    expect(await harness.gitRepositoryRepository.findByProjectId(projectId)).toBeNull();
    expect(harness.credentialSource.deleteCalls.map((id) => id.value)).toEqual([projectId.value]);
  });

  test('unreachable remote fails with the mapped code, and cleans up the placeholder row and credential', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublishFailure(projectId, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
    expect(await harness.gitRepositoryRepository.findByProjectId(projectId)).toBeNull();
  });

  test('authentication failure fails with the mapped code, and cleans up the placeholder row and credential', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublishFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
    expect(await harness.gitRepositoryRepository.findByProjectId(projectId)).toBeNull();
  });

  test('an actor without owner membership is refused, and the placeholder row/credential are still cleaned up', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    // Not seeding OWNER membership at all — requireGitRole denies non-members outright.
    const placeholder = buildPlaceholderRepository(projectId);
    await harness.gitRepositoryRepository.save(placeholder);
    harness.credentialSource.seed(projectId, TOKEN);

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: INITIALIZE_FAILED_ERROR_CODE });
    expect(await harness.gitRepositoryRepository.findByProjectId(projectId)).toBeNull();
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('missing GitRepository placeholder row fails without throwing, and never runs the publish', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    // No seedPendingInitialize call: the placeholder row a route should have created is absent.

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: INITIALIZE_REPOSITORY_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('missing stored credential fails without throwing, and never runs the publish', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await harness.projectMemberRepository.addMember(
      new ProjectMember(projectId, OWNER_ID, Role.create('owner'), new Date()),
    );
    await harness.gitRepositoryRepository.save(buildPlaceholderRepository(projectId));
    // No credentialSource.seed call: the stored credential a route should have written is absent.

    const outcome = await harness.handler(buildInitializeOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: INITIALIZE_CREDENTIAL_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('the decrypted token never appears in any logged output', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublish(projectId, PUBLISH_OUTCOME);

    await harness.handler(buildInitializeOperation(projectId));

    for (const warning of harness.logger.warnings) {
      expect(warning.message).not.toContain(TOKEN);
      expect(JSON.stringify(warning.meta ?? {})).not.toContain(TOKEN);
    }
  });

  test('regression: a claimed operation (already RUNNING in the repository, as the run loop leaves it before dispatch) does not self-conflict with its own withGuard call', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublish(projectId, PUBLISH_OUTCOME);

    // Mirrors the real run loop: enqueue, then claim into RUNNING, so the operation the handler
    // receives is the SAME row `withGuard`'s active-operation check would otherwise find and treat
    // as a conflicting in-flight action.
    await harness.gitOperationRepository.enqueue({ projectId, kind: 'INITIALIZE', triggeredByUserId: OWNER_ID });
    const claimed = await harness.gitOperationRepository.claimNextQueued(30_000);
    expect(claimed?.state).toBe('RUNNING'); // sanity

    const outcome = await harness.handler(claimed!);

    expect(outcome).toEqual({ kind: 'succeeded' });
  });

  test('passes the operation branch through to the publish call', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingInitialize(harness, projectId);
    harness.commandRunner.seedInitializeAndPublish(projectId, { ...PUBLISH_OUTCOME, defaultBranch: 'trunk' });

    await harness.handler(buildInitializeOperation(projectId, 'trunk'));

    expect(harness.commandRunner.initializeAndPublishCalls).toEqual([
      { projectId, input: { remoteUrl: REMOTE_URL, token: TOKEN, branch: 'trunk' } },
    ]);
  });
});
