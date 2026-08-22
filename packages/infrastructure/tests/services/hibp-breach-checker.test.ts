import {
  HIBPBreachChecker,
  HibpBreachCheckerConfig,
} from '../../src/services/hibp-breach-checker';

// The checker calls the global fetch directly, so the global is the seam. No test here may reach the
// network: every call is served by this mock.
const fetchMock = jest.fn();
const realFetch = globalThis.fetch;

function createConfig(overrides: Partial<HibpBreachCheckerConfig> = {}): HibpBreachCheckerConfig {
  return {
    hibpApiUrl: 'https://api.example.test/range',
    ...overrides,
  };
}

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 — a published value, so the split
// below pins both the digest algorithm and the 5/35 k-anonymity split.
const PASSWORD = 'password';
const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';
const EXPECTED_URL = `https://api.example.test/range/${PREFIX}`;

// SHA-1("123456") = 7C4A8D09CA3762AF61E59520943DC26494F8941B
const OTHER_PASSWORD = '123456';
const OTHER_PREFIX = '7C4A8';
const OTHER_SUFFIX = 'D09CA3762AF61E59520943DC26494F8941B';

/** A stand-in for the `Response` slice the checker touches, with an observable `text()`. */
function createResponse(body: string, { ok = true }: { ok?: boolean } = {}) {
  return { ok, text: jest.fn().mockResolvedValue(body) };
}

/** The shape HIBP actually returns: `SUFFIX:count` lines separated by CRLF. */
function rangeBody(entries: [suffix: string, count: number][]): string {
  return entries.map(([suffix, count]) => `${suffix}:${count}`).join('\r\n');
}

