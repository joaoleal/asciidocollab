import { randomUUID } from 'crypto';
import { ImportRepositoryUseCase } from '../../../src/use-cases/git/import-repository';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { ClonedRepository } from '../../../src/ports/git/git-command-runner';
import { Project } from '../../../src/entities/project';
import { GitRepository } from '../../../src/entities/git-repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';

const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const ANOTHER_USER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440002');
const REMOTE_URL = 'https://github.com/example/handbook.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

const CLONED_REPOSITORY: ClonedRepository = {
  defaultBranch: 'main',
  headCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  entries: [
    { path: 'index.adoc', content: Buffer.from('= Handbook\n', 'utf8'), mimeType: 'text/asciidoc' },
    { path: 'chapters/intro.adoc', content: Buffer.from('== Intro\n', 'utf8'), mimeType: 'text/asciidoc' },
    { path: 'images/logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
    // Internal/platform paths a (misbehaving) clone response might list — must never be imported.
    { path: '.git/config', content: Buffer.from('[core]\n', 'utf8'), mimeType: 'text/plain' },
    { path: '.collab/session.json', content: Buffer.from('{}', 'utf8'), mimeType: 'application/json' },
  ],
};

interface Harness {
  useCase: ImportRepositoryUseCase;
  projectRepo: InMemoryProjectRepository;
  fileNodeRepo: InMemoryFileNodeRepository;
  documentRepo: InMemoryDocumentRepository;
  assetRepo: InMemoryAssetRepository;
  fileStore: InMemoryProjectFileStore;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
  memberRepo: InMemoryProjectMemberRepository;
  auditRepo: InMemoryAuditLogRepository;
}

function buildHarness(): Harness {
  const projectRepo = new InMemoryProjectRepository();
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const assetRepo = new InMemoryAssetRepository();
  const fileStore = new InMemoryProjectFileStore();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const memberRepo = new InMemoryProjectMemberRepository();
  const auditRepo = new InMemoryAuditLogRepository();

  const useCase = new ImportRepositoryUseCase(
    projectRepo,
    fileNodeRepo,
    documentRepo,
    assetRepo,
    fileStore,
    gitRepositoryRepo,
    commandRunner,
    memberRepo,
    auditRepo,
  );

  return {
    useCase,
    projectRepo,
    fileNodeRepo,
    documentRepo,
    assetRepo,
    fileStore,
    gitRepositoryRepo,
    commandRunner,
    memberRepo,
    auditRepo,
  };
}

/**
 * Seeds the fakes with exactly what a route allocating an import synchronously would have
 * written before ever enqueuing the operation this use case now runs: a memberless (and so
 * invisible) `Project` row, and its `GitRepository` link in its pre-import state — connected to
 * nothing yet, `DISCONNECTED` and with no observed branch/head.
 */
async function seedPendingImport(harness: Harness, projectId: ProjectId, actorId: UserId): Promise<void> {
  await harness.projectRepo.save(new Project(projectId, ProjectName.create('Handbook'), null, [], null));
  await harness.gitRepositoryRepo.save(
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
      actorId,
    ),
  );
}

/**
 * Wraps `fileNodeRepo.save` to also record every id it is asked to save, without changing its
 * behavior — the only way, given the fakes' interface, to know afterward exactly which rows a run
 * wrote and so exactly which ids must have no trace left once cleanup has run.
 */
function captureFileNodeIds(harness: Harness): FileNodeId[] {
  const ids: FileNodeId[] = [];
  const originalSave = harness.fileNodeRepo.save.bind(harness.fileNodeRepo);
  jest.spyOn(harness.fileNodeRepo, 'save').mockImplementation(async (node) => {
    ids.push(node.id);
    await originalSave(node);
  });
  return ids;
}

/**
 * Asserts that none of `nodeIds` (and nothing else under the project) survives: no `FileNode`, and
 * for each, no `Document` or `Asset` keyed to it either.
 */
