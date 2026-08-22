/**
 * The project-wide search/replace client. What matters here is the error translation: the server's own
 * code and message have to survive the trip, because the search view renders an invalid pattern inline
 * rather than as a generic failure — and a body that is not JSON at all must not mask the status.
 */
import {
  searchProjectContent,
  replaceProjectContent,
  ProjectSearchApiError,
} from '@/lib/api/project-search';
import type { SearchQueryDto, ReplaceRequestDto } from '@asciidocollab/shared';

const QUERY: SearchQueryDto = { query: 'needle', mode: 'literal', caseSensitive: false, wholeWord: false };
const REPLACE: ReplaceRequestDto = { query: QUERY, replacement: 'thread', scope: 'project', files: [] };

/** Stands in for one `fetch` round trip. */
function respond(init: { ok: boolean; status?: number; body?: unknown; throwOnJson?: boolean }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => {
      if (init.throwOnJson) throw new Error('not JSON');
      return init.body;
    },
  } as unknown as Response;
}

/** The envelope shapes the endpoints actually return, so the fixtures cannot drift from the wire. */
const SEARCH_RESULT = { groups: [], totalMatches: 0, returnedMatches: 0, capped: false, skippedFiles: 0 };
const REPLACE_RESULT = { replacedCount: 0, files: [], conflicts: [] };

const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('searchProjectContent', () => {
  test('posts the query to the project search endpoint and unwraps the envelope', async () => {
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: SEARCH_RESULT } }));
    await expect(searchProjectContent('proj-1', QUERY)).resolves.toEqual(SEARCH_RESULT);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/projects/proj-1/search');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(options.body).toBe(JSON.stringify(QUERY));
  });

  test('passes the abort signal so a superseded query is cancelled', async () => {
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: SEARCH_RESULT } }));
    const controller = new AbortController();
    await searchProjectContent('proj-1', QUERY, controller.signal);
    expect(mockFetch.mock.calls[0]![1].signal).toBe(controller.signal);
  });

  test('sends no signal key when none was given', async () => {
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: SEARCH_RESULT } }));
    await searchProjectContent('proj-1', QUERY);
    expect('signal' in mockFetch.mock.calls[0]![1]).toBe(false);
  });

  test('declares the JSON content type so the API parses the body', async () => {
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: SEARCH_RESULT } }));
    await searchProjectContent('proj-1', QUERY);
    expect(mockFetch.mock.calls[0]![1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('surfaces the server’s code and message so an invalid pattern can be shown inline', async () => {
    mockFetch.mockResolvedValue(
      respond({
        ok: false,
        status: 400,
        body: { error: { code: 'INVALID_PATTERN', message: 'Unterminated group' } },
      }),
    );
    await expect(searchProjectContent('proj-1', QUERY)).rejects.toMatchObject({
      name: 'ProjectSearchApiError',
      status: 400,
      code: 'INVALID_PATTERN',
      message: 'Unterminated group',
    });
  });

  test('falls back to a generic code and a status-bearing message when the error body says nothing', async () => {
    mockFetch.mockResolvedValue(respond({ ok: false, status: 503, body: {} }));
    const error = await searchProjectContent('proj-1', QUERY).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ProjectSearchApiError);
    expect(error).toMatchObject({ code: 'SEARCH_ERROR', status: 503 });
    expect((error as ProjectSearchApiError).message).toContain('503');
  });

  test('names the failed operation in the fallback message', async () => {
    // The fallback is the only text the user sees when the server said nothing, so it has to say
    // which call failed — "503" alone does not distinguish a failed search from a failed replace.
    mockFetch.mockResolvedValue(respond({ ok: false, status: 503, body: {} }));
    const error = await searchProjectContent('proj-1', QUERY).catch((error_: unknown) => error_);
    expect((error as ProjectSearchApiError).message).toBe('Search failed: 503');
  });

  test('a JSON body of literal null still yields the fallback code and message', async () => {
    // `response.json()` resolving to `null` is well-formed JSON, so the `.catch` fallback never runs
    // and `null` reaches the error translator — which must not dereference it.
    mockFetch.mockResolvedValue(respond({ ok: false, status: 500, body: null }));
    const error = await searchProjectContent('proj-1', QUERY).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ProjectSearchApiError);
    expect((error as ProjectSearchApiError).code).toBe('SEARCH_ERROR');
    expect((error as ProjectSearchApiError).message).toBe('Search failed: 500');
  });

  test('a body that is not JSON still yields the status, not a parse error', async () => {
    // An HTML error page from a proxy would otherwise surface as "Unexpected token <", hiding the 502.
    mockFetch.mockResolvedValue(respond({ ok: false, status: 502, throwOnJson: true }));
    await expect(searchProjectContent('proj-1', QUERY)).rejects.toMatchObject({
      code: 'SEARCH_ERROR',
      status: 502,
    });
  });
});

describe('replaceProjectContent', () => {
  test('posts the reviewed replace request and unwraps the envelope', async () => {
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: REPLACE_RESULT } }));
    await expect(replaceProjectContent('proj-1', REPLACE)).resolves.toEqual(REPLACE_RESULT);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/projects/proj-1/replace');
    expect(options.body).toBe(JSON.stringify(REPLACE));
  });

  test('sends the replace as a credentialed JSON POST', async () => {
    // Replace is a mutating, membership-gated call: without the method it would be a GET, and
    // without the cookie the server would reject it as anonymous.
    mockFetch.mockResolvedValue(respond({ ok: true, body: { data: REPLACE_RESULT } }));
    await replaceProjectContent('proj-1', REPLACE);
    const options = mockFetch.mock.calls[0]![1];
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('surfaces a rejected replacement template with its own code', async () => {
    mockFetch.mockResolvedValue(
      respond({
        ok: false,
        status: 400,
        body: { error: { code: 'INVALID_REPLACEMENT', message: 'Unknown capture group $9' } },
      }),
    );
    await expect(replaceProjectContent('proj-1', REPLACE)).rejects.toMatchObject({
      code: 'INVALID_REPLACEMENT',
      message: 'Unknown capture group $9',
    });
  });

  test('falls back to the replace-specific fallback message', async () => {
    mockFetch.mockResolvedValue(respond({ ok: false, status: 500, body: {} }));
    await expect(replaceProjectContent('proj-1', REPLACE)).rejects.toMatchObject({
      code: 'SEARCH_ERROR',
      message: expect.stringContaining('Replace failed'),
    });
  });
});
