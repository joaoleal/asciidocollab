import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  GitOperation,
  GitOperationId,
  GitProvider,
  GitRepository,
  Project,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';
import type { EnqueueGitOperationInput } from '@asciidocollab/domain';
import { gitImportRoutes } from '../../../src/routes/git/import';
import { errorHandler } from '../../../src/plugins/error-handler';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';

interface HarnessOptions {
  /** Maximum import requests the rate limiter allows in the window. */
  rateLimitMax?: number;
  /** Length of that window in milliseconds. */
  rateLimitWindow?: number;
  /** When set, `repos.project.save` throws this — simulating a persistence failure. */
  projectSaveError?: Error;
  /** When set, `repos.gitRepository.save` throws this. */
  gitRepositorySaveError?: Error;
  /** When set, `services.gitCredentialStore.save` throws this. */
  credentialSaveError?: Error;
  /** When set, `repos.gitOperation.enqueue` throws this — any value, not necessarily an `Error`. */
  enqueueError?: unknown;
  /** When false, `services.gitCredentialStore` itself is undefined (unconfigured). */
  credentialStoreConfigured?: boolean;
}

interface Harness {
  /** The server under test, already awaited and ready. */
  app: FastifyInstance;
  /** Project rows the run wrote, in write order. */
  savedProjects: Project[];
  /** Membership rows the run wrote — must stay empty; the worker writes the first one. */
  savedMembers: unknown[];
  /** GitRepository rows the run wrote, in write order. */
  savedGitRepositories: GitRepository[];
  /** Credential-store `save` calls, in call order. */
  savedCredentials: { projectId: string; token: string; provider: string; createdByUserId: string }[];
  /** GitOperation `enqueue` calls, in call order. */
  enqueuedOperations: EnqueueGitOperationInput[];
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    rateLimitMax = 20,
    rateLimitWindow = 60_000,
    projectSaveError,
    gitRepositorySaveError,
    credentialSaveError,
    enqueueError,
    credentialStoreConfigured = true,
  } = options;

  const savedProjects: Project[] = [];
  const savedMembers: unknown[] = [];
  const savedGitRepositories: GitRepository[] = [];
  const savedCredentials: { projectId: string; token: string; provider: string; createdByUserId: string }[] = [];
  const enqueuedOperations: EnqueueGitOperationInput[] = [];

  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { global: false });
  app.decorate('config', {
    git: { rateLimitMax, rateLimitWindow },
  } as never);
  app.decorate('services', {
    gitCredentialStore: credentialStoreConfigured
      ? {
          save: jest.fn(async (projectId: ProjectId, credential: { token: string; provider: { value: string }; createdByUserId: UserId }) => {
            if (credentialSaveError) throw credentialSaveError;
            savedCredentials.push({
              projectId: projectId.value,
              token: credential.token,
              provider: credential.provider.value,
              createdByUserId: credential.createdByUserId.value,
            });
          }),
          load: jest.fn(async () => null),
          delete: jest.fn(async () => undefined),
        }
      : undefined,
  } as never);
  app.decorate('repos', {
    project: {
      save: jest.fn(async (project: Project) => {
        if (projectSaveError) throw projectSaveError;
        savedProjects.push(project);
      }),
      findById: jest.fn(async () => null),
    },
    gitRepository: {
      save: jest.fn(async (repository: GitRepository) => {
        if (gitRepositorySaveError) throw gitRepositorySaveError;
        savedGitRepositories.push(repository);
      }),
      findByProjectId: jest.fn(async () => null),
    },
    projectMember: {
      addMember: jest.fn(async (member: unknown) => {
        savedMembers.push(member);
      }),
      findByProjectId: jest.fn(async () => []),
    },
    gitOperation: {
      enqueue: jest.fn(async (input: EnqueueGitOperationInput) => {
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
      }),
    },
  } as never);

  await app.register(gitImportRoutes);
  await app.ready();

  return { app, savedProjects, savedMembers, savedGitRepositories, savedCredentials, enqueuedOperations };
}

function importRepo(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/git/import', payload });
}

