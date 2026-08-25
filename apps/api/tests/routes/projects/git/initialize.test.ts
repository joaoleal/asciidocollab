import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitOperation, GitOperationId, GitRepository, GitRepositoryId, ProjectId, UserId } from '@asciidocollab/domain';
import type { EnqueueGitOperationInput } from '@asciidocollab/domain';
import { gitInitializeRoutes } from '../../../../src/routes/projects/git/initialize';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

const VALID_BODY = {
  provider: 'github',
  remoteUrl: 'https://github.com/acme/handbook.git',
  token: 'ghp_supersecrettoken',
};

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** A pre-existing `GitRepository` row `findByProjectId` should resolve, or null for none. */
  existingRepository?: GitRepository | null;
  /** When set, `repos.gitRepository.save` throws this. */
  gitRepositorySaveError?: Error;
  /** When set, `services.gitCredentialStore.save` throws this. */
  credentialSaveError?: Error;
  /** When set, `repos.gitOperation.enqueue` throws this. */
  enqueueError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'owner', existingRepository = null, gitRepositorySaveError, credentialSaveError, enqueueError } =
    options;

  const savedGitRepositories: GitRepository[] = [];
  const savedCredentials: { projectId: string; token: string; provider: string; createdByUserId: string }[] = [];
  const enqueuedOperations: EnqueueGitOperationInput[] = [];
  const auditSave = jest.fn();

  const save = jest.fn(async (repository: GitRepository) => {
    if (gitRepositorySaveError) throw gitRepositorySaveError;
    savedGitRepositories.push(repository);
  });
  const findByProjectId = jest.fn(async () => existingRepository);
  const credentialSave = jest.fn(
    async (projectId: ProjectId, credential: { token: string; provider: { value: string }; createdByUserId: UserId }) => {
      if (credentialSaveError) throw credentialSaveError;
      savedCredentials.push({
        projectId: projectId.value,
        token: credential.token,
        provider: credential.provider.value,
        createdByUserId: credential.createdByUserId.value,
      });
    },
  );
  const enqueue = jest.fn(async (input: EnqueueGitOperationInput) => {
    if (enqueueError) throw enqueueError;
    enqueuedOperations.push(input);
    return new GitOperation(
      GitOperationId.create(randomUUID()),
      input.projectId,
      input.kind,
      'QUEUED',
      input.triggeredByUserId,
      input.branch ?? null,
    );
  });

  const build = async (): Promise<FastifyInstance> => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
      gitRepository: { save, findByProjectId },
      gitOperation: { enqueue },
    } as never);
    app.decorate('services', {
      gitCredentialStore: { save: credentialSave, load: jest.fn(async () => null), delete: jest.fn() },
    } as never);
    await app.register(gitInitializeRoutes);
    await app.ready();
    return app;
  };

  return { build, save, findByProjectId, credentialSave, enqueue, savedGitRepositories, savedCredentials, enqueuedOperations };
}

function initialize(app: FastifyInstance, projectId: string, payload: Record<string, unknown> = VALID_BODY) {
  return app.inject({ method: 'POST', url: `/projects/${projectId}/git/initialize`, payload });
}

function existingConnectedRepository(overrides: Partial<{ syncStatus: string }> = {}): GitRepository {
  return new GitRepository(
    GitRepositoryId.create(randomUUID()),
    ProjectId.create(PROJECT_ID),
    { value: 'github', equals: () => false } as never,
    'https://github.com/acme/existing.git',
    PROJECT_ID,
    'main',
    (overrides.syncStatus ?? 'UP_TO_DATE') as never,
  );
}

describe('POST /projects/:projectId/git/initialize', () => {
  it('answers 202 with an operationId and projectId, and writes a placeholder row + credential + enqueues INITIALIZE', async () => {
    const { build, savedGitRepositories, savedCredentials, enqueuedOperations } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.projectId).toBe(PROJECT_ID);

    expect(savedGitRepositories).toHaveLength(1);
    const repository = savedGitRepositories[0];
    expect(repository.projectId.value).toBe(PROJECT_ID);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(VALID_BODY.remoteUrl);
    expect(repository.syncStatus).toBe('DISCONNECTED');
    expect(repository.connectedByUserId?.value).toBe(ACTOR_ID);

    expect(savedCredentials).toHaveLength(1);
    expect(savedCredentials[0].projectId).toBe(PROJECT_ID);
    expect(savedCredentials[0].token).toBe(VALID_BODY.token);
    expect(savedCredentials[0].createdByUserId).toBe(ACTOR_ID);

    expect(enqueuedOperations).toHaveLength(1);
    expect(enqueuedOperations[0]).toMatchObject({
      projectId: expect.objectContaining({ value: PROJECT_ID }),
      kind: 'INITIALIZE',
      triggeredByUserId: expect.objectContaining({ value: ACTOR_ID }),
    });

    await app.close();
  });

  it('never leaks a wrapped id ({_value}) in the 202 body', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(Object.keys(response.json()).toSorted()).toEqual(['operationId', 'projectId']);
    expect(JSON.stringify(response.json())).not.toContain('_value');

    await app.close();
  });

  it('answers 403 for a non-owner and writes/enqueues nothing', async () => {
    const { build, save, credentialSave, enqueue } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(save).not.toHaveBeenCalled();
    expect(credentialSave).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and writes/enqueues nothing', async () => {
    const { build, save, enqueue } = buildHarness({ role: null });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 409 already_connected when the project already has a non-placeholder repository, and enqueues nothing', async () => {
    const { build, save, enqueue } = buildHarness({ existingRepository: existingConnectedRepository() });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('already_connected');
    expect(save).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('proceeds (reusing the existing row id) when the only existing row is a DISCONNECTED placeholder', async () => {
    const leftover = existingConnectedRepository({ syncStatus: 'DISCONNECTED' });
    const { build, savedGitRepositories, enqueuedOperations } = buildHarness({ existingRepository: leftover });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(202);
    expect(savedGitRepositories).toHaveLength(1);
    expect(savedGitRepositories[0].id.value).toBe(leftover.id.value);
    expect(enqueuedOperations).toHaveLength(1);

    await app.close();
  });

  it('answers 400 validation_error for an unrecognized provider, before anything is written', async () => {
    const { build, save, enqueue } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID, { ...VALID_BODY, provider: 'sourcehut' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    expect(save).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 400 validation_error for a malformed remote URL, before anything is written', async () => {
    const { build, save } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID, { ...VALID_BODY, remoteUrl: 'not a url; rm -rf /' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 400 when the token is missing', async () => {
    const { build, save } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID, { provider: 'github', remoteUrl: VALID_BODY.remoteUrl });

    expect(response.statusCode).toBe(400);
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('never echoes the token back in the response body', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(JSON.stringify(response.json())).not.toContain(VALID_BODY.token);

    await app.close();
  });

  it('answers 500 without leaking internals when the repository row cannot be saved', async () => {
    const { build } = buildHarness({ gitRepositorySaveError: new Error('connection reset') });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).not.toContain('connection reset');

    await app.close();
  });

  it('answers 500 without leaking internals when the credential cannot be stored', async () => {
    const { build } = buildHarness({ credentialSaveError: new Error('kms unavailable') });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).not.toContain('kms unavailable');

    await app.close();
  });

  it('answers 500 when the operation cannot be enqueued', async () => {
    const { build } = buildHarness({ enqueueError: new Error('queue unavailable') });
    const app = await build();

    const response = await initialize(app, PROJECT_ID);

    expect(response.statusCode).toBe(500);

    await app.close();
  });
});
