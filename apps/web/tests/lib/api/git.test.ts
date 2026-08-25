/**
 * Direct unit tests for the git-import API client (`src/lib/api/git.ts`): starting an import into
 * a brand-new project, and polling the long-running operation it returns.
 */
import { API_BASE_URL } from '@/lib/api/base-url';
import {
  checkoutBranch,
  commitChanges,
  completePull,
  createBranch,
  getBehindAhead,
  getBranches,
  getConflicts,
  getConflictStages,
  getGitOperation,
  getGitStatus,
  getGitTreeStatus,
  importRepository,
  isGitOperationTerminal,
  resolveConflict,
  startPull,
  undoPull,
} from '@/lib/api/git';

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

describe('getGitTreeStatus', () => {
  test('GETs the project-scoped tree-status endpoint', async () => {
    const body = { statusByFileNodeId: { 'file-1': 'modified', 'file-2': 'staged' } };
    okOnce(body);

    const result = await getGitTreeStatus('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/tree-status`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(body);
  });

  test('surfaces a not-connected refusal for a project with no git repo', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'Project is not connected to a git repository' } });

    await expect(getGitTreeStatus('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('getGitStatus', () => {
  test('GETs the project-scoped status endpoint', async () => {
    const status = {
      branch: 'main',
      syncStatus: 'UP_TO_DATE',
      ahead: 0,
      behind: 0,
      lastSyncAt: null,
      staged: [{ path: 'a.adoc', changeType: 'modified' }],
      unstaged: [],
      untracked: [],
      conflicted: [],
    };
    okOnce(status);

    const result = await getGitStatus('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/status`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(status);
  });

  test('surfaces a not-connected refusal for a project with no git repo', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'Project is not connected to a git repository' } });

    await expect(getGitStatus('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('commitChanges', () => {
  test('POSTs the trimmed message to the project-scoped commit endpoint', async () => {
    const commit = { hash: 'abc123', message: 'Fix typo', authorUserId: 'user1', authoredAt: '2026-08-24T00:00:00Z' };
    okOnce({ commit });

    const result = await commitChanges('proj1', 'Fix typo');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/commit`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ message: 'Fix typo' });
    expect(result).toEqual({ commit });
  });

  test('surfaces a typed refusal, e.g. nothing staged', async () => {
    failOnce(409, { error: { code: 'nothing_staged', message: 'There is nothing staged to commit' } });

    await expect(commitChanges('proj1', 'Fix typo')).rejects.toMatchObject({
      status: 409,
      code: 'nothing_staged',
    });
  });
});

describe('getBehindAhead', () => {
  test('GETs the project-scoped behind-ahead endpoint', async () => {
    const body = { behind: 3, ahead: 1 };
    okOnce(body);

    const result = await getBehindAhead('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/behind-ahead`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(body);
  });

  test('surfaces a not-connected refusal for a project with no git repo', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'Project is not connected to a git repository' } });

    await expect(getBehindAhead('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('startPull', () => {
  test('POSTs to the project-scoped pull endpoint with an empty body by default', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    const result = await startPull('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/pull`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({});
    expect(result).toEqual({ operationId: 'op1', projectId: 'proj1' });
  });

  test('includes confirmAffectsOpenFiles only when explicitly requested', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await startPull('proj1', { confirmAffectsOpenFiles: true });

    expect(requestBody()).toEqual({ confirmAffectsOpenFiles: true });
  });

  test('surfaces the open-files refusal', async () => {
    failOnce(409, { error: { code: 'open_files_need_confirm', message: 'Files are open in live editing sessions' } });

    await expect(startPull('proj1')).rejects.toMatchObject({
      status: 409,
      code: 'open_files_need_confirm',
    });
  });
});

describe('getBranches', () => {
  test('GETs the project-scoped branches endpoint', async () => {
    const body = { current: 'main', branches: [{ name: 'main', isCurrent: true }, { name: 'dev', isCurrent: false }] };
    okOnce(body);

    const result = await getBranches('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/branches`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(body);
  });

  test('surfaces a not-connected refusal for a project with no git repo', async () => {
    failOnce(404, { error: { code: 'repository_not_connected', message: 'This project has no connected Git repository' } });

    await expect(getBranches('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'repository_not_connected',
    });
  });
});

describe('createBranch', () => {
  test('POSTs the name to the project-scoped branches endpoint', async () => {
    const branch = { name: 'feature/x', isCurrent: false };
    okOnce({ branch });

    const result = await createBranch('proj1', 'feature/x');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/branches`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ name: 'feature/x' });
    expect(result).toEqual({ branch });
  });

  test('surfaces a refusal, e.g. insufficient role', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'You do not have the required role for this action' } });

    await expect(createBranch('proj1', 'feature/x')).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
  });
});

describe('checkoutBranch', () => {
  test('POSTs the branch name to the project-scoped checkout endpoint, omitting unset flags', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    const result = await checkoutBranch('proj1', { name: 'dev' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/checkout`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ name: 'dev' });
    expect(result).toEqual({ operationId: 'op1', projectId: 'proj1' });
  });

  test('includes confirmAffectsOpenFiles only when explicitly requested', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await checkoutBranch('proj1', { name: 'dev', confirmAffectsOpenFiles: true });

    expect(requestBody()).toEqual({ name: 'dev', confirmAffectsOpenFiles: true });
  });

  test('includes stashLocal only when explicitly requested', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await checkoutBranch('proj1', { name: 'dev', stashLocal: true });

    expect(requestBody()).toEqual({ name: 'dev', stashLocal: true });
  });

  test('includes both flags when both are requested', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await checkoutBranch('proj1', { name: 'dev', confirmAffectsOpenFiles: true, stashLocal: true });

    expect(requestBody()).toEqual({ name: 'dev', confirmAffectsOpenFiles: true, stashLocal: true });
  });

  test('surfaces the uncommitted-changes refusal', async () => {
    failOnce(409, { error: { code: 'uncommitted_changes', message: 'There are uncommitted local changes' } });

    await expect(checkoutBranch('proj1', { name: 'dev' })).rejects.toMatchObject({
      status: 409,
      code: 'uncommitted_changes',
    });
  });

  test('surfaces the open-files refusal', async () => {
    failOnce(409, { error: { code: 'open_files_need_confirm', message: 'Files are open in live editing sessions' } });

    await expect(checkoutBranch('proj1', { name: 'dev', stashLocal: true })).rejects.toMatchObject({
      status: 409,
      code: 'open_files_need_confirm',
    });
  });
});

