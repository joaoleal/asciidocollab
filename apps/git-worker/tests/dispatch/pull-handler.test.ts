import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  ProjectMember,
  Role,
  RepositoryUnreachableError,
  UserId,
} from '@asciidocollab/domain';
import type { DomainError, FileChangeReconciler, GitChangeReconcileResult, GitMergeFileChange, GitReconcileAnomaly, Logger, Result } from '@asciidocollab/domain';
import {
  createPullHandler,
  PULL_CREDENTIAL_NOT_FOUND_ERROR_CODE,
  PULL_FAILED_ERROR_CODE,
  PULL_REPOSITORY_NOT_FOUND_ERROR_CODE,
} from '../../src/dispatch/pull-handler.js';
import { InMemoryProjectMemberRepository } from '../helpers/in-memory-project-member-repository.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { InMemoryAuditLogRepository } from '../helpers/in-memory-audit-log-repository.js';
import { InMemoryGitOperationRepository } from '../helpers/in-memory-git-operation-repository.js';
import { InMemoryFileNodeRepository } from '../helpers/in-memory-file-node-repository.js';
import { InMemoryDocumentRepository } from '../helpers/in-memory-document-repository.js';
import { InMemoryCollaborationSessionRepository } from '../helpers/in-memory-collaboration-session-repository.js';
import { FakePushCredentialSource } from '../helpers/fake-push-credential-source.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const CURRENT_BRANCH = 'main';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
const REMOTE_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** A spying fake for the domain `Logger` port: records every call so a test can assert on it. */
class SpyLogger implements Logger {
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

/**
 * A structural `FileChangeReconciler` test double: always lands the merge cleanly, recording every
 * call it received so a test can assert the handler wired it through. The reconciler's own landing
 * logic is `GitChangeReconciler`'s concern, already covered where that class is built — this stub
 * exists only so the handler test can stay focused on outcome mapping.
 */
class StubReconciler implements FileChangeReconciler {
  readonly calls: Array<{ projectId: ProjectId; changes: readonly GitMergeFileChange[] }> = [];
  /** Anomalies the next apply reports back, so a test can exercise the drift-summary path. */
  anomaliesToReturn: readonly GitReconcileAnomaly[] = [];

  async apply(
    projectId: ProjectId,
    changes: readonly GitMergeFileChange[],
  ): Promise<Result<GitChangeReconcileResult, DomainError>> {
    this.calls.push({ projectId, changes });
    return {
      success: true,
      value: {
        changedPaths: changes.map((change) => ('path' in change ? change.path : change.toPath)),
        anomalies: this.anomaliesToReturn,
      },
    };
  }
}

function buildHarness() {
  const projectMemberRepository = new InMemoryProjectMemberRepository();
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const gitOperationRepository = new InMemoryGitOperationRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const auditLogRepository = new InMemoryAuditLogRepository();
  const fileNodeRepository = new InMemoryFileNodeRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const collaborationSessionRepository = new InMemoryCollaborationSessionRepository();
  const collaborativeContentReader = {
    readContent: async () => {
      throw new Error('not used by these tests: no active collaboration session is ever seeded');
    },
  };
  const reconciler = new StubReconciler();
  const credentialSource = new FakePushCredentialSource();
  const logger = new SpyLogger();

  const handler = createPullHandler({
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    commandRunner,
    fileNodeRepository,
    documentRepository,
    collaborativeContentReader,
    collaborationSessionRepository,
    reconciler,
    credentialSource,
    logger,
  });

  return {
    handler,
    projectMemberRepository,
    gitRepositoryRepository,
    commandRunner,
    auditLogRepository,
    reconciler,
    credentialSource,
    logger,
  };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued pull. */
function buildPullOperation(projectId: ProjectId): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'PULL', 'RUNNING', ACTOR_ID, null);
}

/**
 * Seeds the fakes with exactly what a prior CONNECT already put in place before the route enqueued a
 * PULL operation: a connected `GitRepository` link, an editor membership, and a decryptable stored
 * credential.
 */
