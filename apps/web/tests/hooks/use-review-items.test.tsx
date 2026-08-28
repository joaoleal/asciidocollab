import { renderHook, act, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import type { ThreadDto } from '@asciidocollab/shared';
import { useReviewItems } from '@/hooks/use-review-items';
import { listDocumentReviewItems } from '@/lib/api/review';
import { COLLAB_YTEXT_KEY } from '@/components/editor/editor-collab-extensions';
import { resolveThreadAnchors, toReviewAnchorRanges } from '@/lib/review/thread-ranges';

jest.mock('@/lib/api/review', () => ({ listDocumentReviewItems: jest.fn() }));

// Capture the SSE handler the hook registers so tests can fire document events at it.
let sseHandler: ((event: { documentId: string }) => void) | undefined;
jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: (_projectId: string, options: { onReviewItemsChanged?: (event: { documentId: string }) => void }) => {
    sseHandler = options.onReviewItemsChanged;
  },
}));

// Control the anchor→range resolution so we can drive the hook's equality/skip branches directly.
jest.mock('@/lib/review/thread-ranges', () => ({
  resolveThreadAnchors: jest.fn(() => []),
  toReviewAnchorRanges: jest.fn(() => []),
}));

const mockList = listDocumentReviewItems as jest.MockedFunction<typeof listDocumentReviewItems>;
const mockResolveAnchors = resolveThreadAnchors as jest.MockedFunction<typeof resolveThreadAnchors>;
const mockToRanges = toReviewAnchorRanges as jest.MockedFunction<typeof toReviewAnchorRanges>;

const thread = (id: string): ThreadDto => ({
  root: {
    id,
    documentId: 'd1',
    projectId: 'p1',
    kind: 'comment',
    body: 'body',
    author: { id: 'u1', displayName: 'Alice', avatarKey: null },
    reactions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  replies: [],
});

function ydocWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(COLLAB_YTEXT_KEY).insert(0, text);
  return doc;
}

beforeEach(() => {
  sseHandler = undefined;
  mockList.mockReset().mockResolvedValue([]);
  mockResolveAnchors.mockReset().mockReturnValue([]);
  mockToRanges.mockReset().mockReturnValue([]);
});

