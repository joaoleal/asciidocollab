import { Server } from '@hocuspocus/server';
import type {
  Extension,
  onConnectPayload,
  onDisconnectPayload,
  beforeHandleMessagePayload,
} from '@hocuspocus/server';
import type { SystemSettingRepository, DocumentRepository } from '@asciidocollab/domain';
import { YjsStateId, ProjectId, DocumentId } from '@asciidocollab/domain';
import type { Result } from '@asciidocollab/domain';
import { PRESENCE_ROOM_PREFIX, isPresenceRoom, parseContentRoom } from '@asciidocollab/shared';
import pino from 'pino';

const defaultLogger = pino({ redact: ['req.headers.cookie', 'req.headers.Cookie'] });

/** The single document lookup the session-lifecycle hooks need (ISP: narrower than DocumentRepository). */
export type DocumentByYjsStateLookup = Pick<DocumentRepository, 'findByYjsStateId'>;

const COLLAB_WRITEBACK_INTERVAL_KEY = 'collaboration.writeback_interval_seconds';
const COLLAB_WRITEBACK_INTERVAL_DEFAULT = 30;

/** Callbacks invoked when the first client joins or the last client leaves a room. */
export interface SessionCallbacks {
  /**
   * Called when the first client connects to a room.
   *
   * @param projectId - The project that owns the document.
   * @param documentId - The document being opened for collaboration.
   * @returns Result indicating success or failure.
   */
  onRoomOpen(projectId: ProjectId, documentId: DocumentId): Promise<Result<void, Error>>;
  /**
   * Called when the last client disconnects from a room.
   *
   * @param projectId - The project that owns the document.
   * @param documentId - The document being closed.
   * @returns Result indicating success or failure.
   */
  onRoomClose(projectId: ProjectId, documentId: DocumentId): Promise<Result<void, Error>>;
}

/** WebSocket close code for an over-limit message (RFC 6455 "Message Too Big"). */
const MESSAGE_TOO_BIG = { code: 1009, reason: 'Message Too Big' };

/**
 * Builds a `beforeHandleMessage` guard that rejects an inbound
 * collaboration message larger than `maxPayloadBytes`, closing the connection
 * (code 1009) without crashing the server.
 */
export function createMaxPayloadGuard(maxPayloadBytes: number) {
  return async (payload: beforeHandleMessagePayload): Promise<void> => {
    if (payload.update.byteLength > maxPayloadBytes) {
      throw MESSAGE_TOO_BIG;
    }
  };
}

/** Parses a presence room name (`presence/<projectId>`) into its typed `ProjectId`. */
export function parsePresenceRoom(documentName: string) {
  if (!isPresenceRoom(documentName)) {
    throw new Error(`Invalid presence room name (expected "presence/<projectId>"): ${documentName}`);
  }
  return { projectId: ProjectId.create(documentName.slice(PRESENCE_ROOM_PREFIX.length)) };
}

/** Parses a Hocuspocus room name of the form `<projectId>/<yjsStateId>` into typed value objects. */
export function parseRoomName(documentName: string) {
  // Fail clearly on a malformed name rather than fabricating ids from slice(0, -1)/slice(0).
  const parsed = parseContentRoom(documentName);
  if (!parsed) {
    throw new Error(`Invalid room name (expected "<projectId>/<yjsStateId>"): ${documentName}`);
  }
  return {
    projectId: ProjectId.create(parsed.projectId),
    yjsStateId: YjsStateId.create(parsed.yjsStateId),
  };
}

