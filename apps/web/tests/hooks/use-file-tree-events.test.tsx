import { renderHook, act } from '@testing-library/react';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import type { FileTreeEventDto } from '@asciidocollab/shared';

let capturedMessageHandler: ((event: MessageEvent) => void) | null = null;

const mockPort = {
  postMessage: jest.fn(),
  start: jest.fn(),
  addEventListener: jest.fn((type: string, handler: (event: MessageEvent) => void) => {
    if (type === 'message') capturedMessageHandler = handler;
  }),
  removeEventListener: jest.fn((type: string) => {
    if (type === 'message') capturedMessageHandler = null;
  }),
};

const mockWorker = { port: mockPort };

globalThis.SharedWorker = jest.fn().mockImplementation(() => mockWorker) as unknown as typeof SharedWorker;

const API_BASE = 'http://localhost:4000';

function triggerMessage(data: unknown) {
  capturedMessageHandler?.({ data } as MessageEvent);
}

describe('useFileTreeEvents', () => {
  const projectId = 'project-123';
  const onFileTreeEvent = jest.fn();
  const onContentChanged = jest.fn();
  const onMainFileChanged = jest.fn();
  const onReconnect = jest.fn();
  const onConnected = jest.fn();

  const handlers = { onFileTreeEvent, onContentChanged, onMainFileChanged, onReconnect, onConnected };

  beforeEach(() => {
    jest.clearAllMocks();
    capturedMessageHandler = null;
  });

  it('posts subscribe message on mount with correct projectId and apiBase', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: 'subscribe',
      projectId,
      apiBase: API_BASE,
    });
  });

  it('routes a file-tree event to onFileTreeEvent', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    const event: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'node-1',
      nodeType: 'file',
      name: 'test.txt',
      path: '/test.txt',
      parentId: null,
    };
    act(() => triggerMessage({ type: 'project-event', event }));
    expect(onFileTreeEvent).toHaveBeenCalledWith(event);
    expect(onContentChanged).not.toHaveBeenCalled();
    expect(onMainFileChanged).not.toHaveBeenCalled();
  });

  it('routes a content-changed event to onContentChanged only', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    const event = { type: 'content-changed', fileNodeId: 'node-7' };
    act(() => triggerMessage({ type: 'project-event', event }));
    expect(onContentChanged).toHaveBeenCalledWith(event);
    expect(onFileTreeEvent).not.toHaveBeenCalled();
  });

  it('routes a main-file-changed event to onMainFileChanged only', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    const event = { type: 'main-file-changed', mainFileNodeId: 'node-3' };
    act(() => triggerMessage({ type: 'project-event', event }));
    expect(onMainFileChanged).toHaveBeenCalledWith(event);
    expect(onFileTreeEvent).not.toHaveBeenCalled();
  });

  it('calls onReconnect when reconnect message received', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    act(() => triggerMessage({ type: 'reconnect' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('calls onConnected when the sse-connected message received', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    act(() => triggerMessage({ type: 'sse-connected' }));
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('routes a review-items-changed event to onReviewItemsChanged only', () => {
    const onReviewItemsChanged = jest.fn();
    renderHook(() => useFileTreeEvents(projectId, { ...handlers, onReviewItemsChanged }));
    const event = { type: 'review-items-changed', documentId: 'doc-1' };
    act(() => triggerMessage({ type: 'project-event', event }));
    expect(onReviewItemsChanged).toHaveBeenCalledWith(event);
    expect(onFileTreeEvent).not.toHaveBeenCalled();
  });

  it('drops every event type when no handler is registered for it', () => {
    renderHook(() => useFileTreeEvents(projectId, {}));

    act(() => triggerMessage({ type: 'reconnect' }));
    act(() => triggerMessage({ type: 'sse-connected' }));
    act(() => triggerMessage({ type: 'project-event', event: { type: 'content-changed', fileNodeId: 'n1' } }));
    act(() => triggerMessage({ type: 'project-event', event: { type: 'main-file-changed', mainFileNodeId: 'n2' } }));
    act(() => triggerMessage({ type: 'project-event', event: { type: 'review-items-changed', documentId: 'd1' } }));
    act(() =>
      triggerMessage({
        type: 'project-event',
        event: {
          type: 'created',
          fileNodeId: 'n3',
          nodeType: 'file',
          name: 'a.txt',
          path: '/a.txt',
          parentId: null,
        },
      }),
    );

    expect(onReconnect).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(onFileTreeEvent).not.toHaveBeenCalled();
  });

  it('posts unsubscribe message on unmount', () => {
    const { unmount } = renderHook(() => useFileTreeEvents(projectId, handlers));
    unmount();
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'unsubscribe', projectId });
  });

  it('removes message listener on unmount so events stop firing', () => {
    const { unmount } = renderHook(() => useFileTreeEvents(projectId, handlers));
    unmount();
    act(() => triggerMessage({ type: 'reconnect' }));
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('ignores messages with no data or an unknown type', () => {
    renderHook(() => useFileTreeEvents(projectId, handlers));
    act(() => triggerMessage(undefined));
    act(() => triggerMessage({ type: 'something-else' }));
    expect(onFileTreeEvent).not.toHaveBeenCalled();
    expect(onContentChanged).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('is a no-op in environments without SharedWorker', () => {
    const original = globalThis.SharedWorker;
    // @ts-expect-error — simulate an environment without SharedWorker
    delete globalThis.SharedWorker;
    try {
      renderHook(() => useFileTreeEvents(projectId, handlers));
      expect(mockPort.postMessage).not.toHaveBeenCalled();
    } finally {
      globalThis.SharedWorker = original;
    }
  });
});