describe('useReviewItems', () => {
  test('does not fetch while disabled', async () => {
    renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null, enabled: false }));
    await Promise.resolve();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('loads threads and resolves ranges against the live doc', async () => {
    mockList.mockResolvedValue([thread('r1')]);
    mockResolveAnchors.mockReturnValue([{ id: 'r1', range: { from: 0, to: 4 }, state: 'located' }]);
    mockToRanges.mockReturnValue([{ id: 'r1', from: 0, to: 4 }]);
    const ydoc = ydocWithText('some text');

    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc }));

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.ranges).toEqual([{ id: 'r1', from: 0, to: 4 }]);
    expect(result.current.anchorStates.get('r1')).toBe('located');
  });

  test('re-fetches when a matching SSE event arrives, ignores other documents', async () => {
    mockList.mockResolvedValue([thread('r1')]);
    renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    act(() => sseHandler?.({ documentId: 'other' }));
    expect(mockList).toHaveBeenCalledTimes(1); // unrelated document — no refetch

    act(() => sseHandler?.({ documentId: 'd1' }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  test('fetches with the default (unresolved) filter on mount', async () => {
    renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('p1', 'd1', { includeResolved: false }));
  });

  test('re-resolves ranges as the document changes', async () => {
    mockList.mockResolvedValue([thread('r1')]);
    const ydoc = ydocWithText('start');
    renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc }));
    await waitFor(() => expect(mockResolveAnchors).toHaveBeenCalled());

    const before = mockResolveAnchors.mock.calls.length;
    act(() => {
      ydoc.getText(COLLAB_YTEXT_KEY).insert(0, 'X');
    });
    await waitFor(() => expect(mockResolveAnchors.mock.calls.length).toBeGreaterThan(before));
  });

  test('surfaces a fetch error', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
  });

  test('honours an explicit includeResolved seed', async () => {
    renderHook(() =>
      useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null, includeResolved: true }),
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('p1', 'd1', { includeResolved: true }));
  });

  test('exposes a refetch control that re-runs the fetch', async () => {
    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    act(() => result.current.refetch());

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  test('drops the resolved ranges when the collaborative doc goes away', async () => {
    mockList.mockResolvedValue([thread('r1')]);
    mockResolveAnchors.mockReturnValue([{ id: 'r1', range: { from: 0, to: 4 }, state: 'located' }]);
    mockToRanges.mockReturnValue([{ id: 'r1', from: 0, to: 4 }]);
    const ydoc = ydocWithText('some text');

    const { result, rerender } = renderHook(
      ({ doc }: { doc: Y.Doc | null }) => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: doc }),
      { initialProps: { doc: ydoc } },
    );
    await waitFor(() => expect(result.current.ranges).toHaveLength(1));

    rerender({ doc: null });

    await waitFor(() => expect(result.current.ranges).toHaveLength(0));
    expect(result.current.anchorStates.size).toBe(0);
  });

  test('a superseded in-flight fetch never overwrites the newer result', async () => {
    let releaseFirst: ((value: ThreadDto[]) => void) | undefined;
    mockList.mockImplementationOnce(
      () =>
        new Promise<ThreadDto[]>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    mockList.mockResolvedValue([thread('newer')]);

    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      sseHandler?.({ documentId: 'd1' });
    });
    await waitFor(() => expect(result.current.threads.map((entry) => entry.root.id)).toEqual(['newer']));

    await act(async () => {
      releaseFirst?.([thread('stale')]);
    });

    expect(result.current.threads.map((entry) => entry.root.id)).toEqual(['newer']);
    expect(result.current.loading).toBe(false);
  });

  test('a superseded fetch that fails never surfaces its error', async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mockList.mockImplementationOnce(
      () =>
        new Promise<ThreadDto[]>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    mockList.mockResolvedValue([thread('newer')]);

    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      sseHandler?.({ documentId: 'd1' });
    });
    await waitFor(() => expect(result.current.threads.map((entry) => entry.root.id)).toEqual(['newer']));

    await act(async () => {
      rejectFirst?.(new Error('stale failure'));
    });

    expect(result.current.error).toBeNull();
  });

  test('reports a generic message when the failure is not an Error', async () => {
    mockList.mockRejectedValue('a string rejection');
    const { result } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc: null }));
    await waitFor(() => expect(result.current.error?.message).toBe('Failed to load review items'));
  });

  test('coalesces a burst of document transactions into a single re-resolve', async () => {
    const ydoc = ydocWithText('start');
    renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc }));
    await waitFor(() => expect(mockResolveAnchors).toHaveBeenCalled());

    const before = mockResolveAnchors.mock.calls.length;
    act(() => {
      const ytext = ydoc.getText(COLLAB_YTEXT_KEY);
      ytext.insert(0, 'X');
      ytext.insert(0, 'Y');
      ytext.insert(0, 'Z');
    });

    await waitFor(() => expect(mockResolveAnchors.mock.calls.length).toBe(before + 1));
  });

  test('cancels a pending re-resolve frame when the doc is torn down', async () => {
    const cancel = jest.spyOn(globalThis, 'cancelAnimationFrame');
    const ydoc = ydocWithText('start');
    const { unmount } = renderHook(() => useReviewItems({ projectId: 'p1', documentId: 'd1', ydoc }));
    await waitFor(() => expect(mockResolveAnchors).toHaveBeenCalled());

    act(() => {
      ydoc.getText(COLLAB_YTEXT_KEY).insert(0, 'X');
    });
    unmount();

    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });

  test('clears the previous document state on a document switch', async () => {
    mockList.mockResolvedValue([thread('r1')]);
    const { result, rerender } = renderHook(
      ({ documentId }) => useReviewItems({ projectId: 'p1', documentId, ydoc: null }),
      { initialProps: { documentId: 'd1' } },
    );
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    mockList.mockResolvedValueOnce([]);
    rerender({ documentId: 'd2' });
    // The switch synchronously drops the prior document's threads before the new fetch resolves.
    expect(result.current.threads).toHaveLength(0);
  });
});