/** Creates and returns a configured Hocuspocus server instance. */
export async function createCollabServer(
  config: { port: number; maxPayloadBytes?: number; logger?: pino.Logger },
  extensions: Extension[],
  systemSettingRepo: SystemSettingRepository,
  sessionCallbacks?: SessionCallbacks,
  documentRepository?: DocumentByYjsStateLookup,
): Promise<Server> {
  // Inject the composition-root logger so session-hook logs share its redaction config; fall back
  // to a module default for callers (e.g. tests) that do not supply one.
  const logger = config.logger ?? defaultLogger;
  const intervalString = await systemSettingRepo.get(COLLAB_WRITEBACK_INTERVAL_KEY);
  const intervalSeconds = intervalString
    ? Number.parseInt(intervalString, 10)
    : COLLAB_WRITEBACK_INTERVAL_DEFAULT;
  const maxDebounce = intervalSeconds * 1000;

  const onConnect = sessionCallbacks && documentRepository
    ? async (payload: onConnectPayload) => {
        // Feature 024: presence rooms carry no document and have no CollaborationSession lifecycle —
        // skip the document lookup + session open entirely (parseRoomName would also reject them).
        if (isPresenceRoom(payload.documentName)) return;
        // This hook creates the CollaborationSession row behind the active-session edit lock
        // (spec-018): while a room is open, REST PUT /content and delete on the file are
        // blocked. It therefore REJECTS (throws) on ANY failure rather than letting a live room
        // exist without its session row — an untracked-but-live room would let a concurrent REST
        // write bypass the lock and clobber live edits, AND would mismatch onDisconnect's
        // connection counting. onRoomOpen is an idempotent upsert, so calling it on every connect
        // is safe and avoids the two-simultaneous-first-connections race.
        //
        // Trade-off: this hook runs AFTER ConnectionLimitExtension (which has already counted the
        // connection) and Hocuspocus fires no onDisconnect for a connection rejected in onConnect,
        // so a rejection here leaks that user's ConnectionLimit accounting (connection + room +
        // socketUsers entry) until the next restart. Likewise, if the socket dies AFTER a
        // successful onConnect but before Hocuspocus finishes setup, no onDisconnect fires and the
        // session row stays open until restart (closeAll). Both are accepted, restart-recoverable
        // costs of the best-effort in-memory ledger — see plan.md "ConnectionLimitExtension is a
        // best-effort in-memory ledger" for the reconciliation follow-up that would self-heal them.
        try {
          const { projectId, yjsStateId } = parseRoomName(payload.documentName);
          const document = await documentRepository.findByYjsStateId(yjsStateId);
          if (!document) {
            logger.warn({ documentName: payload.documentName }, 'Document not found for room; rejecting connection');
            throw new Error('Document not found');
          }
          const result = await sessionCallbacks.onRoomOpen(projectId, document.id);
          if (!result.success) {
            logger.error({ err: result.error, documentName: payload.documentName }, 'Failed to open collaboration session; rejecting connection to preserve the edit lock');
            throw result.error;
          }
          // Best-effort fast path: stash the documentId so onDisconnect can skip a DB lookup IF the
          // context is preserved. Hocuspocus does NOT reliably carry the onConnect-mutated context
          // into onDisconnect, so onDisconnect must (and does) fall back to a yjsStateId lookup.
          payload.context.documentId = document.id;
        } catch (error) {
          logger.error({ err: error, documentName: payload.documentName }, 'Error in onConnect; rejecting connection');
          throw error;
        }
      }
    : undefined;

  const onDisconnect = sessionCallbacks && documentRepository
    ? async (payload: onDisconnectPayload) => {
        // Feature 024: presence rooms have no CollaborationSession to close.
        if (isPresenceRoom(payload.documentName)) return;
        if (payload.clientsCount !== 0) return;

        try {
          const { projectId, yjsStateId } = parseRoomName(payload.documentName);
          // Resolve the documentId. Hocuspocus does NOT preserve the per-connection `context`
          // mutated in onConnect across to onDisconnect, so `context.documentId` is unreliable
          // (it is honoured as a fast path when present, e.g. in tests); otherwise look it up by
          // the room's yjsStateId. Without this, the session row would never be deleted and the
          // file would become permanently undeletable (an active-session 409).
          let documentId: DocumentId | undefined = payload.context?.documentId;
          if (!documentId) {
            const document = await documentRepository.findByYjsStateId(yjsStateId);
            documentId = document?.id;
          }
          if (!documentId) return;
          // Re-check connection count after the async lookup above — a new client may have
          // joined and called onRoomOpen while we were awaiting. If so, do not close the session.
          if (payload.document.getConnectionsCount() > 0) return;
          // Flush the pending write-back BEFORE the session row goes away.
          //
          // GetFileNodeContentUseCase reads a document's LIVE text only while its CollaborationSession
          // row exists, and otherwise trusts the file-store projection on the stated grounds that "a
          // dormant document's file store is already current (the collab server writes back on
          // disconnect)". But Hocuspocus runs that write-back only AFTER this hook resolves — it awaits
          // the onDisconnect hooks and only then invokes the onClose callback that executes the
          // debounced onStoreDocument. Closing the session first therefore opens a window in which the
          // row is gone AND the projection still holds pre-edit text, so every reader that samples
          // `GET /content` inside it gets stale content — and the web client caches file content
          // write-once (include-tree-fetcher skips any id already cached), so a single stale sample
          // sticks for the rest of the session. That is what made a child file's preview keep showing a
          // parent attribute's old value after the author edited it and switched files.
          //
          // `immediately: true` cancels the pending debounce and runs the same store hooks now,
          // serialised on the document's save mutex; afterwards Hocuspocus's own onClose sees nothing
          // debounced and takes its "already stored" branch, so the document is not stored twice.
          //
          // Failures are absorbed deliberately: a stuck store must never keep the session row alive,
          // which would 409 REST writes and make the file undeletable.
          try {
            await payload.instance.storeDocumentHooks(
              payload.document,
              {
                clientsCount: 0,
                document: payload.document,
                documentName: payload.documentName,
                instance: payload.instance,
                lastContext: payload.context,
                lastTransactionOrigin: null,
              },
              true,
            );
          } catch (error) {
            logger.error(
              { err: error, documentName: payload.documentName },
              'Failed to flush the write-back before closing the collaboration session; the file store may lag',
            );
          }
          const result = await sessionCallbacks.onRoomClose(projectId, documentId);
          if (!result.success) {
            logger.error({ err: result.error, documentName: payload.documentName }, 'Failed to close collaboration session');
          }
        } catch (error) {
          logger.error({ err: error, documentName: payload.documentName }, 'Error in onDisconnect');
        }
      }
    : undefined;

  const beforeHandleMessage = config.maxPayloadBytes
    ? createMaxPayloadGuard(config.maxPayloadBytes)
    : undefined;

  // Hocuspocus v4: `Server` is a class wrapping the WS server + a Hocuspocus instance. The v2
  // static `Server.configure({...})` is replaced by `new Server({...})`; `ServerConfiguration`
  // extends the Hocuspocus `Configuration`, so the hooks/extensions/debounce config still apply.
  const server = new Server({
    port: config.port,
    debounce: 2000,
    maxDebounce,
    extensions,
    ...(onConnect && { onConnect }),
    ...(onDisconnect && { onDisconnect }),
    ...(beforeHandleMessage && { beforeHandleMessage }),
  });

  return server;
}
