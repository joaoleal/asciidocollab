import { ImportRepositoryUseCase } from '../../../src/use-cases/git/import-repository';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { ClonedRepository } from '../../../src/ports/git/git-command-runner';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCredentialStore } from '../../ports/git/in-memory-git-credential-store';
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
  credentialStore: InMemoryGitCredentialStore;
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
  const credentialStore = new InMemoryGitCredentialStore();
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
    credentialStore,
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
    credentialStore,
    commandRunner,
    memberRepo,
    auditRepo,
  };
}

describe('ImportRepositoryUseCase', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('any authenticated user imports a remote: a new project is created and the user owns it', async () => {
    const harness = buildHarness();
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const result = await harness.useCase.execute({
      actorId: ANOTHER_USER_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { project, repository } = result.value;
    expect(repository.projectId).toEqual(project.id);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(REMOTE_URL);
    expect(repository.defaultBranch).toBe('main');
    expect(repository.lastKnownRemoteHead).toBe(CLONED_REPOSITORY.headCommit);
    expect(repository.connectedByUserId).toEqual(ANOTHER_USER_ID);

    // No pre-existing membership, role, or project was required — the actor becomes OWNER of the
    // project this call itself created.
    const membership = await harness.memberRepo.findByCompositeKey(project.id, ANOTHER_USER_ID);
    expect(membership?.role.value).toBe('owner');

    const saved = await harness.projectRepo.findById(project.id);
    expect(saved).not.toBeNull();

    const entries = await harness.auditRepo.findByProjectId(project.id);
    expect(entries.some((entry) => entry.action === 'git.operation_succeeded')).toBe(true);
  });

  test('builds the tree correctly: fresh ids, .git/.collab excluded', async () => {
    const harness = buildHarness();
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const projectId = result.value.project.id;

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

    const storedCredential = await harness.credentialStore.load(projectId);
    expect(storedCredential).not.toBeNull();
    expect(storedCredential!.encryptedToken).not.toBe(TOKEN);
  });

  test('clones the remote with the given credential and branch', async () => {
    const harness = buildHarness();
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    await harness.useCase.execute({
      actorId: OWNER_ID,
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
      harness.commandRunner.seedCloneFailure(REMOTE_URL, new RepositoryUnreachableError());

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
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
    test('leaves no orphan or partial project behind', async () => {
      const harness = buildHarness();
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      const saveSpy = jest.spyOn(harness.projectRepo, 'save');
      const removeProjectSpy = jest.spyOn(harness.fileStore, 'removeProject');
      // Let the tree start building, then force a failure partway through — proving a partially
      // materialized project is rolled back entirely, not just one that never started.
      let documentSaves = 0;
      jest.spyOn(harness.documentRepo, 'save').mockImplementation(async () => {
        documentSaves += 1;
        if (documentSaves >= 1) throw new Error('document store unavailable');
      });

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);

      const projectId = saveSpy.mock.calls[0][0].id;
      // No owner-visible project survives the failure: it is unreachable both by id...
      expect(await harness.projectRepo.findById(projectId)).toBeNull();
      // ...and, equivalently, has no membership row for the actor who attempted the import.
      expect(await harness.memberRepo.findByCompositeKey(projectId, OWNER_ID)).toBeNull();
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);

      expect(await harness.gitRepositoryRepo.findByProjectId(projectId)).toBeNull();
      expect(await harness.credentialStore.load(projectId)).toBeNull();
      expect(removeProjectSpy).toHaveBeenCalledWith(projectId);
    });

    test('reports the forced failure rather than throwing it', async () => {
      const harness = buildHarness();
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      jest.spyOn(harness.fileNodeRepo, 'save').mockRejectedValue(new Error('storage unavailable'));

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      expect(await harness.memberRepo.findByUserId(OWNER_ID)).toHaveLength(0);
    });

    test('cleans up when the owner-membership row itself cannot be written', async () => {
      const harness = buildHarness();
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      const saveSpy = jest.spyOn(harness.projectRepo, 'save');
      const deleteSpy = jest.spyOn(harness.projectRepo, 'delete');
      jest.spyOn(harness.memberRepo, 'addMember').mockRejectedValue(new Error('deadlock detected'));

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      // The membership row is the commit point, so an import that fails to write it is exactly
      // the residue nothing can ever surface: invisible to every read path, and so never found by
      // anything that walks visible projects.
      expect(result.success).toBe(false);
      const projectId = saveSpy.mock.calls[0][0].id;
      expect(deleteSpy).toHaveBeenCalledWith(projectId);
      expect(await harness.projectRepo.findById(projectId)).toBeNull();
    });
  });
});
