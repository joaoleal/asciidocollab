import https from 'node:https';
import { createMtlsFetch } from '../../src/services/mtls-fetch';

jest.mock('node:https');

const mockHttps = https as jest.Mocked<typeof https>;

function makeFakeResponse(
  statusCode: number | undefined,
  body: Buffer,
  headers?: Record<string, string | string[] | undefined>,
) {
  const listeners: Record<string, ((...arguments_: unknown[]) => void)[]> = {};
  const result = {
    statusCode,
    headers: headers ?? { 'content-type': 'application/json' },
    on(event: string, callback: (...arguments_: unknown[]) => void) {
      (listeners[event] ??= []).push(callback);
      return result;
    },
    emit(event: string, ...arguments_: unknown[]) {
      for (const callback of listeners[event] ?? []) callback(...arguments_);
    },
    body,
  };
  return result;
}

/**
 * The slice of `http.ClientRequest` the adapter drives. Named so a fake whose `on` handler returns
 * the request itself can be annotated — otherwise the object references itself in its own
 * initializer and TypeScript can only infer `any`.
 */
interface FakeClientRequest {
  on: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  destroy: jest.Mock;
}

function makeFakeRequest(): FakeClientRequest {
  const request: FakeClientRequest = {
    on: jest.fn().mockReturnThis(),
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  };
  return request;
}

/**
 * Installs an `https.request` mock that replies with `response` and records the options it was
 * called with, so a test can assert the exact request line the adapter built. With no `response`
 * the request never completes, leaving abort as the only possible outcome.
 */
function stubRequest(response?: ReturnType<typeof makeFakeResponse>): {
  request: FakeClientRequest;
  options: () => Record<string, unknown>;
} {
  (mockHttps.Agent as unknown) = jest.fn();
  const request = makeFakeRequest();
  (mockHttps.request as jest.Mock).mockImplementation(
    (_options: unknown, callback: (response: unknown) => void) => {
      if (response) {
        setImmediate(() => {
          callback(response);
          if (response.body.length > 0) response.emit('data', response.body);
          response.emit('end');
        });
      }
      return request;
    },
  );
  return {
    request,
    options: () => (mockHttps.request as jest.Mock).mock.calls[0][0] as Record<string, unknown>,
  };
}

describe('createMtlsFetch (infrastructure)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds an https.Agent with the client cert/key/ca and rejectUnauthorized', () => {
    const AgentMock = jest.fn();
    (mockHttps.Agent as unknown) = AgentMock;
    createMtlsFetch(Buffer.from('cert'), Buffer.from('key'), Buffer.from('ca'));
    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cert: Buffer.from('cert'), key: Buffer.from('key'), ca: Buffer.from('ca'), rejectUnauthorized: true }),
    );
  });

  it('POSTs the body and resolves a Response from the upstream reply', async () => {
    (mockHttps.Agent as unknown) = jest.fn();
    const request = makeFakeRequest();
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (response: unknown) => void) => {
      setImmediate(() => {
        const response = makeFakeResponse(200, Buffer.from('{"applied":1}'));
        callback(response);
        response.emit('data', Buffer.from('{"applied":1}'));
        response.emit('end');
      });
      return request;
    });

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    const response = await fetchImpl('https://collab.internal:4003/internal/collab/apply-edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 1 });
    expect(request.write).toHaveBeenCalledWith('{"x":1}');
    expect(request.end).toHaveBeenCalled();
  });

  it('rejects when the request errors', async () => {
    (mockHttps.Agent as unknown) = jest.fn();
    const request: FakeClientRequest = {
      on: jest.fn((event: string, callback: (error: Error) => void) => {
        if (event === 'error') setImmediate(() => callback(new Error('ECONNREFUSED')));
        return request;
      }),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    (mockHttps.request as jest.Mock).mockReturnValue(request);

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    await expect(fetchImpl('https://collab.internal/x')).rejects.toThrow('ECONNREFUSED');
  });

  it('accepts a URL instance and defaults the port to 443 and the method to GET', async () => {
    const { request, options } = stubRequest(makeFakeResponse(201, Buffer.alloc(0)));

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    const response = await fetchImpl(new URL('https://collab.internal/internal/health?deep=1'));

    expect(response.status).toBe(201);
    expect(options()).toMatchObject({
      hostname: 'collab.internal',
      port: 443,
      path: '/internal/health?deep=1',
      method: 'GET',
      headers: {},
    });
    expect(request.write).not.toHaveBeenCalled();
    expect(request.end).toHaveBeenCalledTimes(1);
  });

  it('accepts a Request instance and uppercases an explicit lowercase method', async () => {
    const { options } = stubRequest(makeFakeResponse(200, Buffer.from('ok')));

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    const response = await fetchImpl(new Request('https://collab.internal:4003/internal/collab/x'), {
      method: 'delete',
    });

    expect(await response.text()).toBe('ok');
    expect(options()).toMatchObject({
      hostname: 'collab.internal',
      port: 4003,
      path: '/internal/collab/x',
      method: 'DELETE',
    });
  });

  it('flattens a Headers instance into the outgoing header map', async () => {
    const { options } = stubRequest(makeFakeResponse(200, Buffer.from('ok')));

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    await fetchImpl('https://collab.internal/x', {
      headers: new Headers({ 'x-trace': 'abc', 'content-type': 'text/plain' }),
    });

    expect(options().headers).toEqual({ 'x-trace': 'abc', 'content-type': 'text/plain' });
  });

  it('flattens an array of header tuples into the outgoing header map', async () => {
    const { options } = stubRequest(makeFakeResponse(200, Buffer.from('ok')));

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    await fetchImpl('https://collab.internal/x', {
      headers: [
        ['x-trace', 'abc'],
        ['x-user', 'u-1'],
      ],
    });

    expect(options().headers).toEqual({ 'x-trace': 'abc', 'x-user': 'u-1' });
  });

  it('does not write a non-string body', async () => {
    const { request } = stubRequest(makeFakeResponse(200, Buffer.from('ok')));

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    await fetchImpl('https://collab.internal/x', { method: 'POST', body: new Uint8Array([1, 2, 3]) });

    expect(request.write).not.toHaveBeenCalled();
    expect(request.end).toHaveBeenCalledTimes(1);
  });

  it('joins multi-value response headers, skips undefined ones, and defaults a missing status to 200', async () => {
    stubRequest(
      makeFakeResponse(undefined, Buffer.from('body'), {
        'set-cookie': ['a=1', 'b=2'],
        'x-absent': undefined,
        'content-type': 'text/plain',
      }),
    );

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    const response = await fetchImpl('https://collab.internal/x');

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2');
    expect(response.headers.has('x-absent')).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('body');
  });

  it('destroys the request and rejects with an AbortError when the signal aborts', async () => {
    const { request } = stubRequest(); // never replies — the abort is the only outcome
    const controller = new AbortController();

    const fetchImpl = createMtlsFetch(Buffer.from('c'), Buffer.from('k'), Buffer.from('a'));
    const pending = fetchImpl('https://collab.internal/x', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted' });
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });
});
