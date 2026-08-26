import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitRepository, GitRepositoryId, ProjectId } from '@asciidocollab/domain';
import { gitCredentialRoutes } from '../../../../src/routes/projects/git/credential';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const NEW_TOKEN = 'ghp_brandnewtoken';

function existingRepository(): GitRepository {
  return new GitRepository(
    GitRepositoryId.create(randomUUID()),
    ProjectId.create(PROJECT_ID),
    { value: 'github', equals: () => false } as never,
    'https://github.com/acme/existing.git',
    PROJECT_ID,
    'main',
    'UP_TO_DATE' as never,
  );
}

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** A pre-existing `GitRepository` row `findByProjectId` should resolve, or null for none. */
  existing?: GitRepository | null;
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'owner', existing = existingRepository() } = options;

  const savedCredentials: { projectId: string; token: string; provider: string; createdByUserId: string }[] = [];
  const auditSave = jest.fn();

  const save = jest.fn(
    async (projectId: ProjectId, credential: { token: string; provider: { value: string }; createdByUserId: { value: string } }) => {
      savedCredentials.push({
        projectId: projectId.value,
        token: credential.token,
        provider: credential.provider.value,
        createdByUserId: credential.createdByUserId.value,
      });
    },
  );
  const load = jest.fn(async () => ({ encryptedToken: 'iv:tag:cipher', tokenHint: '...oken' }));
  const findByProjectId = jest.fn(async () => existing);

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
      gitRepository: { findByProjectId },
    } as never);
    app.decorate('services', {
      gitCredentialStore: { save, load, delete: jest.fn() },
    } as never);
    await app.register(gitCredentialRoutes);
    await app.ready();
    return app;
  };

  return { build, save, load, findByProjectId, savedCredentials };
}

function rotateCredential(app: FastifyInstance, projectId: string, token = NEW_TOKEN) {
  return app.inject({ method: 'PUT', url: `/projects/${projectId}/git/credential`, payload: { token } });
}

describe('PUT /projects/:projectId/git/credential', () => {
  it('answers 200 {tokenHint} and rotates the stored token, preserving the existing provider', async () => {
    const { build, savedCredentials } = buildHarness();
    const app = await build();

    const response = await rotateCredential(app, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tokenHint: '...oken' });

    expect(savedCredentials).toHaveLength(1);
    expect(savedCredentials[0].token).toBe(NEW_TOKEN);
    expect(savedCredentials[0].provider).toBe('github');
    expect(savedCredentials[0].createdByUserId).toBe(ACTOR_ID);

    await app.close();
  });

  it('never returns the raw token in the response body', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await rotateCredential(app, PROJECT_ID);

    expect(JSON.stringify(response.json())).not.toContain(NEW_TOKEN);

    await app.close();
  });

  it('answers 403 for a non-owner and never rotates the credential', async () => {
    const { build, save } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await rotateCredential(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never rotates the credential', async () => {
    const { build, save } = buildHarness({ role: null });
    const app = await build();

    const response = await rotateCredential(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 404 repository_not_connected when the project has no repository row', async () => {
    const { build, save } = buildHarness({ existing: null });
    const app = await build();

    const response = await rotateCredential(app, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 400 when the token is missing', async () => {
    const { build, save } = buildHarness();
    const app = await build();

    const response = await app.inject({ method: 'PUT', url: `/projects/${PROJECT_ID}/git/credential`, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(save).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const existing = existingRepository();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'owner' } })) },
      auditLog: { save: jest.fn() },
      gitRepository: { findByProjectId: jest.fn(async () => existing) },
    } as never);
    app.decorate('services', {
      gitCredentialStore: {
        save: jest.fn(),
        load: jest.fn(async () => ({ encryptedToken: 'iv:tag:cipher', tokenHint: '...oken' })),
        delete: jest.fn(),
      },
    } as never);
    await app.register(gitCredentialRoutes);
    await app.ready();

    const first = await rotateCredential(app, PROJECT_ID);
    const second = await rotateCredential(app, PROJECT_ID);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
