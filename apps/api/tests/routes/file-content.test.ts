import Fastify from 'fastify';
import {
  GetFileNodeContentUseCase,
  SaveDocumentContentUseCase,
  PermissionDeniedError,
  FileNodeNotFoundError,
  ContentNotFoundError,
} from '@asciidocollab/domain';
import { fileContentRoutes } from '../../src/routes/projects/file-content';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

afterEach(() => jest.restoreAllMocks());

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440003';
const CONTENT_ID = '660e8400-e29b-41d4-a716-446655440004';
const DOC_ID = '770e8400-e29b-41d4-a716-446655440005';
const YJS_STATE_ID = '880e8400-e29b-41d4-a716-446655440006';

function buildTestServer(options: { contentId?: string; activeSession?: boolean } = {}) {
  const app = Fastify();
  decorateApp(app, 'repos', {
    projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'viewer' } }) },
    fileNode: { findById: jest.fn().mockResolvedValue({ projectId: { value: PROJECT_ID }, path: { value: '/test.adoc' } }) },
    document: {
      findByFileNodeId: jest.fn().mockResolvedValue({
        id: { value: DOC_ID },
        fileNodeId: { value: FILE_NODE_ID },
        contentId: { value: options.contentId ?? CONTENT_ID },
        yjsStateId: { value: YJS_STATE_ID },
        mimeType: { value: 'text/asciidoc' },
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      }),
      save: jest.fn().mockResolvedValue(undefined),
    },
    collaborationSession: {
      isActive: jest.fn().mockResolvedValue(options.activeSession ?? false),
    },
  });
  decorateApp(app, 'stores', {
    fileStore: {
      read: jest.fn().mockResolvedValue(Buffer.from('= Hello')),
      write: jest.fn().mockResolvedValue(undefined),
    },
  });
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  decorateApp(app, 'config', { project: { fileContent: { rateLimitMax: 600, rateLimitWindow: 3_600_000 } } });
  decorateApp(app, 'fileTreeEventBus', { emit: jest.fn(), subscribe: jest.fn() });
  app.register(fileContentRoutes);
  return app;
}