describe('getConflicts', () => {
  test('GETs the project-scoped conflicts endpoint', async () => {
    const body = {
      operationId: 'op1',
      files: [
        { path: 'a.adoc', isBinary: false, resolved: false },
        { path: 'assets/logo.png', isBinary: true, resolved: true },
      ],
    };
    okOnce(body);

    const result = await getConflicts('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/conflicts`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(body);
  });

  test('surfaces a not-connected refusal for a project with no conflicts', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'No conflicts awaiting resolution' } });

    await expect(getConflicts('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('getConflictStages', () => {
  test('GETs the project-scoped conflict-stages endpoint, URL-encoding the path', async () => {
    const body = { base: 'base text', ours: 'ours text', theirs: 'theirs text', isBinary: false };
    okOnce(body);

    const result = await getConflictStages('proj1', 'docs/getting started.adoc');

    expect(requestUrl()).toBe(
      `${API_BASE_URL}/api/projects/proj1/git/conflicts/${encodeURIComponent('docs/getting started.adoc')}`,
    );
    expect(requestUrl()).toContain('docs%2Fgetting%20started.adoc');
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual(body);
  });

  test('surfaces a not-found refusal', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'No such conflicting file' } });

    await expect(getConflictStages('proj1', 'missing.adoc')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('resolveConflict', () => {
  test('POSTs ours/theirs resolutions without a mergedContent field, URL-encoding the path', async () => {
    okOnce({ resolved: true });

    const result = await resolveConflict('proj1', 'a folder/file.adoc', { resolution: 'ours' });

    expect(requestUrl()).toBe(
      `${API_BASE_URL}/api/projects/proj1/git/conflicts/${encodeURIComponent('a folder/file.adoc')}`,
    );
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ resolution: 'ours' });
    expect(result).toEqual({ resolved: true });
  });

  test('includes mergedContent only for a merged resolution', async () => {
    okOnce({ resolved: true });

    await resolveConflict('proj1', 'a.adoc', { resolution: 'merged', mergedContent: '= Final\n' });

    expect(requestBody()).toEqual({ resolution: 'merged', mergedContent: '= Final\n' });
  });

  test('omits mergedContent for theirs even when one was passed', async () => {
    okOnce({ resolved: true });

    await resolveConflict('proj1', 'a.adoc', { resolution: 'theirs', mergedContent: 'ignored' });

    expect(requestBody()).toEqual({ resolution: 'theirs' });
  });

  test('surfaces a permission refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'nope' } });

    await expect(resolveConflict('proj1', 'a.adoc', { resolution: 'ours' })).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
  });

  test('surfaces a validation refusal', async () => {
    failOnce(422, { error: { code: 'validation_error', message: 'mergedContent is required' } });

    await expect(resolveConflict('proj1', 'a.adoc', { resolution: 'merged' })).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    });
  });
});

describe('completePull', () => {
  test('POSTs an empty body to the project-scoped complete endpoint', async () => {
    okOnce({ operationId: 'op1' });

    const result = await completePull('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/pull/complete`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({});
    expect(result).toEqual({ operationId: 'op1' });
  });

  test('surfaces the unresolved-conflicts refusal', async () => {
    failOnce(409, { error: { code: 'unresolved_conflicts', message: 'files remain unresolved' } });

    await expect(completePull('proj1')).rejects.toMatchObject({
      status: 409,
      code: 'unresolved_conflicts',
    });
  });
});

describe('undoPull', () => {
  test('POSTs an empty body to the project-scoped undo-pull endpoint', async () => {
    okOnce({ operationId: 'op1' });

    const result = await undoPull('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/undo-pull`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({});
    expect(result).toEqual({ operationId: 'op1' });
  });

  test('surfaces the nothing-to-undo refusal', async () => {
    failOnce(409, { error: { code: 'nothing_to_undo', message: 'nothing to undo' } });

    await expect(undoPull('proj1')).rejects.toMatchObject({
      status: 409,
      code: 'nothing_to_undo',
    });
  });

  test('surfaces a permission refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'nope' } });

    await expect(undoPull('proj1')).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
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
