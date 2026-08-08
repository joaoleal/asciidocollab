import Fastify from 'fastify';
import { Readable } from 'stream';
import { DownloadFileUseCase } from '@asciidocollab/domain';
import { fileDownloadRoute } from '../../../src/routes/projects/file-download';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID   = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440003';
const ROOT_NODE_ID = '550e8400-e29b-41d4-a716-446655440004';
// A file node that belongs to a DIFFERENT project — IDOR guard test
const OTHER_PID    = '550e8400-e29b-41d4-a716-446655440005';

function makeFileNode(projectId = PROJECT_ID) {
  return {
    id: { value: FILE_NODE_ID },
    projectId: { value: projectId },
    type: { value: 'file' },
    name: 'readme.adoc',
    path: { value: '/readme.adoc' },
    parentId: { value: ROOT_NODE_ID },
  };
}

function makeFolderNode() {
  return {
    id: { value: FILE_NODE_ID },
    projectId: { value: PROJECT_ID },
    type: { value: 'folder' },
    name: 'docs',
    path: { value: '/docs' },
    parentId: { value: ROOT_NODE_ID },
  };
}

function buildTestServer(options: {
  memberRole?: string | null;
  fileNode?: object | null;
  readStreamResult?: Readable | null;
  document?: object | null;
  sessionActive?: boolean;
  readerResult?: { success: boolean; value?: string | null; error?: Error };
} = {}) {
  const app = Fastify();
  const {
    memberRole = 'viewer',
    fileNode = makeFileNode(),
    readStreamResult,
    document = null,
    sessionActive = false,
    readerResult = { success: true, value: null },
  } = options;

  const fileStream = readStreamResult === undefined
    ? Readable.from(Buffer.from('= Hello'))
    : readStreamResult;

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(
        memberRole ? { role: { value: memberRole } } : null,
      ),
    },
    project: {
      findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID }, name: { value: 'My Project' } }),
    },
    fileNode: {
      findById: jest.fn().mockResolvedValue(fileNode),
    },
    document: {
      findByFileNodeId: jest.fn().mockResolvedValue(document),
    },
    collaborationSession: {
      isActive: jest.fn().mockResolvedValue(sessionActive),
    },
  });

  decorateApp(app, 'stores', {
    fileStore: {
      readStream: jest.fn().mockResolvedValue(fileStream),
    },
    collaborativeContentEditor: {
      readContent: jest.fn().mockResolvedValue(readerResult),
    },
  });

  decorateApp(app, 'config', {
    downloads: {
      file: { rateLimitMax: 30, rateLimitWindow: 60_000 },
    },
  });

  app.register(fileDownloadRoute);
  return app;
}