/** Reads the fileTreeEventBus.emit mock off a built test server. */
function emitMock(app: ReturnType<typeof buildTestServer>) {
  return (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus.emit;
}

describe('GET /projects/:projectId/files/:fileNodeId/content', () => {
  // Issue C10: ETag must be derived from contentId (a stable domain identifier)
  // not from an MD5 hash computed on every request.
  test('returns ETag header containing the document contentId', async () => {
    const app = buildTestServer({ contentId: CONTENT_ID });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
    });
    expect(response.statusCode).toBe(200);
    const etag = response.headers['etag'];
    expect(etag).toBeDefined();
    // Must contain the contentId UUID, not an arbitrary hash
    expect(etag).toContain(CONTENT_ID);
  });

  test('ETag is stable across identical requests (same contentId → same ETag)', async () => {
    const app = buildTestServer({ contentId: CONTENT_ID });
    const first = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    const second = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(first.headers['etag']).toBe(second.headers['etag']);
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/content (error paths)', () => {
  it('returns 403 FORBIDDEN on PermissionDeniedError', async () => {
    jest.spyOn(GetFileNodeContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const result = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 NOT_FOUND on FileNodeNotFoundError', async () => {
    jest.spyOn(GetFileNodeContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new FileNodeNotFoundError(FILE_NODE_ID),
    });

    const app = buildTestServer();
    const result = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND on ContentNotFoundError', async () => {
    jest.spyOn(GetFileNodeContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ContentNotFoundError(FILE_NODE_ID),
    });

    const app = buildTestServer();
    const result = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(result.statusCode).toBe(404);
  });

  it('returns 500 INTERNAL_ERROR for unrecognised error', async () => {
    jest.spyOn(GetFileNodeContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('unknown') as never,
    });

    const app = buildTestServer();
    const result = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('omits ETag header when contentId is absent', async () => {
    jest.spyOn(GetFileNodeContentUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        content: Buffer.from('= Hello'),
        mimeType: { value: 'text/asciidoc' },
        contentId: null,
      } as never,
    });

    const app = buildTestServer();
    const result = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content` });
    expect(result.statusCode).toBe(200);
    expect(result.headers['etag']).toBeUndefined();
  });
});

describe('PUT /projects/:projectId/files/:fileNodeId/content (error paths)', () => {
  it('returns 403 FORBIDDEN on PermissionDeniedError', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const result = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Content',
      headers: { 'content-type': 'text/plain' },
    });
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 NOT_FOUND on FileNodeNotFoundError', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new FileNodeNotFoundError(FILE_NODE_ID),
    });

    const app = buildTestServer();
    const result = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Content',
      headers: { 'content-type': 'text/plain' },
    });
    expect(result.statusCode).toBe(404);
  });

  it('returns 500 INTERNAL_ERROR for unrecognised error', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('unknown') as never,
    });

    const app = buildTestServer();
    const result = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Content',
      headers: { 'content-type': 'text/plain' },
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('PUT /projects/:projectId/files/:fileNodeId/content', () => {
  // Issue 2: PUT must return an ETag so useAutoSave can seed storedEtag for
  // external-change polling. Without it storedEtag stays null and the HEAD
  // poll short-circuits on every tick, making collaborative sync dead.
  test('returns an ETag header after successfully saving content', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Updated',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['etag']).toBeDefined();
    expect(typeof response.headers['etag']).toBe('string');
    expect((response.headers['etag'] as string).length).toBeGreaterThan(0);
  });

  test('emits a content-changed event for the saved file so open dependents refresh', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { contentId: CONTENT_ID } as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Updated',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(204);
    expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, { type: 'content-changed', fileNodeId: FILE_NODE_ID });
  });

  test('does not emit a content-changed event when the save is rejected', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Updated',
      headers: { 'content-type': 'text/plain' },
    });
    expect(emitMock(app)).not.toHaveBeenCalled();
  });

  test('accepts JSON body (non-Buffer) and returns 204', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { contentId: 'test-content-id' } as never,
    });

    const app = buildTestServer();
    const result = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: { data: '= Hello' },
      headers: { 'content-type': 'application/json' },
    });
    expect(result.statusCode).toBe(204);
  });

  test('accepts string body (non-Buffer, non-JSON) and returns 204', async () => {
    jest.spyOn(SaveDocumentContentUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { contentId: 'test-content-id' } as never,
    });

    const app = Fastify();
    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'viewer' } }) },
      fileNode: { findById: jest.fn().mockResolvedValue({ projectId: { value: PROJECT_ID }, path: { value: '/test.adoc' } }) },
      document: {
        findByFileNodeId: jest.fn().mockResolvedValue({
          id: { value: '770e8400-e29b-41d4-a716-446655440005' },
          contentId: { value: 'test-content-id' },
          mimeType: { value: 'text/asciidoc' },
        }),
        save: jest.fn().mockResolvedValue(undefined),
      },
      collaborationSession: { isActive: jest.fn().mockResolvedValue(false) },
    });
    decorateApp(app, 'stores', {
      fileStore: { read: jest.fn().mockResolvedValue(Buffer.from('= Hello')), write: jest.fn().mockResolvedValue(undefined) },
    });
    app.addContentTypeParser('text/markdown', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    decorateApp(app, 'config', { project: { fileContent: { rateLimitMax: 600, rateLimitWindow: 3_600_000 } } });
    decorateApp(app, 'fileTreeEventBus', { emit: jest.fn(), subscribe: jest.fn() });
    app.register(fileContentRoutes);
    await app.ready();

    const result = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Hello world',
      headers: { 'content-type': 'text/markdown' },
    });
    expect(result.statusCode).toBe(204);
    await app.close();
  });

  test('returns 409 with { error: { code, message } } when a collaboration session is active', async () => {
    const app = buildTestServer({ activeSession: true });
    const response = await app.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/content`,
      payload: '= Updated',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(typeof body.error.message).toBe('string');
  });
});
