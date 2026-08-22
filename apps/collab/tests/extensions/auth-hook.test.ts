import { AuthHookExtension } from '../../src/extensions/auth-hook';
import type { onConnectPayload } from '@hocuspocus/server';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440001';
const YJS_STATE_ID = '550e8400-e29b-41d4-a716-446655440002';
const DOCUMENT_NAME = `${PROJECT_ID}/${YJS_STATE_ID}`;
const COOKIE = 'sessionId=abc123';

function makePayload(overrides: { context?: Record<string, unknown> } = {}): onConnectPayload {
  return {
    context: overrides.context ?? {},
    documentName: DOCUMENT_NAME,
    // v4: requestHeaders is a web Headers object; read-only lives on connectionConfig.
    requestHeaders: new Headers({ cookie: COOKIE }),
    requestParameters: new URLSearchParams(),
    instance: {} as onConnectPayload['instance'],
    request: {} as onConnectPayload['request'],
    socketId: 'test-socket',
    connectionConfig: { readOnly: false, isAuthenticated: true },
  } as unknown as onConnectPayload;
}

const mockLogger = { warn: jest.fn(), error: jest.fn() };

/** Builds a hook wired to the shared logger mock and the given fetch stub. */
function makeAuthHook(mockFetch: jest.Mock): AuthHookExtension {
  return new AuthHookExtension({
    apiInternalUrl: 'http://127.0.0.1:4001',
    authTimeoutMs: 3000,
    logger: mockLogger as never,
    fetch: mockFetch as never,
  });
}

/** A payload for an arbitrary room name (the default helper is fixed to the document room). */
function payloadFor(documentName: string): onConnectPayload {
  return { ...makePayload(), documentName } as unknown as onConnectPayload;
}

/** A 200 body that WOULD be accepted, used to prove a denial came from the status/room check. */
const OK_DOCUMENT_BODY = { role: 'editor', userId: 'u-1' };

