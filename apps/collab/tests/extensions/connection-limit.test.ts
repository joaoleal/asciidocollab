import { ConnectionLimitExtension } from '../../src/extensions/connection-limit';
import type { onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';

const ROOM_A = 'p1/doc-a';
const ROOM_B = 'p1/doc-b';
const ROOM_C = 'p1/doc-c';

function connectPayload(userId: string, socketId = 'sock', documentName = ROOM_A): onConnectPayload {
  return { context: { userId }, documentName, socketId } as unknown as onConnectPayload;
}

// Real Hocuspocus does NOT carry the onConnect-mutated context into onDisconnect (see server.ts).
// `includeUserId` lets a test assert the realistic case where context.userId is absent on disconnect.
function disconnectPayload(
  socketId = 'sock',
  documentName = ROOM_A,
  options: { userId?: string } = {},
): onDisconnectPayload {
  const context = options.userId ? { userId: options.userId } : {};
  return { context, documentName, socketId } as unknown as onDisconnectPayload;
}

function makeExtension(
  limits: { maxConnectionsPerUser?: number; maxRoomsPerUser?: number; connectRatePerMin?: number },
  now: () => number = () => 0,
) {
  return new ConnectionLimitExtension({
    maxConnectionsPerUser: limits.maxConnectionsPerUser ?? 100,
    maxRoomsPerUser: limits.maxRoomsPerUser ?? 100,
    connectRatePerMin: limits.connectRatePerMin ?? 1000,
    logger: { warn: jest.fn(), error: jest.fn() } as never,
    now,
  });
}

interface InternalUserState {
  connections: number;
  rooms: Map<string, number>;
  connectTimestamps: number[];
}

// Reads the extension's per-user bookkeeping so eviction (no lingering entries) and the exact
// per-counter arithmetic can be asserted, not just the pass/deny outcome.
function readUsers(extension: ConnectionLimitExtension): Map<string, InternalUserState> {
  return (extension as unknown as { users: Map<string, InternalUserState> }).users;
}

// Same as makeExtension, but hands back the logger mock so the denial audit (actor/resource/reason)
// can be asserted exactly.
function makeLoggedExtension(
  limits: { maxConnectionsPerUser?: number; maxRoomsPerUser?: number; connectRatePerMin?: number },
  now: () => number = () => 0,
) {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const extension = new ConnectionLimitExtension({
    maxConnectionsPerUser: limits.maxConnectionsPerUser ?? 100,
    maxRoomsPerUser: limits.maxRoomsPerUser ?? 100,
    connectRatePerMin: limits.connectRatePerMin ?? 1000,
    logger: logger as never,
    now,
  });
  return { extension, logger };
}

// Per-user connection, room, and connect-rate caps.
describe('ConnectionLimitExtension', () => {
  it('accepts connections within all limits', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 3 });
    await expect(extension.onConnect(connectPayload('u1', 's1'))).resolves.toBeUndefined();
    await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
  });

  it('rejects (1008) when MAX_CONNECTIONS_PER_USER is exceeded', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 2 });
    await extension.onConnect(connectPayload('u1', 's1'));
    await extension.onConnect(connectPayload('u1', 's2'));
    await expect(extension.onConnect(connectPayload('u1', 's3'))).rejects.toMatchObject({ code: 1008 });
  });

  it('rejects (1008) when MAX_ROOMS_PER_USER is exceeded', async () => {
    const extension = makeExtension({ maxRoomsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
    await expect(extension.onConnect(connectPayload('u1', 's2', ROOM_B))).rejects.toMatchObject({ code: 1008 });
  });

  it('rejects (1008) when CONNECT_RATE_PER_MIN is exceeded within the window', async () => {
    const extension = makeExtension({ connectRatePerMin: 2 }, () => 1000);
    await extension.onConnect(connectPayload('u1', 's1'));
    await extension.onConnect(connectPayload('u1', 's2'));
    await expect(extension.onConnect(connectPayload('u1', 's3'))).rejects.toMatchObject({ code: 1008 });
  });

  it('prunes the rate window so old attempts no longer count', async () => {
    let clock = 0;
    const extension = makeExtension({ connectRatePerMin: 1 }, () => clock);
    await extension.onConnect(connectPayload('u1', 's1'));
    clock = 61_000; // > 60s later
    await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
  });

  it('frees a connection slot on disconnect', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1'));
    await extension.onDisconnect(disconnectPayload('s1'));
    await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
  });

  // Regression: real Hocuspocus delivers onDisconnect WITHOUT the onConnect-mutated context
  // (server.ts works around the same loss for documentId). The slot must still be released —
  // keyed on the per-connection socketId — or the user is eventually permanently locked out.
  it('frees the slot on disconnect even when the disconnect context lacks userId', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1'));
    await extension.onDisconnect(disconnectPayload('s1')); // context = {} (no userId)
    await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
  });

  it('does not leak room slots across repeated open/close cycles when context lacks userId', async () => {
    const extension = makeExtension({ maxRoomsPerUser: 1 });
    for (let index = 0; index < 5; index += 1) {
      await extension.onConnect(connectPayload('u1', `s${index}`, ROOM_A));
      await extension.onDisconnect(disconnectPayload(`s${index}`, ROOM_A)); // no userId in context
    }
    // After 5 clean cycles the single room slot must be free again.
    await expect(extension.onConnect(connectPayload('u1', 's-final', ROOM_B))).resolves.toBeUndefined();
  });

  it('frees a room slot when the last connection to that room disconnects', async () => {
    const extension = makeExtension({ maxRoomsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
    await extension.onDisconnect(disconnectPayload('s1', ROOM_A));
    await expect(extension.onConnect(connectPayload('u1', 's2', ROOM_B))).resolves.toBeUndefined();
  });

  it('tracks limits independently per user', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1'));
    await expect(extension.onConnect(connectPayload('u2', 's2'))).resolves.toBeUndefined();
  });

  it('does not limit when the connection has no authenticated user id', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 1 });
    const noUser = { context: {}, documentName: ROOM_A, socketId: 's1' } as unknown as onConnectPayload;
    await expect(extension.onConnect(noUser)).resolves.toBeUndefined();
    await expect(extension.onConnect({ ...noUser, socketId: 's2' } as onConnectPayload)).resolves.toBeUndefined();
  });

  // A REJECTED connection must leave no trace: no lingering per-user state (memory leak) and no
  // rate-budget consumed by attempts that were turned away.
  it('leaves no lingering user state when a user is denied on their first connection', async () => {
    const extension = makeExtension({ maxConnectionsPerUser: 0 });
    await expect(extension.onConnect(connectPayload('u1', 's1'))).rejects.toMatchObject({ code: 1008 });
    const users = (extension as unknown as { users: Map<string, unknown> }).users;
    expect(users.has('u1')).toBe(false);
    expect(users.size).toBe(0);
  });

  it('does not count cap-denied attempts toward the connect-rate window', async () => {
    // maxConnections=1, rate=2: one accepted connect, then over-cap attempts. Those denied attempts
    // must NOT consume rate budget — after disconnecting, a fresh connect must succeed (it would be
    // wrongly rate-limited if denials counted toward the window).
    const extension = makeExtension({ maxConnectionsPerUser: 1, connectRatePerMin: 2 });
    await extension.onConnect(connectPayload('u1', 's1'));
    await expect(extension.onConnect(connectPayload('u1', 's2'))).rejects.toMatchObject({ code: 1008 });
    await expect(extension.onConnect(connectPayload('u1', 's3'))).rejects.toMatchObject({ code: 1008 });
    await extension.onDisconnect(disconnectPayload('s1'));
    await expect(extension.onConnect(connectPayload('u1', 's4'))).resolves.toBeUndefined();
  });

  // Multiple connections to the same room: disconnecting one must decrement the room count, not
  // delete the room entry — only the last disconnect for that room should free the slot.
  it('decrements the room connection count without freeing the slot when multiple connections share a room', async () => {
    const extension = makeExtension({ maxRoomsPerUser: 1 });
    await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
    await extension.onConnect(connectPayload('u1', 's2', ROOM_A));
    // Disconnect one — ROOM_A still held by s2, so maxRooms=1 must still block ROOM_B
    await extension.onDisconnect(disconnectPayload('s1', ROOM_A));
    await expect(extension.onConnect(connectPayload('u1', 's3', ROOM_B))).rejects.toMatchObject({ code: 1008 });
    // Disconnect the second — now ROOM_A is fully released
    await extension.onDisconnect(disconnectPayload('s2', ROOM_A));
    await expect(extension.onConnect(connectPayload('u1', 's4', ROOM_B))).resolves.toBeUndefined();
  });

  // Feature 024: presence rooms are exempt from the per-document caps but still rate-limited.
  describe('presence rooms', () => {
    const PRESENCE = 'presence/550e8400-e29b-41d4-a716-446655440001';

    it('does not count a presence connection against the per-connection cap', async () => {
      const extension = makeExtension({ maxConnectionsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A)); // consumes the only doc slot
      await expect(extension.onConnect(connectPayload('u1', 's2', PRESENCE))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's3', ROOM_B))).rejects.toMatchObject({ code: 1008 });
    });

    it('does not count a presence connection against the per-room cap', async () => {
      const extension = makeExtension({ maxRoomsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await expect(extension.onConnect(connectPayload('u1', 's2', PRESENCE))).resolves.toBeUndefined();
    });

    it('still applies the connect-rate limit to presence connections', async () => {
      const extension = makeExtension({ connectRatePerMin: 1 }, () => 1000);
      await extension.onConnect(connectPayload('u1', 's1', PRESENCE));
      await expect(extension.onConnect(connectPayload('u1', 's2', PRESENCE))).rejects.toMatchObject({ code: 1008 });
    });

    it('does not count a presence disconnect against an existing document connection', async () => {
      const extension = makeExtension({ maxConnectionsPerUser: 2 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await expect(extension.onDisconnect(disconnectPayload('s2', PRESENCE))).resolves.toBeUndefined();
      await extension.onConnect(connectPayload('u1', 's3', ROOM_A));
      await expect(extension.onConnect(connectPayload('u1', 's4', ROOM_A))).rejects.toMatchObject({ code: 1008 });
    });

    it('leaves no lingering users entry after a presence connect + disconnect', async () => {
      const extension = makeExtension({});
      await extension.onConnect(connectPayload('u1', 's1', PRESENCE));
      await extension.onDisconnect(disconnectPayload('s1', PRESENCE));
      const users = (extension as unknown as { users: Map<string, unknown> }).users;
      expect(users.has('u1')).toBe(false);
    });

    it('keeps the user entry when a presence connection closes but a document connection remains', async () => {
      const extension = makeExtension({});
      await extension.onConnect(connectPayload('u1', 'doc', ROOM_A));
      await extension.onConnect(connectPayload('u1', 'pres', PRESENCE));
      await extension.onDisconnect(disconnectPayload('pres', PRESENCE));
      const users = (extension as unknown as { users: Map<string, { connections: number }> }).users;
      expect(users.get('u1')?.connections).toBe(1);
    });

    // REWRITTEN when the eviction leak was fixed. This test previously asserted the OPPOSITE — that
    // the entry survived with `rooms.get(ROOM_A) === 2` — which encoded the leak as intended
    // behaviour. A disconnect naming a room the socket never joined no longer strands a room
    // reference, because the release now uses the room the socket RESERVED at connect time.
    it('evicts the user entry when a mismatched disconnect drains the connections (presence)', async () => {
      const extension = makeExtension({});
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onConnect(connectPayload('u1', 's2', ROOM_A));
      // Both disconnects report ROOM_B, a room the user never joined. The release ignores that and
      // frees ROOM_A — what s1 and s2 actually reserved — so the counters stay in step.
      await extension.onDisconnect(disconnectPayload('s1', ROOM_B));
      await extension.onDisconnect(disconnectPayload('s2', ROOM_B));

      expect(readUsers(extension).has('u1')).toBe(false);

      // A later presence connect/disconnect on the same user must also leave nothing behind.
      await extension.onConnect(connectPayload('u1', 'p1', PRESENCE));
      await extension.onDisconnect(disconnectPayload('p1', PRESENCE));

      expect(readUsers(extension).has('u1')).toBe(false);
    });
  });

  // Exact denial reasons, limit boundaries from both sides, and the disconnect fallback paths.
  describe('denial reasons, boundaries, and disconnect resolution', () => {
    it('denies an over-rate connect with reason connect_rate_exceeded and close code 1008', async () => {
      const { extension, logger } = makeLoggedExtension({ connectRatePerMin: 1 }, () => 1000);
      await extension.onConnect(connectPayload('u1', 's1'));

      await expect(extension.onConnect(connectPayload('u1', 's2'))).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        { actor: 'u1', resource: ROOM_A, reason: 'connect_rate_exceeded' },
        'collab connection rejected',
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('denies an over-cap connect with reason max_connections_exceeded and close code 1008', async () => {
      const { extension, logger } = makeLoggedExtension({ maxConnectionsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1'));

      await expect(extension.onConnect(connectPayload('u1', 's2'))).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        { actor: 'u1', resource: ROOM_A, reason: 'max_connections_exceeded' },
        'collab connection rejected',
      );
    });

    it('denies an over-room-cap connect with reason max_rooms_exceeded and close code 1008', async () => {
      const { extension, logger } = makeLoggedExtension({ maxRoomsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));

      await expect(extension.onConnect(connectPayload('u1', 's2', ROOM_B))).rejects.toEqual({
        code: 1008,
        reason: 'Policy Violation',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        { actor: 'u1', resource: ROOM_B, reason: 'max_rooms_exceeded' },
        'collab connection rejected',
      );
    });

    // Boundary, both sides: the Nth connection is allowed, the (N+1)th is denied.
    it('allows exactly maxConnectionsPerUser connections and denies the next one', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 2 });
      await expect(extension.onConnect(connectPayload('u1', 's1'))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's3'))).rejects.toMatchObject({ code: 1008 });
    });

    it('allows exactly maxRoomsPerUser rooms and denies the next distinct room', async () => {
      const { extension } = makeLoggedExtension({ maxRoomsPerUser: 2 });
      await expect(extension.onConnect(connectPayload('u1', 's1', ROOM_A))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's2', ROOM_B))).resolves.toBeUndefined();
      // Re-joining a room already held is not a new room and stays allowed.
      await expect(extension.onConnect(connectPayload('u1', 's3', ROOM_A))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's4', 'p1/doc-c'))).rejects.toMatchObject({ code: 1008 });
    });

    it('allows exactly connectRatePerMin connects in the window and denies the next one', async () => {
      const { extension } = makeLoggedExtension({ connectRatePerMin: 2 }, () => 5000);
      await expect(extension.onConnect(connectPayload('u1', 's1'))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's3'))).rejects.toMatchObject({ code: 1008 });
    });

    // Rate-window boundary, both sides. The window is `now - t < 60_000`: a timestamp exactly
    // 60_000 ms old has left the window, one 59_999 ms old has not.
    it('still counts an attempt 59_999 ms old but drops one exactly 60_000 ms old', async () => {
      let clock = 0;
      const { extension } = makeLoggedExtension({ connectRatePerMin: 1 }, () => clock);
      await extension.onConnect(connectPayload('u1', 's1'));

      clock = 59_999;
      await expect(extension.onConnect(connectPayload('u1', 's2'))).rejects.toMatchObject({ code: 1008 });

      clock = 60_000;
      await expect(extension.onConnect(connectPayload('u1', 's3'))).resolves.toBeUndefined();
    });

    // The window measures elapsed time (now - t), not a sum: two connects late in the clock's life
    // are 10 s apart and must still collide with a 1/min limit.
    it('measures the window as elapsed time, so two connects 10 s apart at a high clock still collide', async () => {
      let clock = 40_000;
      const { extension } = makeLoggedExtension({ connectRatePerMin: 1 }, () => clock);
      await extension.onConnect(connectPayload('u1', 's1'));

      clock = 50_000;
      await expect(extension.onConnect(connectPayload('u1', 's2'))).rejects.toMatchObject({ code: 1008 });
    });

    // An empty-string user id is not an authenticated user: it must fall through the guard
    // untouched even when the caps are set to zero.
    it('does not limit (or record) a connection whose user id is the empty string', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 0, connectRatePerMin: 0 });
      await expect(extension.onConnect(connectPayload('', 's1'))).resolves.toBeUndefined();
      expect(readUsers(extension).size).toBe(0);
    });

    it('does not limit a connection payload that carries no context at all', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 0 });
      const noContext = { documentName: ROOM_A, socketId: 's1' } as unknown as onConnectPayload;
      await expect(extension.onConnect(noContext)).resolves.toBeUndefined();
      expect(readUsers(extension).size).toBe(0);
    });

    it('releases the slot for a disconnect payload that carries no context at all', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1'));
      const noContext = { documentName: ROOM_A, socketId: 's1' } as unknown as onDisconnectPayload;

      await expect(extension.onDisconnect(noContext)).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
    });

    // Fallback path: the socketId was never mapped (for example a disconnect for a connection the
    // extension never saw), so the user must be resolved from context.userId instead.
    it('falls back to a non-empty context.userId when the socketId is unknown', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1'));

      await extension.onDisconnect(disconnectPayload('never-mapped', ROOM_A, { userId: 'u1' }));

      expect(readUsers(extension).has('u1')).toBe(false);
      await expect(extension.onConnect(connectPayload('u1', 's2'))).resolves.toBeUndefined();
    });

    it('ignores a disconnect for a user that holds no state', async () => {
      const { extension } = makeLoggedExtension({});
      await expect(
        extension.onDisconnect(disconnectPayload('never-mapped', ROOM_A, { userId: 'ghost' })),
      ).resolves.toBeUndefined();
      await expect(
        extension.onDisconnect(disconnectPayload('never-mapped', 'presence/p1', { userId: 'ghost' })),
      ).resolves.toBeUndefined();
      expect(readUsers(extension).size).toBe(0);
    });

    // Zero connections is the authority: the entry goes even if a room reference is still held,
    // since with no socket left nothing could ever release it (see `evictIfEmpty`).
    it('evicts the user entry once the last document connection and room are released', async () => {
      const { extension } = makeLoggedExtension({});
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onDisconnect(disconnectPayload('s1', ROOM_A));
      expect(readUsers(extension).has('u1')).toBe(false);
    });

    it('keeps the entry and decrements by exactly one when a second connection remains', async () => {
      const { extension } = makeLoggedExtension({ maxConnectionsPerUser: 2 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onConnect(connectPayload('u1', 's2', ROOM_A));
      await extension.onDisconnect(disconnectPayload('s1', ROOM_A));

      const state = readUsers(extension).get('u1');
      expect(state?.connections).toBe(1);
      expect(state?.rooms.get(ROOM_A)).toBe(1);
      // Exactly one slot came free: the next connect fits, the one after it does not.
      await expect(extension.onConnect(connectPayload('u1', 's3', ROOM_A))).resolves.toBeUndefined();
      await expect(extension.onConnect(connectPayload('u1', 's4', ROOM_A))).rejects.toMatchObject({ code: 1008 });
    });

    // REWRITTEN when the eviction leak was fixed. This previously asserted the entry SURVIVED with
    // `rooms.get(ROOM_A) === 2` — the unbounded-memory path, pinned as if it were the contract.
    it('releases the room the socket reserved, not the one the disconnect names', async () => {
      const { extension } = makeLoggedExtension({});
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onConnect(connectPayload('u1', 's2', ROOM_A));

      // One mismatched disconnect: ROOM_A must drop to a single reference, not stay at 2.
      await extension.onDisconnect(disconnectPayload('s1', ROOM_B));
      const midway = readUsers(extension).get('u1');
      expect(midway?.connections).toBe(1);
      expect(midway?.rooms.get(ROOM_A)).toBe(1);

      // The second drains it: no stranded room reference, so the entry goes rather than lingering
      // until restart with its room slots and rate-window timestamps still held.
      await extension.onDisconnect(disconnectPayload('s2', ROOM_B));
      expect(readUsers(extension).has('u1')).toBe(false);
    });

    // Guards the `roomCount <= 0` branch itself. A released room must be REMOVED from the map, not
    // left behind holding a zero count: `rooms.size` is what the per-user room cap is measured
    // against, so a zero-count leftover silently consumes a slot. This needs a user who still holds
    // another room — with only one room the entry is evicted wholesale, which masks the difference.
    it('removes a fully released room from the cap rather than leaving a zero count', async () => {
      const { extension } = makeLoggedExtension({ maxRoomsPerUser: 2, maxConnectionsPerUser: 5 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onConnect(connectPayload('u1', 's2', ROOM_B));

      // Release ROOM_A entirely; ROOM_B keeps the entry alive so no eviction can hide the result.
      await extension.onDisconnect(disconnectPayload('s1', ROOM_A));

      const state = readUsers(extension).get('u1');
      expect(state?.rooms.has(ROOM_A)).toBe(false);
      expect(state?.rooms.size).toBe(1);

      // The freed slot is genuinely reusable: a third room now fits under the cap of 2.
      await expect(extension.onConnect(connectPayload('u1', 's3', ROOM_C))).resolves.toBeUndefined();
    });

    // The room-slot half of the same leak: a stranded reference used to count against the user's own
    // future connections, so a user could be locked out of a room cap they were no longer using.
    it('frees the room slot for reuse after mismatched disconnects', async () => {
      const { extension } = makeLoggedExtension({ maxRoomsPerUser: 1 });
      await extension.onConnect(connectPayload('u1', 's1', ROOM_A));
      await extension.onDisconnect(disconnectPayload('s1', ROOM_B));

      // With ROOM_A stranded, this second connect used to be denied max_rooms_exceeded.
      await expect(extension.onConnect(connectPayload('u1', 's2', ROOM_B))).resolves.toBeUndefined();
    });
  });
});
