import { EventEmitter } from 'node:events';

// The mTLS listener's security posture lives entirely in the OPTIONS object handed to
// https.createServer: `requestCert` decides whether a client certificate is asked for at all and
// `rejectUnauthorized` decides whether an unverifiable one is refused. Flip either to false and the
// internal edit endpoint — which mutates live documents — accepts any anonymous peer, while every
// end-to-end assertion (status codes, bodies, bind logging) keeps passing. Nothing short of reading
// the options back can see that, so this spec mocks node:http/node:https and asserts them directly.
//
// Native ESM: jest.mock() cannot intercept a static import, so mock the modules and import the unit
// under test dynamically. The mock objects are shared by reference, so per-test configuration of
// createServer is visible to the module's default imports.
const mockHttp = { createServer: jest.fn() };
const mockHttps = { createServer: jest.fn() };
jest.unstable_mockModule('node:http', () => ({ default: mockHttp }));
jest.unstable_mockModule('node:https', () => ({ default: mockHttps }));

const { startInternalEditServer } = await import('../src/internal-edit-server');

/** A stand-in for the created server: a real EventEmitter, so listener bookkeeping is real too. */
interface FakeServer extends EventEmitter {
  listen: jest.Mock;
}

/**
 * Builds the fake server node's createServer would return. `autoListen: false` leaves it hanging in
 * the pre-listening state so a bind failure can be injected.
 *
 * @param options - Set `autoListen: false` to suppress the automatic 'listening' event.
 * @returns The fake server.
 */
function fakeServer(options: { autoListen?: boolean } = {}): FakeServer {
  // The unit under test drives node's EventEmitter API (`once`, `removeListener`) and the assertions
  // read `listenerCount`; EventTarget has none of those, and hand-rolling them would test this
  // file's own bookkeeping instead of node's.
  // eslint-disable-next-line unicorn/prefer-event-target -- see above: node server API, not a DOM target
  const server = new EventEmitter() as FakeServer;
  server.listen = jest.fn(() => {
    if (options.autoListen !== false) setImmediate(() => server.emit('listening'));
    return server;
  });
  return server;
}

function fakeLogger(): { info: jest.Mock; error: jest.Mock } {
  return { info: jest.fn(), error: jest.fn() };
}

// The apply/read collaborators are never exercised here (no request is served), so minimal stand-ins
// are enough: this spec is about how the LISTENER is constructed.
function startOptions(logger: { info: jest.Mock; error: jest.Mock }) {
  return {
    hocuspocus: { openDirectConnection: jest.fn(), documents: new Map() } as never,
    yjsStateStore: {} as never,
    regexEngine: {} as never,
    host: '127.0.0.1',
    port: 4321,
    logger: logger as never,
  };
}

describe('startInternalEditServer TLS options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires AND verifies a client certificate on the mTLS listener', async () => {
    const created = fakeServer();
    (mockHttps.createServer as jest.Mock).mockReturnValue(created);
    const cert = Buffer.from('server-cert-pem');
    const key = Buffer.from('server-key-pem');
    const clientCa = Buffer.from('client-ca-pem');
    const logger = fakeLogger();

    const server = await startInternalEditServer({ ...startOptions(logger), tls: { cert, key, clientCa } });

    expect(server).toBe(created);
    expect(mockHttps.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttp.createServer).not.toHaveBeenCalled();

    const [tlsOptions, listener] = (mockHttps.createServer as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    // Peer verification, asserted field by field: `requestCert: false` never asks the API for a
    // certificate, and `rejectUnauthorized: false` accepts one no CA vouches for. Either alone
    // turns this endpoint's client authentication off without changing anything else.
    expect(tlsOptions.requestCert).toBe(true);
    expect(tlsOptions.rejectUnauthorized).toBe(true);
    // The whole object, so a dropped or renamed key is caught too: the trust anchor is the CLIENT
    // CA, and the server presents its own cert/key.
    expect(tlsOptions).toEqual({
      requestCert: true,
      rejectUnauthorized: true,
      cert,
      key,
      ca: clientCa,
    });
    expect(typeof listener).toBe('function');
    expect(created.listen).toHaveBeenCalledWith(4321, '127.0.0.1');
    expect(logger.info).toHaveBeenCalledWith(
      { port: 4321, host: '127.0.0.1', tls: true },
      'Collab internal edit server listening',
    );
  });

  it('uses a plain HTTP listener (no TLS options) when no material is configured', async () => {
    const created = fakeServer();
    (mockHttp.createServer as jest.Mock).mockReturnValue(created);
    const logger = fakeLogger();

    const server = await startInternalEditServer(startOptions(logger));

    expect(server).toBe(created);
    expect(mockHttps.createServer).not.toHaveBeenCalled();
    expect(mockHttp.createServer).toHaveBeenCalledTimes(1);
    // A single argument: the request listener. No options object can smuggle TLS settings in here.
    const call = (mockHttp.createServer as jest.Mock).mock.calls[0] as unknown[];
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('function');
    expect(logger.info).toHaveBeenCalledWith(
      { port: 4321, host: '127.0.0.1', tls: false },
      'Collab internal edit server listening',
    );
  });

  // A bind failure must take the pending 'listening' listener with it. If it stays registered, a
  // later 'listening' event (the handle outlives the failed promise) runs the success path on an
  // already-REJECTED start: it logs "listening" for a server that never bound and re-arms the
  // late-error logger, hiding the failure the caller just handled.
  it('removes the pending listening listener when the bind fails', async () => {
    const created = fakeServer({ autoListen: false });
    (mockHttp.createServer as jest.Mock).mockReturnValue(created);
    const logger = fakeLogger();

    const started = startInternalEditServer(startOptions(logger));
    const bindFailure = Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' });
    created.emit('error', bindFailure);

    await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE', message: 'bind failed' });
    expect(created.listenerCount('listening')).toBe(0);

    // Proof the removal is real and not just a count: a stray 'listening' now does nothing at all.
    created.emit('listening');
    expect(logger.info).not.toHaveBeenCalled();
    expect(created.listenerCount('error')).toBe(0);
  });
});
