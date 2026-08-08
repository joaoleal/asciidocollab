import type { InjectOptions } from 'fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  Project,
  ProjectName,
  ProjectId,
  FileNodeId,
  FileNode,
  FileNodeType,
  FilePath,
} from '@asciidocollab/domain';
import { projectMainFileRoutes } from '../../../src/routes/projects/main-file';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_ID = '550e8400-e29b-41d4-a716-446655440003';
const ADOC_ID = '550e8400-e29b-41d4-a716-446655440004';
const TXT_ID = '550e8400-e29b-41d4-a716-446655440005';

function adocNode(): FileNode {
  return new FileNode(FileNodeId.create(ADOC_ID), ProjectId.create(PROJECT_ID), FileNodeId.create(ROOT_ID), 'main.adoc', FileNodeType.create('file'), FilePath.create('/main.adoc'));
}
function txtNode(): FileNode {
  return new FileNode(FileNodeId.create(TXT_ID), ProjectId.create(PROJECT_ID), FileNodeId.create(ROOT_ID), 'notes.txt', FileNodeType.create('file'), FilePath.create('/notes.txt'));
}

interface ServerOptions {
  role?: string | null;
  projectExists?: boolean;
  rateLimitMax?: number;
}

async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const { role = 'editor', projectExists = true, rateLimitMax = 50 } = options;
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateApp(app, 'config', { project: { mainFile: { rateLimitMax, rateLimitWindow: 60_000 } } });
  decorateApp(app, 'repos', {
    project: {
      findById: jest.fn(async () =>
        projectExists ? new Project(ProjectId.create(PROJECT_ID), ProjectName.create('P'), null, [], FileNodeId.create(ROOT_ID)) : null,
      ),
      save: jest.fn(),
    },
    projectMember: {
      findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
    },
    fileNode: {
      findById: jest.fn(async (id: { value: string }) => {
        if (id.value === ADOC_ID) return adocNode();
        if (id.value === TXT_ID) return txtNode();
        return null;
      }),
    },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'fileTreeEventBus', { emit: jest.fn(), subscribe: jest.fn() });
  await app.register(projectMainFileRoutes);
  await app.ready();
  return app;
}

/** Reads the fileTreeEventBus.emit mock off a built test server. */
function emitMock(app: FastifyInstance) {
  return (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus.emit;
}

function put(app: FastifyInstance, body: InjectOptions['payload']) {
  return app.inject({ method: 'PUT', url: `/projects/${PROJECT_ID}/main-file`, payload: body });
}

describe('PUT /projects/:projectId/main-file', () => {
  test('200 — an editor sets the main file', async () => {
    const app = await buildServer({ role: 'editor' });
    const response = await put(app, { mainFileNodeId: ADOC_ID });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.mainFileNodeId).toBe(ADOC_ID);
    await app.close();
  });

  test('200 — clearing (null) is allowed', async () => {
    const app = await buildServer({ role: 'owner' });
    const response = await put(app, { mainFileNodeId: null });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.mainFileNodeId).toBeNull();
    await app.close();
  });

  test('emits main-file-changed with the new anchor on a successful set', async () => {
    const app = await buildServer({ role: 'editor' });
    await put(app, { mainFileNodeId: ADOC_ID });
    expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, { type: 'main-file-changed', mainFileNodeId: ADOC_ID });
    await app.close();
  });

  test('emits main-file-changed with null when the main file is cleared', async () => {
    const app = await buildServer({ role: 'owner' });
    await put(app, { mainFileNodeId: null });
    expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, { type: 'main-file-changed', mainFileNodeId: null });
    await app.close();
  });

  test('does not emit main-file-changed when the request is rejected', async () => {
    const app = await buildServer({ role: 'viewer' });
    await put(app, { mainFileNodeId: ADOC_ID });
    expect(emitMock(app)).not.toHaveBeenCalled();
    await app.close();
  });

  test('403 — a viewer is forbidden (use-case PermissionDenied surfaced)', async () => {
    const app = await buildServer({ role: 'viewer' });
    const response = await put(app, { mainFileNodeId: ADOC_ID });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  test('400 — a non-.adoc file', async () => {
    const app = await buildServer({ role: 'editor' });
    const response = await put(app, { mainFileNodeId: TXT_ID });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('MainFileNotAsciiDoc');
    await app.close();
  });

  test('404 — an unknown node', async () => {
    const app = await buildServer({ role: 'editor' });
    const response = await put(app, { mainFileNodeId: '550e8400-e29b-41d4-a716-4466554400ff' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  test('404 — an unknown project', async () => {
    const app = await buildServer({ role: 'editor', projectExists: false });
    const response = await put(app, { mainFileNodeId: ADOC_ID });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  test('429 — exceeding the per-route rate limit returns RATE_LIMITED', async () => {
    const app = await buildServer({ role: 'editor', rateLimitMax: 1 });
    const first = await put(app, { mainFileNodeId: ADOC_ID });
    expect(first.statusCode).toBe(200);
    const second = await put(app, { mainFileNodeId: ADOC_ID });
    expect(second.statusCode).toBe(429);
    await app.close();
  });
});
