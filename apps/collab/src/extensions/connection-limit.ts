import type { Extension, onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';
import type { Logger } from 'pino';
import { logCollabConnectionDenial } from '../audit-log-denial.js';
import { isPresenceRoom } from '@asciidocollab/shared';

const POLICY_VIOLATION = { code: 1008, reason: 'Policy Violation' };
const RATE_WINDOW_MS = 60_000;

/** Options for {@link ConnectionLimitExtension}. */
export interface ConnectionLimitOptions {
  /** Maximum concurrent connections per authenticated user. */
  maxConnectionsPerUser: number;
  /** Maximum distinct rooms a user may join concurrently. */
  maxRoomsPerUser: number;
  /** Maximum new connections per user within a rolling 60-second window. */
  connectRatePerMin: number;
  /** Pino logger for denial audit. */
  logger: Logger;
  /** Injectable clock (defaults to Date.now) for deterministic tests. */
  now?: () => number;
}

interface UserState {
  connections: number;
  rooms: Map<string, number>;
  connectTimestamps: number[];
}

/**
 * In-app rate limiting and connection/room caps for the public collaboration
 * WebSocket. Wired into the `onConnect`/`onDisconnect` seam after
 * the auth hook, keyed on the authenticated user id it stores on the context. The
 * server listens directly via Hocuspocus (not behind Fastify), so it inherits none
 * of the API's protections — these are enforced here.
 */
export class ConnectionLimitExtension implements Extension {
  private readonly maxConnectionsPerUser: number;
  private readonly maxRoomsPerUser: number;
  private readonly connectRatePerMin: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly users = new Map<string, UserState>();
  // Maps a per-connection socketId → the user AND the room that socket actually reserved. Hocuspocus
  // does NOT preserve the onConnect-mutated `context` into onDisconnect (the same reason server.ts
  // re-looks-up the documentId), so the releasing side cannot rely on context.userId; the socketId is
  // present on both payloads.
  //
  // The documentName is recorded for the same reason. `connections` and the room counters are
  // incremented TOGETHER on every accepted connect, so they may only be decremented together.
  // Releasing whatever room the disconnect payload happens to name breaks that pairing whenever the
  // two disagree: the connection count drains while the room reference stays behind, and the entry —
  // its rate-window timestamps and room slots with it — then lingers until restart. Releasing the
  // room this socket reserved keeps the two counters in step by construction.
  private readonly socketConnections = new Map<string, { userId: string; documentName: string }>();

  /** Creates the extension with the given per-user limits. */
  constructor(options: ConnectionLimitOptions) {
    this.maxConnectionsPerUser = options.maxConnectionsPerUser;
    this.maxRoomsPerUser = options.maxRoomsPerUser;
    this.connectRatePerMin = options.connectRatePerMin;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  private deny(userId: string, documentName: string, reason: string): never {
    logCollabConnectionDenial(this.logger, { actor: userId, resource: documentName, reason });
    throw POLICY_VIOLATION;
  }

  /** Enforces the per-user caps on each new connection; throws (1008) to reject. */
  async onConnect(payload: onConnectPayload): Promise<void> {
    const userId: unknown = payload.context?.userId;
    // Without an authenticated user id there is nothing to key on — the auth hook,
    // which runs first, already rejected unauthenticated connections.
    if (typeof userId !== 'string' || userId.length === 0) return;

    const { documentName } = payload;
    const existing = this.users.get(userId);
    const now = this.now();

    // Evaluate the caps WITHOUT mutating any stored state. A rejected connection must leave no
    // trace: it must not create a lingering per-user entry (memory leak) for a first-time denied
    // user, and a turned-away attempt must not consume rate-window budget.
    const recentTimestamps = (existing?.connectTimestamps ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    const connections = existing?.connections ?? 0;
    const rooms = existing?.rooms ?? new Map<string, number>();

    if (recentTimestamps.length + 1 > this.connectRatePerMin) {
      this.deny(userId, documentName, 'connect_rate_exceeded');
    }

    // Feature 024: presence rooms are exempt from the per-document connection/room caps (a user
    // idling on a project with the tree open must not burn a document slot). The connect-rate limit
    // above still applies; record the accepted timestamp but do NOT count a connection or room, and
    // do NOT register a socketId→user mapping (onDisconnect skips presence too, so nothing leaks).
    if (isPresenceRoom(documentName)) {
      recentTimestamps.push(now);
      this.users.set(userId, { connections, rooms, connectTimestamps: recentTimestamps });
      // Track the socket so onDisconnect can resolve the user and evict an otherwise-empty entry
      // (presence-only users never reach the connection/room cleanup path otherwise).
      this.socketConnections.set(payload.socketId, { userId, documentName });
      return;
    }

    if (connections + 1 > this.maxConnectionsPerUser) {
      this.deny(userId, documentName, 'max_connections_exceeded');
    }
    const isNewRoom = !rooms.has(documentName);
    if (isNewRoom && rooms.size + 1 > this.maxRoomsPerUser) {
      this.deny(userId, documentName, 'max_rooms_exceeded');
    }

    // Accepted: commit the slot, the room, the (accepted-only) rate timestamp, and the
    // socketId→userId mapping used to release the slot on disconnect.
    recentTimestamps.push(now);
    rooms.set(documentName, (rooms.get(documentName) ?? 0) + 1);
    this.users.set(userId, { connections: connections + 1, rooms, connectTimestamps: recentTimestamps });
    this.socketConnections.set(payload.socketId, { userId, documentName });
  }

  /** Releases the connection's slot and room reference. */
  async onDisconnect(payload: onDisconnectPayload): Promise<void> {
    // Resolve the user from the socketId map (set on connect); fall back to context.userId only
    // for callers that still provide it. Without this the slot would never be released.
    const reserved = this.socketConnections.get(payload.socketId);
    const contextUserId = payload.context?.userId;
    const userId =
      reserved?.userId ??
      (typeof contextUserId === 'string' && contextUserId.length > 0 ? contextUserId : undefined);
    if (!userId) return;
    this.socketConnections.delete(payload.socketId);
    const state = this.users.get(userId);
    if (!state) return;

    // Release what this socket RESERVED, not what the disconnect payload names. Falling back to the
    // payload only covers a socket we never recorded (the context.userId path above), which is the
    // one case that can still desynchronise the counters — the guard at the end of this method
    // handles that remnant.
    const documentName = reserved?.documentName ?? payload.documentName;

    // Feature 024: a presence connection was never counted against connections/rooms (see onConnect),
    // so do NOT decrement — just evict the entry if it now holds no document connections/rooms,
    // otherwise a presence-only user's record would linger until restart.
    if (isPresenceRoom(documentName)) {
      this.evictIfEmpty(userId, state);
      return;
    }

    state.connections = Math.max(0, state.connections - 1);
    const roomCount = (state.rooms.get(documentName) ?? 0) - 1;
    if (roomCount <= 0) {
      state.rooms.delete(documentName);
    } else {
      state.rooms.set(documentName, roomCount);
    }

    this.evictIfEmpty(userId, state);
  }

  /**
   * Drops a user's entry once it holds nothing releasable, self-healing a desynchronised state.
   *
   * Every accepted connect increments `connections` and a room counter together, so the healthy
   * invariant is `rooms.size > 0 ⟹ connections > 0`. If `connections` reaches zero with rooms still
   * referenced, the two have drifted apart and nothing can ever release those rooms again — no
   * socket remains to disconnect. Requiring BOTH counters to be zero (as this did) meant such an
   * entry survived until process restart, holding its room slots against the user's own future
   * connections and keeping its rate-window timestamps alive. Treat zero connections as the
   * authority and discard the orphaned references.
   */
  private evictIfEmpty(userId: string, state: UserState): void {
    if (state.connections !== 0) return;
    state.rooms.clear();
    this.users.delete(userId);
  }
}