describe('HIBPBreachChecker', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  describe('k-anonymity request', () => {
    test('requests the range endpoint with the first five hex characters of the SHA-1', async () => {
      fetchMock.mockResolvedValue(createResponse(''));

      await new HIBPBreachChecker(createConfig()).isBreached(PASSWORD);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(EXPECTED_URL);
    });

    test('never puts the remaining 35 characters of the hash on the wire', async () => {
      // This is the entire point of k-anonymity: leaking the suffix would identify the password.
      fetchMock.mockResolvedValue(createResponse(''));

      await new HIBPBreachChecker(createConfig()).isBreached(PASSWORD);

      const [url] = fetchMock.mock.calls[0];
      expect(url).not.toContain(SUFFIX);
      expect(url.split('/').pop()).toHaveLength(5);
    });

    test("upper-cases the prefix so it matches the API's casing", async () => {
      fetchMock.mockResolvedValue(createResponse(''));

      await new HIBPBreachChecker(createConfig()).isBreached(PASSWORD);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(EXPECTED_URL);
      expect(url).not.toContain(PREFIX.toLowerCase());
    });

    test('derives a different prefix for a different password', async () => {
      fetchMock.mockResolvedValue(createResponse(''));

      await new HIBPBreachChecker(createConfig()).isBreached(OTHER_PASSWORD);

      expect(fetchMock).toHaveBeenCalledWith(`https://api.example.test/range/${OTHER_PREFIX}`);
    });

    test('uses the configured API base URL', async () => {
      fetchMock.mockResolvedValue(createResponse(''));

      await new HIBPBreachChecker(createConfig({ hibpApiUrl: 'http://hibp.internal/v3/range' }))
        .isBreached(PASSWORD);

      expect(fetchMock).toHaveBeenCalledWith(`http://hibp.internal/v3/range/${PREFIX}`);
    });

    test('sends one request per check and does not cache across passwords', async () => {
      fetchMock.mockResolvedValue(createResponse(''));
      const checker = new HIBPBreachChecker(createConfig());

      await checker.isBreached(PASSWORD);
      await checker.isBreached(OTHER_PASSWORD);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        EXPECTED_URL,
        `https://api.example.test/range/${OTHER_PREFIX}`,
      ]);
    });
  });

  describe('response parsing', () => {
    test('reports a breach when a returned line starts with the hash suffix', async () => {
      fetchMock.mockResolvedValue(createResponse(rangeBody([[SUFFIX, 10_000]])));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(true);
    });

    test('finds the matching line anywhere in the body', async () => {
      const body = rangeBody([
        ['0000000000000000000000000000000000A', 1],
        ['1111111111111111111111111111111111B', 2],
        [SUFFIX, 3],
        ['2222222222222222222222222222222222C', 4],
      ]);
      fetchMock.mockResolvedValue(createResponse(body));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(true);
    });

    test('matches the last line even without a trailing newline', async () => {
      fetchMock.mockResolvedValue(
        createResponse(rangeBody([['0000000000000000000000000000000000A', 1], [SUFFIX, 2]])),
      );

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(true);
    });

    test('tolerates LF-only line endings', async () => {
      fetchMock.mockResolvedValue(
        createResponse(`0000000000000000000000000000000000A:1\n${SUFFIX}:2\n`),
      );

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(true);
    });

    test('reports no breach when the range contains other suffixes only', async () => {
      const body = rangeBody([
        ['0000000000000000000000000000000000A', 1],
        [OTHER_SUFFIX, 5],
        ['2222222222222222222222222222222222C', 4],
      ]);
      fetchMock.mockResolvedValue(createResponse(body));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('reports no breach for an empty range body', async () => {
      fetchMock.mockResolvedValue(createResponse(''));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('requires the suffix at the START of a line, not merely somewhere in it', async () => {
      // A containment check would match this line and report a breach that HIBP never reported.
      fetchMock.mockResolvedValue(createResponse(`0000${SUFFIX}:9\r\n`));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('does not match a line that is only a prefix of the suffix', async () => {
      fetchMock.mockResolvedValue(createResponse(`${SUFFIX.slice(0, -1)}:9\r\n`));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('does not match a line differing in its final hex character', async () => {
      const nearMiss = `${SUFFIX.slice(0, -1)}${SUFFIX.endsWith('8') ? '9' : '8'}`;
      fetchMock.mockResolvedValue(createResponse(rangeBody([[nearMiss, 9]])));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test("does not match another password's suffix", async () => {
      fetchMock.mockResolvedValue(createResponse(rangeBody([[SUFFIX, 3]])));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(OTHER_PASSWORD))
        .resolves.toBe(false);
    });

    test('reads the response body exactly once', async () => {
      const response = createResponse(rangeBody([[SUFFIX, 3]]));
      fetchMock.mockResolvedValue(response);

      await new HIBPBreachChecker(createConfig()).isBreached(PASSWORD);

      expect(response.text).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure handling (fail open)', () => {
    test('reports no breach and does not read the body on a non-ok response', async () => {
      const response = createResponse(rangeBody([[SUFFIX, 3]]), { ok: false });
      fetchMock.mockResolvedValue(response);

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
      // Even though the body WOULD have matched: a non-ok status means the payload is not a range.
      expect(response.text).not.toHaveBeenCalled();
    });

    test('reports no breach when the request is rate limited', async () => {
      fetchMock.mockResolvedValue(createResponse('Rate limit exceeded', { ok: false }));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('reports no breach when the network call rejects', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('reports no breach when reading the body rejects', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: jest.fn().mockRejectedValue(new Error('connection reset while streaming')),
      });

      await expect(new HIBPBreachChecker(createConfig()).isBreached(PASSWORD)).resolves.toBe(false);
    });

    test('reports no breach when fetch throws synchronously', async () => {
      fetchMock.mockImplementation(() => {
        throw new TypeError('Invalid URL');
      });

      await expect(new HIBPBreachChecker(createConfig({ hibpApiUrl: 'not a url' })).isBreached(PASSWORD))
        .resolves.toBe(false);
    });

    test('resolves rather than rejecting when the API is unreachable', async () => {
      // Registration must not be blocked by an HIBP outage, so the rejection has to be converted
      // into a resolved "not breached" — never re-thrown.
      fetchMock.mockRejectedValue(new Error('DNS lookup failed'));
      const settled = await Promise.allSettled([
        new HIBPBreachChecker(createConfig()).isBreached(PASSWORD),
      ]);

      expect(settled[0]).toEqual({ status: 'fulfilled', value: false });
    });
  });
});