describe('AuthHookExtension', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('200 editor: stores role=editor on context, connection accepted (no throw)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ role: 'editor', userId: 'u-1' }),
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    const payload = makePayload();
    await expect(extension.onConnect(payload)).resolves.toBeUndefined();
    expect(payload.context.role).toBe('editor');
    expect(payload.context.userId).toBe('u-1');
    expect(payload.connectionConfig.readOnly).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/internal/collab/auth/document?projectId=${PROJECT_ID}&yjsStateId=${YJS_STATE_ID}`),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: COOKIE }),
      }),
    );
  });

  it('200 observer: stores role=observer on context, connection accepted', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ role: 'observer', userId: 'u-1' }),
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    const payload = makePayload();
    await expect(extension.onConnect(payload)).resolves.toBeUndefined();
    expect(payload.context.role).toBe('observer');
    // SEC: observers must be marked read-only at the WS connection level so Hocuspocus rejects
    // their inbound document updates — client-side read-only is not an authorization boundary.
    expect(payload.connectionConfig.readOnly).toBe(true);
  });

  it('401: throws with code 1008', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });
  });

  it('403: throws with code 1008', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });
  });

  it('timeout: throws with code 1008 and logs warn with room name (no cookie)', async () => {
    const abortError = Object.assign(new Error('AbortError'), { name: 'AbortError' });
    const mockFetch = jest.fn().mockRejectedValue(abortError);

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ resource: DOCUMENT_NAME }),
      expect.any(String),
    );
    const warnCall = mockLogger.warn.mock.calls[0];
    const warnArgument = JSON.stringify(warnCall);
    expect(warnArgument).not.toContain('abc123');
    expect(warnArgument).not.toContain('sessionId');
    expect(warnArgument).not.toContain('Cookie');
  });

  it('network error: throws with code 1008 and logs warn with room name (no cookie)', async () => {
    const networkError = new Error('ECONNREFUSED');
    const mockFetch = jest.fn().mockRejectedValue(networkError);

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ resource: DOCUMENT_NAME }),
      expect.any(String),
    );
    const warnArgument = JSON.stringify(mockLogger.warn.mock.calls[0]);
    expect(warnArgument).not.toContain('abc123');
    expect(warnArgument).not.toContain('Cookie');
  });

  it('200 with unknown role body: throws with code 1008 — prevents unknown roles from gaining access', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ role: 'admin' }), // unknown role value
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });
  });

  it('200 with missing role field: throws with code 1008', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 'ok' }), // no role field
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });
  });

  it('non-Error thrown: uses "Error" as the class name and rejects with code 1008', async () => {
    // Validates the fallback branch where something other than an Error instance is thrown
    // (e.g. a plain string or object), so the error.constructor.name path is not available.
    const mockFetch = jest.fn().mockRejectedValue('plain string rejection');

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    await expect(extension.onConnect(makePayload())).rejects.toMatchObject({ code: 1008 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'Error' }),
      expect.any(String),
    );
  });

  it('uses globalThis.fetch as default when no fetch option is provided', () => {
    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      // fetch not provided — should fall back to globalThis.fetch
    });
    expect(extension).toBeDefined();
  });

  it('no cookie header: omits Cookie header from auth request', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ role: 'editor', userId: 'u-1' }),
    });

    const extension = new AuthHookExtension({
      apiInternalUrl: 'http://127.0.0.1:4001',
      authTimeoutMs: 3000,
      logger: mockLogger as never,
      fetch: mockFetch as never,
    });

    const payload = {
      ...makePayload(),
      requestHeaders: new Headers(), // no cookie
    } as unknown as onConnectPayload;

    await extension.onConnect(payload);

    const [, callInit] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(Object.keys(callInit.headers)).toHaveLength(0);
  });

  // Feature 024: a presence room is authorized by project membership; the API returns `{ userId }`
  // (no role — presence is read-only awareness).
  describe('presence room', () => {
    const PRESENCE_NAME = 'presence/550e8400-e29b-41d4-a716-446655440001';

    function presencePayload() {
      return { ...makePayload(), documentName: PRESENCE_NAME } as unknown as onConnectPayload;
    }

    it('accepts a presence connection on 200 {userId} (sets context.userId, no role)', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ userId: 'u-1' }) });
      const extension = new AuthHookExtension({ apiInternalUrl: 'http://127.0.0.1:4001', authTimeoutMs: 3000, logger: mockLogger as never, fetch: mockFetch as never });
      const payload = presencePayload();
      await expect(extension.onConnect(payload)).resolves.toBeUndefined();
      expect(payload.context.userId).toBe('u-1');
      expect(payload.context.role).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/internal/collab/auth/presence?projectId=550e8400-e29b-41d4-a716-446655440001'),
        expect.anything(),
      );
    });

    // A presence connection must be READ-ONLY at the WS layer so a member cannot write
    // document updates into the presence room's shared doc (awareness is unaffected by readOnly).
    it('marks the presence connection read-only (cannot write document updates into the presence room)', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ userId: 'u-1' }) });
      const extension = new AuthHookExtension({ apiInternalUrl: 'http://127.0.0.1:4001', authTimeoutMs: 3000, logger: mockLogger as never, fetch: mockFetch as never });
      const payload = presencePayload();
      await extension.onConnect(payload);
      expect(payload.connectionConfig.readOnly).toBe(true);
    });

    it('rejects a presence connection (1008) when the API denies it', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 403, json: async () => ({ error: 'Not a member of this project' }) });
      const extension = new AuthHookExtension({ apiInternalUrl: 'http://127.0.0.1:4001', authTimeoutMs: 3000, logger: mockLogger as never, fetch: mockFetch as never });
      await expect(extension.onConnect(presencePayload())).rejects.toMatchObject({ code: 1008 });
    });

    it('rejects a presence connection (1008) on a malformed 200 (no userId)', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({}) });
      const extension = new AuthHookExtension({ apiInternalUrl: 'http://127.0.0.1:4001', authTimeoutMs: 3000, logger: mockLogger as never, fetch: mockFetch as never });
      await expect(extension.onConnect(presencePayload())).rejects.toMatchObject({ code: 1008 });
    });

    // The presence body shape is `{ userId: string }` and nothing else may pass. Each case below
    // pins one conjunct of the guard: a null body, a non-object body, and a non-string userId.
    it.each([
      ['a null body', null],
      ['a non-object body', 'not-an-object'],
      ['a non-string userId', { userId: 42 }],
      ['a userId-less object', { role: 'editor' }],
    ])('rejects a presence connection (1008, auth_malformed_response) on %s', async (_label, body) => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => body });
      const extension = new AuthHookExtension({ apiInternalUrl: 'http://127.0.0.1:4001', authTimeoutMs: 3000, logger: mockLogger as never, fetch: mockFetch as never });
      const payload = presencePayload();

      // toEqual (not toMatchObject) so a TypeError from a loosened guard cannot pass as a denial.
      await expect(extension.onConnect(payload)).rejects.toEqual({ code: 1008, reason: 'Policy Violation' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: PRESENCE_NAME, reason: 'auth_malformed_response' },
        'collab connection rejected',
      );
      expect(payload.context.userId).toBeUndefined();
    });
  });

  // Exact-value assertions on the denial path: the reason strings are the audit contract, and the
  // guards must reject every body that is not exactly the documented shape.
  describe('denial reasons and guard boundaries', () => {
    // A room name the typed parsers reject must be denied BEFORE any auth call is made — the
    // fetch would otherwise be issued with an undefined URL.
    it.each([
      ['a document room without a separator', 'not-a-room'],
      ['a document room with a non-UUID id', 'not-a-uuid/also-not-a-uuid'],
      ['a presence room with a non-UUID project id', 'presence/not-a-uuid'],
    ])('denies %s with reason invalid_room and never calls the auth API', async (_label, documentName) => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => OK_DOCUMENT_BODY });
      const extension = makeAuthHook(mockFetch);

      await expect(extension.onConnect(payloadFor(documentName))).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: documentName, reason: 'invalid_room' },
        'collab connection rejected',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // A non-200 must be rejected on the status alone: a body that would otherwise be accepted
    // must not rescue it, and the audit reason carries the exact status code.
    it.each([401, 403, 500])('denies status %i with reason auth_status_<code> even when the body is valid', async (status) => {
      const mockFetch = jest.fn().mockResolvedValue({ status, json: async () => OK_DOCUMENT_BODY });
      const extension = makeAuthHook(mockFetch);
      const payload = makePayload();

      await expect(extension.onConnect(payload)).rejects.toEqual({ code: 1008, reason: 'Policy Violation' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: DOCUMENT_NAME, reason: `auth_status_${status}` },
        'collab connection rejected',
      );
      expect(payload.context.role).toBeUndefined();
      expect(payload.context.userId).toBeUndefined();
    });

    // 200 is the ONLY accepted status — the guard is `!== 200`, not `>= 400`.
    it('accepts exactly status 200 and denies the adjacent 201', async () => {
      const okFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => OK_DOCUMENT_BODY });
      await expect(makeAuthHook(okFetch).onConnect(makePayload())).resolves.toBeUndefined();

      const createdFetch = jest.fn().mockResolvedValue({ status: 201, json: async () => OK_DOCUMENT_BODY });
      await expect(makeAuthHook(createdFetch).onConnect(makePayload())).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: DOCUMENT_NAME, reason: 'auth_status_201' },
        'collab connection rejected',
      );
    });

    it('logs the exact auth_unreachable warning (reason, errorClass, message) when the API is down', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
      const extension = makeAuthHook(mockFetch);

      await expect(extension.onConnect(makePayload())).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { resource: DOCUMENT_NAME, reason: 'auth_unreachable', errorClass: 'TypeError' },
        'collab connection rejected',
      );
    });

    // An unparseable body (json() rejects) must be treated as malformed, not as a crash.
    it('denies with auth_malformed_response when the 200 body is not JSON', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
      const extension = makeAuthHook(mockFetch);

      await expect(extension.onConnect(makePayload())).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: DOCUMENT_NAME, reason: 'auth_malformed_response' },
        'collab connection rejected',
      );
    });

    // Every conjunct of the document-body guard, one failing case each. `{ role: 'admin', userId }`
    // is the important one: with the role check relaxed (or OR-ed) an unknown role would be
    // accepted and written onto the connection context.
    it.each([
      ['a null body', null],
      ['a non-object body', 'not-an-object'],
      ['an unknown role with a valid userId', { role: 'admin', userId: 'u-1' }],
      ['a null role with a valid userId', { role: null, userId: 'u-1' }],
      ['a valid role with a non-string userId', { role: 'editor', userId: 42 }],
      ['a valid role with no userId at all', { role: 'observer' }],
    ])('denies a document connection (auth_malformed_response) for %s', async (_label, body) => {
      const mockFetch = jest.fn().mockResolvedValue({ status: 200, json: async () => body });
      const extension = makeAuthHook(mockFetch);
      const payload = makePayload();

      // toEqual pins the thrown value exactly: a TypeError escaping a loosened guard fails here.
      await expect(extension.onConnect(payload)).rejects.toEqual({ code: 1008, reason: 'Policy Violation' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actor: undefined, resource: DOCUMENT_NAME, reason: 'auth_malformed_response' },
        'collab connection rejected',
      );
      // Nothing may be written onto the connection for a rejected body.
      expect(payload.context.role).toBeUndefined();
      expect(payload.context.userId).toBeUndefined();
      expect(payload.connectionConfig.readOnly).toBe(false);
    });
  });
});
