import { ProjectId, YjsStateId } from '@asciidocollab/domain';
import {
  HttpCollaborativeContentEditor,
  COLLAB_APPLY_EDITS_PATH,
  COLLAB_READ_CONTENT_PATH,
  COLLAB_APPLY_FULL_CONTENT_PATH,
} from '../../src/services/http-collaborative-content-editor';

describe('HttpCollaborativeContentEditor', () => {
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const yjsStateId = YjsStateId.create('11111111-e29b-41d4-a716-446655440111');
  const replacements = [{ find: 'include::intro.adoc[]', replace: 'include::overview.adoc[]' }];

  it('POSTs the replacements to the collab apply-edits endpoint and returns the apply count on 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ applied: 2 }, { status: 200 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003/',
      secret: 's3cret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await editor.applyReplacements(projectId, yjsStateId, replacements);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on baseUrl is normalised so the path is not doubled.
    expect(url).toBe(`http://127.0.0.1:4003${COLLAB_APPLY_EDITS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-collab-internal-secret']).toBe('s3cret');
    expect(JSON.parse(init.body)).toEqual({
      projectId: projectId.value,
      yjsStateId: yjsStateId.value,
      replacements,
    });
  });

  it('omits the secret header when none is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ applied: 1 }, { status: 200 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await editor.applyReplacements(projectId, yjsStateId, replacements);
    expect(fetchMock.mock.calls[0][1].headers['x-collab-internal-secret']).toBeUndefined();
  });

  it('returns an error result on a non-2xx response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await editor.applyReplacements(projectId, yjsStateId, replacements);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('503');
  });

  it('returns an error result (never throws) when the request fails', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await editor.applyReplacements(projectId, yjsStateId, replacements);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('ECONNREFUSED');
  });

  it('short-circuits with zero applied and makes no request when there are no replacements', async () => {
    const fetchMock = jest.fn();
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await editor.applyReplacements(projectId, yjsStateId, []);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an error when apply-edits responds 200 with a malformed body (no numeric applied)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ nope: true }, { status: 200 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const result = await editor.applyReplacements(projectId, yjsStateId, replacements);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('malformed');
  });

  it('constructs an mTLS fetch when tls is provided and no explicit fetch', () => {
    expect(
      () =>
        new HttpCollaborativeContentEditor({
          baseUrl: 'https://collab.internal:4003',
          tls: { cert: Buffer.from('cert'), key: Buffer.from('key'), ca: Buffer.from('ca') },
        }),
    ).not.toThrow();
  });

  it('prefers an injected fetch over tls', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ applied: 1 }, { status: 200 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'https://collab.internal:4003',
      tls: { cert: Buffer.from('cert'), key: Buffer.from('key'), ca: Buffer.from('ca') },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await editor.applyReplacements(projectId, yjsStateId, replacements);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POSTs to the read-content endpoint and returns the live content on 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json({ content: '= Doc\n\n:folder2: value\n' }, { status: 200 }));
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003/',
      secret: 's3cret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await editor.readContent(projectId, yjsStateId);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe('= Doc\n\n:folder2: value\n');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4003${COLLAB_READ_CONTENT_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-collab-internal-secret']).toBe('s3cret');
    expect(JSON.parse(init.body)).toEqual({ projectId: projectId.value, yjsStateId: yjsStateId.value });
  });

  it('returns an error result for a non-2xx or malformed read-content response', async () => {
    const notOk = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: jest.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch,
    });
    const r1 = await notOk.readContent(projectId, yjsStateId);
    expect(r1.success).toBe(false);

    const malformed = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: jest.fn().mockResolvedValue(Response.json({ nope: true }, { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    const r2 = await malformed.readContent(projectId, yjsStateId);
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error.message).toContain('malformed');
  });

  it('returns a null value when read-content reports no live source for the document', async () => {
    const editor = new HttpCollaborativeContentEditor({
      baseUrl: 'http://127.0.0.1:4003',
      fetch: jest.fn().mockResolvedValue(Response.json({ content: null }, { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    const result = await editor.readContent(projectId, yjsStateId);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBeNull();
  });

  describe('replaceContent', () => {
    const targetContent = '= Doc\n\nreplaced body\n';

    it('POSTs to the apply-full-content endpoint and returns ok(undefined) on 200', async () => {
      const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));
      const editor = new HttpCollaborativeContentEditor({
        baseUrl: 'http://127.0.0.1:4003/',
        secret: 's3cret',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await editor.replaceContent(projectId, yjsStateId, targetContent);

      expect(result.success).toBe(true);
      if (result.success) expect(result.value).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:4003${COLLAB_APPLY_FULL_CONTENT_PATH}`);
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['x-collab-internal-secret']).toBe('s3cret');
      expect(JSON.parse(init.body)).toEqual({
        projectId: projectId.value,
        yjsStateId: yjsStateId.value,
        content: targetContent,
      });
    });

    it('omits the secret header when none is configured', async () => {
      const fetchMock = jest.fn().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));
      const editor = new HttpCollaborativeContentEditor({
        baseUrl: 'http://127.0.0.1:4003',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      await editor.replaceContent(projectId, yjsStateId, targetContent);
      expect(fetchMock.mock.calls[0][1].headers['x-collab-internal-secret']).toBeUndefined();
    });

    it('returns an error result (never throws) on a non-2xx response, without leaking the secret', async () => {
      const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 500 }));
      const editor = new HttpCollaborativeContentEditor({
        baseUrl: 'http://127.0.0.1:4003',
        secret: 's3cret',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await editor.replaceContent(projectId, yjsStateId, targetContent);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('500');
        expect(result.error.message).not.toContain('s3cret');
      }
    });

    it('returns an error result (never throws) when the request fails, without leaking the secret', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const editor = new HttpCollaborativeContentEditor({
        baseUrl: 'http://127.0.0.1:4003',
        secret: 's3cret',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await editor.replaceContent(projectId, yjsStateId, targetContent);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('ECONNREFUSED');
        expect(result.error.message).not.toContain('s3cret');
      }
    });
  });
});
