import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  Project,
  ProjectId,
  ProjectName,
  RepositoryTooLargeError,
  RepositoryUnreachableError,
  UserId,
} from '@asciidocollab/domain';
import type { ClonedRepository, Logger } from '@asciidocollab/domain';
import {
  createImportHandler,
  IMPORT_CREDENTIAL_NOT_FOUND_ERROR_CODE,
  IMPORT_REPOSITORY_NOT_FOUND_ERROR_CODE,
} from '../../src/dispatch/import-handler.js';
import { InMemoryProjectRepository } from '../helpers/in-memory-project-repository.js';
import { InMemoryProjectMemberRepository } from '../helpers/in-memory-project-member-repository.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryFileNodeRepository } from '../helpers/in-memory-file-node-repository.js';
import { InMemoryDocumentRepository } from '../helpers/in-memory-document-repository.js';
import { InMemoryAssetRepository } from '../helpers/in-memory-asset-repository.js';
import { InMemoryProjectFileStore } from '../helpers/in-memory-project-file-store.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { InMemoryAuditLogRepository } from '../helpers/in-memory-audit-log-repository.js';
import { FakeImportCredentialSource } from '../helpers/fake-import-credential-source.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

const CLONED_REPOSITORY: ClonedRepository = {
  defaultBranch: 'main',
  headCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  entries: [{ path: 'index.adoc', content: Buffer.from('= Handbook\n', 'utf8'), mimeType: 'text/asciidoc' }],
};

/** A spying fake for the domain `Logger` port: records every call so a test can assert on it. */
class SpyLogger implements Logger {
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

function buildHarness() {
  const projectRepository = new InMemoryProjectRepository();
  const fileNodeRepository = new InMemoryFileNodeRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const assetRepository = new InMemoryAssetRepository();
  const fileStore = new InMemoryProjectFileStore();
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const projectMemberRepository = new InMemoryProjectMemberRepository();
  const auditLogRepository = new InMemoryAuditLogRepository();
  const credentialSource = new FakeImportCredentialSource();
  const logger = new SpyLogger();

  const handler = createImportHandler({
    projectRepository,
    fileNodeRepository,
    documentRepository,
    assetRepository,
    fileStore,
    gitRepositoryRepository,
    commandRunner,
    projectMemberRepository,
    auditLogRepository,
    credentialSource,
    logger,
  });

  return {
    handler,
    projectRepository,
    fileNodeRepository,
    documentRepository,
    assetRepository,
    fileStore,
    gitRepositoryRepository,
    commandRunner,
    projectMemberRepository,
    auditLogRepository,
    credentialSource,
    logger,
  };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued import. */
function buildImportOperation(projectId: ProjectId, branch: string | null = null): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'IMPORT', 'RUNNING', ACTOR_ID, branch);
}

/**
 * Seeds the fakes with exactly what the route allocates synchronously before enqueuing an
 * IMPORT operation: a memberless `Project` row, its pre-import `GitRepository` link, and a
 * decryptable stored credential.
 */
function seedPendingImport(
  harness: ReturnType<typeof buildHarness>,
  projectId: ProjectId,
): void {
  void harness.projectRepository.save(new Project(projectId, ProjectName.create('Handbook'), null, [], null));
  void harness.gitRepositoryRepository.save(
    new GitRepository(
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
      ACTOR_ID,
    ),
  );
  harness.credentialSource.seed(projectId, TOKEN);
}

describe('createImportHandler', () => {
  test('happy path: succeeds, grants owner membership, and materializes the tree', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'succeeded' });

    const membership = await harness.projectMemberRepository.findByCompositeKey(projectId, ACTOR_ID);
    expect(membership?.role.value).toBe('owner');

    const nodes = await harness.fileNodeRepository.findByProjectId(projectId);
    const paths = nodes.map((node) => node.path.value).toSorted();
    expect(paths).toEqual(['/', '/index.adoc']);

    expect(harness.commandRunner.cloneCalls).toEqual([{ remoteUrl: REMOTE_URL, token: TOKEN, branch: undefined }]);
  });

  test('clone failure (repository unreachable) fails with the mapped safe code and grants no membership', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedCloneFailure(REMOTE_URL, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
    expect(await harness.projectMemberRepository.findByCompositeKey(projectId, ACTOR_ID)).toBeNull();
  });

  test('clone failure (authentication failed) fails with the mapped safe code and grants no membership', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedCloneFailure(REMOTE_URL, new AuthenticationFailedError());

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
    expect(await harness.projectMemberRepository.findByCompositeKey(projectId, ACTOR_ID)).toBeNull();
  });

  test('clone failure (repository too large) fails with the mapped safe code and grants no membership', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedCloneFailure(REMOTE_URL, new RepositoryTooLargeError());

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_too_large' });
    expect(await harness.projectMemberRepository.findByCompositeKey(projectId, ACTOR_ID)).toBeNull();
  });

  test('missing GitRepository row fails without throwing, and never attempts a clone', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    // No seedPendingImport call: the GitRepository row a route should have created is absent.

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: IMPORT_REPOSITORY_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.cloneCalls).toHaveLength(0);
  });

  test('missing stored credential fails without throwing, and never attempts a clone', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    void harness.projectRepository.save(new Project(projectId, ProjectName.create('Handbook'), null, [], null));
    void harness.gitRepositoryRepository.save(
      new GitRepository(
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
        ACTOR_ID,
      ),
    );
    // No credentialSource.seed call: the stored credential a route should have written is absent.

    const outcome = await harness.handler(buildImportOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: IMPORT_CREDENTIAL_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.cloneCalls).toHaveLength(0);
  });

  test('the decrypted token never appears in any logged output', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    await harness.handler(buildImportOperation(projectId));

    for (const warning of harness.logger.warnings) {
      expect(warning.message).not.toContain(TOKEN);
      expect(JSON.stringify(warning.meta ?? {})).not.toContain(TOKEN);
    }
  });

  test('passes the operation branch through to the clone call', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    seedPendingImport(harness, projectId);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    await harness.handler(buildImportOperation(projectId, 'develop'));

    expect(harness.commandRunner.cloneCalls).toEqual([{ remoteUrl: REMOTE_URL, token: TOKEN, branch: 'develop' }]);
  });
});