async function seedPendingPull(harness: ReturnType<typeof buildHarness>, projectId: ProjectId): Promise<void> {
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
      'previous-remote-head-commit-hash',
      null,
      new Date('2024-01-01T00:00:00.000Z'),
      ACTOR_ID,
    ),
  );
  harness.credentialSource.seed(projectId, TOKEN);
}

describe('createPullHandler', () => {
  test('a clean merge succeeds and lands the change-set through the reconciler', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(projectId, {
      status: 'merged',
      headCommit: REMOTE_HEAD,
      changes: [{ type: 'added', path: 'docs/new-page.adoc', content: Buffer.from('content'), mimeType: 'text/asciidoc' }],
    });

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(harness.reconciler.calls).toHaveLength(1);
  });

  test('a clean merge whose reconcile hit drift carries a drift summary on the succeeded outcome', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(projectId, {
      status: 'merged',
      headCommit: REMOTE_HEAD,
      changes: [{ type: 'modified', path: 'docs', content: Buffer.from('content'), mimeType: 'text/asciidoc' }],
    });
    harness.reconciler.anomaliesToReturn = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
      { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true, message: 'created' },
    ];

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({
      kind: 'succeeded',
      driftSummary: {
        total: 2,
        droppedCount: 1,
        anomalies: [
          { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
          { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
        ],
      },
    });
  });

  test('fetch is invoked once for a clean merge', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(projectId, {
      status: 'merged',
      headCommit: REMOTE_HEAD,
      changes: [{ type: 'added', path: 'docs/new-page.adoc', content: Buffer.from('content'), mimeType: 'text/asciidoc' }],
    });

    await harness.handler(buildPullOperation(projectId));

    expect(harness.commandRunner.fetchCalls).toEqual([
      { projectId, input: { remoteUrl: REMOTE_URL, token: TOKEN, branch: CURRENT_BRANCH } },
    ]);

    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
  });

  test('a conflicted merge reports awaitingConflict, not a failure', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(projectId, {
      status: 'conflicted',
      conflicts: [{ path: 'docs/shared-page.adoc', isBinary: false }],
    });

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'awaitingConflict' });
    expect(harness.reconciler.calls).toHaveLength(0);
  });

  test('missing GitRepository row fails without throwing, and never attempts a fetch', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    // No seedPendingPull call: the GitRepository row a route/prior CONNECT should have created is absent.

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PULL_REPOSITORY_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });

  test('missing stored credential fails without throwing, and never attempts a fetch', async () => {
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
        'previous-remote-head-commit-hash',
        null,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
    // No credentialSource.seed call: the stored credential a route should have written is absent.

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PULL_CREDENTIAL_NOT_FOUND_ERROR_CODE });
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });

  test('an unreachable remote fails the fetch with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new RepositoryUnreachableError());

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'repository_unreachable' });
  });

  test('a rejected credential fails the fetch with the mapped safe code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new AuthenticationFailedError());

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: 'authentication_failed' });
  });

  test('a generic fetch failure falls back to the stable failure code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetchFailure(projectId, new GitCommandFailedError('fetch failed'));

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PULL_FAILED_ERROR_CODE });
  });

  test('a generic merge failure falls back to the stable failure code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMergeFailure(projectId, new GitCommandFailedError('merge failed'));

    const outcome = await harness.handler(buildPullOperation(projectId));

    expect(outcome).toEqual({ kind: 'failed', errorCode: PULL_FAILED_ERROR_CODE });
  });

  test('the decrypted token reaches the fetch call but never appears in any logged output', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingPull(harness, projectId);
    harness.commandRunner.seedFetch(projectId, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(projectId, { status: 'merged', headCommit: REMOTE_HEAD, changes: [] });

    await harness.handler(buildPullOperation(projectId));

    expect(harness.commandRunner.fetchCalls[0]?.input.token).toBe(TOKEN);
    for (const warning of harness.logger.warnings) {
      expect(warning.message).not.toContain(TOKEN);
      expect(JSON.stringify(warning.meta ?? {})).not.toContain(TOKEN);
    }
  });
});
