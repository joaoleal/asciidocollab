import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import * as Y from 'yjs';
import type { Logger } from 'pino';
import { Re2RegexEngine } from '@asciidocollab/infrastructure';
import {
  APPLY_EDITS_PATH,
  APPLY_STRUCTURED_REPLACEMENT_PATH,
  APPLY_FULL_CONTENT_PATH,
  READ_CONTENT_PATH,
  createApplyEditsRequestHandler,
  parseApplyEditsBody,
  parseStructuredApplyBody,
  parseApplyFullContentBody,
  parseReadContentBody,
  startInternalEditServer,
  type ApplyEditsHandlerDeps,
} from '../src/internal-edit-server';

const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440003';
const YJS_STATE_ID = '11111111-e29b-41d4-a716-446655440111';

/** Mirrors the source's hard body cap so the boundary (exactly at the cap) can be exercised. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const regexEngine = new Re2RegexEngine();
const silentLogger = { info: () => {}, error: () => {} } as unknown as import('pino').Logger;

const JSON_HEADERS = { 'content-type': 'application/json' };

type FakeRequest = PassThrough & { method: string; url: string; headers: IncomingHttpHeaders };

interface RecordedResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  headersSent: boolean;
  ended: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => RecordedResponse;
  end: (chunk?: string) => RecordedResponse;
}

interface HandlerDoubles {
  applyEdits: jest.Mock;
  applyStructuredReplacement: jest.Mock;
  applyFullContent: jest.Mock;
  readContent: jest.Mock;
  logger: { info: jest.Mock; error: jest.Mock };
  secret?: string;
}

// A readable stream stands in for IncomingMessage: readBody() needs the real 'data'/'end'/'error'
// event machinery plus pause()/removeAllListeners(), and the handler needs method/url/headers.
function fakeRequest(method: string, url: string, headers: IncomingHttpHeaders = {}): FakeRequest {
  const request = new PassThrough() as FakeRequest;
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

// Records exactly what the handler wrote: status, the header object as passed, and the body string.
function recordingResponse(headersSent = false): RecordedResponse {
  const response: RecordedResponse = {
    headersSent,
    ended: false,
    writeHead: (status, headers) => {
      response.statusCode = status;
      response.headers = headers;
      response.headersSent = true;
      return response;
    },
    end: (chunk) => {
      response.body = chunk;
      response.ended = true;
      return response;
    },
  };
  return response;
}

function fakeLogger(): { info: jest.Mock; error: jest.Mock } {
  return { info: jest.fn(), error: jest.fn() };
}

function asLogger(logger: { info: jest.Mock; error: jest.Mock }): Logger {
  return logger as unknown as Logger;
}

function handlerDoubles(): HandlerDoubles {
  return {
    applyEdits: jest.fn(async () => 3),
    applyStructuredReplacement: jest.fn(async () => 2),
    applyFullContent: jest.fn(async () => {}),
    readContent: jest.fn(async () => 'live-text'),
    logger: fakeLogger(),
  };
}

function asDeps(doubles: HandlerDoubles): ApplyEditsHandlerDeps {
  return doubles as unknown as ApplyEditsHandlerDeps;
}

function startHandling(doubles: HandlerDoubles, request: FakeRequest, response: RecordedResponse): Promise<void> {
  const handler = createApplyEditsRequestHandler(asDeps(doubles));
  return handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
}

async function handle(
  doubles: HandlerDoubles,
  request: FakeRequest,
  response: RecordedResponse,
  body = '',
): Promise<RecordedResponse> {
  const done = startHandling(doubles, request, response);
  request.end(body);
  await done;
  return response;
}

// A YjsStateStore stub — used by the read endpoint for dormant rooms; the apply-edits tests below
// never read a dormant room, so a load() that returns null is fine.
function fakeStateStore(): never {
  return { load: async () => null, save: async () => {}, delete: async () => {}, deleteAllForProject: async () => {} } as never;
}

// A fake Hocuspocus whose DirectConnection edits an in-memory string, so the real
// applyEditsToDocument runs end to end without a live collaboration server. `documents` is the
// in-memory room map the read endpoint consults; seed it via `loadedRooms` for read tests.
function fakeHocuspocus(initial = 'a', loadedRooms: Map<string, Y.Doc> = new Map()): never {
  let text = initial;
  const ytext = {
    toString: () => text,
    delete: (index: number, length: number) => {
      text = text.slice(0, index) + text.slice(index + length);
    },
    insert: (index: number, value: string) => {
      text = text.slice(0, index) + value + text.slice(index);
    },
  };
  const connection = {
    transact: async (function_: (document: { getText: () => typeof ytext }) => void) =>
      function_({ getText: () => ytext }),
    disconnect: async () => {},
  };
  return { openDirectConnection: jest.fn().mockResolvedValue(connection), documents: loadedRooms } as never;
}

describe('parseApplyEditsBody', () => {
  const valid = JSON.stringify({
    projectId: PROJECT_ID,
    yjsStateId: YJS_STATE_ID,
    replacements: [{ find: 'a', replace: 'b' }],
  });

  it('accepts a well-formed body', () => {
    expect(parseApplyEditsBody(valid)).toEqual({
      projectId: PROJECT_ID,
      yjsStateId: YJS_STATE_ID,
      replacements: [{ find: 'a', replace: 'b' }],
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseApplyEditsBody('{not json')).toBeNull();
  });

  it('rejects non-UUID ids (which would yield a nonsensical room name)', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: '../etc', yjsStateId: YJS_STATE_ID, replacements: [] }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: 'x', replacements: [] }))).toBeNull();
  });

  it('rejects replacements that are not {find,replace} string pairs', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, replacements: 'nope' }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, replacements: [{ find: 1, replace: 'b' }] }))).toBeNull();
  });

  // A JSON `null` is `typeof 'object'` — the record guard must reject it rather than destructure it.
  it('rejects a JSON null body', () => {
    expect(parseApplyEditsBody('null')).toBeNull();
  });

  it('rejects a non-string id even when it stringifies to a UUID', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: [PROJECT_ID], yjsStateId: YJS_STATE_ID, replacements: [] }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: [YJS_STATE_ID], replacements: [] }))).toBeNull();
  });

  // The UUID pattern is anchored at BOTH ends: a room name must not be smuggled in as a prefix or
  // suffix around an otherwise valid id.
  it('rejects ids with anything before or after the UUID', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: `zz${PROJECT_ID}`, yjsStateId: YJS_STATE_ID, replacements: [] }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: `${PROJECT_ID}zz`, yjsStateId: YJS_STATE_ID, replacements: [] }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: `zz${YJS_STATE_ID}`, replacements: [] }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: `${YJS_STATE_ID}zz`, replacements: [] }))).toBeNull();
  });

  it('rejects a non-array replacements object and a null entry', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, replacements: { find: 'a', replace: 'b' } }))).toBeNull();
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, replacements: [null] }))).toBeNull();
  });

  it('rejects a non-string replace as well as a non-string find', () => {
    expect(parseApplyEditsBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, replacements: [{ find: 'a', replace: 5 }] }))).toBeNull();
  });
});

describe('parseStructuredApplyBody', () => {
  const valid = {
    projectId: PROJECT_ID,
    yjsStateId: YJS_STATE_ID,
    query: { text: 'foo', mode: 'literal', caseSensitive: true, wholeWord: false },
    replacement: 'bar',
    selections: [{ ordinal: 0, expectedText: 'foo' }],
  };

  it('accepts a well-formed body', () => {
    expect(parseStructuredApplyBody(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects a non-UUID id, an unknown mode, and a malformed selection', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, projectId: '../etc' }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: { ...valid.query, mode: 'glob' } }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, selections: [{ ordinal: -1, expectedText: 'foo' }] }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, selections: [{ ordinal: 0 }] }))).toBeNull();
  });

  it('rejects a missing replacement or query', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, replacement: 5 }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: 'nope' }))).toBeNull();
  });

  it('accepts the regex mode verbatim', () => {
    const regexQuery = { ...valid, query: { text: 'fo+', mode: 'regex', caseSensitive: false, wholeWord: true } };
    expect(parseStructuredApplyBody(JSON.stringify(regexQuery))).toEqual(regexQuery);
  });

  it('rejects malformed JSON and a JSON null body', () => {
    expect(parseStructuredApplyBody('{not json')).toBeNull();
    expect(parseStructuredApplyBody('null')).toBeNull();
  });

  it('rejects a non-string id that stringifies to a UUID, and a non-UUID yjsStateId', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, projectId: [PROJECT_ID] }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, yjsStateId: [YJS_STATE_ID] }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, yjsStateId: 'x' }))).toBeNull();
  });

  it('rejects a null query and a non-string query text', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: null }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: { ...valid.query, text: 5 } }))).toBeNull();
  });

  it('rejects a non-boolean caseSensitive and a non-boolean wholeWord independently', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: { ...valid.query, caseSensitive: 'yes' } }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, query: { ...valid.query, wholeWord: 'no' } }))).toBeNull();
  });

  it('rejects a non-array selections object, a null entry, and a fractional ordinal', () => {
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, selections: { ordinal: 0, expectedText: 'foo' } }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, selections: [null] }))).toBeNull();
    expect(parseStructuredApplyBody(JSON.stringify({ ...valid, selections: [{ ordinal: 1.5, expectedText: 'foo' }] }))).toBeNull();
  });
});

describe('parseReadContentBody', () => {
  it('accepts a well-formed body', () => {
    expect(parseReadContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID }))).toEqual({
      projectId: PROJECT_ID,
      yjsStateId: YJS_STATE_ID,
    });
  });

  it('rejects malformed JSON and non-UUID ids', () => {
    expect(parseReadContentBody('{nope')).toBeNull();
    expect(parseReadContentBody(JSON.stringify({ projectId: '../etc', yjsStateId: YJS_STATE_ID }))).toBeNull();
    expect(parseReadContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: 'x' }))).toBeNull();
  });

  it('rejects a JSON null body and non-string ids that stringify to a UUID', () => {
    expect(parseReadContentBody('null')).toBeNull();
    expect(parseReadContentBody(JSON.stringify({ projectId: [PROJECT_ID], yjsStateId: YJS_STATE_ID }))).toBeNull();
    expect(parseReadContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: [YJS_STATE_ID] }))).toBeNull();
  });
});

describe('parseApplyFullContentBody', () => {
  it('accepts a well-formed body', () => {
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'hello' })),
    ).toEqual({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'hello' });
  });

  // An empty target legitimately clears the document — must NOT be rejected as "missing".
  it('accepts an empty content string', () => {
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: '' })),
    ).toEqual({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: '' });
  });

  it('rejects malformed JSON and a JSON null body', () => {
    expect(parseApplyFullContentBody('{nope')).toBeNull();
    expect(parseApplyFullContentBody('null')).toBeNull();
  });

  it('rejects non-UUID ids', () => {
    expect(parseApplyFullContentBody(JSON.stringify({ projectId: '../etc', yjsStateId: YJS_STATE_ID, content: 'x' }))).toBeNull();
    expect(parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: 'x', content: 'x' }))).toBeNull();
  });

  it('rejects a non-string id that stringifies to a UUID', () => {
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: [PROJECT_ID], yjsStateId: YJS_STATE_ID, content: 'x' })),
    ).toBeNull();
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: [YJS_STATE_ID], content: 'x' })),
    ).toBeNull();
  });

  it('rejects a missing or non-string content', () => {
    expect(parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID }))).toBeNull();
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 5 })),
    ).toBeNull();
    expect(
      parseApplyFullContentBody(JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: null })),
    ).toBeNull();
  });
});

describe('internal edit server (HTTP)', () => {
  let server: Server;
  let baseUrl: string;

  async function waitListening(target: Server): Promise<void> {
    if (target.listening) return;
    await new Promise<void>((resolve) => target.once('listening', () => resolve()));
  }

  async function startWith(options: { secret?: string } = {}): Promise<void> {
    server = await startInternalEditServer({
      hocuspocus: fakeHocuspocus(),
      yjsStateStore: fakeStateStore(),
      regexEngine,
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger,
      ...options,
    });
    await waitListening(server);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const body = JSON.stringify({
    projectId: PROJECT_ID,
    yjsStateId: YJS_STATE_ID,
    replacements: [{ find: 'a', replace: 'b' }],
  });

  it('returns 404 for the wrong method or path', async () => {
    await startWith();
    const wrongMethod = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, { method: 'GET' });
    expect(wrongMethod.status).toBe(404);
    const wrongPath = await fetch(`${baseUrl}/nope`, { method: 'POST', body });
    expect(wrongPath.status).toBe(404);
  });

  it('returns 400 for an invalid body', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, { method: 'POST', body: '{bad' });
    expect(response.status).toBe(400);
  });

  it('applies a structured replacement and returns the applied count', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${APPLY_STRUCTURED_REPLACEMENT_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: { text: 'a', mode: 'literal', caseSensitive: true, wholeWord: false },
        replacement: 'Z',
        selections: [{ ordinal: 0, expectedText: 'a' }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 1 });
  });

  it('returns 400 for an invalid structured-apply body', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${APPLY_STRUCTURED_REPLACEMENT_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, query: 'nope', replacement: '', selections: [] }),
    });
    expect(response.status).toBe(400);
  });

  it('applies full content and returns { ok: true }', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${APPLY_FULL_CONTENT_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'new content' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 400 for an invalid apply-full-content body', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${APPLY_FULL_CONTENT_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 5 }),
    });
    expect(response.status).toBe(400);
  });

  it('enforces the shared secret when configured', async () => {
    await startWith({ secret: 'top-secret' });
    const noSecret = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body,
    });
    expect(noSecret.status).toBe(401);
    await noSecret.text(); // fully consume the response before reconnecting

    const withSecret = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, {
      method: 'POST',
      headers: { 'x-collab-internal-secret': 'top-secret', connection: 'close' },
      body,
    });
    expect(withSecret.status).toBe(200);
    expect(await withSecret.json()).toEqual({ applied: expect.any(Number) });
  });

  it('rejects a same-length but wrong secret (constant-time compare still denies)', async () => {
    await startWith({ secret: 'top-secret' });
    const wrong = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, {
      method: 'POST',
      headers: { 'x-collab-internal-secret': 'TOP-SECRET', connection: 'close' },
      body,
    });
    expect(wrong.status).toBe(401);
    await wrong.text();
  });

  it('rejects a missing secret on apply-full-content, and never echoes the secret back', async () => {
    await startWith({ secret: 'top-secret' });
    const noSecret = await fetch(`${baseUrl}${APPLY_FULL_CONTENT_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'x' }),
    });
    expect(noSecret.status).toBe(401);
    const noSecretBody = await noSecret.text();
    expect(noSecretBody).not.toContain('top-secret');

    const withSecret = await fetch(`${baseUrl}${APPLY_FULL_CONTENT_PATH}`, {
      method: 'POST',
      headers: { 'x-collab-internal-secret': 'top-secret', connection: 'close' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'x' }),
    });
    expect(withSecret.status).toBe(200);
    const withSecretBody = await withSecret.text();
    expect(withSecretBody).not.toContain('top-secret');
  });

  it('returns 413 for a body larger than the cap without crashing the connection', async () => {
    await startWith();
    const huge = 'x'.repeat(5 * 1024 * 1024); // exceeds MAX_BODY_BYTES (4 MiB)
    const response = await fetch(`${baseUrl}${APPLY_EDITS_PATH}`, {
      method: 'POST',
      headers: { connection: 'close' },
      body: huge,
    });
    expect(response.status).toBe(413);
  });

  it('rejects (does not crash) when the port is already in use', async () => {
    await startWith();
    const inUsePort = (server.address() as AddressInfo).port;
    await expect(
      startInternalEditServer({
        hocuspocus: fakeHocuspocus(),
        yjsStateStore: fakeStateStore(),
        regexEngine,
        host: '127.0.0.1',
        port: inUsePort,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('reads live document content via the read-content endpoint', async () => {
    // Seed the in-memory room map with a loaded doc; the read endpoint must return its text verbatim.
    const document = new Y.Doc();
    document.getText('codemirror').insert(0, 'live-text');
    const rooms = new Map<string, Y.Doc>([[`${PROJECT_ID}/${YJS_STATE_ID}`, document]]);
    server = await startInternalEditServer({
      hocuspocus: fakeHocuspocus('a', rooms),
      yjsStateStore: fakeStateStore(),
      regexEngine,
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger,
    });
    await waitListening(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${READ_CONTENT_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: 'live-text' });
  });

  it('returns 400 for an invalid read-content body', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${READ_CONTENT_PATH}`, { method: 'POST', body: '{bad' });
    expect(response.status).toBe(400);
  });

  it('returns 500 when applying the edits throws', async () => {
    // openDirectConnection rejects → applyEditsToDocument throws → 500 (no secret required here).
    const hocuspocus = { openDirectConnection: jest.fn().mockRejectedValue(new Error('room boom')), documents: new Map() } as never;
    server = await startInternalEditServer({ hocuspocus, yjsStateStore: fakeStateStore(), regexEngine, host: '127.0.0.1', port: 0, logger: silentLogger });
    await waitListening(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${APPLY_EDITS_PATH}`, { method: 'POST', body });
    expect(response.status).toBe(500);
  });
});

// Drives the exported handler directly with injected deps and a recording response, so the exact
// status, header object and JSON body of every branch can be asserted (a real `fetch` response
// carries node's own headers, which hides a dropped or renamed one).
describe('createApplyEditsRequestHandler', () => {
  const applyBody = JSON.stringify({
    projectId: PROJECT_ID,
    yjsStateId: YJS_STATE_ID,
    replacements: [{ find: 'a', replace: 'b' }],
  });
  const readContentBody = JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });
  const fullContentBody = JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID, content: 'new content' });
  const structuredBody = JSON.stringify({
    projectId: PROJECT_ID,
    yjsStateId: YJS_STATE_ID,
    query: { text: 'a', mode: 'literal', caseSensitive: true, wholeWord: false },
    replacement: 'Z',
    selections: [{ ordinal: 0, expectedText: 'a' }],
  });

  it('answers apply-edits with the applied count as JSON', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', APPLY_EDITS_PATH), recordingResponse(), applyBody);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"applied":3}');
    expect(doubles.applyEdits).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      yjsStateId: YJS_STATE_ID,
      replacements: [{ find: 'a', replace: 'b' }],
    });
  });

  it('answers apply-edits with a JSON error object on an invalid body', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', APPLY_EDITS_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.applyEdits).not.toHaveBeenCalled();
  });

  it('logs the cause and answers a JSON 500 when applyEdits throws', async () => {
    const doubles = handlerDoubles();
    const boom = new Error('apply boom');
    doubles.applyEdits = jest.fn(async () => {
      throw boom;
    });
    const response = await handle(doubles, fakeRequest('POST', APPLY_EDITS_PATH), recordingResponse(), applyBody);
    expect(response.statusCode).toBe(500);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"apply-edits failed"}');
    expect(doubles.logger.error).toHaveBeenCalledWith({ err: boom }, 'apply-edits failed');
  });

  it('answers read-content with the live text as JSON', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', READ_CONTENT_PATH), recordingResponse(), readContentBody);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"content":"live-text"}');
    expect(doubles.readContent).toHaveBeenCalledWith({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });
  });

  it('answers read-content with a JSON error object on an invalid body', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', READ_CONTENT_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.readContent).not.toHaveBeenCalled();
  });

  it('logs the cause and answers a JSON 500 when readContent throws', async () => {
    const doubles = handlerDoubles();
    const boom = new Error('read boom');
    doubles.readContent = jest.fn(async () => {
      throw boom;
    });
    const response = await handle(doubles, fakeRequest('POST', READ_CONTENT_PATH), recordingResponse(), readContentBody);
    expect(response.statusCode).toBe(500);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"read-content failed"}');
    expect(doubles.logger.error).toHaveBeenCalledWith({ err: boom }, 'read-content failed');
  });

  it('answers apply-full-content with { ok: true } and dispatches the parsed body', async () => {
    const doubles = handlerDoubles();
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_FULL_CONTENT_PATH),
      recordingResponse(),
      fullContentBody,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"ok":true}');
    expect(doubles.applyFullContent).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      yjsStateId: YJS_STATE_ID,
      content: 'new content',
    });
  });

  it('answers apply-full-content with a JSON error object on an invalid body', async () => {
    const doubles = handlerDoubles();
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_FULL_CONTENT_PATH),
      recordingResponse(),
      '{bad',
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.applyFullContent).not.toHaveBeenCalled();
  });

  it('logs the cause and answers a JSON 500 when applyFullContent throws', async () => {
    const doubles = handlerDoubles();
    const boom = new Error('full-content boom');
    doubles.applyFullContent = jest.fn(async () => {
      throw boom;
    });
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_FULL_CONTENT_PATH),
      recordingResponse(),
      fullContentBody,
    );
    expect(response.statusCode).toBe(500);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"apply-full-content failed"}');
    expect(doubles.logger.error).toHaveBeenCalledWith({ err: boom }, 'apply-full-content failed');
  });

  it('answers structured-apply with the applied count as JSON', async () => {
    const doubles = handlerDoubles();
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_STRUCTURED_REPLACEMENT_PATH),
      recordingResponse(),
      structuredBody,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"applied":2}');
    expect(doubles.applyStructuredReplacement).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      yjsStateId: YJS_STATE_ID,
      query: { text: 'a', mode: 'literal', caseSensitive: true, wholeWord: false },
      replacement: 'Z',
      selections: [{ ordinal: 0, expectedText: 'a' }],
    });
  });

  it('answers structured-apply with a JSON error object on an invalid body', async () => {
    const doubles = handlerDoubles();
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_STRUCTURED_REPLACEMENT_PATH),
      recordingResponse(),
      '{bad',
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.applyStructuredReplacement).not.toHaveBeenCalled();
  });

  it('logs the cause and answers a JSON 500 when the structured apply throws', async () => {
    const doubles = handlerDoubles();
    const boom = new Error('structured boom');
    doubles.applyStructuredReplacement = jest.fn(async () => {
      throw boom;
    });
    const response = await handle(
      doubles,
      fakeRequest('POST', APPLY_STRUCTURED_REPLACEMENT_PATH),
      recordingResponse(),
      structuredBody,
    );
    expect(response.statusCode).toBe(500);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"apply-structured-replacement failed"}');
    expect(doubles.logger.error).toHaveBeenCalledWith({ err: boom }, 'apply-structured-replacement failed');
  });

  it('answers 404 with no body for a wrong method and an unknown path', async () => {
    const doubles = handlerDoubles();
    const wrongMethod = await handle(doubles, fakeRequest('GET', APPLY_EDITS_PATH), recordingResponse(), applyBody);
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.headers).toBeUndefined();
    expect(wrongMethod.body).toBeUndefined();

    const unknownPath = await handle(doubles, fakeRequest('POST', '/internal/collab/nope'), recordingResponse(), applyBody);
    expect(unknownPath.statusCode).toBe(404);
    expect(doubles.applyEdits).not.toHaveBeenCalled();
  });

  // The route is matched on the path only — a query string must not turn a known route into a 404.
  it('matches the route with a query string appended', async () => {
    const doubles = handlerDoubles();
    const response = await handle(
      doubles,
      fakeRequest('POST', `${READ_CONTENT_PATH}?revision=7`),
      recordingResponse(),
      readContentBody,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"content":"live-text"}');
  });

  it('rejects a secret of a different length and accepts the exact one', async () => {
    const shortSecret = handlerDoubles();
    shortSecret.secret = 'top-secret';
    const rejected = await handle(
      shortSecret,
      fakeRequest('POST', APPLY_EDITS_PATH, { 'x-collab-internal-secret': 'short' }),
      recordingResponse(),
      applyBody,
    );
    expect(rejected.statusCode).toBe(401);
    expect(shortSecret.applyEdits).not.toHaveBeenCalled();

    const exact = handlerDoubles();
    exact.secret = 'top-secret';
    const accepted = await handle(
      exact,
      fakeRequest('POST', APPLY_EDITS_PATH, { 'x-collab-internal-secret': 'top-secret' }),
      recordingResponse(),
      applyBody,
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toBe('{"applied":3}');
  });

  it('answers 413 and closes the connection once the body passes the cap', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', APPLY_EDITS_PATH);
    const response = recordingResponse();
    const done = startHandling(doubles, request, response);
    request.write(Buffer.alloc(MAX_BODY_BYTES + 1, 120));
    await done;
    expect(response.statusCode).toBe(413);
    expect(response.headers).toEqual({ connection: 'close' });
    // Buffering must stop: the 'data' listener is gone and the unread request is paused.
    expect(request.listenerCount('data')).toBe(0);
    expect(request.isPaused()).toBe(true);
    request.destroy();
  });

  // Boundary: a body of exactly the cap is still accepted (the guard is `>`, not `>=`).
  it('accepts a body of exactly the cap', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', APPLY_EDITS_PATH);
    const response = recordingResponse();
    const done = startHandling(doubles, request, response);
    request.end(Buffer.alloc(MAX_BODY_BYTES, 120)); // 'x' × 4 MiB — read in full, then rejected as non-JSON
    await done;
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Invalid body"}');
  });

  it('answers 413 when the request stream errors mid-body', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', APPLY_EDITS_PATH);
    const response = recordingResponse();
    const done = startHandling(doubles, request, response);
    request.destroy(new Error('socket reset'));
    await done;
    expect(response.statusCode).toBe(413);
    expect(response.headers).toEqual({ connection: 'close' });
  });

  it('does not write a second time when the response head is already out', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', APPLY_EDITS_PATH);
    const response = recordingResponse(true);
    const done = startHandling(doubles, request, response);
    request.destroy(new Error('socket reset'));
    await done;
    expect(response.statusCode).toBeUndefined();
    expect(response.ended).toBe(false);
  });
});

describe('startInternalEditServer wiring', () => {
  let listening: Server | undefined;

  // Close in a hook rather than at the end of the test: a failing assertion would otherwise skip
  // the close and leave jest hanging on the open handle instead of reporting the failure.
  afterEach(async () => {
    const running = listening;
    listening = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  it('logs the bind details and keeps exactly one late-error listener', async () => {
    const logger = fakeLogger();
    const server = await startInternalEditServer({
      hocuspocus: fakeHocuspocus(),
      yjsStateStore: fakeStateStore(),
      regexEngine,
      host: '127.0.0.1',
      port: 0,
      logger: asLogger(logger),
    });
    listening = server;
    expect(logger.info).toHaveBeenCalledWith(
      { port: 0, host: '127.0.0.1', tls: false },
      'Collab internal edit server listening',
    );
    // The start-up 'error' listener that rejects the promise is gone; only the late-error logger
    // remains, so an error after startup is logged instead of crashing the process.
    expect(server.listenerCount('error')).toBe(1);
    const late = new Error('late failure');
    server.emit('error', late);
    expect(logger.error).toHaveBeenCalledWith({ err: late }, 'Collab internal edit server error');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // With mTLS configured the material is loaded eagerly: unusable certificates must fail the start
  // rather than silently bring up a server that accepts anything.
  it('fails fast on unusable TLS material', async () => {
    let started: Promise<Server> | undefined;
    let thrown: unknown;
    try {
      started = startInternalEditServer({
        hocuspocus: fakeHocuspocus(),
        yjsStateStore: fakeStateStore(),
        regexEngine,
        host: '127.0.0.1',
        port: 0,
        logger: silentLogger,
        tls: { cert: Buffer.from('not-a-certificate'), key: Buffer.from('not-a-key'), clientCa: Buffer.from('not-a-ca') },
      });
    } catch (error) {
      thrown = error;
    }
    // Close first: should the material ever stop being loaded eagerly, the assertions below fail
    // instead of hanging the run on the handle this test just leaked.
    if (started) {
      const leaked = await started;
      await new Promise<void>((resolve) => leaked.close(() => resolve()));
    }
    expect(started).toBeUndefined();
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_OSSL_PEM_NO_START_LINE');
  });
});
