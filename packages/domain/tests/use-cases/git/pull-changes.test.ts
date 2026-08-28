import { PullChangesUseCase } from '../../../src/use-cases/git/pull-changes';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { LiveContentFlushFailedError } from '../../../src/errors/git/live-content-flush-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
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
import type { GitMergeFileChange, GitMergeOutcome } from '../../../src/ports/git/git-command-runner';
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
const TOKEN = 'ghp_super-secret-token-value';
const REMOTE_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const MERGE_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

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

const MERGE_CHANGES: readonly GitMergeFileChange[] = [
  { type: 'added', path: 'chapters/new.adoc', content: Buffer.from('= New', 'utf8'), mimeType: 'text/asciidoc' },
];
const CHANGED_PATHS = ['chapters/new.adoc'];

const MERGED_OUTCOME: GitMergeOutcome = { status: 'merged', headCommit: MERGE_HEAD, changes: MERGE_CHANGES };
// A pure fast-forward leaves the local branch tip exactly ON the fetched remote head: no local
// commit the remote lacks, so the project is genuinely UP_TO_DATE afterwards.
const FAST_FORWARD_OUTCOME: GitMergeOutcome = { status: 'merged', headCommit: REMOTE_HEAD, changes: MERGE_CHANGES };
const CONFLICTED_OUTCOME: GitMergeOutcome = {
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
  useCase: PullChangesUseCase;
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
  initialSyncStatus?: 'BEHIND' | 'UP_TO_DATE';
  /** When true, two extra open rooms are seeded whose document/file node no longer resolve. */
  danglingSessions?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    reader = makeReader({ success: true, value: LIVE_TEXT }),
    activeSession = true,
    initialSyncStatus = 'BEHIND',
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
        CURRENT_BRANCH,
        initialSyncStatus,
        'main',
        'previous-head-commit-hash',
        null,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
  }

  const useCase = new PullChangesUseCase(
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

function pullInput() {
  return { actorId: ACTOR_ID, projectId: PROJECT_ID, operationId: OPERATION_ID, token: TOKEN };
}

describe('PullChangesUseCase', () => {
  test('a clean merge that lands a local commit ahead of the remote refreshes the row to AHEAD, and audits nothing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    // The merge left the local branch tip (MERGE_HEAD) past the fetched remote head — e.g. a live-edit
    // flush commit that is not yet pushed — so the project is AHEAD, not UP_TO_DATE.
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    const before = new Date();
    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ status: 'merged', headCommit: MERGE_HEAD, changedPaths: CHANGED_PATHS, anomalies: [] });

    // The reconciler received the merge's own change-set.
    expect(harness.reconciler.apply).toHaveBeenCalledTimes(1);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, MERGE_CHANGES);

    // The row is refreshed: AHEAD (a just-flushed local commit still needs pushing — not hidden as
    // UP_TO_DATE), remote head from the FETCH, lastSyncAt stamped.
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('AHEAD');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
    expect(saved?.lastSyncAt).not.toBeNull();
    expect((saved?.lastSyncAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Untouched fields carry over from the loaded row.
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
    expect(saved?.remoteUrl).toBe(REMOTE_URL);

    // No success audit is emitted here — auditLogRepo is used only for the denial path (via
    // requireGitRole); the git-worker run loop records the terminal SUCCEEDED audit for an async op.
    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(0);
  });

  test('records a git.pull_partially_applied audit and returns the anomalies when the reconciler hit drift', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);
    const anomalies = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped: a folder occupies that path' },
      { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true, message: 'created as a new file' },
    ];
    harness.reconciler.apply.mockResolvedValue({ success: true, value: { changedPaths: CHANGED_PATHS, anomalies } });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ status: 'merged', headCommit: MERGE_HEAD, changedPaths: CHANGED_PATHS, anomalies });

    // A durable, user-readable record of the drift — the user has no log access.
    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('git.pull_partially_applied');
    expect(audits[0]!.metadata).toMatchObject({ total: 2, droppedCount: 1 });
    expect(audits[0]!.metadata.anomalies).toEqual(anomalies);
  });

  test('a clean fast-forward merge that leaves local level with the remote refreshes the row to UP_TO_DATE', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    // The merge fast-forwarded the local branch exactly onto the fetched remote head: no local commit
    // the remote lacks, so the project is genuinely UP_TO_DATE.
    harness.commandRunner.seedMerge(PROJECT_ID, FAST_FORWARD_OUTCOME);

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ status: 'merged', headCommit: REMOTE_HEAD, changedPaths: CHANGED_PATHS, anomalies: [] });

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);
  });

  test('the fetch is authenticated with the token and the remote URL and branch of the row', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    await harness.useCase.execute(pullInput());

    expect(harness.commandRunner.fetchCalls).toHaveLength(1);
    expect(harness.commandRunner.fetchCalls[0].input).toEqual({
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: CURRENT_BRANCH,
    });
  });

  test('an active-session document is flushed into the merge as a git-relative entry (no leading slash)', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    await harness.useCase.execute(pullInput());

    expect(harness.commandRunner.mergeCalls).toHaveLength(1);
    expect(harness.commandRunner.mergeCalls[0].input.branch).toBe(CURRENT_BRANCH);
    expect(harness.commandRunner.mergeCalls[0].input.flush).toEqual([{ path: LIVE_PATH, content: LIVE_TEXT }]);
    expect(harness.commandRunner.mergeCalls[0].input.operationId).toBe(OPERATION_ID);
  });

  test('a dormant document (no active session) contributes no flush entry', async () => {
    const harness = await buildHarness({ activeSession: false });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    await harness.useCase.execute(pullInput());

    expect(harness.commandRunner.mergeCalls[0].input.flush).toEqual([]);
  });

  test('a conflicted merge records one GitConflict per file, marks the row CONFLICTED, and awaits resolution', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, CONFLICTED_OUTCOME);

    const result = await harness.useCase.execute(pullInput());

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
    expect(saved?.syncStatus).toBe('CONFLICTED');
    expect(saved?.lastKnownRemoteHead).toBe(REMOTE_HEAD);

    // A conflict is not a clean merge: the reconciler never runs.
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
  });

  test('a live read that fails aborts with LiveContentFlushFailedError before fetch or merge', async () => {
    const harness = await buildHarness({
      reader: makeReader({ success: false, error: new Error('collab server unreachable') }),
    });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(LiveContentFlushFailedError);
      expect((result.error as LiveContentFlushFailedError).path).toBe(LIVE_PATH);
    }
    // Aborted while gathering the flush set — no network work happened.
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
    expect(harness.commandRunner.mergeCalls).toHaveLength(0);
  });

  test('a fetch failure propagates and merge is never attempted', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetchFailure(PROJECT_ID, new RepositoryUnreachableError());

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(harness.commandRunner.mergeCalls).toHaveLength(0);
  });

  test('a merge command failure propagates', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMergeFailure(PROJECT_ID, new GitCommandFailedError('git merge failed'));

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a reconciler failure propagates and the row is not advanced to UP_TO_DATE', async () => {
    const harness = await buildHarness({ initialSyncStatus: 'BEHIND' });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);
    harness.reconciler.apply.mockResolvedValue({
      success: false,
      error: new GitCommandFailedError('collaboration source unreachable'),
    });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('BEHIND');
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError before any git call', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
    expect(harness.commandRunner.mergeCalls).toHaveLength(0);
  });

  test('a VIEWER is denied with InsufficientRoleError and neither fetch nor merge is called', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
    expect(harness.commandRunner.mergeCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness({ role: null });

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });

  test('open rooms whose document or file node no longer resolves are skipped instead of aborting the pull', async () => {
    const harness = await buildHarness({ danglingSessions: true });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(true);
    // Only the one resolvable live document is flushed as the merge's local side.
    expect(harness.commandRunner.mergeCalls[0].input.flush).toEqual([{ path: LIVE_PATH, content: LIVE_TEXT }]);
  });

  test('a live room with no text yet contributes no flush entry, leaving the working tree bytes as the local side', async () => {
    const harness = await buildHarness({ reader: makeReader({ success: true, value: null }) });
    harness.commandRunner.seedFetch(PROJECT_ID, { remoteHead: REMOTE_HEAD });
    harness.commandRunner.seedMerge(PROJECT_ID, MERGED_OUTCOME);

    const result = await harness.useCase.execute(pullInput());

    expect(result.success).toBe(true);
    expect(harness.commandRunner.mergeCalls[0].input.flush).toEqual([]);
  });
});
