/**
 * Direct unit tests for the git-import API client (`src/lib/api/git.ts`): starting an import into
 * a brand-new project, and polling the long-running operation it returns.
 */
import { API_BASE_URL } from '@/lib/api/base-url';
import {
  amendCommit,
  checkoutBranch,
  commitChanges,
  completePull,
  connectRepository,
  createBranch,
  discardChanges,
  disconnectRepository,
  getBehindAhead,
  getBlame,
  getBranches,
  getConflicts,
  getConflictStages,
  getDiff,
  getGitOperation,
  getGitStatus,
  getGitTreeStatus,
  getHistory,
  importRepository,
  initializeRepository,
  isGitOperationTerminal,
  resolveConflict,
  rotateGitCredential,
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

describe('connectRepository', () => {
  test('POSTs provider/remoteUrl/token to the project-scoped connect endpoint and returns the repository', async () => {
    const repository = {
      id: 'repo1',
      projectId: 'proj1',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      currentBranch: 'main',
      defaultBranch: 'main',
      syncStatus: 'UP_TO_DATE',
      lastSyncAt: null,
      connectedByUserId: 'user1',
      createdAt: '2026-08-24T00:00:00Z',
    };
    okOnce({ repository });

    const result = await connectRepository('proj1', {
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/connect`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });
    expect(result).toEqual({ repository });
  });

  test('includes a branch only when given', async () => {
    okOnce({ repository: {} });

    await connectRepository('proj1', {
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/acme/handbook.git',
      token: 'glpat_secret',
      branch: 'develop',
    });

    expect(requestBody()).toEqual({
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/acme/handbook.git',
      token: 'glpat_secret',
      branch: 'develop',
    });
  });

  test('omits branch when not given', async () => {
    okOnce({ repository: {} });

    await connectRepository('proj1', {
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });

    expect(requestBody()).not.toHaveProperty('branch');
  });

  test('surfaces an already-connected refusal', async () => {
    failOnce(409, { error: { code: 'already_connected', message: 'This project already has a connected repository' } });

    await expect(
      connectRepository('proj1', { provider: 'github', remoteUrl: 'https://github.com/a/b.git', token: 't' }),
    ).rejects.toMatchObject({ status: 409, code: 'already_connected' });
  });

  test('surfaces a non-owner refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'You do not have the required role for this action' } });

    await expect(
      connectRepository('proj1', { provider: 'github', remoteUrl: 'https://github.com/a/b.git', token: 't' }),
    ).rejects.toMatchObject({ status: 403, code: 'insufficient_role' });
  });
});

describe('initializeRepository', () => {
  test('POSTs provider/remoteUrl/token to the project-scoped initialize endpoint and returns the queued operation', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    const result = await initializeRepository('proj1', {
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/initialize`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });
    expect(result).toEqual({ operationId: 'op1', projectId: 'proj1' });
  });

  test('includes a branch only when given', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await initializeRepository('proj1', {
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/acme/handbook.git',
      token: 'glpat_secret',
      branch: 'develop',
    });

    expect(requestBody()).toMatchObject({ branch: 'develop' });
  });

  test('omits branch when not given', async () => {
    okOnce({ operationId: 'op1', projectId: 'proj1' });

    await initializeRepository('proj1', {
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: 'ghp_secret',
    });

    expect(requestBody()).not.toHaveProperty('branch');
  });

  test('surfaces an already-connected refusal', async () => {
    failOnce(409, { error: { code: 'already_connected', message: 'This project already has a connected repository' } });

    await expect(
      initializeRepository('proj1', { provider: 'github', remoteUrl: 'https://github.com/a/b.git', token: 't' }),
    ).rejects.toMatchObject({ status: 409, code: 'already_connected' });
  });
});

describe('disconnectRepository', () => {
  test('POSTs an empty body to the project-scoped disconnect endpoint', async () => {
    okOnce({ ok: true });

    const result = await disconnectRepository('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/disconnect`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({});
    expect(result).toEqual({ ok: true });
  });

  test('surfaces a not-connected refusal', async () => {
    failOnce(404, { error: { code: 'repository_not_connected', message: 'This project has no connected Git repository' } });

    await expect(disconnectRepository('proj1')).rejects.toMatchObject({
      status: 404,
      code: 'repository_not_connected',
    });
  });

  test('surfaces a non-owner refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'You do not have the required role for this action' } });

    await expect(disconnectRepository('proj1')).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
  });
});

