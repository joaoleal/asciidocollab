import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';

// The sentinel cleanup swallows every failure (`.catch(() => undefined)`), so the ONLY way to see
// what it asked for is to watch the call. Native ESM: jest.mock() cannot intercept a static import,
// so register the module mock and import the unit under test dynamically. Only `rm` is wrapped — it
// delegates to the real implementation, so the sentinel is genuinely deleted and every other fs call
// is untouched. This file's own static `rm` import above was linked before the mock exists, so the
// per-test cleanup below is the real one and does not pollute the spy.
const actualFsPromises = await import('node:fs/promises');
const rmSpy = jest.fn(actualFsPromises.rm);
jest.unstable_mockModule('node:fs/promises', () => ({ ...actualFsPromises, rm: rmSpy }));

const { verifySharedStorage } = await import('../src/storage-probe');

const logger = pino({ level: 'silent' });
const API_URL = 'http://127.0.0.1:4001';

async function makeStorage(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'collab-probe-'));
}

// The probe is injected with a `typeof globalThis.fetch`, so its stubs are declared with that
// argument tuple. A bare `jest.fn(async () => …)` records an EMPTY tuple, and the assertion on the
// probe URL below then indexes past the end of it — which is why it used to need `as never` on the
// way in and a cast on the way out, and checked a value TypeScript knew nothing about.
type FetchArguments = [input: RequestInfo | URL, init?: RequestInit];

