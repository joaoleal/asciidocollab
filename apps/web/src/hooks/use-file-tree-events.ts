'use client';
import { useEffect, useRef } from 'react';
import { API_BASE_URL } from '@/lib/api/base-url';
import type {
  ContentChangedEventDto,
  FileTreeEventDto,
  MainFileChangedEventDto,
  ProjectEventDto,
  ReviewItemsChangedEventDto,
} from '@asciidocollab/shared';

let workerInstance: SharedWorker | null = null;

function getWorker(): SharedWorker | null {
  if (typeof SharedWorker === 'undefined') return null;
  if (!workerInstance) {
    workerInstance = new SharedWorker('/workers/file-tree-events.worker.js', { type: 'classic', name: 'file-tree-events' });
    workerInstance.port.start();
  }
  return workerInstance;
}

/** Per-type callbacks for the project SSE stream; every field is optional so a consumer opts into only what it needs. */
export interface ProjectEventHandlers {
  /**
   * Handles a structural file-tree change (created/deleted/renamed/moved).
   *
   * @param event - The file-tree change event.
   */
  onFileTreeEvent?: (event: FileTreeEventDto) => void;
  /**
   * Handles a file content change — a collaborator's live edit or a save.
   *
   * @param event - The content-changed event.
   */
  onContentChanged?: (event: ContentChangedEventDto) => void;
  /**
   * Handles a change to the project's designated main file setting.
   *
   * @param event - The main-file-changed event.
   */
  onMainFileChanged?: (event: MainFileChangedEventDto) => void;
  /**
   * Handles a change to a document's review items (comment/task created, replied,
   * resolved, reacted, edited, or deleted); the consumer re-fetches that document's items.
   *
   * @param event - The review-items-changed event.
   */
  onReviewItemsChanged?: (event: ReviewItemsChangedEventDto) => void;
  /** The SSE connection dropped (fires on error and on each failed retry); the consumer should resync. */
  onReconnect?: () => void;
  /** The SSE connection was (re)established; content is live again. */
  onConnected?: () => void;
}

/**
 * Subscribes to the project's SSE event stream via a SharedWorker (one SSE connection shared across
 * all tabs) and dispatches each {@link ProjectEventDto} to the matching handler by its `type`.
 *
 * @param projectId - The project whose event stream to subscribe to.
 * @param handlers - Per-type callbacks; only the provided ones fire.
 */
export function useFileTreeEvents(projectId: string, handlers: ProjectEventHandlers): void {
  const handlersReference = useRef(handlers);
  handlersReference.current = handlers;

  useEffect(() => {
    const worker = getWorker();
    if (!worker) return;

    worker.port.postMessage({ type: 'subscribe', projectId, apiBase: API_BASE_URL });

    const handleMessage = (message: MessageEvent) => {
      const data = message.data;
      if (data?.type === 'reconnect') {
        handlersReference.current.onReconnect?.();
        return;
      }
      if (data?.type === 'sse-connected') {
        handlersReference.current.onConnected?.();
        return;
      }
      if (data?.type !== 'project-event') return;
      const event: ProjectEventDto = data.event;
      const current = handlersReference.current;
      switch (event.type) {
        case 'content-changed': {
          current.onContentChanged?.(event);
          break;
        }
        case 'main-file-changed': {
          current.onMainFileChanged?.(event);
          break;
        }
        case 'review-items-changed': {
          current.onReviewItemsChanged?.(event);
          break;
        }
        default: {
          // Remaining union members are the structural file-tree events.
          current.onFileTreeEvent?.(event);
        }
      }
    };

    worker.port.addEventListener('message', handleMessage);

    return () => {
      worker.port.removeEventListener('message', handleMessage);
      worker.port.postMessage({ type: 'unsubscribe', projectId });
    };
  }, [projectId]);
}
