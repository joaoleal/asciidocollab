import { CommitChangesUseCase } from '../../../src/use-cases/git/commit-changes';
import { AUDIT_GIT_CHANGES_COMMITTED } from '../../../src/audit-actions';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { EmptyCommitMessageError } from '../../../src/errors/git/empty-commit-message';
import { NothingStagedError } from '../../../src/errors/git/nothing-staged';
import { LiveContentFlushFailedError } from '../../../src/errors/git/live-content-flush-failed';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { User } from '../../../src/entities/user';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
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
import { Email } from '../../../src/value-objects/identity/email';
import { Role } from '../../../src/value-objects/identity/role';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import type { GitWorkingTreeStatus } from '../../../src/ports/git/git-command-runner';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryEditorPreferencesRepository } from '../../ports/user/in-memory-editor-preferences.repository';
import { EditorPreferences } from '../../../src/entities/editor-preferences';
import { EditorPreferencesId } from '../../../src/value-objects/ids/editor-preferences-id';
import { EditorTheme } from '../../../src/value-objects/editor/editor-theme';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const ROOT_NODE_ID = FileNodeId.create('550e8400-e29b-41d4-a716-446655440010');

const STAGED_LIVE_PATH = 'chapters/intro.adoc';
const STAGED_DORMANT_PATH = 'chapters/appendix.adoc';
const UNSTAGED_LIVE_PATH = 'chapters/draft.adoc';
const UNSTAGED_DORMANT_PATH = 'chapters/legacy.adoc';
const MESSAGE = 'Revise the introduction';
const LIVE_TEXT = '= Introduction\nEdited live moments ago — héllo wörld';
const COMMIT_HASH = 'abc123def4567890';

interface SeededFile {
  node: FileNode;
  document: Document;
}

function makeFile(gitPath: string, suffix: string): SeededFile {
  const node = new FileNode(
    FileNodeId.create(`550e8400-e29b-41d4-a716-4466554${suffix}0`),
    PROJECT_ID,
    ROOT_NODE_ID,
    gitPath.split('/').pop() as string,
    FileNodeType.create('file'),
    FilePath.create('/' + gitPath),
  );
  const document = new Document(
    DocumentId.create(`550e8400-e29b-41d4-a716-4466554${suffix}1`),
    node.id,
    ContentId.create(`550e8400-e29b-41d4-a716-4466554${suffix}2`),
    YjsStateId.create(`550e8400-e29b-41d4-a716-4466554${suffix}3`),
    MimeType.create('text/asciidoc'),
  );
  return { node, document };
}

const stagedLive = makeFile(STAGED_LIVE_PATH, '5001');
const stagedDormant = makeFile(STAGED_DORMANT_PATH, '5002');
const unstagedLive = makeFile(UNSTAGED_LIVE_PATH, '5003');
const unstagedDormant = makeFile(UNSTAGED_DORMANT_PATH, '5004');

function makeReader(
  result: { success: true; value: string | null } | { success: false; error: Error },
): CollaborativeContentReader {
  return { readContent: jest.fn().mockResolvedValue(result) };
}

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: CommitChangesUseCase;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
  reader?: CollaborativeContentReader;
  withUser?: boolean;
  privateCommitEmail?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    reader = makeReader({ success: true, value: LIVE_TEXT }),
    withUser = true,
    privateCommitEmail = false,
  } = options;

  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const collaborationSessionRepo = new InMemoryCollaborationSessionRepository();
  const userRepo = new InMemoryUserRepository();
  const editorPreferencesRepo = new InMemoryEditorPreferencesRepository();

  for (const { node, document } of [stagedLive, stagedDormant, unstagedLive, unstagedDormant]) {
    await fileNodeRepo.save(node);
    await documentRepo.save(document);
  }
  // Live sessions for the staged-live file AND the unstaged-live file: both are flushed with their
  // current collaborative text.
  await collaborationSessionRepo.open(PROJECT_ID, stagedLive.document.id);
  await collaborationSessionRepo.open(PROJECT_ID, unstagedLive.document.id);
  // The staged-dormant and unstaged-dormant files have a document but no session → stored: the
  // staged one keeps its indexed bytes, the unstaged one is staged from disk before committing.

  if (withUser) {
    await userRepo.save(
      new User(ACTOR_ID, Email.create('ada@example.com'), 'Ada Editor', 'argon2-hash', [], null, null),
    );
  }

  if (privateCommitEmail) {
    const themeResult = EditorTheme.parse('default');
    if (!themeResult.success) throw themeResult.error;
    await editorPreferencesRepo.save(
      new EditorPreferences(
        EditorPreferencesId.create('660e8400-e29b-41d4-a716-446655440001'),
        ACTOR_ID,
        14,
        themeResult.value,
        false,
        undefined,
        true,
        undefined,
        true,
        false,
        true,
      ),
    );
  }

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );
  }

  const useCase = new CommitChangesUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
    fileNodeRepo,
    documentRepo,
    reader,
    collaborationSessionRepo,
    userRepo,
    editorPreferencesRepo,
  );

  return { useCase, commandRunner, gitOperationRepo, auditRepo };
}