describe('verifySharedStorage', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await makeStorage();
  });

  afterEach(async () => {
    await rm(storagePath, { recursive: true, force: true });
  });

  it('resolves when the API confirms the sentinel is shared', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ shared: true }, { status: 200 }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).resolves.toBeUndefined();

    // The probe must include the token it wrote, and clean the sentinel up afterwards.
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toMatch(/\/internal\/collab\/storage-probe\?token=[0-9a-f-]+/);
    expect(await readdir(storagePath)).toHaveLength(0);
  });

  it('throws when the API reports the sentinel is NOT shared (divergent storage)', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ shared: false }, { status: 200 }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/do NOT share the same file-storage root/);

    expect(await readdir(storagePath)).toHaveLength(0);
  });

  it('throws when the probe endpoint stays unreachable past the ready window', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      // readyTimeoutMs: 0 → fail on the first connection error (keeps the test fast).
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, readyTimeoutMs: 0, fetch: fetchMock, logger }),
    ).rejects.toThrow(/Could not reach the API storage-probe endpoint/);

    expect(await readdir(storagePath)).toHaveLength(0);
  });

  it('retries a not-yet-ready API and succeeds once it comes up (startup race)', async () => {
    let calls = 0;
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED'); // API still starting
      return Response.json({ shared: true }, { status: 200 });
    });

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, readyTimeoutMs: 5000, fetch: fetchMock, logger }),
    ).resolves.toBeUndefined();

    expect(calls).toBe(3);
    expect(await readdir(storagePath)).toHaveLength(0);
  });

  it('writes a prefixed sentinel holding the probe marker and fetches it with an abort signal', async () => {
    let token: string | null = null;
    let entriesDuringProbe: string[] = [];
    let sentinelContents: string[] = [];
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async (input) => {
      // Read the storage root WHILE the probe is in flight — afterwards the sentinel is gone.
      token = new URL(String(input)).searchParams.get('token');
      entriesDuringProbe = await readdir(storagePath);
      sentinelContents = await Promise.all(
        entriesDuringProbe.map(async (entry) => readFile(path.join(storagePath, entry), 'utf8')),
      );
      return Response.json({ shared: true }, { status: 200 });
    });

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${API_URL}/internal/collab/storage-probe?token=${encodeURIComponent(token!)}`,
    );
    // Exact file name: the hidden `.collab-storage-probe-` prefix keeps the sentinel out of the way
    // and out of directory listings, and the API looks the token up by that same name.
    expect(entriesDuringProbe).toEqual([`.collab-storage-probe-${token!}`]);
    expect(sentinelContents).toEqual(['asciidocollab-storage-consistency-probe']);
    // The per-request timeout must actually be armed, otherwise a hung API blocks startup forever.
    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
  });

  it('deletes the sentinel with force so a vanished file is not an error', async () => {
    let token: string | null = null;
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async (input) => {
      token = new URL(String(input)).searchParams.get('token');
      return Response.json({ shared: true }, { status: 200 });
    });

    rmSpy.mockClear();
    await verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger });

    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(rmSpy.mock.calls[0][0]).toBe(path.resolve(storagePath, `.collab-storage-probe-${token!}`));
    expect(rmSpy.mock.calls[0][1]).toEqual({ force: true });
  });

  it('logs the resolved storage root with the exact success message', async () => {
    const info = jest.fn();
    const spyLogger = { info, warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ shared: true }, { status: 200 }),
    );

    await verifySharedStorage({
      storagePath,
      apiInternalUrl: API_URL,
      timeoutMs: 1000,
      fetch: fetchMock,
      logger: spyLogger,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { storagePath: path.resolve(storagePath) },
      'Verified shared file storage with the API',
    );
  });

  it('spells out the full remedy when storage is not shared', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ shared: false }, { status: 200 }),
    );

    const error = (await verifySharedStorage({
      storagePath,
      apiInternalUrl: API_URL,
      timeoutMs: 1000,
      fetch: fetchMock,
      logger,
    }).then(() => null, (error_: unknown) => error_)) as Error;

    // Exact text: this message is the operator's only instruction for a data-loss configuration,
    // so every clause (consequence, the offending root, the fix) has to survive.
    expect(error.message).toBe(
      'The collaboration server and the REST API do NOT share the same file-storage root, so ' +
        'collaborative edits would never reach the documents the API serves and the two sides would ' +
        'overwrite each other.\n' +
        `  collab storage root: ${path.resolve(storagePath)}\n` +
        'Set ASCIIDOCOLLAB_STORAGE_PATH to the SAME absolute directory (a shared mount) for both ' +
        'apps/api and apps/collab, then restart.',
    );
  });

  it('treats a non-object JSON body as not shared', async () => {
    // A proxy or error page can answer 200 with a JSON string; `'shared' in body` would throw on it,
    // so the typeof guard has to run first and the failure has to be the diagnosable one.
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('"not-an-object"', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/do NOT share the same file-storage root/);
  });

  it('treats a null JSON body as not shared', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/do NOT share the same file-storage root/);
  });

  it('reports the ready window it actually waited and keeps the connection failure as the cause', async () => {
    const cause = new Error('ECONNREFUSED');
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      throw cause;
    });

    const error = (await verifySharedStorage({
      storagePath,
      apiInternalUrl: API_URL,
      timeoutMs: 1000,
      readyTimeoutMs: 1,
      fetch: fetchMock,
      logger,
    }).then(() => null, (error_: unknown) => error_)) as Error;

    expect(error.message).toBe(
      `Could not reach the API storage-probe endpoint at ${API_URL} to verify shared storage ` +
        'after 1ms (ECONNREFUSED). Is apps/api running?',
    );
    expect(error.cause).toBe(cause);
  });

  it('gives up the instant the clock reaches the deadline (not one retry later)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    // 1st call computes the deadline; the 2nd is the check in the catch and lands exactly ON it.
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(9999);
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      throw new Error('ECONNREFUSED');
    });

    try {
      await expect(
        verifySharedStorage({
          storagePath,
          apiInternalUrl: API_URL,
          timeoutMs: 1000,
          readyTimeoutMs: 0,
          fetch: fetchMock,
          logger,
        }),
      ).rejects.toThrow(/Could not reach the API storage-probe endpoint/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('waits the retry interval between connection attempts', async () => {
    let calls = 0;
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return Response.json({ shared: true }, { status: 200 });
    });

    const startedAt = performance.now();
    await verifySharedStorage({
      storagePath,
      apiInternalUrl: API_URL,
      timeoutMs: 1000,
      readyTimeoutMs: 5000,
      fetch: fetchMock,
      logger,
    });
    const elapsedMs = performance.now() - startedAt;

    // Two failures → two 500ms waits. Without the wait the loop would spin the CPU flat out
    // against a starting API.
    expect(calls).toBe(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
  });

  it('throws on a non-200 probe response', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('nope', { status: 500 }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/returned HTTP 500/);
  });

  it('probes through the global fetch when no fetch is injected', async () => {
    // Production wiring passes a fetch only when mTLS is configured; a plain loopback deployment
    // relies on this fallback, so the probe must still reach the API without one.
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ shared: true }, { status: 200 }));

    try {
      await expect(
        verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, logger }),
      ).resolves.toBeUndefined();

      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(String(globalFetch.mock.calls[0][0])).toMatch(/\/internal\/collab\/storage-probe\?token=/);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('describes a rejection that is not an Error in the unreachable message', async () => {
    // Undici can reject with a non-Error value; the diagnostic must still name what went wrong
    // rather than rendering "[object Object]" or crashing on a missing `.message`.
    const nonErrorFailure: unknown = 'socket hang up';
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      throw nonErrorFailure;
    });

    const error = (await verifySharedStorage({
      storagePath,
      apiInternalUrl: API_URL,
      timeoutMs: 1000,
      readyTimeoutMs: 0,
      fetch: fetchMock,
      logger,
    }).then(() => null, (error_: unknown) => error_)) as Error;

    expect(error.message).toBe(
      `Could not reach the API storage-probe endpoint at ${API_URL} to verify shared storage ` +
        'after 0ms (socket hang up). Is apps/api running?',
    );
  });

  it('treats a body that is not JSON at all as not shared', async () => {
    // A proxy or captive portal can answer 200 with HTML; parsing it throws, and the probe must
    // fail with the divergent-storage diagnosis rather than an unhandled parse error.
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/do NOT share the same file-storage root/);
  });

  it('still resolves when the sentinel cleanup itself fails', async () => {
    // A stray sentinel is harmless; a failed cleanup must never turn a verified-shared storage
    // root into a startup abort.
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ shared: true }, { status: 200 }),
    );
    rmSpy.mockRejectedValueOnce(new Error('EBUSY'));

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).resolves.toBeUndefined();

    expect(rmSpy).toHaveBeenCalled();
  });
});
