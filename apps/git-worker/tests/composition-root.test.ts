import { randomUUID } from 'crypto';
import {
  AuthenticationFailedError,
  GitOperationId,
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
import { compositionRoot, createConnectOpFn, mapGitRepositoryToWire, mapOperationId } from '../src/composition-root.js';
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

describe('mapOperationId', () => {
  // The regression this closes: GitOperationId (a Uuid subclass) defines no toJSON, so handing a
  // domain result straight to JSON.stringify serializes operationId as {"_value": "<uuid>"} instead
  // of a plain string — malformed for the API route/client, which decode operationId as a string.
  // A prior version of this binding's own server test missed this because its doubles already used
  // pre-stringified fixtures; this exercises the REAL mapping over a REAL GitOperationId instance,
  // then round-trips it through JSON exactly as the wire response would.
  it('serializes a real GitOperationId as a plain string, not {_value}, in the wire-mapped envelope', () => {
    const uuid = '990e8400-e29b-41d4-a716-446655440099';
    const operationId = GitOperationId.create(uuid);

    const mapped = mapOperationId({ status: 'resolved' as const, operationId, headCommit: 'abc123' });
    const envelope = { ok: true, data: mapped };
    const roundTripped = JSON.parse(JSON.stringify(envelope));

    expect(typeof roundTripped.data.operationId).toBe('string');
    expect(roundTripped.data.operationId).toBe(uuid);
    expect(roundTripped.data.headCommit).toBe('abc123');
    expect(roundTripped.data.status).toBe('resolved');
  });

  it('preserves every other field unchanged, mapping only operationId', () => {
    const uuid = '990e8400-e29b-41d4-a716-446655440098';
    const operationId = GitOperationId.create(uuid);

    const mapped = mapOperationId({
      operationId,
      files: [{ path: 'a.adoc', isBinary: false, resolved: true }],
    });

    expect(mapped).toEqual({ operationId: uuid, files: [{ path: 'a.adoc', isBinary: false, resolved: true }] });
  });
});

describe('mapGitRepositoryToWire', () => {
  // The regression this closes: GitRepositoryId/ProjectId/GitProvider/UserId are value objects with
  // no toJSON, so handing a domain GitRepository straight to JSON.stringify would serialize each as
  // {"_value": "..."} instead of a plain string — malformed for the API route/client. This exercises
  // the REAL mapping over a REAL GitRepository entity, then round-trips it through JSON exactly as
  // the wire response would.
  it('serializes a real GitRepository as plain strings, not {_value}, in the wire-mapped envelope', () => {
    const repository = new GitRepository(
      GitRepositoryId.create('990e8400-e29b-41d4-a716-446655440020'),
      ProjectId.create('990e8400-e29b-41d4-a716-446655440021'),
      GitProvider.create('github'),
      'https://github.com/example/repo.git',
      '990e8400-e29b-41d4-a716-446655440021',
      'main',
      'UP_TO_DATE',
      'main',
      null,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      UserId.create('990e8400-e29b-41d4-a716-446655440022'),
    );

    const mapped = mapGitRepositoryToWire(repository);
    const roundTripped = JSON.parse(JSON.stringify({ ok: true, data: { repository: mapped } }));

    expect(roundTripped).toEqual({
      ok: true,
      data: {
        repository: {
          id: '990e8400-e29b-41d4-a716-446655440020',
          projectId: '990e8400-e29b-41d4-a716-446655440021',
          provider: 'github',
          remoteUrl: 'https://github.com/example/repo.git',
          currentBranch: 'main',
          defaultBranch: 'main',
          syncStatus: 'UP_TO_DATE',
          lastSyncAt: '2026-01-01T00:00:00.000Z',
          connectedByUserId: '990e8400-e29b-41d4-a716-446655440022',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      },
    });
    expect(JSON.stringify(roundTripped)).not.toContain('_value');
  });

  it('maps a null lastSyncAt/connectedByUserId through unchanged', () => {
    const repository = new GitRepository(
      GitRepositoryId.create('990e8400-e29b-41d4-a716-446655440023'),
      ProjectId.create('990e8400-e29b-41d4-a716-446655440024'),
      GitProvider.create('gitlab'),
      'https://gitlab.com/example/repo.git',
      '990e8400-e29b-41d4-a716-446655440024',
    );

    const mapped = mapGitRepositoryToWire(repository);

    expect(mapped.lastSyncAt).toBeNull();
    expect(mapped.connectedByUserId).toBeNull();
  });
});

describe('createConnectOpFn', () => {
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

    const connect = createConnectOpFn({
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