const VALID_BODY = {
  provider: 'github',
  remoteUrl: 'https://github.com/acme/handbook.git',
  token: 'ghp_supersecrettoken',
};

describe('POST /api/git/import', () => {
  it('answers 202 with an operationId and projectId for a valid request from any authenticated user', async () => {
    const { app } = await buildHarness();

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.projectId).toEqual(expect.any(String));

    await app.close();
  });

  it('creates an invisible (memberless) project, a matching GitRepository row, a stored credential, and an enqueued IMPORT op', async () => {
    const { app, savedProjects, savedMembers, savedGitRepositories, savedCredentials, enqueuedOperations } =
      await buildHarness();

    const response = await importRepo(app, VALID_BODY);
    const { projectId, operationId } = response.json();

    expect(savedProjects).toHaveLength(1);
    expect(savedProjects[0].id.value).toBe(projectId);
    expect(savedProjects[0].name.value).toBe('handbook');

    // No membership row: the project must stay unreadable until the worker's import commits it.
    expect(savedMembers).toHaveLength(0);

    expect(savedGitRepositories).toHaveLength(1);
    const repository = savedGitRepositories[0];
    expect(repository.projectId.value).toBe(projectId);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(VALID_BODY.remoteUrl);
    // Keyed by the project id — the credential store looks credentials up this way.
    expect(repository.credentialReference).toBe(projectId);
    expect(repository.connectedByUserId?.value).toBe(ACTOR_ID);
    expect(repository.syncStatus).toBe('DISCONNECTED');

    expect(savedCredentials).toHaveLength(1);
    expect(savedCredentials[0].projectId).toBe(projectId);
    expect(savedCredentials[0].token).toBe(VALID_BODY.token);
    expect(savedCredentials[0].createdByUserId).toBe(ACTOR_ID);

    expect(enqueuedOperations).toHaveLength(1);
    expect(enqueuedOperations[0]).toMatchObject({
      projectId: expect.objectContaining({ value: projectId }),
      kind: 'IMPORT',
      triggeredByUserId: expect.objectContaining({ value: ACTOR_ID }),
    });
    expect(operationId).toEqual(expect.any(String));

    await app.close();
  });

  it('derives the project name from an scp-style remote when no `.git` suffix is present', async () => {
    const { app, savedProjects } = await buildHarness();

    await importRepo(app, { ...VALID_BODY, remoteUrl: 'git@github.com:acme/team-wiki' });

    expect(savedProjects[0].name.value).toBe('team-wiki');

    await app.close();
  });

  it('carries the requested branch onto the enqueued operation and the pre-import repository link', async () => {
    const { app, savedGitRepositories, enqueuedOperations } = await buildHarness();

    await importRepo(app, { ...VALID_BODY, branch: 'develop' });

    expect(savedGitRepositories[0].currentBranch).toBe('develop');
    expect(enqueuedOperations[0].branch).toBe('develop');

    await app.close();
  });

  it('never echoes the token back in the response body', async () => {
    const { app } = await buildHarness();

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(202);
    expect(Object.keys(response.json()).toSorted()).toEqual(['operationId', 'projectId']);
    expect(JSON.stringify(response.json())).not.toContain(VALID_BODY.token);

    await app.close();
  });

  it('answers 401 when the caller is not authenticated (requireAuth preHandler enforced)', async () => {
    // The route itself carries no membership/role check to gate — any authenticated user may
    // import — so the only authorization behavior worth exercising here is that the shared
    // requireAuth preHandler (installed for every protected route by the composition root) still
    // guards it. Swapped in for real here rather than relying on the module-level mock above,
    // mirroring how other routes that depend purely on the outer registration scope test this.
    const { requireAuth: realRequireAuth } = jest.requireActual<typeof import('../../../src/plugins/require-auth')>(
      '../../../src/plugins/require-auth',
    );
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: Record<string, unknown> }).session = {};
    });
    app.addHook('preHandler', realRequireAuth);
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.decorate('services', { gitCredentialStore: { save: jest.fn() } } as never);
    app.decorate('repos', {
      project: { save: jest.fn() },
      gitRepository: { save: jest.fn() },
      gitOperation: { enqueue: jest.fn() },
    } as never);
    await app.register(gitImportRoutes);
    await app.ready();

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    await app.close();
  });

  it('answers 400 for an unrecognized provider, before anything is written', async () => {
    const { app, savedProjects, savedGitRepositories } = await buildHarness();

    const response = await importRepo(app, { ...VALID_BODY, provider: 'sourcehut' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);
    expect(savedGitRepositories).toHaveLength(0);

    await app.close();
  });

  it('answers 400 for a malformed remote URL, before anything is written', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await importRepo(app, { ...VALID_BODY, remoteUrl: 'not a url; rm -rf /' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 400 when the token is missing', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await importRepo(app, { provider: 'github', remoteUrl: VALID_BODY.remoteUrl });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 429 once the caller has spent the import rate limit', async () => {
    const { app } = await buildHarness({ rateLimitMax: 1 });

    const first = await importRepo(app, VALID_BODY);
    const second = await importRepo(app, { ...VALID_BODY, remoteUrl: 'https://github.com/acme/other.git' });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');

    await app.close();
  });

  it('answers 500 with a safe generic code when the project row cannot be saved', async () => {
    const { app, savedGitRepositories } = await buildHarness({ projectSaveError: new Error('connection reset') });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('GIT_IMPORT_FAILED');
    expect(response.json().error.message).not.toContain('connection reset');
    expect(savedGitRepositories).toHaveLength(0);

    await app.close();
  });

  it('leaves no membership row when a mid-way persistence failure happens after the project is written', async () => {
    const { app, savedProjects, savedMembers } = await buildHarness({
      gitRepositorySaveError: new Error('connection reset'),
    });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    // The invisible project row survives — it is harmless without a membership — but nothing
    // ever makes it visible.
    expect(savedProjects).toHaveLength(1);
    expect(savedMembers).toHaveLength(0);

    await app.close();
  });

  it('answers 500 without leaking internals when the credential cannot be stored', async () => {
    const { app, savedMembers } = await buildHarness({ credentialSaveError: new Error('kms unavailable') });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('GIT_IMPORT_FAILED');
    expect(response.json().error.message).not.toContain('kms unavailable');
    expect(savedMembers).toHaveLength(0);

    await app.close();
  });

  it('answers 500 when the credential store is not configured', async () => {
    const { app } = await buildHarness({ credentialStoreConfigured: false });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('GIT_IMPORT_FAILED');

    await app.close();
  });

  it('answers 500 when the operation cannot be enqueued', async () => {
    const { app, savedMembers } = await buildHarness({ enqueueError: new Error('queue unavailable') });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('GIT_IMPORT_FAILED');
    expect(savedMembers).toHaveLength(0);

    await app.close();
  });

  it('falls back to a fixed project name when the derived candidate is not a valid project name', async () => {
    const { app, savedProjects } = await buildHarness();
    const oversizedSegment = 'a'.repeat(150);

    const response = await importRepo(app, {
      ...VALID_BODY,
      remoteUrl: `https://github.com/acme/${oversizedSegment}.git`,
    });

    expect(response.statusCode).toBe(202);
    expect(savedProjects[0].name.value).toBe('Imported repository');

    await app.close();
  });

  it('answers 500 when the operation cannot be enqueued and the rejection is not an Error', async () => {
    const { app, savedMembers } = await buildHarness({ enqueueError: 'queue unavailable' });

    const response = await importRepo(app, VALID_BODY);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('GIT_IMPORT_FAILED');
    expect(response.json().error.message).not.toContain('queue unavailable');
    expect(savedMembers).toHaveLength(0);

    await app.close();
  });

  it('propagates a provider failure that is not a domain validation error', async () => {
    const createSpy = jest.spyOn(GitProvider, 'create').mockImplementation(() => {
      throw new TypeError('provider registry unavailable');
    });
    const { app, enqueuedOperations } = await buildHarness();

    try {
      const response = await importRepo(app, VALID_BODY);

      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(enqueuedOperations).toHaveLength(0);
    } finally {
      createSpy.mockRestore();
      await app.close();
    }
  });
});
