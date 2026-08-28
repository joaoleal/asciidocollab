import { SwitchBranchUseCase } from '../../../src/use-cases/git/switch-branch';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { LiveContentFlushFailedError } from '../../../src/errors/git/live-content-flush-failed';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { Role } from '../../../src/value-objects/identity/role';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import type { GitMergeFileChange, GitCheckoutOutcome } from '../../../src/ports/git/git-command-runner';
import type { FileChangeReconciler } from '../../../src/use-cases/git/pull-changes';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REPO_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099');
const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440077');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'main';
const TARGET_BRANCH = 'develop';
const SWITCH_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const PREVIOUS_HEAD = 'previous-head-commit-hash';
const LAST_SYNC_AT = new Date('2024-06-15T12:00:00.000Z');

const LIVE_PATH = 'chapters/intro.adoc';
const LIVE_TEXT = '= Introduction\nEdited live moments ago — héllo wörld';

const liveNode = new FileNode(
  FileNodeId.create('550e8400-e29b-41d4-a716-446655440020'),
  PROJECT_ID,
  FileNodeId.create('550e8400-e29b-41d4-a716-446655440010'),
  'intro.adoc',
  FileNodeType.create('file'),
  FilePath.create('/' + LIVE_PATH),
);
const liveDocument = new Document(
  DocumentId.create('550e8400-e29b-41d4-a716-446655440021'),
  liveNode.id,
  ContentId.create('550e8400-e29b-41d4-a716-446655440022'),
  YjsStateId.create('550e8400-e29b-41d4-a716-446655440023'),
  MimeType.create('text/asciidoc'),
);

// A document whose file node was removed from the tree while its collaborative room stayed open.
const danglingDocument = new Document(
  DocumentId.create('550e8400-e29b-41d4-a716-446655440031'),
  FileNodeId.create('550e8400-e29b-41d4-a716-446655440030'),
  ContentId.create('550e8400-e29b-41d4-a716-446655440032'),
  YjsStateId.create('550e8400-e29b-41d4-a716-446655440033'),
  MimeType.create('text/asciidoc'),
);
// An open room whose document row no longer exists at all.
const ORPHAN_DOCUMENT_ID = DocumentId.create('550e8400-e29b-41d4-a716-446655440041');

const SWITCH_CHANGES: readonly GitMergeFileChange[] = [
  { type: 'added', path: 'chapters/new.adoc', content: Buffer.from('= New', 'utf8'), mimeType: 'text/asciidoc' },
];
const CHANGED_PATHS = ['chapters/new.adoc'];

const SWITCHED_OUTCOME: GitCheckoutOutcome = { status: 'switched', headCommit: SWITCH_HEAD, changes: SWITCH_CHANGES };
const CONFLICTED_OUTCOME: GitCheckoutOutcome = {
  status: 'conflicted',
  conflicts: [
    { path: 'chapters/intro.adoc', isBinary: false },
    { path: 'assets/logo.png', isBinary: true },
  ],
};

function makeReader(
  result: { success: true; value: string | null } | { success: false; error: Error },
): CollaborativeContentReader {
  return { readContent: jest.fn().mockResolvedValue(result) };
}

