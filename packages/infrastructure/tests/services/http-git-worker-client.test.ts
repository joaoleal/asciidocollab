import {
  HttpGitWorkerClient,
  GitWorkerTransportError,
  GIT_WORKER_STATUS_PATH,
  GIT_WORKER_BEHIND_AHEAD_PATH,
  GIT_WORKER_STAGE_PATH,
  GIT_WORKER_UNSTAGE_PATH,
  GIT_WORKER_COMMIT_PATH,
  GIT_WORKER_CONNECT_PATH,
  GIT_WORKER_BRANCHES_PATH,
  GIT_WORKER_BRANCH_CREATE_PATH,
  GIT_WORKER_PULL_COMPLETE_PATH,
  GIT_WORKER_UNDO_PULL_PATH,
  GIT_WORKER_CONFLICTS_PATH,
  GIT_WORKER_CONFLICT_STAGES_PATH,
  GIT_WORKER_CONFLICT_RESOLVE_PATH,
  GIT_WORKER_HISTORY_PATH,
  GIT_WORKER_DIFF_PATH,
  GIT_WORKER_BLAME_PATH,
  GIT_WORKER_DISCARD_PATH,
  GIT_WORKER_AMEND_PATH,
  GIT_WORKER_PREVIEW_PULL_PATH,
  GIT_WORKER_PREVIEW_PUSH_PATH,
} from '../../src/services/http-git-worker-client';

