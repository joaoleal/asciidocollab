import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  InsufficientRoleError,
  ProjectId,
  ProjectMember,
  RepositoryAlreadyConnectedError,
  RepositoryUnreachableError,
  Role,
  UserId,
} from '@asciidocollab/domain';
import { compositionRoot, createConnectOpFunction } from '../src/composition-root.js';
import { InMemoryGitRepositoryRepository } from './helpers/in-memory-git-repository-repository.js';
import { InMemoryGitCredentialStore } from './helpers/in-memory-git-credential-store.js';
import { InMemoryGitCommandRunner } from './helpers/in-memory-git-command-runner.js';
import { InMemoryGitOperationRepository } from './helpers/in-memory-git-operation-repository.js';
import { InMemoryProjectMemberRepository } from './helpers/in-memory-project-member-repository.js';
import { InMemoryAuditLogRepository } from './helpers/in-memory-audit-log-repository.js';

describe('git-worker composition root', () => {
  it('constructs, starts, and cleanly shuts down without throwing', async () => {
    const app = await compositionRoot();

    expect(app.isRunning()).toBe(false);

    await app.start();
    expect(app.isRunning()).toBe(true);

    await app.shutdown();
    expect(app.isRunning()).toBe(false);
  });
});

describe('createConnectOpFunction', () => {
  const PROJECT_ID = ProjectId.create('990e8400-e29b-41d4-a716-446655440030');
  const OWNER_ID = UserId.create('990e8400-e29b-41d4-a716-446655440031');
  const REMOTE_URL = 'https://github.com/example/handbook.git';
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

  async function buildHarness(role: string | null = 'owner') {
    const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
    const gitCredentialStore = new InMemoryGitCredentialStore();
    const gitCommandRunner = new InMemoryGitCommandRunner();
    const gitOperationRepository = new InMemoryGitOperationRepository();
    const projectMemberRepository = new InMemoryProjectMemberRepository();
    const auditLogRepository = new InMemoryAuditLogRepository();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = { warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta }) };

    if (role) {
      await projectMemberRepository.addMember(new ProjectMember(PROJECT_ID, OWNER_ID, Role.create(role)));
    }

    const connect = createConnectOpFunction({
      gitRepositoryRepository,
      gitCredentialStore,
      gitCommandRunner,
      gitOperationRepository,
      projectMemberRepository,
      auditLogRepository,
      logger,
    });

    return {
      connect,
      gitRepositoryRepository,
      gitCredentialStore,
      gitCommandRunner,
      auditLogRepository,
      warnings,
    };
  }

  it('runs the use case and returns the serialized repository for a well-formed request', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally testing JSON.stringify wire serialization (no {_value} leaking through), not a deep clone; structuredClone would not exercise the same semantics.
    const roundTripped = JSON.parse(JSON.stringify(result.value));
    expect(roundTripped.repository).toEqual({
      id: expect.any(String),
      projectId: PROJECT_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      currentBranch: 'main',
      defaultBranch: null,
      syncStatus: 'UP_TO_DATE',
      lastSyncAt: null,
      connectedByUserId: OWNER_ID.value,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(roundTripped)).not.toContain('_value');
    expect(JSON.stringify(roundTripped)).not.toContain(TOKEN);

    expect(harness.gitCommandRunner.remoteAccessCalls).toEqual([{ remoteUrl: REMOTE_URL, token: TOKEN }]);
    const savedCredential = await harness.gitCredentialStore.load(PROJECT_ID);
    expect(savedCredential?.encryptedToken).not.toBe(TOKEN);

    expect(harness.warnings.every((entry) => JSON.stringify(entry) !== TOKEN)).toBe(true);
  });

  it('passes an omitted branch through as undefined, defaulting to main', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.repository.currentBranch).toBe('main');
  });

  it('passes a requested branch through', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: 'develop',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.repository.currentBranch).toBe('develop');
  });

  it('reports RepositoryUnreachableError as a typed failure', async () => {
    const harness = await buildHarness('owner');
    harness.gitCommandRunner.seedRemoteAccessFailure(REMOTE_URL, new RepositoryUnreachableError());

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(await harness.gitRepositoryRepository.findByProjectId(PROJECT_ID)).toBeNull();
  });

  it('reports AuthenticationFailedError as a typed failure', async () => {
    const harness = await buildHarness('owner');
    harness.gitCommandRunner.seedRemoteAccessFailure(REMOTE_URL, new AuthenticationFailedError());

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(AuthenticationFailedError);
  });

  it('reports RepositoryAlreadyConnectedError when the project already has a repository link', async () => {
    const harness = await buildHarness('owner');
    await harness.gitRepositoryRepository.save(
      new GitRepository(
        GitRepositoryId.create(randomUUID()),
        PROJECT_ID,
        GitProvider.create('gitlab'),
        'https://gitlab.com/existing/repo.git',
        PROJECT_ID.value,
      ),
    );

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryAlreadyConnectedError);
  });

  it('reports InsufficientRoleError for a non-owner, without calling the remote', async () => {
    const harness = await buildHarness('editor');

    const result = await harness.connect({
      projectId: PROJECT_ID.value,
      actorId: OWNER_ID.value,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.gitCommandRunner.remoteAccessCalls).toHaveLength(0);
  });
});
