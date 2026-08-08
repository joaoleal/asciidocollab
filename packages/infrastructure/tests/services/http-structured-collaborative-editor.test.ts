import {
  HttpStructuredCollaborativeEditor,
  COLLAB_APPLY_STRUCTURED_REPLACEMENT_PATH,
} from '../../src/services/http-structured-collaborative-editor';
import { ProjectId, YjsStateId } from '@asciidocollab/domain';
import type { StructuredReplacementSpec } from '@asciidocollab/domain';

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
});
