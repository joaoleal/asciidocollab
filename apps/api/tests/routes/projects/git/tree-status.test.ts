import Fastify, { type FastifyInstance } from 'fastify';
import { FileNode, FileNodeId, FileNodeType, FilePath, ProjectId } from '@asciidocollab/domain';
import type {
  GitWorkerClient,
  GitWorkerPendingChange,
  GitWorkerResult,
  GitWorkerStatusData,
} from '@asciidocollab/infrastructure';
import {
  buildTreeStatus,
  deriveFileGitStatus,
  gitTreeStatusRoutes,
} from '../../../../src/routes/projects/git/tree-status';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_FOLDER_ID = '550e8400-e29b-41d4-a716-446655440010';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440011';

function statusData(changes: readonly GitWorkerPendingChange[]): GitWorkerStatusData {
  return {
    currentBranch: 'main',
    changes,
    syncStatus: 'UP_TO_DATE',
    defaultBranch: 'main',
    lastKnownRemoteHead: null,
    lastSyncAt: null,
  };
}

function buildFileNode(path: string, id: string): FileNode {
  return new FileNode(
    FileNodeId.create(id),
    ProjectId.create(PROJECT_ID),
    FileNodeId.create(ROOT_FOLDER_ID),
    'doc.adoc',
    FileNodeType.create('file'),
    FilePath.create(path),
  );
}

describe('deriveFileGitStatus (pure helper)', () => {
  test('conflicted takes precedence over everything else', () => {
    expect(deriveFileGitStatus({ path: 'a', changeType: 'removed', state: 'conflicted' })).toBe('conflicted');
  });

  test('untracked takes precedence over changeType/staged', () => {
    expect(deriveFileGitStatus({ path: 'a', changeType: 'removed', state: 'untracked' })).toBe('untracked');
  });

  test('a removed changeType (not conflicted/untracked) maps to removed regardless of staged/unstaged', () => {
    expect(deriveFileGitStatus({ path: 'a', changeType: 'removed', state: 'staged' })).toBe('removed');
    expect(deriveFileGitStatus({ path: 'a', changeType: 'removed', state: 'unstaged' })).toBe('removed');
  });

  test('staged (non-removed) maps to staged', () => {
    expect(deriveFileGitStatus({ path: 'a', changeType: 'modified', state: 'staged' })).toBe('staged');
  });

  test('everything else falls through to modified', () => {
    expect(deriveFileGitStatus({ path: 'a', changeType: 'modified', state: 'unstaged' })).toBe('modified');
    expect(deriveFileGitStatus({ path: 'a', changeType: 'added', state: 'unstaged' })).toBe('modified');
  });
});

describe('buildTreeStatus (pure helper)', () => {
  test('normalizes a worker (no leading slash) path to match a leading-slash FileNode path', () => {
    const nodes = [buildFileNode('/docs/intro.adoc', FILE_NODE_ID)];
    const result = buildTreeStatus([{ path: 'docs/intro.adoc', changeType: 'modified', state: 'unstaged' }], nodes);
    expect(result.statusByFileNodeId).toEqual({ [FILE_NODE_ID]: 'modified' });
  });

  test('skips a change with no matching FileNode (e.g. an internal or not-yet-imported path)', () => {
    const nodes = [buildFileNode('/docs/intro.adoc', FILE_NODE_ID)];
    const result = buildTreeStatus(
      [{ path: '.collab/some-blob', changeType: 'added', state: 'untracked' }],
      nodes,
    );
    expect(result.statusByFileNodeId).toEqual({});
  });

  test('applies deriveFileGitStatus precedence per matched change', () => {
    const otherId = '550e8400-e29b-41d4-a716-446655440012';
    const nodes = [buildFileNode('/a.adoc', FILE_NODE_ID), buildFileNode('/b.adoc', otherId)];
    const result = buildTreeStatus(
      [
        { path: 'a.adoc', changeType: 'modified', state: 'conflicted' },
        { path: 'b.adoc', changeType: 'added', state: 'untracked' },
      ],
      nodes,
    );
    expect(result.statusByFileNodeId).toEqual({ [FILE_NODE_ID]: 'conflicted', [otherId]: 'untracked' });
  });
});

/** Builds a `getStatus` fake resolving with a fixed result. */
function mockGetStatus(result: GitWorkerResult<GitWorkerStatusData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/tree-status', () => {
  function buildServer(options: {
    role?: string | null;
    client?: Partial<GitWorkerClient>;
    nodes?: FileNode[];
  }): FastifyInstance {
    const { role = 'viewer', client = {}, nodes = [] } = options;
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    instance.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
      fileNode: { findByProjectId: jest.fn(async () => nodes) },
    } as never);
    instance.decorate('stores', {
      gitWorkerClient: {
        getStatus: mockGetStatus({ ok: true, data: statusData([]) }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instance: FastifyInstance) {
    await instance.register(gitTreeStatusRoutes);
    return instance;
  }

  function getTreeStatus(app: FastifyInstance, projectId: string) {
    return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/tree-status` });
  }

  test('returns 200 with the FileNodeId -> FileGitStatus map', async () => {
    const nodes = [buildFileNode('/docs/intro.adoc', FILE_NODE_ID)];
    const instance = await register(
      buildServer({
        role: 'viewer',
        nodes,
        client: {
          getStatus: mockGetStatus({
            ok: true,
            data: statusData([{ path: 'docs/intro.adoc', changeType: 'modified', state: 'staged' }]),
          }),
        },
      }),
    );

    const response = await getTreeStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ statusByFileNodeId: { [FILE_NODE_ID]: 'staged' } });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403', async () => {
    const getStatusMock = mockGetStatus({ ok: true, data: statusData([]) });
    const instance = await register(buildServer({ role: null, client: { getStatus: getStatusMock } }));

    const response = await getTreeStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(getStatusMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getStatus: mockGetStatus({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getTreeStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });
});
