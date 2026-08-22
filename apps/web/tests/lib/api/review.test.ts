// Tests for apps/web/src/lib/api/review.ts — each client hits the right URL/method/body,
// unwraps the `{ data }` envelope, and surfaces the API error code on a non-2xx response.
import {
  listDocumentReviewItems,
  listProjectReviewItems,
  createReviewItem,
  replyToThread,
  editReviewItem,
  resolveReviewItem,
  reactToItem,
  patchReviewItem,
  convertReviewItem,
  assignTask,
  setTaskStatus,
  reanchorReviewItem,
  deleteReviewItem,
  bulkDeleteDocument,
  bulkDeleteProject,
} from '@/lib/api/review';
import { ApiError, API_BASE_URL } from '@/lib/api/transport';
import type { CreateReviewItemInput } from '@asciidocollab/shared';

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

/** Resolves the mock fetch once with an ok JSON body. */
function mockOk(body: unknown): void {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** The single request the client made: `[url, options]`. */
function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[0] as [string, RequestInit];
}

const anchor: CreateReviewItemInput['anchor'] = {
  relPos: 'AAAA',
  quote: { prefix: 'a', exact: 'b', suffix: 'c' },
  lineHint: 3,
};

describe('listDocumentReviewItems', () => {
  test('GETs the document review-items endpoint and unwraps threads', async () => {
    mockOk({ data: { threads: [{ root: { id: 'r1' }, replies: [] }] } });
    const threads = await listDocumentReviewItems('proj-1', 'doc-1');
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/documents/doc-1/review-items');
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.credentials).toBe('include');
    expect(threads).toEqual([{ root: { id: 'r1' }, replies: [] }]);
  });

  test('adds includeResolved=true only when requested', async () => {
    mockOk({ data: { threads: [] } });
    await listDocumentReviewItems('proj-1', 'doc-1', { includeResolved: true });
    expect(lastCall()[0]).toContain('includeResolved=true');
  });

  test('omits the includeResolved query by default', async () => {
    mockOk({ data: { threads: [] } });
    await listDocumentReviewItems('proj-1', 'doc-1');
    expect(lastCall()[0]).not.toContain('includeResolved');
  });

  test('requests the bare endpoint — no trailing query separator — when no filter applies', async () => {
    // The whole URL, not just the absence of the parameter: an empty filter set must contribute
    // nothing at all, so a stray suffix (a lone "?" or any other text) is a routing bug.
    mockOk({ data: { threads: [] } });
    await listDocumentReviewItems('proj-1', 'doc-1');
    expect(lastCall()[0]).toBe(`${API_BASE_URL}/projects/proj-1/documents/doc-1/review-items`);
  });

  test('appends exactly one query parameter when resolved items are requested', async () => {
    mockOk({ data: { threads: [] } });
    await listDocumentReviewItems('proj-1', 'doc-1', { includeResolved: true });
    expect(lastCall()[0]).toBe(
      `${API_BASE_URL}/projects/proj-1/documents/doc-1/review-items?includeResolved=true`,
    );
  });
});

describe('listProjectReviewItems', () => {
  test('GETs the project endpoint and unwraps items', async () => {
    mockOk({ data: { items: [{ id: 'i1' }] } });
    const items = await listProjectReviewItems('proj-1');
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items');
    expect(options.method ?? 'GET').toBe('GET');
    expect(items).toEqual([{ id: 'i1' }]);
  });

  test('serialises assignee/status/documentId filters into the query string', async () => {
    mockOk({ data: { items: [] } });
    await listProjectReviewItems('proj-1', { assigneeId: 'u9', status: 'open', documentId: 'doc-2' });
    const url = lastCall()[0];
    expect(url).toContain('assigneeId=u9');
    expect(url).toContain('status=open');
    expect(url).toContain('documentId=doc-2');
  });

  test('requests the bare endpoint when no filter is set', async () => {
    mockOk({ data: { items: [] } });
    await listProjectReviewItems('proj-1');
    expect(lastCall()[0]).toBe(`${API_BASE_URL}/projects/proj-1/review-items`);
  });

  test('drops the undefined filters and keeps only the one that was set', async () => {
    mockOk({ data: { items: [] } });
    await listProjectReviewItems('proj-1', { status: 'open' });
    expect(lastCall()[0]).toBe(`${API_BASE_URL}/projects/proj-1/review-items?status=open`);
  });
});

describe('createReviewItem', () => {
  test('POSTs the create body and returns the unwrapped item', async () => {
    mockOk({ data: { id: 'new-1' } });
    const input: CreateReviewItemInput = { kind: 'comment', body: 'hi', anchor };
    const item = await createReviewItem('proj-1', 'doc-1', input);
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/documents/doc-1/review-items');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual(input);
    expect(item).toEqual({ id: 'new-1' });
  });
});

describe('replyToThread', () => {
  test('POSTs to the replies endpoint with the body', async () => {
    mockOk({ data: { id: 'reply-1' } });
    const item = await replyToThread('proj-1', 'root-1', { body: 'sure' });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1/replies');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ body: 'sure' });
    expect(item).toEqual({ id: 'reply-1' });
  });
});