describe('rotateGitCredential', () => {
  test('PUTs the token to the project-scoped credential endpoint and returns the new hint', async () => {
    okOnce({ tokenHint: '…a1b2' });

    const result = await rotateGitCredential('proj1', { token: 'ghp_new_secret' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/credential`);
    expect(requestInit().method).toBe('PUT');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ token: 'ghp_new_secret' });
    expect(result).toEqual({ tokenHint: '…a1b2' });
  });

  test('surfaces a not-connected refusal', async () => {
    failOnce(404, { error: { code: 'repository_not_connected', message: 'This project has no connected Git repository' } });

    await expect(rotateGitCredential('proj1', { token: 't' })).rejects.toMatchObject({
      status: 404,
      code: 'repository_not_connected',
    });
  });

  test('surfaces a non-owner refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'You do not have the required role for this action' } });

    await expect(rotateGitCredential('proj1', { token: 't' })).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
  });

  test('never logs the token to the console', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    okOnce({ tokenHint: '…a1b2' });
    const secret = 'ghp_super_secret_token_value';
    await rotateGitCredential('proj1', { token: secret });

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(secret);
      }
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('getHistory', () => {
  test('GETs the project-scoped history endpoint with no query when no options are given', async () => {
    const commits = [{ hash: 'abc1234567', message: 'Initial commit', authoredAt: '2026-08-24T00:00:00Z' }];
    okOnce({ commits });

    const result = await getHistory('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/history`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual({ commits });
  });

  test('includes path and limit only when given', async () => {
    okOnce({ commits: [] });

    await getHistory('proj1', { path: 'docs/intro.adoc', limit: 20 });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/history?path=docs%2Fintro.adoc&limit=20`);
  });

  test('includes only path when limit is omitted', async () => {
    okOnce({ commits: [] });

    await getHistory('proj1', { path: 'docs/intro.adoc' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/history?path=docs%2Fintro.adoc`);
  });

  test('surfaces a not-connected refusal for a project with no git repo', async () => {
    failOnce(404, { error: { code: 'NOT_FOUND', message: 'Project is not connected to a git repository' } });

    await expect(getHistory('proj1')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('getDiff', () => {
  test('GETs the project-scoped diff endpoint with no query when no options are given', async () => {
    const diff = { unified: '@@ -1 +1 @@\n-old\n+new\n' };
    okOnce(diff);

    const result = await getDiff('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/diff`);
    expect(requestInit().method).toBeUndefined();
    expect(result).toEqual(diff);
  });

  test('includes path, from, and to only when given', async () => {
    okOnce({ unified: '' });

    await getDiff('proj1', { path: 'a.adoc', from: 'abc123', to: 'def456' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/diff?path=a.adoc&from=abc123&to=def456`);
  });

  test('omits from/to when not given', async () => {
    okOnce({ unified: '' });

    await getDiff('proj1', { path: 'a.adoc' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/diff?path=a.adoc`);
  });
});

describe('getBlame', () => {
  test('GETs the project-scoped blame endpoint, always including the required path', async () => {
    const blame = { lines: [{ lineNumber: 1, hash: 'abc123', authoredAt: '2026-08-24T00:00:00Z', content: '= Title' }] };
    okOnce(blame);

    const result = await getBlame('proj1', 'a.adoc');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/blame?path=a.adoc`);
    expect(requestInit().method).toBeUndefined();
    expect(result).toEqual(blame);
  });

  test('includes ref only when given', async () => {
    okOnce({ lines: [] });

    await getBlame('proj1', 'a.adoc', { ref: 'feature-branch' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/blame?path=a.adoc&ref=feature-branch`);
  });
});

describe('discardChanges', () => {
  test('POSTs a paths body as-is for a discard', async () => {
    okOnce({ ok: true });

    const result = await discardChanges('proj1', { paths: ['a.adoc', 'b.adoc'] });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/discard`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({ paths: ['a.adoc', 'b.adoc'] });
    expect(result).toEqual({ ok: true });
  });

  test('POSTs a path+commit body as-is for a restore', async () => {
    okOnce({ ok: true });

    await discardChanges('proj1', { path: 'a.adoc', commit: 'abc123' });

    expect(requestBody()).toEqual({ path: 'a.adoc', commit: 'abc123' });
  });

  test('surfaces a permission refusal', async () => {
    failOnce(403, { error: { code: 'insufficient_role', message: 'nope' } });

    await expect(discardChanges('proj1', { paths: ['a.adoc'] })).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
  });
});

describe('amendCommit', () => {
  test('POSTs an empty body to the project-scoped amend endpoint when no message is given', async () => {
    const commit = { hash: 'def456', message: 'Fix typo', authoredAt: '2026-08-24T00:00:00Z' };
    okOnce({ commit });

    const result = await amendCommit('proj1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/proj1/git/amend`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().credentials).toBe('include');
    expect(requestBody()).toEqual({});
    expect(result).toEqual({ commit });
  });

  test('includes the message only when given', async () => {
    okOnce({ commit: { hash: 'def456', message: 'Better message', authoredAt: '2026-08-24T00:00:00Z' } });

    await amendCommit('proj1', { message: 'Better message' });

    expect(requestBody()).toEqual({ message: 'Better message' });
  });

  test('surfaces the already-pushed refusal', async () => {
    failOnce(409, { error: { code: 'commit_already_pushed', message: 'This commit has already been pushed' } });

    await expect(amendCommit('proj1')).rejects.toMatchObject({
      status: 409,
      code: 'commit_already_pushed',
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