describe('GET /projects/:projectId/files/:fileNodeId/download', () => {
  test('member can download file — returns 200', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
  });

  test('Content-Disposition header contains attachment and filename', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/readme\.adoc/);
  });

  test('preHandler hook headers (e.g. CORS) appear in response — stored path', async () => {
    const app = Fastify();
    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'viewer' } }) },
      project: { findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID }, name: { value: 'P' } }) },
      fileNode: { findById: jest.fn().mockResolvedValue(makeFileNode()) },
      document: { findByFileNodeId: jest.fn().mockResolvedValue(null) },
      collaborationSession: { isActive: jest.fn().mockResolvedValue(false) },
    });
    decorateApp(app, 'stores', {
      fileStore: { readStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('= Hi'))) },
      collaborativeContentEditor: { readContent: jest.fn().mockResolvedValue({ success: true, value: null }) },
    });
    decorateApp(app, 'config', { downloads: { file: { rateLimitMax: 30, rateLimitWindow: 60_000 } } });
    app.addHook('preHandler', async (_request, reply) => { reply.header('x-test-hook', 'present'); });
    app.register(fileDownloadRoute);
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download` });
    expect(response.headers['x-test-hook']).toBe('present');
  });

  test('preHandler hook headers (e.g. CORS) appear in response — inline path', async () => {
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = Fastify();
    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'viewer' } }) },
      project: { findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID }, name: { value: 'P' } }) },
      fileNode: { findById: jest.fn().mockResolvedValue(makeFileNode()) },
      document: { findByFileNodeId: jest.fn().mockResolvedValue(fakeDocument) },
      collaborationSession: { isActive: jest.fn().mockResolvedValue(true) },
    });
    decorateApp(app, 'stores', {
      fileStore: { readStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))) },
      collaborativeContentEditor: { readContent: jest.fn().mockResolvedValue({ success: true, value: '= Live' }) },
    });
    decorateApp(app, 'config', { downloads: { file: { rateLimitMax: 30, rateLimitWindow: 60_000 } } });
    app.addHook('preHandler', async (_request, reply) => { reply.header('x-test-hook', 'present'); });
    app.register(fileDownloadRoute);
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download` });
    expect(response.headers['x-test-hook']).toBe('present');
  });

  test('SECURITY S4: response sets Content-Type: application/octet-stream', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.headers['content-type']).toMatch(/application\/octet-stream/);
  });

  test('folder node returns 400', async () => {
    const app = buildTestServer({ fileNode: makeFolderNode() });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(400);
  });

  test('non-member returns 403', async () => {
    const app = buildTestServer({ memberRole: null });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(403);
  });

  test('file from different project returns 404 (IDOR guard)', async () => {
    // File node exists but belongs to a different project
    const app = buildTestServer({ fileNode: makeFileNode(OTHER_PID) });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(404);
  });

  test('fileNode not found returns 404', async () => {
    const app = buildTestServer({ fileNode: null });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(404);
  });

  test('fileStore.readStream() returns null → 404 (filesystem/DB desync)', async () => {
    const app = buildTestServer({ readStreamResult: null });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(404);
  });

  test('rate limit returns 429 when exceeded', async () => {

    const rateLimit = require('@fastify/rate-limit') as { default: typeof import('@fastify/rate-limit')['default'] };
    const app = Fastify();

    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'viewer' } }) },
      project: { findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID }, name: { value: 'P' } }) },
      fileNode: { findById: jest.fn().mockResolvedValue(makeFileNode()) },
      document: { findByFileNodeId: jest.fn().mockResolvedValue(null) },
      collaborationSession: { isActive: jest.fn().mockResolvedValue(false) },
    });
    decorateApp(app, 'stores', {
      fileStore: { readStream: jest.fn().mockResolvedValue(Readable.from('hello')) },
      collaborativeContentEditor: { readContent: jest.fn().mockResolvedValue({ success: true, value: null }) },
    });
    decorateApp(app, 'config', { downloads: { file: { rateLimitMax: 1, rateLimitWindow: 60_000 } } });

    await app.register(rateLimit.default, { global: false });
    app.register(fileDownloadRoute);
    await app.ready();

    // First request — counts against limit
    await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download` });
    // Second request — rate limited
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download` });
    expect(response.statusCode).toBe(429);
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — live content', () => {
  test('active session + reader returns text → response body is the live bytes', async () => {
    const liveText = '= Live Edit\nContent edited by user';
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = buildTestServer({
      document: fakeDocument,
      sessionActive: true,
      readerResult: { success: true, value: liveText },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from(liveText, 'utf8'));
  });

  test('active session + reader returns text → Content-Disposition header is unchanged', async () => {
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = buildTestServer({
      document: fakeDocument,
      sessionActive: true,
      readerResult: { success: true, value: '= Live' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/readme\.adoc/);
  });

  test('no active session (stored) → response is produced via fileStore.readStream', async () => {
    const storedContent = Buffer.from('= Stored Content');
    const app = buildTestServer({ readStreamResult: Readable.from(storedContent) });

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    expect(response.statusCode).toBe(200);
    const { stores } = app as unknown as { stores: { fileStore: { readStream: jest.Mock } } };
    expect(stores.fileStore.readStream).toHaveBeenCalled();
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — resilience', () => {
  test('active session + reader returns error → 200 with disk bytes, no internal error in response', async () => {
    const storedContent = Buffer.from('= Stored Fallback');
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = buildTestServer({
      document: fakeDocument,
      sessionActive: true,
      readerResult: { success: false, error: new Error('collab server unreachable') },
      readStreamResult: Readable.from(storedContent),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    // SECURITY S3: client gets 200 with file bytes — no internal error detail
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(storedContent);
    // Ensure the response is not a JSON error object
    expect(() => JSON.parse(response.body)).toThrow();
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — filename sanitization', () => {
  test(String.raw`CRLF in filename does not crash the response (\r\n stripped) — stored path`, async () => {
    const fileNodeWithCrlf = {
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      type: { value: 'file' },
      name: 'evil\r\nfile.adoc',
      path: { value: '/evil\r\nfile.adoc' },
      parentId: { value: ROOT_NODE_ID },
    };
    const app = buildTestServer({ fileNode: fileNodeWithCrlf });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).not.toMatch(/\r|\n/);
  });

  test(String.raw`CRLF in filename does not crash the response (\r\n stripped) — inline path`, async () => {
    const fileNodeWithCrlf = {
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      type: { value: 'file' },
      name: 'report\r\n.adoc',
      path: { value: '/report\r\n.adoc' },
      parentId: { value: ROOT_NODE_ID },
    };
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = buildTestServer({
      fileNode: fileNodeWithCrlf,
      document: fakeDocument,
      sessionActive: true,
      readerResult: { success: true, value: '= Live' },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).not.toMatch(/\r|\n/);
  });

  test('double-quote in filename is stripped from Content-Disposition to prevent header injection', async () => {
    const fileNodeWithQuote = {
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      type: { value: 'file' },
      name: 'evil".adoc',
      path: { value: '/evil".adoc' },
      parentId: { value: ROOT_NODE_ID },
    };
    const app = buildTestServer({ fileNode: fileNodeWithQuote });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).not.toContain('"evil"');
    expect(disposition).toMatch(/evil\.adoc/);
  });

  test('inline path: double-quote in filename is stripped from Content-Disposition', async () => {
    const fileNodeWithQuote = {
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      type: { value: 'file' },
      name: 'report".adoc',
      path: { value: '/report".adoc' },
      parentId: { value: ROOT_NODE_ID },
    };
    const fakeDocument = {
      id: { value: '550e8400-e29b-41d4-a716-aaabbbccc001' },
      fileNodeId: { value: FILE_NODE_ID },
      yjsStateId: { value: '550e8400-e29b-41d4-a716-aaabbbccc002' },
    };
    const app = buildTestServer({
      fileNode: fileNodeWithQuote,
      document: fakeDocument,
      sessionActive: true,
      readerResult: { success: true, value: '= Live' },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).not.toContain('"report"');
    expect(disposition).toMatch(/report\.adoc/);
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — stream error handling', () => {
  test('stream error does not call reply.raw.end() — only logs; Fastify eos destroys the socket', async () => {
    // reply.raw.end() is synchronous — it sets writableEnded=true immediately.
    // Fastify's eos-based destroy() is asynchronous (fires after stream.finished callback).
    // We can distinguish them by checking writableEnded synchronously right after the error fires.
    let writableEndedImmediatelyAfterError: boolean | null = null;
    const errorStream = new Readable({ read() {} });

    const app = buildTestServer({ readStreamResult: errorStream });

    let rawResponse: import('http').ServerResponse | null = null;
    app.addHook('onSend', async (_request, reply) => { rawResponse = reply.raw; });

    const responsePromise = app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    setImmediate(() => {
      errorStream.emit('error', new Error('S3 network fault'));
      // Check synchronously: if our handler called reply.raw.end(), writableEnded is already true.
      writableEndedImmediatelyAfterError = rawResponse?.writableEnded ?? null;
    });

    await responsePromise;

    // After fix: our handler only logs — reply.raw.end() is not called, writableEnded stays false.
    expect(writableEndedImmediatelyAfterError).toBe(false);
  });

  test('storage stream error is caught — no unhandled EventEmitter error, response completes without process crash', async () => {
    const errorStream = new Readable({ read() {} });
    const app = buildTestServer({ readStreamResult: errorStream });

    const responsePromise = app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });

    // Emit error after the handler has attached stream.on('error') but before piping completes.
    // The explicit error listener prevents an unhandled EventEmitter error (process crash).
    // Fastify's own error handler then closes the response — inject() resolves rather than rejects.
    setImmediate(() => errorStream.emit('error', new Error('S3 network fault')));

    const response = await responsePromise;
    // Any completed response (not a hanging promise) proves no uncaught exception occurred.
    expect([500, 200]).toContain(response.statusCode);
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — non-ASCII filename (RFC 5987)', () => {
  test('non-ASCII filename emits filename*=UTF-8\'\'... in Content-Disposition', async () => {
    const nonAsciiFileNode = {
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      type: { value: 'file' },
      name: 'café.adoc',
      path: { value: '/café.adoc' },
      parentId: { value: ROOT_NODE_ID },
    };
    const app = buildTestServer({ fileNode: nonAsciiFileNode });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    // RFC 5987 encoded param must be present
    expect(disposition).toContain("filename*=UTF-8''");
    // é = U+00E9 → UTF-8 0xC3 0xA9 → %C3%A9
    expect(disposition).toContain('%C3%A9');
    // Legacy ASCII fallback must be present (strips non-ASCII)
    expect(disposition).toContain('filename="caf.adoc"');
  });
});

describe('GET /projects/:projectId/files/:fileNodeId/download — use case error paths', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns 500 INTERNAL_ERROR for unexpected use case error', async () => {
    jest.spyOn(DownloadFileUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('unexpected') as never,
    });
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/download`,
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
  });
});
