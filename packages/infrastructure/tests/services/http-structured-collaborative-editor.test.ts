import {
  HttpStructuredCollaborativeEditor,
  COLLAB_APPLY_STRUCTURED_REPLACEMENT_PATH,
} from '../../src/services/http-structured-collaborative-editor';
import { ProjectId, YjsStateId } from '@asciidocollab/domain';
import type { StructuredReplacementSpec } from '@asciidocollab/domain';
import { createMtlsFetch } from '../../src/services/mtls-fetch';

// The constructor picks its transport without doing any I/O, so the mTLS factory is stubbed: the
// assertion is that the adapter *builds* the client from the configured material and then routes
// the request through it, not that node's TLS stack works.
jest.mock('../../src/services/mtls-fetch', () => ({ createMtlsFetch: jest.fn() }));
const createMtlsFetchMock = createMtlsFetch as jest.MockedFunction<typeof createMtlsFetch>;

const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
const yjsStateId = YjsStateId.create('11111111-e29b-41d4-a716-446655440111');

const spec: StructuredReplacementSpec = {
  query: { text: 'foo', mode: 'literal', caseSensitive: true, wholeWord: false },
  replacement: 'bar',
  selections: [{ ordinal: 0, expectedText: 'foo' }],
};

// The editor is injected with a `typeof globalThis.fetch`, so its stubs are declared with that
// argument tuple. A bare `jest.fn(async () => …)` records an EMPTY tuple, and destructuring the
// recorded call below then indexes past the end of it.
type FetchArguments = [input: RequestInfo | URL, init?: RequestInit];

describe('HttpStructuredCollaborativeEditor', () => {
  beforeEach(() => {
    createMtlsFetchMock.mockReset();
  });

  it('posts the spec to the structured-apply endpoint and returns the applied count', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ applied: 3 }, { status: 200 }),
    );
    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101/', secret: 's3cret', fetch: fetchMock });

    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    expect(result).toEqual({ success: true, value: 3 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://collab:4101${COLLAB_APPLY_STRUCTURED_REPLACEMENT_PATH}`);
    expect(init?.headers).toMatchObject({ 'x-collab-internal-secret': 's3cret' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      projectId: projectId.value,
      yjsStateId: yjsStateId.value,
      query: { text: 'foo', mode: 'literal' },
      replacement: 'bar',
      selections: [{ ordinal: 0, expectedText: 'foo' }],
    });
  });

  it('returns an error on a non-2xx response', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      new Response('nope', { status: 500 }),
    );
    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101', fetch: fetchMock });
    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    expect(result.success).toBe(false);
  });

  it('returns an error on a malformed body', async () => {
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ nope: true }, { status: 200 }),
    );
    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101', fetch: fetchMock });
    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    expect(result.success).toBe(false);
  });

  it('surfaces a transport rejection as the very Error the transport threw', async () => {
    const failure = new Error('connect ECONNREFUSED 10.0.0.1:4101');
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(async () => {
      throw failure;
    });
    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101', fetch: fetchMock });

    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    if (result.success) throw new Error('expected the apply to fail');
    // Identity, not just shape: the adapter must not re-wrap an Error and lose its stack/cause.
    expect(result.error).toBe(failure);
  });

  it('wraps a non-Error rejection in an Error carrying its string form', async () => {
    // A rejection with a non-Error value (what a stringly-typed transport or a thrown literal
    // produces) must still reach the caller as an Error.
    const fetchMock = jest.fn<Promise<Response>, FetchArguments>(() => Promise.reject('collab exploded'));
    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101', fetch: fetchMock });

    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    if (result.success) throw new Error('expected the apply to fail');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('collab exploded');
  });

  it('builds an mTLS transport from the configured client material when no fetch is injected', async () => {
    const tlsFetch = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ applied: 1 }, { status: 200 }),
    );
    createMtlsFetchMock.mockReturnValue(tlsFetch as unknown as typeof globalThis.fetch);
    const tls = { cert: Buffer.from('CERT'), key: Buffer.from('KEY'), ca: Buffer.from('CA') };

    const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101///', tls });
    expect(createMtlsFetchMock).toHaveBeenCalledTimes(1);
    expect(createMtlsFetchMock).toHaveBeenCalledWith(tls.cert, tls.key, tls.ca);

    const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);
    expect(result).toEqual({ success: true, value: 1 });

    expect(tlsFetch).toHaveBeenCalledTimes(1);
    const [url, init] = tlsFetch.mock.calls[0];
    // Every trailing slash is stripped, so the path is joined exactly once.
    expect(url).toBe(`http://collab:4101${COLLAB_APPLY_STRUCTURED_REPLACEMENT_PATH}`);
    // No secret configured: the header must be absent entirely, not empty.
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('falls back to the global fetch when neither a fetch nor mTLS material is configured', async () => {
    const globalFetch = jest.fn<Promise<Response>, FetchArguments>(async () =>
      Response.json({ applied: 7 }, { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = globalFetch as unknown as typeof globalThis.fetch;
    try {
      const editor = new HttpStructuredCollaborativeEditor({ baseUrl: 'http://collab:4101' });
      const result = await editor.applyStructuredReplacement(projectId, yjsStateId, spec);

      expect(result).toEqual({ success: true, value: 7 });
      expect(createMtlsFetchMock).not.toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0][0]).toBe(`http://collab:4101${COLLAB_APPLY_STRUCTURED_REPLACEMENT_PATH}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