async function expectNoMaterializedTree(harness: Harness, projectId: ProjectId, nodeIds: readonly FileNodeId[]): Promise<void> {
  expect(await harness.fileNodeRepo.findByProjectId(projectId)).toHaveLength(0);
  for (const id of nodeIds) {
    expect(await harness.fileNodeRepo.findById(id)).toBeNull();
    expect(await harness.documentRepo.findByFileNodeId(id)).toBeNull();
    expect(await harness.assetRepo.findById(id)).toBeNull();
  }
}

describe('ImportRepositoryUseCase', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('runs a pre-allocated import: the actor becomes the project owner', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingImport(harness, projectId, ANOTHER_USER_ID);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const result = await harness.useCase.execute({
      actorId: ANOTHER_USER_ID,
      projectId,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { project, repository } = result.value;
    expect(project.id).toEqual(projectId);
    expect(repository.projectId).toEqual(project.id);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(REMOTE_URL);
    expect(repository.defaultBranch).toBe('main');
    expect(repository.lastKnownRemoteHead).toBe(CLONED_REPOSITORY.headCommit);
    expect(repository.syncStatus).toBe('UP_TO_DATE');
    // Carried over untouched from the row the route had already connected it under.
    expect(repository.connectedByUserId).toEqual(ANOTHER_USER_ID);

    // The project and its repository link already existed, memberless — this run's own
    // commit point is what grants the actor OWNER access, not either row's mere existence.
    const membership = await harness.memberRepo.findByCompositeKey(project.id, ANOTHER_USER_ID);
    expect(membership?.role.value).toBe('owner');

    const entries = await harness.auditRepo.findByProjectId(project.id);
    expect(entries.some((entry) => entry.action === 'git.operation_succeeded')).toBe(true);
  });

  test('builds the tree correctly: fresh ids, .git/.collab excluded', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingImport(harness, projectId, OWNER_ID);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const nodes = await harness.fileNodeRepo.findByProjectId(projectId);
    const paths = nodes.map((node) => node.path.value).toSorted();
    expect(paths).toEqual(['/', '/chapters', '/chapters/intro.adoc', '/images', '/images/logo.png', '/index.adoc']);
    // Neither internal path was materialized as a node under any name.
    expect(nodes.some((node) => node.name === '.git' || node.name === '.collab')).toBe(false);

    const index = nodes.find((node) => node.path.value === '/index.adoc')!;
    const intro = nodes.find((node) => node.path.value === '/chapters/intro.adoc')!;
    const logo = nodes.find((node) => node.path.value === '/images/logo.png')!;

    const indexDoc = await harness.documentRepo.findByFileNodeId(index.id);
    const introDoc = await harness.documentRepo.findByFileNodeId(intro.id);
    expect(indexDoc).not.toBeNull();
    expect(introDoc).not.toBeNull();
    // Fresh, distinct ids — nothing here is copied from the remote or from one another.
    expect(indexDoc!.contentId.value).not.toBe(indexDoc!.yjsStateId.value);
    expect(indexDoc!.id.value).not.toBe(introDoc!.id.value);
    expect(indexDoc!.contentId.value).not.toBe(introDoc!.contentId.value);
    expect(indexDoc!.yjsStateId.value).not.toBe(introDoc!.yjsStateId.value);

    const logoAsset = await harness.assetRepo.findById(logo.id);
    expect(logoAsset).not.toBeNull();
    expect(logoAsset!.mimeType.value).toBe('image/png');
    expect(logoAsset!.sizeBytes).toBe(BigInt(4));

    expect(await harness.fileStore.read(projectId, FilePath.create('/index.adoc'))).toEqual(
      CLONED_REPOSITORY.entries[0].content,
    );
    expect(await harness.fileStore.read(projectId, FilePath.create('/images/logo.png'))).toEqual(
      CLONED_REPOSITORY.entries[2].content,
    );
  });

  test('clones the remote with the given credential and branch', async () => {
    const harness = buildHarness();
    const projectId = ProjectId.create(randomUUID());
    await seedPendingImport(harness, projectId, OWNER_ID);
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: 'develop',
    });

    expect(harness.commandRunner.cloneCalls).toHaveLength(1);
    expect(harness.commandRunner.cloneCalls[0]).toEqual({ remoteUrl: REMOTE_URL, token: TOKEN, branch: 'develop' });
  });

  describe('validation', () => {
    test('an invalid provider is rejected with ValidationError before any clone runs', async () => {
      const harness = buildHarness();

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: ProjectId.create(randomUUID()),
        provider: 'not-a-real-provider',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);
    });

    test('a malformed remote URL is rejected with ValidationError before any clone runs', async () => {
      const harness = buildHarness();

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: ProjectId.create(randomUUID()),
        provider: 'github',
        remoteUrl: 'not a url; rm -rf /',
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);
    });

    test('a remote that cannot be reached surfaces RepositoryUnreachableError, and nothing is left behind', async () => {
      const harness = buildHarness();
      const projectId = ProjectId.create(randomUUID());
      await seedPendingImport(harness, projectId, OWNER_ID);
      harness.commandRunner.seedCloneFailure(REMOTE_URL, new RepositoryUnreachableError());

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);
    });
  });

  describe('all-or-nothing: a forced mid-import failure', () => {
    test('leaves no owner membership and no partial tree behind', async () => {
      const harness = buildHarness();
      const projectId = ProjectId.create(randomUUID());
      await seedPendingImport(harness, projectId, OWNER_ID);
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      const removeProjectSpy = jest.spyOn(harness.fileStore, 'removeProject');
      const savedNodeIds = captureFileNodeIds(harness);
      // Let the tree start building, then force a failure partway through — proving a partially
      // materialized tree is rolled back entirely, not just one that never started.
      let documentSaves = 0;
      jest.spyOn(harness.documentRepo, 'save').mockImplementation(async () => {
        documentSaves += 1;
        if (documentSaves >= 1) throw new Error('document store unavailable');
      });

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);

      // The invisible project and its repository link persist (a route-created row this use
      // case never deletes), but no owner membership exists for it — unreachable both by the
      // composite key...
      expect(await harness.memberRepo.findByCompositeKey(projectId, OWNER_ID)).toBeNull();
      // ...and, equivalently, has no membership row for the actor who attempted the import.
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);

      await expectNoMaterializedTree(harness, projectId, savedNodeIds);
      expect(removeProjectSpy).toHaveBeenCalledWith(projectId);
    });

    test('reports the forced failure rather than throwing it', async () => {
      const harness = buildHarness();
      const projectId = ProjectId.create(randomUUID());
      await seedPendingImport(harness, projectId, OWNER_ID);
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      jest.spyOn(harness.fileNodeRepo, 'save').mockRejectedValue(new Error('storage unavailable'));

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);
    });

    test('cleans up the whole tree when the owner-membership row itself cannot be written', async () => {
      const harness = buildHarness();
      const projectId = ProjectId.create(randomUUID());
      await seedPendingImport(harness, projectId, OWNER_ID);
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      const savedNodeIds = captureFileNodeIds(harness);
      jest.spyOn(harness.memberRepo, 'addMember').mockRejectedValue(new Error('deadlock detected'));

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      // The membership row is the commit point, so an import that fails to write it — after
      // the whole tree and the repository link have already been built — is exactly the
      // residue nothing can ever surface: invisible to every read path, and so never found by
      // anything that walks visible projects. The project row itself legitimately persists;
      // what must not persist is the tree this run built on top of it.
      expect(result.success).toBe(false);
      expect(await harness.projectRepo.findById(projectId)).not.toBeNull();
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);
      await expectNoMaterializedTree(harness, projectId, savedNodeIds);
    });
  });
});
