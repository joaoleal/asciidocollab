import https from 'node:https';
import { createMtlsFetch } from '../../src/services/mtls-fetch';

jest.mock('node:https');

const mockHttps = https as jest.Mocked<typeof https>;

function makeFakeResponse(statusCode: number, body: Buffer) {
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
});
