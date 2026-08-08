import Fastify from 'fastify';
import { GetProjectTreeUseCase } from '@asciidocollab/domain';
import { fileTreeGetRoutes } from '../../src/routes/projects/file-tree-get';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_ID = '550e8400-e29b-41d4-a716-446655440003';
const FILE_ID = '550e8400-e29b-41d4-a716-446655440004';

/** The slice of a file node these route tests stand in for. */
type NodeFixture = {
  id: { value: string };
  name: string;
  type: { value: string };
  path: { value: string };
  parentId: { value: string } | null;
};

const rootNode: NodeFixture = {
  id: { value: ROOT_ID },
  name: 'root',
  type: { value: 'folder' },
  path: { value: '/' },
  parentId: null,
};

const fileNode: NodeFixture = {
  id: { value: FILE_ID },
  name: 'doc.adoc',
  type: { value: 'file' },
  path: { value: '/doc.adoc' },
  parentId: { value: ROOT_ID },
};

const document_ = {
  fileNodeId: { value: FILE_ID },
  mimeType: { value: 'text/asciidoc' },
};

function buildTestServer({
  isMember = true,
  projectExists = true,
  nodes = [rootNode, fileNode],
  documents = [document_],
}: {
  isMember?: boolean;
  projectExists?: boolean;
  nodes?: NodeFixture[];
  documents?: typeof document_[];
} = {}) {
  const app = Fastify();

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(isMember ? { role: { value: 'viewer' } } : null),
    },
    fileNode: {
      findByProjectId: jest.fn().mockResolvedValue(nodes),
    },
    document: {
      findByFileNodeIds: jest.fn().mockResolvedValue(documents),
    },
    project: {
      findById: jest.fn().mockResolvedValue(
        projectExists
          ? { rootFolderId: { value: ROOT_ID }, name: { value: 'My Project' } }
          : null,
      ),
    },
  });

  decorateApp(app, 'config', {});
  decorateApp(app, 'stores', {});
  decorateApp(app, 'services', {});
  decorateApp(app, 'prisma', null);

  return app;
}

describe('GET /projects/:projectId/files', () => {
  it('returns 200 with root node and nested children for a member', async () => {
    const app = buildTestServer();
    await app.register(fileTreeGetRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(ROOT_ID);
    expect(body.type).toBe('folder');
    expect(body.parentId).toBeNull();
    expect(body.children).toHaveLength(1);
    expect(body.children[0].id).toBe(FILE_ID);
    expect(body.children[0].parentId).toBe(ROOT_ID);

    await app.close();
  });

  it('returns 200 with empty children for a project with no files', async () => {
    const app = buildTestServer({ nodes: [rootNode], documents: [] });
    await app.register(fileTreeGetRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.children).toHaveLength(0);

    await app.close();
  });

  it('returns 404 when the project does not exist', async () => {
    const app = buildTestServer({ projectExists: false });
    await app.register(fileTreeGetRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files` });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('returns 403 when the caller is not a project member', async () => {
    const app = buildTestServer({ isMember: false });
    await app.register(fileTreeGetRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files` });

    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it('returns 500 INTERNAL_ERROR for unexpected use case error', async () => {
    jest.spyOn(GetProjectTreeUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('unexpected failure') as never,
    });
    const app = buildTestServer();
    await app.register(fileTreeGetRoutes);
    await app.ready();
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files` });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
    jest.restoreAllMocks();
    await app.close();
  });
});
