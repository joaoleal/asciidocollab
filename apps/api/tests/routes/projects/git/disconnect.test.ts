import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { GitRepository, GitRepositoryId, ProjectId } from '@asciidocollab/domain';
import { gitDisconnectRoutes } from '../../../../src/routes/projects/git/disconnect';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

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
  /** Whether the project has an active git operation (single-flight guard trips). */
  activeOperation?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'owner', existing = existingRepository(), activeOperation = false } = options;

  const deletedGitRepositoryIds: string[] = [];
  const deletedCredentialProjectIds: string[] = [];
  const auditSave = jest.fn();

  const gitRepositoryDelete = jest.fn(async (id: { value: string }) => {
    deletedGitRepositoryIds.push(id.value);
  });
  const credentialDelete = jest.fn(async (projectId: { value: string }) => {
    deletedCredentialProjectIds.push(projectId.value);
  });
  const findByProjectId = jest.fn(async () => existing);

  const build = async (): Promise<FastifyInstance> => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
      gitRepository: { findByProjectId, delete: gitRepositoryDelete },
      gitOperation: {
        withGuard: jest.fn(async (_projectId: unknown, action: () => Promise<unknown>) => {
          if (activeOperation) {
            return { success: false, error: { name: 'GitOperationInProgressError' } };
          }
          const value = await action();
          return { success: true, value };
        }),
      },
    } as never);
    app.decorate('services', {
      gitCredentialStore: { save: jest.fn(), load: jest.fn(async () => null), delete: credentialDelete },
    } as never);
    await app.register(gitDisconnectRoutes);
    await app.ready();
    return app;
  };

  return { build, findByProjectId, gitRepositoryDelete, credentialDelete, deletedGitRepositoryIds, deletedCredentialProjectIds };
}

function disconnect(app: FastifyInstance, projectId: string) {
  return app.inject({ method: 'POST', url: `/projects/${projectId}/git/disconnect`, payload: {} });
}

describe('POST /projects/:projectId/git/disconnect', () => {
  it('answers 200 {ok:true} and deletes both the repository row and the stored credential', async () => {
    const repository = existingRepository();
    const { build, deletedGitRepositoryIds, deletedCredentialProjectIds } = buildHarness({ existing: repository });
    const app = await build();

    const response = await disconnect(app, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(deletedGitRepositoryIds).toEqual([repository.id.value]);
    expect(deletedCredentialProjectIds).toEqual([PROJECT_ID]);

    await app.close();
  });

  it('answers 403 for a non-owner and deletes nothing', async () => {
    const { build, gitRepositoryDelete, credentialDelete } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await disconnect(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(gitRepositoryDelete).not.toHaveBeenCalled();
    expect(credentialDelete).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and deletes nothing', async () => {
    const { build, gitRepositoryDelete } = buildHarness({ role: null });
    const app = await build();

    const response = await disconnect(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(gitRepositoryDelete).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 404 repository_not_connected when the project has no repository row', async () => {
    const { build, gitRepositoryDelete, credentialDelete } = buildHarness({ existing: null });
    const app = await build();

    const response = await disconnect(app, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');
    expect(gitRepositoryDelete).not.toHaveBeenCalled();
    expect(credentialDelete).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 409 git_operation_in_progress when another git action is already in flight', async () => {
    const { build, gitRepositoryDelete } = buildHarness({ activeOperation: true });
    const app = await build();

    const response = await disconnect(app, PROJECT_ID);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('git_operation_in_progress');
    expect(gitRepositoryDelete).not.toHaveBeenCalled();

    await app.close();
  });
});