function makeReconciler(): FileChangeReconciler & { apply: jest.Mock } {
  return {
    apply: jest.fn().mockResolvedValue({ success: true, value: { changedPaths: CHANGED_PATHS, anomalies: [] } }),
  };
}

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: SwitchBranchUseCase;
  commandRunner: InMemoryGitCommandRunner;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  reconciler: FileChangeReconciler & { apply: jest.Mock };
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
  reader?: CollaborativeContentReader;
  activeSession?: boolean;
  currentBranch?: string;
  /** When true, two extra open rooms are seeded whose document/file node no longer resolve. */
  danglingSessions?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    reader = makeReader({ success: true, value: LIVE_TEXT }),
    activeSession = true,
    currentBranch = CURRENT_BRANCH,
    danglingSessions = false,
  } = options;

  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const collaborationSessionRepo = new InMemoryCollaborationSessionRepository();
  const reconciler = makeReconciler();

  await fileNodeRepo.save(liveNode);
  await documentRepo.save(liveDocument);
  if (activeSession) {
    await collaborationSessionRepo.open(PROJECT_ID, liveDocument.id);
  }
  if (danglingSessions) {
    await collaborationSessionRepo.open(PROJECT_ID, ORPHAN_DOCUMENT_ID);
    await documentRepo.save(danglingDocument);
    await collaborationSessionRepo.open(PROJECT_ID, danglingDocument.id);
  }

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        REPO_ID,
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        currentBranch,
        'BEHIND',
        'main',
        PREVIOUS_HEAD,
        LAST_SYNC_AT,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
  }

  const useCase = new SwitchBranchUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
    fileNodeRepo,
    documentRepo,
    reader,
    collaborationSessionRepo,
    reconciler,
  );

  return { useCase, commandRunner, gitRepositoryRepo, gitOperationRepo, auditRepo, reconciler };
}

function switchInput(overrides: { targetBranch?: string; stashLocal?: boolean } = {}) {
  return {
    actorId: ACTOR_ID,
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    targetBranch: overrides.targetBranch ?? TARGET_BRANCH,
    stashLocal: overrides.stashLocal ?? true,
  };
}

