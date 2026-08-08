import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { verifySharedStorage } from '../src/storage-probe';

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

  it('throws on a non-200 probe response', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('nope', { status: 500 }),
    );

    await expect(
      verifySharedStorage({ storagePath, apiInternalUrl: API_URL, timeoutMs: 1000, fetch: fetchMock, logger }),
    ).rejects.toThrow(/returned HTTP 500/);
  });
});
