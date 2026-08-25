import { ImportRepositoryUseCase } from '../../../src/use-cases/git/import-repository';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryAlreadyConnectedError } from '../../../src/errors/git/repository-already-connected';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { ClonedRepository } from '../../../src/ports/git/git-command-runner';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCredentialStore } from '../../ports/git/in-memory-git-credential-store';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ROOT_FOLDER_ID = FileNodeId.create('550e8400-e29b-41d4-a716-446655440010');
const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/repo.git';
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
  fileNodeRepo: InMemoryFileNodeRepository;
  documentRepo: InMemoryDocumentRepository;
  assetRepo: InMemoryAssetRepository;
  fileStore: InMemoryProjectFileStore;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  credentialStore: InMemoryGitCredentialStore;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  memberRepo: InMemoryProjectMemberRepository;
  auditRepo: InMemoryAuditLogRepository;
}

async function buildHarness(role: string | null = 'owner'): Promise<Harness> {
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const assetRepo = new InMemoryAssetRepository();
  const fileStore = new InMemoryProjectFileStore();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const credentialStore = new InMemoryGitCredentialStore();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const memberRepo = new InMemoryProjectMemberRepository();
  const auditRepo = new InMemoryAuditLogRepository();

  await fileNodeRepo.save(
    new FileNode(ROOT_FOLDER_ID, PROJECT_ID, null, 'Handbook', FileNodeType.create('folder'), FilePath.create('/')),
  );
  if (role) {
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, OWNER_ID, Role.create(role)));
  }

  const useCase = new ImportRepositoryUseCase(
    fileNodeRepo,
    documentRepo,
    assetRepo,
    fileStore,
    gitRepositoryRepo,
    credentialStore,
    commandRunner,
    gitOperationRepo,
    memberRepo,
    auditRepo,
  );

  return {
    useCase,
    fileNodeRepo,
    documentRepo,
    assetRepo,
    fileStore,
    gitRepositoryRepo,
    credentialStore,
    commandRunner,
    gitOperationRepo,
    memberRepo,
    auditRepo,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function noop(): void {
  // Placeholder until the promise executor hands over the real resolver.
}

function deferred(): Deferred {
  let resolve: () => void = noop;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

/** Holds the first import's `clone` call open so a second import can start while it runs. */
function gateClone(runner: InMemoryGitCommandRunner): { reached: Promise<void>; release: () => void } {
  const reached = deferred();
  const held = deferred();
  const passThrough = runner.clone.bind(runner);

  jest.spyOn(runner, 'clone').mockImplementation(async (input) => {
    reached.resolve();
    await held.promise;
    return passThrough(input);
  });

  return { reached: reached.promise, release: held.resolve };
}

describe('ImportRepositoryUseCase', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('an OWNER imports a remote: the tree is built, .git/.collab excluded, ids are fresh', async () => {
    const harness = await buildHarness('owner');
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.repository.projectId).toEqual(PROJECT_ID);
    expect(result.value.repository.provider.value).toBe('github');
    expect(result.value.repository.remoteUrl).toBe(REMOTE_URL);
    expect(result.value.repository.defaultBranch).toBe('main');
    expect(result.value.repository.lastKnownRemoteHead).toBe(CLONED_REPOSITORY.headCommit);
    expect(result.value.repository.connectedByUserId).toEqual(OWNER_ID);
    expect(result.value.operation.state).toBe('SUCCEEDED');

    const nodes = await harness.fileNodeRepo.findByProjectId(PROJECT_ID);
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

    expect(await harness.fileStore.read(PROJECT_ID, FilePath.create('/index.adoc'))).toEqual(
      CLONED_REPOSITORY.entries[0].content,
    );
    expect(await harness.fileStore.read(PROJECT_ID, FilePath.create('/images/logo.png'))).toEqual(
      CLONED_REPOSITORY.entries[2].content,
    );

    const storedCredential = await harness.credentialStore.load(PROJECT_ID);
    expect(storedCredential).not.toBeNull();
    expect(storedCredential!.encryptedToken).not.toBe(TOKEN);

    expect(await harness.gitOperationRepo.findActiveOperation(PROJECT_ID)).toBeNull();

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'git.operation_succeeded')).toBe(true);
  });

  test('an OWNER importing clones the remote with the given credential and branch', async () => {
    const harness = await buildHarness('owner');
    harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

    await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: 'develop',
    });

    expect(harness.commandRunner.cloneCalls).toHaveLength(1);
    expect(harness.commandRunner.cloneCalls[0]).toEqual({ remoteUrl: REMOTE_URL, token: TOKEN, branch: 'develop' });
  });

  describe('authorization', () => {
    test('a non-OWNER (editor) is denied with InsufficientRoleError and nothing is created or stored', async () => {
      const harness = await buildHarness('editor');
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(InsufficientRoleError);

      expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
      expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);
      expect(await harness.fileNodeRepo.findByProjectId(PROJECT_ID)).toHaveLength(1); // only the root folder
      expect(await harness.gitOperationRepo.findActiveOperation(PROJECT_ID)).toBeNull();

      const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
      expect(entries.some((entry) => entry.action === 'authz.denied')).toBe(true);
    });

    test('a non-OWNER (viewer) is denied with InsufficientRoleError', async () => {
      const harness = await buildHarness('viewer');

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    });

    test('a non-member is denied with InsufficientRoleError', async () => {
      const harness = await buildHarness(null);

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    });
  });

  describe('validation', () => {
    test('an invalid provider is rejected with ValidationError before any clone runs', async () => {
      const harness = await buildHarness('owner');

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'not-a-real-provider',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);
    });

    test('a malformed remote URL is rejected with ValidationError before any clone runs', async () => {
      const harness = await buildHarness('owner');

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: 'not a url; rm -rf /',
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);
    });

    test('a project that already has a repository link is refused with RepositoryAlreadyConnectedError', async () => {
      const harness = await buildHarness('owner');
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(RepositoryAlreadyConnectedError);
    });

    test('a remote that cannot be reached surfaces RepositoryUnreachableError, and nothing is stored', async () => {
      const harness = await buildHarness('owner');
      harness.commandRunner.seedCloneFailure(REMOTE_URL, new RepositoryUnreachableError());

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
      expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
      expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
    });
  });

  describe('all-or-nothing: a forced mid-import failure', () => {
    test('leaves the project in its prior consistent state — no partial tree, credential, or link', async () => {
      const harness = await buildHarness('owner');
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      // Let the first two file-node writes (the root's existing save aside) succeed, then force a
      // failure partway through the tree — proving a partially materialized tree is rolled back,
      // not just a clone that never started.
      let saves = 0;
      const passThrough = harness.fileNodeRepo.save.bind(harness.fileNodeRepo);
      jest.spyOn(harness.fileNodeRepo, 'save').mockImplementation(async (node) => {
        saves += 1;
        if (saves > 2) throw new Error('storage unavailable');
        return passThrough(node);
      });

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);

      // Restored to exactly what existed before the attempt: only the pre-existing root folder.
      const nodes = await harness.fileNodeRepo.findByProjectId(PROJECT_ID);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].id).toEqual(ROOT_FOLDER_ID);

      expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
      expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
      expect(await harness.documentRepo.findByFileNodeIds([])).toEqual([]);
      expect(await harness.fileStore.read(PROJECT_ID, FilePath.create('/index.adoc'))).toBeNull();

      // The operation this run enqueued reached a terminal, failed state rather than being left
      // active — and is therefore no longer what a later `findActiveOperation` call reports.
      expect(await harness.gitOperationRepo.findActiveOperation(PROJECT_ID)).toBeNull();
    });

    test('reports the forced failure rather than throwing it', async () => {
      const harness = await buildHarness('owner');
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      jest.spyOn(harness.documentRepo, 'save').mockRejectedValue(new Error('document store unavailable'));

      const result = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(result.success).toBe(false);
      const nodes = await harness.fileNodeRepo.findByProjectId(PROJECT_ID);
      expect(nodes).toHaveLength(1);
      expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    });
  });

  describe('single-flight', () => {
    test('a second import for the same project is refused while the first is still running', async () => {
      const harness = await buildHarness('owner');
      harness.commandRunner.seedClone(REMOTE_URL, CLONED_REPOSITORY);
      const gate = gateClone(harness.commandRunner);

      const first = harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });
      // By the time `clone` is reached, this import's own GitOperation has already been enqueued
      // and claimed (RUNNING) — the single-flight token this second call must see.
      await gate.reached;

      const second = await harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      });

      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBeInstanceOf(GitOperationInProgressError);
      // The refusal was decided without ever calling `clone` a second time.
      expect(harness.commandRunner.cloneCalls).toHaveLength(0);

      gate.release();
      const firstResult = await first;
      expect(firstResult.success).toBe(true);
      // The first import's own clone is the only one that ever actually ran.
      expect(harness.commandRunner.cloneCalls).toHaveLength(1);
    });
  });
});
