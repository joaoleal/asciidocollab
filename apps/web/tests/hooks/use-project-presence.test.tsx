// Tests for apps/web/src/hooks/use-project-presence.ts
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  useProjectPresence,
  type PresenceAwareness,
  type PresenceProvider,
} from '@/hooks/use-project-presence';
import type { AwarenessUser } from '@/lib/collab/awareness-user';

function fakeUser(userId: string, name: string, avatarKey: string | null = null): AwarenessUser {
  return { userId, name, color: '#30bced', colorLight: '#30bced33', avatarKey };
}

interface FakeState {
  user?: AwarenessUser;
  openFileNodeId?: string | null;
  cursorLine?: number;
}

function fakeAwareness(localClientId: number, states: Map<number, FakeState>) {
  const handlers: Array<() => void> = [];
  const awareness = {
    clientID: localClientId,
    getStates: () => states,
    setLocalStateField: jest.fn((field: string, value: unknown) => {
      const self = states.get(localClientId) ?? {};
      states.set(localClientId, { ...self, [field]: value } as FakeState);
    }),
    setLocalState: jest.fn(),
    on: (_event: string, handler: () => void) => { handlers.push(handler); },
    off: (_event: string, handler: () => void) => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    },
    emit: () => { for (const handler of handlers) handler(); },
  };
  return awareness as unknown as PresenceAwareness & { setLocalStateField: jest.Mock; setLocalState: jest.Mock; emit: () => void };
}

function render(options: {
  states: Map<number, FakeState>;
  localClientId: number;
  openFileNodeId: string | null;
  capture?: (document: Y.Doc) => void;
}) {
  const awareness = fakeAwareness(options.localClientId, options.states);
  const provider: PresenceProvider = { awareness, destroy: jest.fn() };
  const createProvider = ({ document }: { document: Y.Doc }) => {
    options.capture?.(document);
    return provider;
  };
  const result = renderHook(() =>
    useProjectPresence({
      projectId: '550e8400-e29b-41d4-a716-446655440000',
      enabled: true,
      user: { userId: 'u-local', name: 'Me' },
      openFileNodeId: options.openFileNodeId,
      createProvider,
    }),
  );
  return { ...result, awareness };
}

