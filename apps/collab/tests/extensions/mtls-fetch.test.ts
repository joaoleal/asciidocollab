// Top-level `await` below is only legal in a module, and this file has no static imports or exports
// of its own — so give it one. (`export {}` is rejected by unicorn/require-module-specifiers.)
export const IS_MODULE = true;

// Native ESM: jest.mock() cannot intercept a static import, so mock the module and import both it
// and the unit under test dynamically. The mock object is shared by reference, so reassigning
// mockHttps.Agent / configuring mockHttps.request is visible to createMtlsFetch's default import.
const mockHttps = { Agent: jest.fn(), request: jest.fn() };
jest.unstable_mockModule('node:https', () => ({ default: mockHttps }));

const { createMtlsFetch } = await import('../../src/extensions/mtls-fetch');

function makeFakeResponse(statusCode: number, _body: Buffer) {
  const listeners: Record<string, ((...arguments_: unknown[]) => void)[]> = {};
  const result = {
    statusCode,
    headers: { 'content-type': 'application/json' },
    on(event: string, callback: (...arguments_: unknown[]) => void) {
      (listeners[event] ??= []).push(callback);
      return result;
    },
    emit(event: string, ...arguments_: unknown[]) {
      for (const callback of listeners[event] ?? []) callback(...arguments_);
    },
  };
  return result;
}

function makeFakeRequest() {
  const listeners: Record<string, ((...arguments_: unknown[]) => void)[]> = {};
  const request = {
    on(event: string, callback: (...arguments_: unknown[]) => void) {
      (listeners[event] ??= []).push(callback);
      return request;
    },
    emit(event: string, ...arguments_: unknown[]) {
      for (const callback of listeners[event] ?? []) callback(...arguments_);
    },
    destroy: jest.fn(),
    end: jest.fn(),
  };
  return request;
}

