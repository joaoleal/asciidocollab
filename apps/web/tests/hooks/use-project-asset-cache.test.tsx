import { renderHook, act } from '@testing-library/react';
import { useProjectAssetCache } from '@/hooks/use-project-asset-cache';

// Mock the network primitive so the hook's cache/dedup logic is exercised in isolation.
jest.mock('@/lib/pdf/fetch-project-asset', () => ({
  fetchProjectAsset: jest.fn(),
}));
import { fetchProjectAsset } from '@/lib/pdf/fetch-project-asset';
const mockFetch = fetchProjectAsset as jest.Mock;

/** Resolve all pending microtasks so a scheduled fetch settles and its state update flushes. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useProjectAssetCache', () => {
  beforeEach(() => mockFetch.mockReset());

  it('fetches referenced assets, caches them, and bumps assetVersion when bytes arrive', async () => {
    const bytes = new Uint8Array([1, 2]);
    mockFetch.mockResolvedValue(bytes);
    const { result } = renderHook(() => useProjectAssetCache('p1'));

    expect(result.current.getAssets()).toEqual([]);
    const versionBefore = result.current.assetVersion;

    act(() => result.current.ensureAssets(['images/logo.png']));
    await flush();

    expect(mockFetch).toHaveBeenCalledWith('p1', 'images/logo.png');
    expect(result.current.getAssets()).toEqual([{ path: 'images/logo.png', kind: 'binary', bytes }]);
    expect(result.current.assetVersion).toBeGreaterThan(versionBefore);
  });

  it('fetches a given path only once across repeated and concurrent requests', async () => {
    mockFetch.mockResolvedValue(new Uint8Array([9]));
    const { result } = renderHook(() => useProjectAssetCache('p1'));

    act(() => {
      result.current.ensureAssets(['a.png', 'a.png']);
      result.current.ensureAssets(['a.png']);
    });
    await flush();
    act(() => result.current.ensureAssets(['a.png'])); // already cached
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('loadAssets awaits every path and omits the ones that could not be fetched', async () => {
    const ok = new Uint8Array([5]);
    mockFetch.mockImplementation(async (_projectId: string, path: string) => (path === 'ok.png' ? ok : null));
    const { result } = renderHook(() => useProjectAssetCache('p1'));

    let records: unknown;
    await act(async () => {
      records = await result.current.loadAssets(['ok.png', 'missing.png']);
    });

    expect(records).toEqual([{ path: 'ok.png', kind: 'binary', bytes: ok }]);
  });

  it('reports an asset as unsettled until its bytes arrive', async () => {
    let resolveFetch!: (bytes: Uint8Array) => void;
    mockFetch.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { result } = renderHook(() => useProjectAssetCache('p1'));

    act(() => result.current.ensureAssets(['images/workflow.svg']));
    // A render started here would report the picture as one it could not find — a warning about a file
    // that is present and on its way — and every second of it would be spent again once it lands.
    expect(result.current.assetsSettled(['images/workflow.svg'])).toBe(false);

    await act(async () => {
      resolveFetch(new Uint8Array([1]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.assetsSettled(['images/workflow.svg'])).toBe(true);
  });

  it('settles an asset that came back empty, and stops asking for it', async () => {
    mockFetch.mockResolvedValue(null);
    const { result } = renderHook(() => useProjectAssetCache('p1'));
    const versionBefore = result.current.assetVersion;

    act(() => result.current.ensureAssets(['gone.png']));
    await flush();

    // The image really is unavailable, so the warning about it is a true one and the render must go
    // ahead. Held for a retry that has already failed, the preview would never render at all.
    expect(result.current.assetsSettled(['gone.png'])).toBe(true);
    // And the settlement has to be announced, or nothing would bring the waiting render back.
    expect(result.current.assetVersion).toBeGreaterThan(versionBefore);

    // Asked for again, it is not re-fetched: it would be in flight once more the instant anyone asked
    // whether it had settled, and the preview would wait on it afresh at every render.
    act(() => result.current.ensureAssets(['gone.png']));
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.assetsSettled(['gone.png'])).toBe(true);
  });

  it('treats a document that references nothing as settled', () => {
    const { result } = renderHook(() => useProjectAssetCache('p1'));

    expect(result.current.assetsSettled([])).toBe(true);
  });

  it('asks again for an asset that was missing under a different project', async () => {
    mockFetch.mockResolvedValue(null);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useProjectAssetCache(id), {
      initialProps: { id: 'p1' },
    });

    act(() => result.current.ensureAssets(['shared.png']));
    await flush();

    rerender({ id: 'p2' });
    await flush();

    // Paths are project-relative: this one names a different file now, and whether p1 had it says
    // nothing about whether p2 does.
    expect(result.current.assetsSettled(['shared.png'])).toBe(false);
  });

  it('drops the cache when the project changes', async () => {
    mockFetch.mockResolvedValue(new Uint8Array([1]));
    const { result, rerender } = renderHook(({ id }: { id: string }) => useProjectAssetCache(id), {
      initialProps: { id: 'p1' },
    });

    act(() => result.current.ensureAssets(['x.png']));
    await flush();
    expect(result.current.getAssets()).toHaveLength(1);

    rerender({ id: 'p2' });
    await flush();
    expect(result.current.getAssets()).toEqual([]);
  });

  it('a fetch in flight across a project switch never pollutes the new project cache', async () => {
    let resolveFetch!: (bytes: Uint8Array) => void;
    mockFetch.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useProjectAssetCache(id), {
      initialProps: { id: 'p1' },
    });

    // Start a fetch for p1's asset, then switch to p2 BEFORE it resolves.
    act(() => result.current.ensureAssets(['shared.png']));
    rerender({ id: 'p2' });
    const versionAfterSwitch = result.current.assetVersion;

    // p1's fetch resolves late: its bytes must land in p1's now-discarded cache, not p2's, and must not
    // trigger a rebuild for p2.
    await act(async () => {
      resolveFetch(new Uint8Array([7]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getAssets()).toEqual([]);
    expect(result.current.assetVersion).toBe(versionAfterSwitch);
  });
});