describe('useProjectPresence', () => {
  test('groups other users by the file they have open, excluding the local client', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: 'file-a' }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
      [3, { user: fakeUser('u-cy', 'Cy'), openFileNodeId: 'file-b' }],
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: 'file-a' });

    // file-a is open by the local client AND Bea, but only Bea (an *other* user) is reported.
    expect(result.current.get('file-a')?.map((p) => p.name)).toEqual(['Bea']);
    expect(result.current.get('file-b')?.map((p) => p.name)).toEqual(['Cy']);
  });

  test('dedupes the same user open in multiple tabs to a single participant per file', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
      [3, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: null });

    expect(result.current.get('file-a')).toHaveLength(1);
  });

  test('does not report a file as open-by-others when only the local client has it open', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: 'file-a' }],
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: 'file-a' });

    expect(result.current.has('file-a')).toBe(false);
  });

  test('publishes the local user and openFileNodeId, and binds NO shared document content', () => {
    const states = new Map<number, FakeState>([[1, {}]]);
    let capturedDoc: Y.Doc | undefined;
    const { awareness } = render({ states, localClientId: 1, openFileNodeId: 'file-a', capture: (d) => { capturedDoc = d; } });

    expect(awareness.setLocalStateField).toHaveBeenCalledWith('user', expect.objectContaining({ userId: 'u-local' }));
    expect(awareness.setLocalStateField).toHaveBeenCalledWith('openFileNodeId', 'file-a');
    // Awareness-only: the hook must never create a shared Yjs type (document content) on the room doc.
    expect(capturedDoc?.share.size).toBe(0);
  });

  test('clears a file from the map when the peer holding it leaves (awareness change)', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    expect(result.current.has('file-a')).toBe(true);

    act(() => {
      states.delete(2); // Bea disconnects → awareness removes her entry and emits change.
      awareness.emit();
    });
    expect(result.current.has('file-a')).toBe(false);
  });

  test('returns an empty map and does not connect when disabled', () => {
    const createProvider = jest.fn();
    const { result } = renderHook(() =>
      useProjectPresence({ projectId: 'p', enabled: false, user: { userId: 'u', name: 'Me' }, openFileNodeId: null, createProvider }),
    );
    expect(result.current.size).toBe(0);
    expect(createProvider).not.toHaveBeenCalled();
  });

  test('does not connect when no user identity is provided', () => {
    const createProvider = jest.fn();
    const { result } = renderHook(() =>
      useProjectPresence({ projectId: 'p', enabled: true, user: undefined, openFileNodeId: null, createProvider }),
    );
    expect(result.current.size).toBe(0);
    expect(createProvider).not.toHaveBeenCalled();
  });

  test('tolerates a provider with no awareness and still destroys on unmount', () => {
    const provider: PresenceProvider = { awareness: null, destroy: jest.fn() };
    const { result, unmount } = renderHook(() =>
      useProjectPresence({ projectId: 'p', enabled: true, user: { userId: 'u', name: 'Me' }, openFileNodeId: null, createProvider: () => provider }),
    );
    expect(result.current.size).toBe(0);
    unmount();
    expect(provider.destroy).toHaveBeenCalled();
  });

  test('keeps the same map reference when an awareness change does not alter the mapping', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    const first = result.current;
    act(() => { awareness.emit(); }); // identical states → identical mapping
    expect(result.current).toBe(first); // no new Map → no needless tree re-render
  });

  test('updates when another user joins the same file', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    expect(result.current.get('file-a')).toHaveLength(1);
    act(() => { states.set(3, { user: fakeUser('u-cy', 'Cy'), openFileNodeId: 'file-a' }); awareness.emit(); });
    expect(result.current.get('file-a')).toHaveLength(2);
  });

  test('updates when a peer switches to a different file', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    act(() => { states.set(2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-b' }); awareness.emit(); });
    expect(result.current.has('file-a')).toBe(false);
    expect(result.current.has('file-b')).toBe(true);
  });

  test('updates when a peer is renamed', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    act(() => { states.set(2, { user: fakeUser('u-bea', 'Beatrice'), openFileNodeId: 'file-a' }); awareness.emit(); });
    expect(result.current.get('file-a')?.[0].name).toBe('Beatrice');
  });

  test('updates when a peer changes only their avatar', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea', 'initials'), openFileNodeId: 'file-a' }],
    ]);
    const { result, awareness } = render({ states, localClientId: 1, openFileNodeId: null });
    expect(result.current.get('file-a')?.[0].avatarKey).toBe('initials');
    // Only the avatar changes — same user, name, file, cursor — and the marker must still refresh.
    act(() => { states.set(2, { user: fakeUser('u-bea', 'Bea', 'bottts:3'), openFileNodeId: 'file-a' }); awareness.emit(); });
    expect(result.current.get('file-a')?.[0].avatarKey).toBe('bottts:3');
  });

  test('excludes the local user\'s own other tabs (same userId, different client)', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }], // this tab
      [2, { user: fakeUser('u-local', 'Me'), openFileNodeId: 'file-a' }], // same user, another tab
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: null });
    // The viewer's own other tab must NOT mark file-a as "open by others".
    expect(result.current.has('file-a')).toBe(false);
  });

  test('republishes openFileNodeId on reconnect when the provider is re-created (identity change)', () => {
    const created: Array<ReturnType<typeof fakeAwareness>> = [];
    const createProvider = (): PresenceProvider => {
      const clientId = created.length + 1;
      const awareness = fakeAwareness(clientId, new Map<number, FakeState>([[clientId, {}]]));
      created.push(awareness);
      return { awareness, destroy: jest.fn() };
    };
    const { rerender } = renderHook(
      (props: { user: { userId: string; name: string } }) =>
        useProjectPresence({ projectId: 'p', enabled: true, user: props.user, openFileNodeId: 'file-a', createProvider }),
      { initialProps: { user: { userId: 'u', name: 'Me' } } },
    );
    // Identity change re-runs the connect effect → a fresh provider/awareness is created.
    rerender({ user: { userId: 'u', name: 'Me Renamed' } });

    const latest = created.at(-1);
    expect(created.length).toBeGreaterThan(1);
    expect(latest?.setLocalStateField).toHaveBeenCalledWith('openFileNodeId', 'file-a');
  });

  test('republishes openFileNodeId when the viewer opens a different file', () => {
    const states = new Map<number, FakeState>([[1, {}]]);
    const awareness = fakeAwareness(1, states);
    const provider: PresenceProvider = { awareness, destroy: jest.fn() };
    const baseProperties = { projectId: 'p', enabled: true, user: { userId: 'u-local', name: 'Me' }, createProvider: () => provider };
    const { rerender } = renderHook((props: { openFileNodeId: string | null }) => useProjectPresence({ ...baseProperties, openFileNodeId: props.openFileNodeId }), {
      initialProps: { openFileNodeId: 'file-a' as string | null },
    });
    rerender({ openFileNodeId: 'file-b' });
    expect(awareness.setLocalStateField).toHaveBeenCalledWith('openFileNodeId', 'file-b');
  });
});

// cursorLine publish + aggregation (feature 032)
describe('useProjectPresence — cursorLine (feature 032)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('publishes cursorLine to awareness after debounce when given a cursor line', async () => {
    const states = new Map<number, FakeState>([[1, {}]]);
    const awareness = fakeAwareness(1, states);
    const provider: PresenceProvider = { awareness, destroy: jest.fn() };
    const baseProperties = { projectId: 'p', enabled: true, user: { userId: 'u', name: 'Me' }, openFileNodeId: 'file-a', createProvider: () => provider };

    const { rerender } = renderHook(
      (props: { cursorLine: number | null }) => useProjectPresence({ ...baseProperties, cursorLine: props.cursorLine }),
      { initialProps: { cursorLine: null as number | null } },
    );
    rerender({ cursorLine: 10 });

    // Not yet (debounced)
    expect(awareness.setLocalStateField).not.toHaveBeenCalledWith('cursorLine', 10);

    // After debounce
    act(() => { jest.advanceTimersByTime(400); });
    expect(awareness.setLocalStateField).toHaveBeenCalledWith('cursorLine', 10);
  });

  test('aggregation includes cursorLine when peer has one', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a', cursorLine: 7 }],
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: null });
    const bea = result.current.get('file-a')?.[0];
    expect(bea).toBeDefined();
    expect((bea as { cursorLine?: number }).cursorLine).toBe(7);
  });

  test('older client without cursorLine still aggregates at file level without crash', () => {
    const states = new Map<number, FakeState>([
      [1, { user: fakeUser('u-local', 'Me'), openFileNodeId: null }],
      [2, { user: fakeUser('u-bea', 'Bea'), openFileNodeId: 'file-a' }], // no cursorLine
    ]);
    const { result } = render({ states, localClientId: 1, openFileNodeId: null });
    expect(result.current.get('file-a')).toHaveLength(1);
    // cursorLine may be absent — no crash
    const bea = result.current.get('file-a')?.[0];
    expect(bea).toBeDefined();
  });
});
