/**
 * Direct unit tests for the git-import API client (`src/lib/api/git.ts`): starting an import into
 * a brand-new project, and polling the long-running operation it returns.
 */
import { API_BASE_URL } from '@/lib/api/base-url';
import { getGitOperation, importRepository, isGitOperationTerminal } from '@/lib/api/git';

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

/** Queues one successful JSON response. */
function okOnce(body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

/** Queues one non-ok JSON response. */
function failOnce(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => body });
}

/** The URL of the single fetch performed by the call under test. */
function requestUrl(): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return String(fetchMock.mock.calls[0][0]);
}

/** The init of the single fetch performed by the call under test. */
function requestInit(): RequestInit {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0][1] as RequestInit;
}

/** The request body of the single fetch, parsed back from JSON. */
function requestBody(): unknown {
  return JSON.parse(String(requestInit().body));
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('importRepository', () => {
  test('POSTs provider/remoteUrl/token to the top-level import endpoint and returns the queued operation', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    const result = await importRepository({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/git/import`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });
    expect(result).toEqual({ operationId: 'op1', projectId: 'proj1' });
  });

  test('includes an optional branch only when given', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await importRepository({
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/acme/handbook.git',
      token: 'glpat_secret',
      branch: 'develop',
    });

    expect(requestBody()).toMatchObject({ branch: 'develop' });
  });

  test('surfaces a validation failure', async () => {
    failOnce(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid Git remote URL' } });

    await expect(
      importRepository({ provider: 'github', remoteUrl: 'not a url', token: 't' }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid Git remote URL' });
  });

  test('surfaces a rate-limited refusal', async () => {
    failOnce(429, { error: { code: 'RATE_LIMITED', message: 'Too many imports' } });

    await expect(
      importRepository({ provider: 'github', remoteUrl: 'https://github.com/a/b.git', token: 't' }),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});

describe('getGitOperation', () => {
  test('GETs the project-scoped operation-status endpoint', async () => {
    const status = { id: 'op1', kind: 'IMPORT', state: 'RUNNING', progress: 42, errorCode: null };
    okOnce(status);

    const result = await getGitOperation('proj1', 'op1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/operations/op1`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(status);
  });

  test('surfaces a not-found refusal without leaking whether the operation exists', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'Git operation not found' } });

    await expect(getGitOperation('proj1', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('isGitOperationTerminal', () => {
  test.each([
    ['QUEUED', false],
    ['RUNNING', false],
    ['AWAITING_CONFLICT', false],
    ['SUCCEEDED', true],
    ['FAILED', true],
    ['ABORTED', true],
  ] as const)('%s is terminal: %s', (state, expected) => {
    expect(isGitOperationTerminal(state)).toBe(expected);
  });
});