const MIXED_STATUS: GitWorkingTreeStatus = {
  currentBranch: 'main',
  changes: [
    { path: STAGED_LIVE_PATH, changeType: 'modified', state: 'staged' },
    { path: STAGED_DORMANT_PATH, changeType: 'modified', state: 'staged' },
    { path: UNSTAGED_LIVE_PATH, changeType: 'modified', state: 'unstaged' },
  ],
};

describe('CommitChangesUseCase', () => {
  test('commits every pending file with live content: both live files are flushed, author is the user', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.commit.hash).toBe(COMMIT_HASH);

    expect(harness.commandRunner.commitCalls).toHaveLength(1);
    const call = harness.commandRunner.commitCalls[0];
    // Both files with an active live session are flushed — the staged one and, now, the unstaged
    // one. The dormant staged file keeps its already-indexed bytes (no flush entry), and nothing
    // needs a separate `git add` because both dormant/binary cases here are already staged.
    expect(call.input.flush).toEqual([
      { path: STAGED_LIVE_PATH, content: LIVE_TEXT },
      { path: UNSTAGED_LIVE_PATH, content: LIVE_TEXT },
    ]);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
    expect(call.input.message).toBe(MESSAGE);
    expect(call.input.author).toEqual({ name: 'Ada Editor', email: 'ada@example.com' });
  });

  test('stages a dormant unstaged file from disk, then commits it (no flush entry for it)', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: UNSTAGED_DORMANT_PATH, changeType: 'modified', state: 'unstaged' }],
    });
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    // Its authoritative bytes are already on disk, so it is `git add`ed rather than flushed.
    expect(harness.commandRunner.stageCalls).toHaveLength(1);
    expect(harness.commandRunner.stageCalls[0].paths).toEqual([UNSTAGED_DORMANT_PATH]);
    expect(harness.commandRunner.commitCalls).toHaveLength(1);
    expect(harness.commandRunner.commitCalls[0].input.flush).toEqual([]);
  });

  test('a failing stage command propagates its GitCommandFailedError without committing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: UNSTAGED_DORMANT_PATH, changeType: 'modified', state: 'unstaged' }],
    });
    harness.commandRunner.seedStageFailure(PROJECT_ID, new GitCommandFailedError('git add failed'));

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a conflicted file is excluded from the committable set and never staged or committed', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [
        { path: STAGED_LIVE_PATH, changeType: 'modified', state: 'staged' },
        { path: UNSTAGED_DORMANT_PATH, changeType: 'modified', state: 'conflicted' },
      ],
    });
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    // The conflicted file is neither staged nor flushed; only the staged live file is committed.
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
    expect(harness.commandRunner.commitCalls[0].input.flush).toEqual([
      { path: STAGED_LIVE_PATH, content: LIVE_TEXT },
    ]);
  });

  test('an already-staged dormant file with no other pending change still commits (back-compat)', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: STAGED_DORMANT_PATH, changeType: 'modified', state: 'staged' }],
    });
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    // Nothing to flush and nothing new to stage — the already-indexed bytes commit as-is.
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
    expect(harness.commandRunner.commitCalls).toHaveLength(1);
    expect(harness.commandRunner.commitCalls[0].input.flush).toEqual([]);
  });

  test('uses a privacy-preserving commit email when the author has opted in, keeping their display name', async () => {
    const harness = await buildHarness({ privateCommitEmail: true });
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    const call = harness.commandRunner.commitCalls[0];
    expect(call.input.author.name).toBe('Ada Editor');
    expect(call.input.author.email).not.toBe('ada@example.com');
    expect(call.input.author.email).toBe(`${ACTOR_ID.value}@users.noreply.asciidocollab.invalid`);
  });

  test('an empty (whitespace) message refuses with EmptyCommitMessageError before any git call', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: '   ',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(EmptyCommitMessageError);
    expect(harness.commandRunner.statusCalls).toHaveLength(0);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('no pending changes refuses with NothingStagedError and commit is never called', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, { currentBranch: 'main', changes: [] });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NothingStagedError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('only conflicted changes pending refuses with NothingStagedError (conflicts are not committable)', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: UNSTAGED_DORMANT_PATH, changeType: 'modified', state: 'conflicted' }],
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NothingStagedError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a VIEWER is denied with InsufficientRoleError and neither status nor commit is called', async () => {
    const harness = await buildHarness({ role: 'viewer' });
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.statusCalls).toHaveLength(0);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('an already-active operation refuses with GitOperationInProgressError and commit is never called', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);
    await harness.gitOperationRepo.enqueue({
      projectId: PROJECT_ID,
      kind: 'PUSH',
      triggeredByUserId: ACTOR_ID,
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError', async () => {
    const harness = await buildHarness({ connected: false });
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a staged file whose live read fails aborts with LiveContentFlushFailedError, naming the file, and commit is never called', async () => {
    const harness = await buildHarness({
      reader: makeReader({ success: false, error: new Error('collab server unreachable') }),
    });
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(LiveContentFlushFailedError);
      expect((result.error as LiveContentFlushFailedError).path).toBe(STAGED_LIVE_PATH);
      expect(result.error.message).toContain(STAGED_LIVE_PATH);
    }
    // Aborted before any write or commit — no partial commit.
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a failing commit command propagates its GitCommandFailedError', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);
    harness.commandRunner.seedCommitFailure(PROJECT_ID, new GitCommandFailedError('git commit failed'));

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a successful commit records an AUDIT_GIT_CHANGES_COMMITTED audit entry with the new hash', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });
    expect(result.success).toBe(true);

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    const entry = entries.find((entry) => entry.action === AUDIT_GIT_CHANGES_COMMITTED);
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ hash: COMMIT_HASH, messageLength: MESSAGE.length });
  });

  test('a failing status read propagates its GitCommandFailedError without committing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatusFailure(PROJECT_ID, new GitCommandFailedError('git status failed'));

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });

  test('a staged path with no matching file node is committed from the working tree without a flush entry', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [
        { path: STAGED_LIVE_PATH, changeType: 'modified', state: 'staged' },
        { path: 'untracked-by-the-tree/notes.txt', changeType: 'added', state: 'staged' },
      ],
    });
    harness.commandRunner.seedCommitResult(PROJECT_ID, {
      hash: COMMIT_HASH,
      message: MESSAGE,
      authoredAt: new Date('2024-06-01T12:00:00.000Z'),
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(true);
    expect(harness.commandRunner.commitCalls).toHaveLength(1);
    expect(harness.commandRunner.commitCalls[0].input.flush).toEqual([
      { path: STAGED_LIVE_PATH, content: LIVE_TEXT },
    ]);
  });

  test('an actor with no user row refuses with a GitCommandFailedError and commits nothing', async () => {
    const harness = await buildHarness({ withUser: false });
    harness.commandRunner.seedStatus(PROJECT_ID, MIXED_STATUS);

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      message: MESSAGE,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(GitCommandFailedError);
      expect(result.error.message).toBe('The commit author could not be resolved');
    }
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
  });
});