describe('createMtlsFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates an https.Agent with the provided cert, key, and ca', () => {
    const cert = Buffer.from('cert-pem');
    const key = Buffer.from('key-pem');
    const ca = Buffer.from('ca-pem');

    const AgentMock = jest.fn();
    (mockHttps.Agent as unknown) = AgentMock;
    (mockHttps.request as jest.Mock).mockImplementation(() => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        const [, callback] = (mockHttps.request as jest.Mock).mock.calls[0];
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    createMtlsFetch(cert, key, ca);

    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cert, key, ca, rejectUnauthorized: true }),
    );
  });

  it('makes a GET request and resolves with status + json() from the response', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');
    const responseBody = JSON.stringify({ role: 'editor' });

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from(responseBody));
        callback(result);
        result.emit('data', Buffer.from(responseBody));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const response = await fetchFunction('https://127.0.0.1:4001/internal/collab/auth?doc=x', {
      headers: { Cookie: 'session=abc' },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ role: 'editor' });
  });

  it('rejects when the request emits an error', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation(() => {
      const request = makeFakeRequest();
      setImmediate(() => request.emit('error', new Error('ECONNREFUSED')));
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await expect(fetchFunction('https://127.0.0.1:4001/path')).rejects.toThrow('ECONNREFUSED');
  });

  it('calls req.destroy() when the AbortSignal fires before the response arrives', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedRequest: ReturnType<typeof makeFakeRequest> | null = null;
    (mockHttps.request as jest.Mock).mockImplementation(() => {
      capturedRequest = makeFakeRequest();
      return capturedRequest;
    });

    const controller = new AbortController();
    const fetchFunction = createMtlsFetch(cert, key, ca);
    const fetchPromise = fetchFunction('https://127.0.0.1:4001/path', { signal: controller.signal });

    controller.abort();
    expect(capturedRequest!.destroy).toHaveBeenCalled();

    // Let the promise settle (it may reject due to the abort)
    await fetchPromise.catch(() => undefined);
  });

  it('accepts a URL object as input and extracts hostname/path correctly', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { hostname?: string; path?: string } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { hostname?: string; path?: string }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction(new URL('https://127.0.0.1:4001/internal/auth?doc=x'));

    expect(capturedOptions!.hostname).toBe('127.0.0.1');
    expect(capturedOptions!.path).toBe('/internal/auth?doc=x');
  });

  it('accepts a Request object as input and extracts its URL', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { hostname?: string } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { hostname?: string }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction(new Request('https://127.0.0.1:4001/internal/auth'));

    expect(capturedOptions!.hostname).toBe('127.0.0.1');
  });

  it('accepts array-form headers and forwards each entry', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { headers?: Record<string, string> } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { headers?: Record<string, string> }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction('https://127.0.0.1:4001/path', { headers: [['x-token', 'abc'], ['x-other', 'def']] });

    expect(capturedOptions!.headers?.['x-token']).toBe('abc');
    expect(capturedOptions!.headers?.['x-other']).toBe('def');
  });

  it('uses default port 443 when the URL has no explicit port number', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { port?: number } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { port?: number }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction('https://internal-api/path');

    expect(capturedOptions!.port).toBe(443);
  });

  it('joins multi-value response headers with a comma', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const fakeResponse = {
          statusCode: 200,
          headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
          on(event: string, callback_: (...arguments_: unknown[]) => void) {
            if (event === 'end') setImmediate(() => callback_());
            if (event === 'data') setImmediate(() => callback_(Buffer.from('')));
            return fakeResponse;
          },
        };
        callback(fakeResponse);
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const response = await fetchFunction('https://127.0.0.1:4001/path');

    expect(response.headers.get('set-cookie')).toBe('a=1; Path=/, b=2; Path=/');
  });

  it('falls back to status 200 when the response statusCode is undefined', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const fakeResponse = {
          statusCode: undefined,
          headers: {},
          on(event: string, callback_: (...arguments_: unknown[]) => void) {
            if (event === 'end') setImmediate(() => callback_());
            if (event === 'data') setImmediate(() => callback_(Buffer.from('')));
            return fakeResponse;
          },
        };
        callback(fakeResponse);
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const response = await fetchFunction('https://127.0.0.1:4001/path');

    expect(response.status).toBe(200);
  });

  it('forwards plain-object headers verbatim', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { headers?: Record<string, string> } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { headers?: Record<string, string> }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction('https://127.0.0.1:4001/internal/collab/auth', {
      headers: { Cookie: 'session=abc', 'x-request-id': 'r-1' },
    });

    // The whole header bag: dropping the plain-object branch would leave it empty and the auth
    // cookie would never reach the API.
    expect(capturedOptions!.headers).toEqual({ Cookie: 'session=abc', 'x-request-id': 'r-1' });
  });

  it('upper-cases the requested method', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { method?: string } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { method?: string }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction('https://127.0.0.1:4001/path', { method: 'post' });

    expect(capturedOptions!.method).toBe('POST');
  });

  it('defaults the method to GET when the init omits it', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { method?: string } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { method?: string }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from('{}'));
        callback(result);
        result.emit('data', Buffer.from('{}'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await fetchFunction('https://127.0.0.1:4001/path');

    expect(capturedOptions!.method).toBe('GET');
  });

  it('skips response headers whose value is undefined', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const fakeResponse = {
          statusCode: 200,
          headers: { 'x-present': 'yes', 'x-missing': undefined },
          on(event: string, callback_: (...arguments_: unknown[]) => void) {
            if (event === 'end') setImmediate(() => callback_());
            if (event === 'data') setImmediate(() => callback_(Buffer.from('')));
            return fakeResponse;
          },
        };
        callback(fakeResponse);
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const response = await fetchFunction('https://127.0.0.1:4001/path');

    expect(response.headers.get('x-present')).toBe('yes');
    // Forwarding it anyway would stringify undefined into the literal header value "undefined".
    expect(response.headers.get('x-missing')).toBeNull();
  });

  it('preserves a non-200 response status', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(503, Buffer.from('nope'));
        callback(result);
        result.emit('data', Buffer.from('nope'));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const response = await fetchFunction('https://127.0.0.1:4001/path');

    expect(response.status).toBe(503);
  });

  it('rejects when the response stream emits an error', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation((_options: unknown, callback: (result: unknown) => void) => {
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from(''));
        callback(result);
        result.emit('error', new Error('stream boom'));
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    await expect(fetchFunction('https://127.0.0.1:4001/path')).rejects.toThrow('stream boom');
  });

  it('rejects with a DOM-shaped AbortError when the signal fires', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    (mockHttps.request as jest.Mock).mockImplementation(() => makeFakeRequest());

    const controller = new AbortController();
    const fetchFunction = createMtlsFetch(cert, key, ca);
    const fetchPromise = fetchFunction('https://127.0.0.1:4001/path', { signal: controller.signal });

    controller.abort();

    // Callers (AbortSignal.timeout in the storage probe, undici-style callers) branch on the
    // `AbortError` name, so both the name and the message are part of the contract.
    const error = (await fetchPromise.then(() => null, (error_: unknown) => error_)) as Error;
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('The operation was aborted');
  });

  it('forwards Headers instance fields as plain header strings', async () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');
    const responseBody = '{}';

    (mockHttps.Agent as unknown) = jest.fn().mockReturnValue({});
    let capturedOptions: { headers?: Record<string, string> } | null = null;
    (mockHttps.request as jest.Mock).mockImplementation((options: { headers?: Record<string, string> }, callback: (result: unknown) => void) => {
      capturedOptions = options;
      const request = makeFakeRequest();
      setImmediate(() => {
        const result = makeFakeResponse(200, Buffer.from(responseBody));
        callback(result);
        result.emit('data', Buffer.from(responseBody));
        result.emit('end');
      });
      return request;
    });

    const fetchFunction = createMtlsFetch(cert, key, ca);
    const headers = new Headers({ 'x-custom': 'value' });
    await fetchFunction('https://127.0.0.1:4001/path', { headers });

    expect(capturedOptions!.headers?.['x-custom']).toBe('value');
  });
});