describe('SwitchBranchUseCase', () => {
  test('a clean switch reconciles the change-set, refreshes the row to UP_TO_DATE on the target branch, and audits nothing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ status: 'switched', branch: TARGET_BRANCH, changedPaths: CHANGED_PATHS, anomalies: [] });

    // checkout received the target branch, the live flush, and the stash flag.
    expect(harness.commandRunner.checkoutCalls).toHaveLength(1);
    expect(harness.commandRunner.checkoutCalls[0].input).toEqual({
      branch: TARGET_BRANCH,
      flush: [{ path: LIVE_PATH, content: LIVE_TEXT }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    // The reconciler received the checkout's own change-set.
    expect(harness.reconciler.apply).toHaveBeenCalledTimes(1);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, SWITCH_CHANGES);

    // The row is refreshed: current branch is now the target, UP_TO_DATE, remote head cleared,
    // lastSyncAt untouched (a local switch is not a remote sync).
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.currentBranch).toBe(TARGET_BRANCH);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
    expect(saved?.lastKnownRemoteHead).toBeNull();
    expect(saved?.lastSyncAt).toEqual(LAST_SYNC_AT);
    // Untouched fields carry over from the loaded row.
    expect(saved?.remoteUrl).toBe(REMOTE_URL);

    // No success audit is emitted here — the git-worker run loop records the terminal SUCCEEDED audit.
    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(0);
  });

  test('records a git.branch_switch_partially_applied audit when the reconciler hit drift', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);
    const anomalies = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
    ];
    harness.reconciler.apply.mockResolvedValue({ success: true, value: { changedPaths: CHANGED_PATHS, anomalies } });

    await harness.useCase.execute(switchInput());

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('git.branch_switch_partially_applied');
    expect(audits[0]!.metadata).toMatchObject({ branch: TARGET_BRANCH, total: 1, droppedCount: 1 });
  });

  test('carries the reconciler anomalies out on a switched result so the handler can surface drift', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);
    const anomalies = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
    ];
    harness.reconciler.apply.mockResolvedValue({ success: true, value: { changedPaths: CHANGED_PATHS, anomalies } });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The admin audit is not the only surfacing: the drift also rides out on the result — otherwise the
    // handler could never populate the operation row and the triggering user would see nothing.
    expect(result.value).toEqual({
      status: 'switched',
      branch: TARGET_BRANCH,
      changedPaths: CHANGED_PATHS,
      anomalies,
    });
  });

  test('an active-session document is flushed into the checkout as a git-relative entry (no leading slash)', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    await harness.useCase.execute(switchInput());

    expect(harness.commandRunner.checkoutCalls).toHaveLength(1);
    expect(harness.commandRunner.checkoutCalls[0].input.branch).toBe(TARGET_BRANCH);
    expect(harness.commandRunner.checkoutCalls[0].input.flush).toEqual([{ path: LIVE_PATH, content: LIVE_TEXT }]);
    expect(harness.commandRunner.checkoutCalls[0].input.operationId).toBe(OPERATION_ID);
  });

  test('the caller stash flag is passed straight through to checkout', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    await harness.useCase.execute(switchInput({ stashLocal: false }));

    expect(harness.commandRunner.checkoutCalls[0].input.stashLocal).toBe(false);
  });

  test('a dormant document (no active session) contributes no flush entry', async () => {
    const harness = await buildHarness({ activeSession: false });
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    await harness.useCase.execute(switchInput());

    expect(harness.commandRunner.checkoutCalls[0].input.flush).toEqual([]);
  });

  test('a conflicted switch records one GitConflict per file, marks the row CONFLICTED on the target branch, and awaits resolution', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, CONFLICTED_OUTCOME);

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      status: 'awaiting_conflict',
      conflictPaths: ['chapters/intro.adoc', 'assets/logo.png'],
    });

    const conflicts = await harness.gitOperationRepo.listConflicts(OPERATION_ID);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((c) => ({ path: c.path, isBinary: c.isBinary }))).toEqual([
      { path: 'chapters/intro.adoc', isBinary: false },
      { path: 'assets/logo.png', isBinary: true },
    ]);
    for (const conflict of conflicts) {
      expect(conflict.operationId.value).toBe(OPERATION_ID.value);
    }

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.currentBranch).toBe(TARGET_BRANCH);
    expect(saved?.syncStatus).toBe('CONFLICTED');
    expect(saved?.lastKnownRemoteHead).toBeNull();

    // A conflict lands nothing: the reconciler never runs, and no audit is emitted.
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(0);
  });

  test('switching to the branch already checked out short-circuits without touching the runner', async () => {
    const harness = await buildHarness({ currentBranch: TARGET_BRANCH });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ status: 'switched', branch: TARGET_BRANCH, changedPaths: [], anomalies: [] });
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
  });

  test('a live read that fails aborts with LiveContentFlushFailedError before any checkout', async () => {
    const harness = await buildHarness({
      reader: makeReader({ success: false, error: new Error('collab server unreachable') }),
    });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(LiveContentFlushFailedError);
      expect((result.error as LiveContentFlushFailedError).path).toBe(LIVE_PATH);
    }
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
  });

  test('a checkout command failure propagates', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckoutFailure(PROJECT_ID, new GitCommandFailedError('unknown branch'));

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a reconciler failure propagates and the row is not advanced to UP_TO_DATE', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);
    harness.reconciler.apply.mockResolvedValue({
      success: false,
      error: new GitCommandFailedError('collaboration source unreachable'),
    });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('BEHIND');
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError before any checkout', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
  });

  test('a VIEWER is denied with InsufficientRoleError and checkout is never called', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness({ role: null });

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.checkoutCalls).toHaveLength(0);
  });

  test('open rooms whose document or file node no longer resolves are skipped instead of aborting the switch', async () => {
    const harness = await buildHarness({ danglingSessions: true });
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    // Only the one resolvable live document is flushed as the switch's working-tree side.
    expect(harness.commandRunner.checkoutCalls[0].input.flush).toEqual([{ path: LIVE_PATH, content: LIVE_TEXT }]);
  });

  test('a live room with no text yet contributes no flush entry, leaving the working tree bytes as the local side', async () => {
    const harness = await buildHarness({ reader: makeReader({ success: true, value: null }) });
    harness.commandRunner.seedCheckout(PROJECT_ID, SWITCHED_OUTCOME);

    const result = await harness.useCase.execute(switchInput());

    expect(result.success).toBe(true);
    expect(harness.commandRunner.checkoutCalls[0].input.flush).toEqual([]);
  });
});
