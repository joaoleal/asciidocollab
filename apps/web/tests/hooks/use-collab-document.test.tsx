import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  useCollabDocument,
  type CollabProvider,
  type CreateCollabProvider,
} from '@/hooks/use-collab-document';
import { COLLAB_SYNC_TIMEOUT_MS } from '@/lib/editor-config';

// Mock the real provider so the default factory (used when no `createProvider` is
// injected) can be constructed without opening a WebSocket. This exercises
// `defaultCreateProvider` and the `options.createProvider ?? defaultCreateProvider`
// fallback in the hook.
const hocuspocusConstructor = jest.fn();
jest.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    awareness = { setLocalState: jest.fn(), setLocalStateField: jest.fn() };
    on = jest.fn();
    off = jest.fn();
    destroy = jest.fn();
    constructor(arguments_: unknown) {
      hocuspocusConstructor(arguments_);
    }
  },
}));

/** A minimal driveable fake of HocuspocusProvider for the hook's event contract. */
class FakeProvider implements CollabProvider {
  awareness = { setLocalState: jest.fn(), setLocalStateField: jest.fn() } as unknown as CollabProvider['awareness'];
  destroy = jest.fn();
  document: Y.Doc;
  name: string;
  url: string;
  private handlers: Record<string, Array<(payload?: unknown) => void>> = {};

  constructor(arguments_: { url: string; name: string; document: Y.Doc }) {
    this.url = arguments_.url;
    this.name = arguments_.name;
    this.document = arguments_.document;
  }

  on(event: string, handler: (payload?: unknown) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }

  off(event: string, handler: (payload?: unknown) => void): void {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers[event] ?? []) handler(payload);
  }
}

