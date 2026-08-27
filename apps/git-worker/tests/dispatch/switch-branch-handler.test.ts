import { randomUUID } from 'crypto';
import {
  GitCommandFailedError,
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  ProjectMember,
  Role,
  UserId,
} from '@asciidocollab/domain';
import type { DomainError, FileChangeReconciler, GitMergeFileChange, GitReconcileAnomaly, Result } from '@asciidocollab/domain';
import {
  createSwitchBranchHandler,
  SWITCH_BRANCH_MISSING_ERROR_CODE,
  SWITCH_FAILED_ERROR_CODE,
} from '../../src/dispatch/switch-branch-handler.js';
import { InMemoryProjectMemberRepository } from '../helpers/in-memory-project-member-repository.js';
import { InMemoryGitRepositoryRepository } from '../helpers/in-memory-git-repository-repository.js';
import { InMemoryGitCommandRunner } from '../helpers/in-memory-git-command-runner.js';
import { InMemoryAuditLogRepository } from '../helpers/in-memory-audit-log-repository.js';
import { InMemoryGitOperationRepository } from '../helpers/in-memory-git-operation-repository.js';
import { InMemoryFileNodeRepository } from '../helpers/in-memory-file-node-repository.js';
import { InMemoryDocumentRepository } from '../helpers/in-memory-document-repository.js';
import { InMemoryCollaborationSessionRepository } from '../helpers/in-memory-collaboration-session-repository.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const CURRENT_BRANCH = 'main';
const TARGET_BRANCH = 'feature';

/** A `FileChangeReconciler` test double: lands cleanly, recording every call for assertions. */
class StubReconciler implements FileChangeReconciler {
  readonly calls: Array<{ projectId: ProjectId; changes: readonly GitMergeFileChange[] }> = [];
  /** Anomalies the next apply reports back, so a test can exercise the drift-summary path. */
  anomaliesToReturn: readonly GitReconcileAnomaly[] = [];

  async apply(
    projectId: ProjectId,
    changes: readonly GitMergeFileChange[],
  ): Promise<Result<{ changedPaths: readonly string[]; anomalies: readonly GitReconcileAnomaly[] }, DomainError>> {
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

  const handler = createSwitchBranchHandler({
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
  });

  return { handler, projectMemberRepository, gitRepositoryRepository, gitOperationRepository, commandRunner, reconciler };
}

/** Builds the `GitOperation` the run loop would have claimed for an enqueued switch. */
function buildSwitchOperation(projectId: ProjectId, branch: string | null): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), projectId, 'BRANCH_SWITCH', 'RUNNING', ACTOR_ID, branch);
}

/** Seeds an editor membership and a connected `GitRepository` link currently on `main`. */
async function seedPendingSwitch(harness: ReturnType<typeof buildHarness>, projectId: ProjectId): Promise<void> {
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
}

describe('createSwitchBranchHandler', () => {
  test('a clean switch succeeds, landing the change-set, with stashLocal true and the operation branch as target', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingSwitch(harness, projectId);
    harness.commandRunner.seedCheckout(projectId, {
      status: 'switched',
      headCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      changes: [{ type: 'added', path: 'feature.adoc', content: Buffer.from('feature only\n'), mimeType: 'text/asciidoc' }],
    });

    const outcome = await harness.handler(buildSwitchOperation(projectId, TARGET_BRANCH));

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(harness.reconciler.calls).toHaveLength(1);
    expect(harness.commandRunner.checkoutCalls).toHaveLength(1);
    expect(harness.commandRunner.checkoutCalls[0]?.input.branch).toBe(TARGET_BRANCH);
    expect(harness.commandRunner.checkoutCalls[0]?.input.stashLocal).toBe(true);

    const saved = await harness.gitRepositoryRepository.findByProjectId(projectId);
    expect(saved?.currentBranch).toBe(TARGET_BRANCH);
  });

  test('a switch that drops content surfaces a driftSummary on the succeeded outcome, mirroring pull', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingSwitch(harness, projectId);
    harness.commandRunner.seedCheckout(projectId, {
      status: 'switched',
      headCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      changes: [{ type: 'modified', path: 'docs', content: Buffer.from('content\n'), mimeType: 'text/asciidoc' }],
    });
    harness.reconciler.anomaliesToReturn = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
      { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true, message: 'created' },
    ];

    const outcome = await harness.handler(buildSwitchOperation(projectId, TARGET_BRANCH));

    // The drift rides out on the row exactly as a pull's does, so the triggering user is warned.
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

  test('a conflicted switch reports awaitingConflict, not a failure, and lands nothing', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingSwitch(harness, projectId);
    harness.commandRunner.seedCheckout(projectId, {
      status: 'conflicted',
      conflicts: [{ path: 'base.adoc', isBinary: false }],
    });

    const outcome = await harness.handler(buildSwitchOperation(projectId, TARGET_BRANCH));

    expect(outcome).toEqual({ kind: 'awaitingConflict' });
    expect(harness.reconciler.calls).toHaveLength(0);
  });

  test('a checkout command failure falls back to the stable failure code', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingSwitch(harness, projectId);
    harness.commandRunner.seedCheckoutFailure(projectId, new GitCommandFailedError('checkout failed'));

    const outcome = await harness.handler(buildSwitchOperation(projectId, TARGET_BRANCH));

    expect(outcome).toEqual({ kind: 'failed', errorCode: SWITCH_FAILED_ERROR_CODE });
  });

  test('a switch operation carrying no target branch fails without invoking the use case', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingSwitch(harness, projectId);

    const outcome = await harness.handler(buildSwitchOperation(projectId, null));

    expect(outcome).toEqual({ kind: 'failed', errorCode: SWITCH_BRANCH_MISSING_ERROR_CODE });
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
  });
});
