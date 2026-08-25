import {
  HttpGitWorkerClient,
  GitWorkerTransportError,
  GIT_WORKER_STATUS_PATH,
  GIT_WORKER_STAGE_PATH,
  GIT_WORKER_UNSTAGE_PATH,
  GIT_WORKER_COMMIT_PATH,
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