function setup(enabled = true) {
  let provider: FakeProvider | undefined;
  const createProvider: CreateCollabProvider = (arguments_) => {
    provider = new FakeProvider(arguments_);
    return provider;
  };
  const view = renderHook(
    (props: { projectId: string; yjsStateId: string; enabled: boolean }) =>
      useCollabDocument({ ...props, createProvider }),
    { initialProps: { projectId: 'p1', yjsStateId: 'y1', enabled } },
  );
  return { view, getProvider: () => provider as FakeProvider };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useCollabDocument', () => {
  test('starts in "connecting" and transitions to "synced" on sync', () => {
    const { view, getProvider } = setup();
    expect(view.result.current.connectionState).toBe('connecting');

    act(() => getProvider().emit('synced', { state: true }));
    expect(view.result.current.connectionState).toBe('synced');
  });

  test('builds the room name as `${projectId}/${yjsStateId}`', () => {
    const { getProvider } = setup();
    expect(getProvider().name).toBe('p1/y1');
  });

  test('goes to "reconnecting" when the connection drops after syncing', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('synced', { state: true }));
    act(() => getProvider().emit('status', { status: 'disconnected' }));
    expect(view.result.current.connectionState).toBe('reconnecting');
  });

  test('goes "offline" when never synced within the timeout', () => {
    const { view } = setup();
    act(() => {
      jest.advanceTimersByTime(COLLAB_SYNC_TIMEOUT_MS + 1);
    });
    expect(view.result.current.connectionState).toBe('offline');
  });

  test('staying offline is not overridden once timed out', () => {
    const { view } = setup();
    act(() => {
      jest.advanceTimersByTime(COLLAB_SYNC_TIMEOUT_MS + 1);
    });
    expect(view.result.current.connectionState).toBe('offline');
  });

  test('tears down provider + Y.Doc and clears awareness on unmount', () => {
    const { view, getProvider } = setup();
    const provider = getProvider();
    const doc = view.result.current.doc as Y.Doc;
    const docDestroy = jest.spyOn(doc, 'destroy');

    view.unmount();

    expect(provider.awareness?.setLocalState).toHaveBeenCalledWith(null);
    expect(provider.destroy).toHaveBeenCalled();
    expect(docDestroy).toHaveBeenCalled();
  });

  test('recreates the provider and tears down the old one when the file switches', () => {
    const { view, getProvider } = setup();
    const first = getProvider();

    act(() => {
      view.rerender({ projectId: 'p1', yjsStateId: 'y2', enabled: true });
    });

    expect(first.destroy).toHaveBeenCalled();
    expect(getProvider().name).toBe('p1/y2');
  });

  test('does not create a provider when disabled', () => {
    const { view, getProvider } = setup(false);
    expect(getProvider()).toBeUndefined();
    expect(view.result.current.doc).toBeNull();
  });

  // readSyncedState returns true when the event fires with no payload — covers the fallback `return true`
  test('transitions to "synced" when the synced event fires with no payload', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('synced')); // no payload
    expect(view.result.current.connectionState).toBe('synced');
  });

  // readStatus returns undefined on a payload with no "status" key — handleStatus becomes a no-op
  test('ignores a status event whose payload carries no recognized status field', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('status', {})); // no 'status' key
    expect(view.result.current.connectionState).toBe('connecting');
    act(() => getProvider().emit('status', 'unexpected-string')); // not an object
    expect(view.result.current.connectionState).toBe('connecting');
  });

  // handleStatus else-if (status === 'connecting') — stays 'offline' once timed out
  test('stays "offline" when a connecting status event fires after the sync timeout', () => {
    const { view, getProvider } = setup();
    act(() => { jest.advanceTimersByTime(COLLAB_SYNC_TIMEOUT_MS + 1); });
    expect(view.result.current.connectionState).toBe('offline');
    act(() => getProvider().emit('status', { status: 'connecting' }));
    expect(view.result.current.connectionState).toBe('offline');
  });

  // handleStatus else-if (status === 'connecting') — stays 'reconnecting' when already reconnecting after sync
  test('stays "reconnecting" when a connecting status event fires while reconnecting', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('synced', { state: true }));
    act(() => getProvider().emit('status', { status: 'disconnected' }));
    expect(view.result.current.connectionState).toBe('reconnecting');
    act(() => getProvider().emit('status', { status: 'connecting' }));
    expect(view.result.current.connectionState).toBe('reconnecting');
  });

  test('publishes the local user presence identity on the awareness "user" field', () => {
    let provider: FakeProvider | undefined;
    const createProvider: CreateCollabProvider = (arguments_) => {
      provider = new FakeProvider(arguments_);
      return provider;
    };
    renderHook(() =>
      useCollabDocument({
        projectId: 'p1',
        yjsStateId: 'y1',
        enabled: true,
        user: { userId: 'u-1', name: 'Ada' },
        createProvider,
      }),
    );

    const setField = (provider as FakeProvider).awareness?.setLocalStateField as jest.Mock;
    expect(setField).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ userId: 'u-1', name: 'Ada', color: expect.any(String), colorLight: expect.any(String) }),
    );
  });

  // defaultCreateProvider fallback (line 78) + the `?? defaultCreateProvider` branch
  // (lines 110/111): rendering with no injected factory uses the mocked HocuspocusProvider.
  test('falls back to the default HocuspocusProvider factory when none is injected', () => {
    renderHook(() => useCollabDocument({ projectId: 'p1', yjsStateId: 'y1', enabled: true }));
    expect(hocuspocusConstructor).toHaveBeenCalledWith(expect.objectContaining({ name: 'p1/y1' }));
  });

  // readStatus line 83 `: undefined` path — payload has a non-string `status` key.
  test('ignores a status event whose status field is present but not a string', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('status', { status: 42 }));
    expect(view.result.current.connectionState).toBe('connecting');
  });

  // handleSynced early return (line 146) — synced fires with `state: false`, so state stays 'connecting'.
  test('does not transition to "synced" when synced fires with state:false', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('synced', { state: false }));
    expect(view.result.current.connectionState).toBe('connecting');
  });

  // handleStatus `if (hasSynced)` false path (line 155) — disconnected before ever syncing is a no-op.
  test('ignores a disconnected status event that arrives before the first sync', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('status', { status: 'disconnected' }));
    expect(view.result.current.connectionState).toBe('connecting');
  });

  // handleStatus ternary `: 'connecting'` path (line 158) — connecting status while in plain 'connecting'.
  test('stays "connecting" when a connecting status event fires before any sync', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('status', { status: 'connecting' }));
    expect(view.result.current.connectionState).toBe('connecting');
  });

  // offlineTimer `if (!hasSynced)` false path (line 167) — timer firing after a sync must not force offline.
  test('does not go offline when the sync timeout elapses after syncing', () => {
    const { view, getProvider } = setup();
    act(() => getProvider().emit('synced', { state: true }));
    expect(view.result.current.connectionState).toBe('synced');
    act(() => {
      jest.advanceTimersByTime(COLLAB_SYNC_TIMEOUT_MS + 1);
    });
    expect(view.result.current.connectionState).toBe('synced');
  });

  // Awareness optional-chaining short-circuit on set (line 142) and cleanup (line 174):
  // a provider whose awareness is null exercises both `?.` no-op paths without throwing.
  test('handles a provider with null awareness on set and teardown', () => {
    let provider: FakeProvider | undefined;
    const createProvider: CreateCollabProvider = (arguments_) => {
      provider = new FakeProvider(arguments_);
      provider.awareness = null;
      return provider;
    };
    const view = renderHook(() =>
      useCollabDocument({
        projectId: 'p1',
        yjsStateId: 'y1',
        enabled: true,
        user: { userId: 'u-1', name: 'Ada' },
        createProvider,
      }),
    );
    expect(view.result.current.awareness).toBeNull();
    expect(() => view.unmount()).not.toThrow();
    expect((provider as FakeProvider).destroy).toHaveBeenCalled();
  });
});