describe('HttpGitWorkerClient', () => {
  const projectId = '770e8400-e29b-41d4-a716-446655440003';
  const actorId = '11111111-e29b-41d4-a716-446655440111';

  it('POSTs the status request to the status endpoint with the secret header and returns the data on a success envelope', async () => {
    const statusData = {
      currentBranch: 'main',
      changes: [{ path: 'doc.adoc', changeType: 'modified', state: 'unstaged' }],
      syncStatus: 'UP_TO_DATE',
      defaultBranch: 'main',
      lastKnownRemoteHead: 'abc123',
      lastSyncAt: '2026-08-24T00:00:00.000Z',
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: statusData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010/',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getStatus({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: statusData });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_STATUS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('POSTs the behind-ahead request to the behind-ahead endpoint with the secret header and returns the data on a success envelope', async () => {
    const behindAheadData = { behind: 2, ahead: 5 };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: behindAheadData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010/',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getBehindAhead({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: behindAheadData });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_BEHIND_AHEAD_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces a domain refusal envelope from the behind-ahead endpoint as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getBehindAhead({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from the behind-ahead endpoint on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getBehindAhead({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs stageChanges to the stage endpoint with the paths, and unstageChanges to the unstage endpoint', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { staged: ['doc.adoc'] } }, { status: 200 })));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const stageResult = await client.stageChanges({ projectId, actorId, paths: ['doc.adoc'] });
    expect(stageResult).toEqual({ ok: true, data: { staged: ['doc.adoc'] } });
    let [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_STAGE_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, paths: ['doc.adoc'] });

    await client.unstageChanges({ projectId, actorId, paths: ['doc.adoc'] });
    [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_UNSTAGE_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, paths: ['doc.adoc'] });
  });

  it('POSTs commitChanges to the commit endpoint with the message and returns the recorded commit', async () => {
    const commitData = { commit: { hash: 'abc123', message: 'Fix typo', authoredAt: '2026-08-24T00:00:00.000Z' } };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: commitData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.commitChanges({ projectId, actorId, message: 'Fix typo' });
    expect(result).toEqual({ ok: true, data: commitData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_COMMIT_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, message: 'Fix typo' });
  });

  it('POSTs connect to the connect endpoint with the credential and returns the connected repository', async () => {
    const repositoryData = {
      id: '990e8400-e29b-41d4-a716-446655440020',
      projectId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      currentBranch: 'main',
      defaultBranch: null,
      syncStatus: 'UP_TO_DATE',
      lastSyncAt: null,
      connectedByUserId: actorId,
      createdAt: '2026-08-24T00:00:00.000Z',
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: true, data: { repository: repositoryData } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.connect({
      projectId,
      actorId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });

    expect(result).toEqual({ ok: true, data: { repository: repositoryData } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_CONNECT_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({
      projectId,
      actorId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });
  });

  it('POSTs connect with a branch when given, and omits it when not', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { repository: {} } }, { status: 200 })));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.connect({
      projectId,
      actorId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      branch: 'develop',
    });
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.branch).toBe('develop');

    await client.connect({
      projectId,
      actorId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(Object.prototype.hasOwnProperty.call(body, 'branch')).toBe(false);
  });

  it('surfaces RepositoryUnreachableError from connect as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryUnreachableError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.connect({
      projectId,
      actorId,
      provider: 'github',
      remoteUrl: 'https://github.com/example/repo.git',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });
    expect(result).toEqual({ ok: false, error: 'RepositoryUnreachableError' });
  });

  it('never includes the token in a thrown transport error on connect', async () => {
    const token = 'ghp_supersecrettokenvalue1234567890';
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    let caught: unknown;
    try {
      await client.connect({ projectId, actorId, provider: 'github', remoteUrl: 'https://github.com/example/repo.git', token });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitWorkerTransportError);
    expect((caught as Error).message).not.toContain(token);
  });

  it('throws GitWorkerTransportError (not a domain refusal) from connect on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.connect({
        projectId,
        actorId,
        provider: 'github',
        remoteUrl: 'https://github.com/example/repo.git',
        token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      }),
    ).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs getBranches to the branches endpoint and returns the branch list', async () => {
    const branchListData = { current: 'main', branches: ['main', 'feature/x'] };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: branchListData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getBranches({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: branchListData });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_BRANCHES_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('POSTs createBranch to the branch-create endpoint with the name and returns the created branch', async () => {
    const createdBranchData = { branch: { name: 'feature/x' } };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: createdBranchData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.createBranch({ projectId, actorId, name: 'feature/x' });

    expect(result).toEqual({ ok: true, data: createdBranchData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_BRANCH_CREATE_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, name: 'feature/x' });
  });

  it('surfaces a domain refusal from the branch-create endpoint as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'ValidationError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.createBranch({ projectId, actorId, name: '' });
    expect(result).toEqual({ ok: false, error: 'ValidationError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from getBranches on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getBranches({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs listConflicts to the conflicts endpoint and returns the conflict list', async () => {
    const conflictListData = {
      operationId: '990e8400-e29b-41d4-a716-446655440010',
      files: [{ path: 'docs/a.adoc', isBinary: false, resolved: false }],
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: conflictListData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.listConflicts({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: conflictListData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_CONFLICTS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('POSTs getConflictStages to the conflict-stages endpoint with the path and returns the stages', async () => {
    const stagesData = { base: 'base text', ours: 'ours text', theirs: 'theirs text', isBinary: false };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: stagesData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getConflictStages({ projectId, actorId, path: 'docs/a.adoc' });

    expect(result).toEqual({ ok: true, data: stagesData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_CONFLICT_STAGES_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, path: 'docs/a.adoc' });
  });

  it('POSTs resolveConflict to the conflict-resolve endpoint with the resolution and mergedContent, and returns resolved:true', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { resolved: true } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.resolveConflict({
      projectId,
      actorId,
      path: 'docs/a.adoc',
      resolution: 'merged',
      mergedContent: 'the merged text',
    });

    expect(result).toEqual({ ok: true, data: { resolved: true } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_CONFLICT_RESOLVE_PATH}`);
    expect(JSON.parse(init.body)).toEqual({
      projectId,
      actorId,
      path: 'docs/a.adoc',
      resolution: 'merged',
      mergedContent: 'the merged text',
    });
  });

  it('POSTs resolveConflict without a mergedContent field when none is given (ours/theirs)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { resolved: true } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.resolveConflict({ projectId, actorId, path: 'docs/a.adoc', resolution: 'ours' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ projectId, actorId, path: 'docs/a.adoc', resolution: 'ours' });
    expect(Object.prototype.hasOwnProperty.call(body, 'mergedContent')).toBe(false);
  });

  it('POSTs completePull to the pull-complete endpoint and returns the resolved outcome', async () => {
    const completeData = { status: 'resolved', operationId: '990e8400-e29b-41d4-a716-446655440010', headCommit: 'abc123' };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: completeData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.completePull({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: completeData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_PULL_COMPLETE_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces UnresolvedConflictsError from completePull as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'UnresolvedConflictsError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.completePull({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'UnresolvedConflictsError' });
  });

  it('POSTs undoPull to the undo-pull endpoint and returns the restored outcome', async () => {
    const undoData = { operationId: '990e8400-e29b-41d4-a716-446655440011', headCommit: 'def456' };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: undoData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.undoPull({ projectId, actorId });

    expect(result).toEqual({ ok: true, data: undoData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_UNDO_PULL_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces NothingToUndoError from undoPull as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'NothingToUndoError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.undoPull({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'NothingToUndoError' });
  });

  it('POSTs getHistory to the history endpoint with path/limit included, and returns the commits', async () => {
    const historyData = {
      commits: [{ hash: 'abc123', message: 'Initial commit', authorUserId: actorId, authoredAt: '2026-01-01T00:00:00.000Z' }],
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: historyData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getHistory({ projectId, actorId, path: 'chapters/intro.adoc', limit: 5 });

    expect(result).toEqual({ ok: true, data: historyData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_HISTORY_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, path: 'chapters/intro.adoc', limit: 5 });
  });

  it('POSTs getHistory omitting path/limit when neither is given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { commits: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.getHistory({ projectId, actorId });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces a domain refusal envelope from getHistory as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getHistory({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from getHistory on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHistory({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs getDiff to the diff endpoint with path/from/to included, and returns the unified diff', async () => {
    const diffData = { unified: '--- a\n+++ b\n' };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: diffData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getDiff({ projectId, actorId, path: 'chapters/intro.adoc', from: 'abc', to: 'def' });

    expect(result).toEqual({ ok: true, data: diffData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_DIFF_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, path: 'chapters/intro.adoc', from: 'abc', to: 'def' });
  });

  it('POSTs getDiff omitting path/from/to when none are given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { unified: '' } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.getDiff({ projectId, actorId });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces a domain refusal envelope from getDiff as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getDiff({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from getDiff on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getDiff({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs getBlame to the blame endpoint with the required path and optional ref, and returns the lines', async () => {
    const blameData = {
      lines: [{ lineNumber: 1, hash: 'abc123', authorUserId: actorId, authoredAt: '2026-01-01T00:00:00.000Z', content: '= Title' }],
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: blameData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getBlame({ projectId, actorId, path: 'chapters/intro.adoc', ref: 'abc123' });

    expect(result).toEqual({ ok: true, data: blameData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_BLAME_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, path: 'chapters/intro.adoc', ref: 'abc123' });
  });

  it('POSTs getBlame omitting ref when not given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { lines: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.getBlame({ projectId, actorId, path: 'chapters/intro.adoc' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, path: 'chapters/intro.adoc' });
  });

  it('surfaces a domain refusal envelope from getBlame as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getBlame({ projectId, actorId, path: 'chapters/intro.adoc' });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from getBlame on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getBlame({ projectId, actorId, path: 'chapters/intro.adoc' })).rejects.toBeInstanceOf(
      GitWorkerTransportError,
    );
  });

  it('throws GitWorkerTransportError (not a domain refusal) from listConflicts on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.listConflicts({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('omits the secret header when none is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: { staged: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await client.stageChanges({ projectId, actorId, paths: [] });
    expect(fetchMock.mock.calls[0][1].headers['x-git-worker-internal-secret']).toBeUndefined();
  });

  it('surfaces a domain refusal envelope as ok:false with the error name, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'InsufficientRoleError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.getStatus({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'InsufficientRoleError' });
  });

  it('surfaces the path on a LiveContentFlushFailedError refusal', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      Response.json({ ok: false, error: 'LiveContentFlushFailedError', path: 'docs/broken.adoc' }, { status: 200 }),
    );
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.commitChanges({ projectId, actorId, message: 'Fix typo' });
    expect(result).toEqual({ ok: false, error: 'LiveContentFlushFailedError', path: 'docs/broken.adoc' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) on a 401 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getStatus({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('throws GitWorkerTransportError on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getStatus({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('throws GitWorkerTransportError on a non-JSON 200 body', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getStatus({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('throws GitWorkerTransportError when the request times out or the network fails', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('The operation was aborted'));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.getStatus({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('never includes the configured secret in a thrown transport error message', async () => {
    const secret = 'sup3r-s3nsitiv3-w0rker-secret';
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    let caught: unknown;
    try {
      await client.getStatus({ projectId, actorId });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it('POSTs discardChanges to the discard endpoint with paths and fromCommit, and returns the restored paths', async () => {
    const discardData = { restoredPaths: ['docs/a.adoc'] };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: discardData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      secret: 'w0rkersecret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.discardChanges({ projectId, actorId, paths: ['docs/a.adoc'], fromCommit: 'abc123' });

    expect(result).toEqual({ ok: true, data: discardData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_DISCARD_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-git-worker-internal-secret']).toBe('w0rkersecret');
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, paths: ['docs/a.adoc'], fromCommit: 'abc123' });
  });

  it('POSTs discardChanges omitting fromCommit when not given', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: true, data: { restoredPaths: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.discardChanges({ projectId, actorId, paths: ['docs/a.adoc'] });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ projectId, actorId, paths: ['docs/a.adoc'] });
    expect(Object.prototype.hasOwnProperty.call(body, 'fromCommit')).toBe(false);
  });

  it('surfaces a domain refusal envelope from discardChanges as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.discardChanges({ projectId, actorId, paths: ['docs/a.adoc'] });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from discardChanges on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.discardChanges({ projectId, actorId, paths: ['docs/a.adoc'] })).rejects.toBeInstanceOf(
      GitWorkerTransportError,
    );
  });

  it('POSTs amendCommit to the amend endpoint with the message, and returns the amended commit', async () => {
    const amendData = { commit: { hash: 'def456', message: 'Amended message', authoredAt: '2026-08-24T00:00:00.000Z' } };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: amendData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.amendCommit({ projectId, actorId, message: 'Amended message' });

    expect(result).toEqual({ ok: true, data: amendData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_AMEND_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, message: 'Amended message' });
  });

  it('POSTs amendCommit omitting message when not given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      Response.json(
        { ok: true, data: { commit: { hash: 'def456', message: 'kept', authoredAt: '2026-08-24T00:00:00.000Z' } } },
        { status: 200 },
      ),
    );
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.amendCommit({ projectId, actorId });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ projectId, actorId });
    expect(Object.prototype.hasOwnProperty.call(body, 'message')).toBe(false);
  });

  it('surfaces a CommitAlreadyPushedError refusal from amendCommit as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'CommitAlreadyPushedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.amendCommit({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'CommitAlreadyPushedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from amendCommit on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.amendCommit({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs previewPull to the preview-pull endpoint with the branch included, and returns the incoming commits', async () => {
    const previewData = {
      incomingCommits: [{ hash: 'abc123', message: 'Remote change', authorUserId: actorId, authoredAt: '2026-01-01T00:00:00.000Z' }],
      changedPaths: ['chapters/intro.adoc'],
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: previewData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.previewPull({ projectId, actorId, branch: 'main' });

    expect(result).toEqual({ ok: true, data: previewData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_PREVIEW_PULL_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, branch: 'main' });
  });

  it('POSTs previewPull omitting branch when none is given', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: true, data: { incomingCommits: [], changedPaths: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.previewPull({ projectId, actorId });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces a domain refusal envelope from previewPull as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryUnreachableError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.previewPull({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'RepositoryUnreachableError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from previewPull on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.previewPull({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('POSTs previewPush to the preview-push endpoint with the branch included, and returns the outgoing commits', async () => {
    const previewData = {
      outgoingCommits: [{ hash: 'def456', message: 'Local change', authorUserId: actorId, authoredAt: '2026-01-02T00:00:00.000Z' }],
      changedPaths: ['chapters/outro.adoc'],
    };
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true, data: previewData }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.previewPush({ projectId, actorId, branch: 'main' });

    expect(result).toEqual({ ok: true, data: previewData });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4010${GIT_WORKER_PREVIEW_PUSH_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId, branch: 'main' });
  });

  it('POSTs previewPush omitting branch when none is given', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: true, data: { outgoingCommits: [], changedPaths: [] } }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.previewPush({ projectId, actorId });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectId, actorId });
  });

  it('surfaces a domain refusal envelope from previewPush as ok:false, without throwing', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(Response.json({ ok: false, error: 'RepositoryNotConnectedError' }, { status: 200 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.previewPush({ projectId, actorId });
    expect(result).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('throws GitWorkerTransportError (not a domain refusal) from previewPush on a 500 response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const client = new HttpGitWorkerClient({
      baseUrl: 'http://127.0.0.1:4010',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.previewPush({ projectId, actorId })).rejects.toBeInstanceOf(GitWorkerTransportError);
  });

  it('constructs an mTLS fetch when tls is provided and no explicit fetch', () => {
    expect(
      () =>
        new HttpGitWorkerClient({
          baseUrl: 'https://git-worker.internal:4010',
          tls: { cert: Buffer.from('cert'), key: Buffer.from('key'), ca: Buffer.from('ca') },
        }),
    ).not.toThrow();
  });
});
