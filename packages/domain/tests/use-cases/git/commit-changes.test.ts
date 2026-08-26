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

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const ROOT_NODE_ID = FileNodeId.create('550e8400-e29b-41d4-a716-446655440010');

const STAGED_LIVE_PATH = 'chapters/intro.adoc';
const STAGED_DORMANT_PATH = 'chapters/appendix.adoc';
const UNSTAGED_LIVE_PATH = 'chapters/draft.adoc';
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
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    reader = makeReader({ success: true, value: LIVE_TEXT }),
    withUser = true,
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

  for (const { node, document } of [stagedLive, stagedDormant, unstagedLive]) {
    await fileNodeRepo.save(node);
    await documentRepo.save(document);
  }
  // Live sessions for the staged-live file AND the unstaged-live file: an active session on an
  // unstaged file must still not flush it.
  await collaborationSessionRepo.open(PROJECT_ID, stagedLive.document.id);
  await collaborationSessionRepo.open(PROJECT_ID, unstagedLive.document.id);
  // The staged-dormant file has a document but no session → stored, never flushed.

  if (withUser) {
    await userRepo.save(
      new User(ACTOR_ID, Email.create('ada@example.com'), 'Ada Editor', 'argon2-hash', [], null, null),
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
  test('commits staged files with live content: only the staged live file is flushed, author is the user', async () => {
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
    // Only the staged file with an active live session is flushed. The dormant staged file keeps
    // its staged bytes, and the unstaged file — live session and all — is not flushed.
    expect(call.input.flush).toEqual([{ path: STAGED_LIVE_PATH, content: LIVE_TEXT }]);
    expect(call.input.message).toBe(MESSAGE);
    expect(call.input.author).toEqual({ name: 'Ada Editor', email: 'ada@example.com' });
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

  test('nothing staged refuses with NothingStagedError and commit is never called', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [
        { path: UNSTAGED_LIVE_PATH, changeType: 'modified', state: 'unstaged' },
        { path: 'chapters/new.adoc', changeType: 'added', state: 'untracked' },
      ],
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
    const entry = entries.find((e) => e.action === AUDIT_GIT_CHANGES_COMMITTED);
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ hash: COMMIT_HASH, messageLength: MESSAGE.length });
  });
});