describe('editReviewItem', () => {
  test('PATCHes the item with op=edit and the replacement body', async () => {
    mockOk({ data: { id: 'root-1', body: 'edited', editedAt: '2026-03-01' } });
    const item = await editReviewItem('proj-1', 'root-1', { body: 'edited' });
    const [url, options] = lastCall();
    expect(url).toBe(`${API_BASE_URL}/projects/proj-1/review-items/root-1`);
    expect(options.method).toBe('PATCH');
    // The discriminator is what routes the PATCH server-side: without `op: 'edit'` the request
    // is either rejected or dispatched to a different handler.
    expect(JSON.parse(options.body as string)).toEqual({ op: 'edit', body: 'edited' });
    expect(item).toEqual({ id: 'root-1', body: 'edited', editedAt: '2026-03-01' });
  });

  test('propagates the API error when the caller is not the author', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'REVIEW_NOT_AUTHOR', message: 'not yours' } }),
    });
    await expect(editReviewItem('proj-1', 'root-1', { body: 'edited' })).rejects.toMatchObject({
      code: 'REVIEW_NOT_AUTHOR',
      status: 403,
      message: 'not yours',
    });
  });
});

describe('resolveReviewItem', () => {
  test('POSTs to the resolve endpoint', async () => {
    mockOk({ data: { id: 'root-1', resolvedAt: '2026-01-01' } });
    const item = await resolveReviewItem('proj-1', 'root-1');
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1/resolve');
    expect(options.method).toBe('POST');
    expect(item).toEqual({ id: 'root-1', resolvedAt: '2026-01-01' });
  });

  test('sends reopen=false by default, so the plain call resolves rather than reopens', async () => {
    mockOk({ data: { id: 'root-1', resolvedAt: '2026-01-01' } });
    await resolveReviewItem('proj-1', 'root-1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ reopen: false });
  });

  test('sends reopen=true when asked to reopen the thread', async () => {
    mockOk({ data: { id: 'root-1', resolvedAt: null } });
    await resolveReviewItem('proj-1', 'root-1', true);
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ reopen: true });
  });
});

describe('reactToItem', () => {
  test('POSTs the emoji and unwraps the reaction summaries', async () => {
    mockOk({ data: { reactions: [{ emoji: '👍', count: 1, reactedByMe: true, userIds: ['u1'] }] } });
    const reactions = await reactToItem('proj-1', 'root-1', { emoji: '👍' });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1/reactions');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ emoji: '👍' });
    expect(reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: true, userIds: ['u1'] }]);
  });
});

describe('patchReviewItem and typed helpers', () => {
  test('patchReviewItem PATCHes the item with the raw op body', async () => {
    mockOk({ data: { id: 'root-1' } });
    await patchReviewItem('proj-1', 'root-1', { op: 'status', status: 'in_progress' });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ op: 'status', status: 'in_progress' });
  });

  test('convertReviewItem sends op=convert with the target kind', async () => {
    mockOk({ data: { id: 'root-1', kind: 'task' } });
    await convertReviewItem('proj-1', 'root-1', { kind: 'task' });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ op: 'convert', kind: 'task' });
  });

  test('assignTask sends op=assign with assignee and due date', async () => {
    mockOk({ data: { id: 'root-1' } });
    await assignTask('proj-1', 'root-1', { assigneeId: 'u2', dueDate: '2026-02-01' });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ op: 'assign', assigneeId: 'u2', dueDate: '2026-02-01' });
  });

  test('setTaskStatus sends op=status with the status', async () => {
    mockOk({ data: { id: 'root-1' } });
    await setTaskStatus('proj-1', 'root-1', { status: 'resolved' });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ op: 'status', status: 'resolved' });
  });
});

describe('reanchorReviewItem', () => {
  test('POSTs the new anchor to the reanchor endpoint', async () => {
    mockOk({ data: { id: 'root-1' } });
    await reanchorReviewItem('proj-1', 'root-1', { anchor });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1/reanchor');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ anchor });
  });
});

describe('deleteReviewItem', () => {
  test('DELETEs the item and resolves void', async () => {
    mockOk({ data: { deleted: true } });
    const result = await deleteReviewItem('proj-1', 'root-1');
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/root-1');
    expect(options.method).toBe('DELETE');
    expect(result).toBeUndefined();
  });
});

describe('bulk delete', () => {
  test('bulkDeleteDocument POSTs the confirm body and returns the count', async () => {
    mockOk({ data: { deleted: 4 } });
    const result = await bulkDeleteDocument('proj-1', 'doc-1', { confirm: true, expectedCount: 4 });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/documents/doc-1/review-items/bulk-delete');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ confirm: true, expectedCount: 4 });
    expect(result).toEqual({ deleted: 4 });
  });

  test('bulkDeleteProject POSTs to the project bulk-delete endpoint', async () => {
    mockOk({ data: { deleted: 9 } });
    const result = await bulkDeleteProject('proj-1', { confirm: true });
    const [url, options] = lastCall();
    expect(url).toContain('/projects/proj-1/review-items/bulk-delete');
    expect(options.method).toBe('POST');
    expect(result).toEqual({ deleted: 9 });
  });
});

describe('error handling', () => {
  test('throws a typed ApiError carrying the server error code on a non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'REVIEW_FORBIDDEN', message: 'nope' } }),
    });
    await expect(listDocumentReviewItems('proj-1', 'doc-1')).rejects.toMatchObject({
      code: 'REVIEW_FORBIDDEN',
      status: 403,
    });
  });

  test('the thrown error is an ApiError instance', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: { code: 'REVIEW_COUNT_MISMATCH', message: 'stale' } }),
    });
    await expect(bulkDeleteDocument('proj-1', 'doc-1', { confirm: true })).rejects.toBeInstanceOf(ApiError);
  });
});
