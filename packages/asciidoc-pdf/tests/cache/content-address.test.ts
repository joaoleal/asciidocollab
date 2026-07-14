import {
  DEFAULT_CACHE_CAPACITY,
  GeneratedAssetCache,
  HASH_HEX_LENGTH,
  computeSourceHash,
  type SourceHashParts,
} from '../../src/cache/content-address';
import type { GeneratedAsset } from '../../src/protocol';

/** Build a minimal {@link GeneratedAsset} whose bytes make cache values distinguishable. */
const makeAsset = (sourceHash: string, marker: number): GeneratedAsset => ({
  sourceHash,
  kind: 'diagram',
  format: 'svg',
  bytes: Uint8Array.of(marker),
  rasterFallback: false,
  altText: '',
});

const partsOf = (overrides: Partial<SourceHashParts> = {}): SourceHashParts => ({
  source: 'graph TD; A-->B',
  renderParams: { engine: 'mermaid', scale: '2' },
  shimVersion: 'shim-1.0.0',
  ...overrides,
});

describe('computeSourceHash', () => {
  it('is deterministic: identical inputs yield an identical hash', () => {
    // Two independently constructed but equal inputs must collapse to one key.
    expect(computeSourceHash(partsOf())).toBe(computeSourceHash(partsOf()));
  });

  it('emits a fixed-length lowercase hex digest', () => {
    const hash = computeSourceHash(partsOf());
    expect(hash).toHaveLength(HASH_HEX_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('changes the hash when the block source changes', () => {
    expect(computeSourceHash(partsOf({ source: 'graph TD; A-->C' }))).not.toBe(
      computeSourceHash(partsOf()),
    );
  });

  it('changes the hash when a render parameter changes', () => {
    expect(computeSourceHash(partsOf({ renderParams: { engine: 'mermaid', scale: '3' } }))).not.toBe(
      computeSourceHash(partsOf()),
    );
  });

  it('changes the hash when the shim version changes', () => {
    expect(computeSourceHash(partsOf({ shimVersion: 'shim-2.0.0' }))).not.toBe(
      computeSourceHash(partsOf()),
    );
  });

  it('is independent of render-parameter key order (canonicalized)', () => {
    const forward = computeSourceHash(partsOf({ renderParams: { engine: 'mermaid', scale: '2' } }));
    const reversed = computeSourceHash(partsOf({ renderParams: { scale: '2', engine: 'mermaid' } }));
    expect(forward).toBe(reversed);
  });

  it('resists field-boundary ambiguity: moving characters across fields changes the hash', () => {
    // Length-prefixed canonicalization: ("ab","c") must not collide with ("a","bc").
    const left = computeSourceHash({ source: 'ab', renderParams: {}, shimVersion: 'c' });
    const right = computeSourceHash({ source: 'a', renderParams: {}, shimVersion: 'bc' });
    expect(left).not.toBe(right);
  });
});

describe('GeneratedAssetCache', () => {
  it('stores and retrieves assets via get/set/has', () => {
    const cache = new GeneratedAssetCache(4);
    const asset = makeAsset('k1', 1);

    expect(cache.has('k1')).toBe(false);
    expect(cache.get('k1')).toBeUndefined();

    cache.set('k1', asset);

    expect(cache.has('k1')).toBe(true);
    expect(cache.get('k1')).toBe(asset);
  });

  it('overwrites the value when the same key is set again', () => {
    const cache = new GeneratedAssetCache(4);
    const first = makeAsset('k1', 1);
    const second = makeAsset('k1', 2);

    cache.set('k1', first);
    cache.set('k1', second);

    expect(cache.get('k1')).toBe(second);
    expect(cache.size).toBe(1);
  });

  it('evicts the least-recently-used entry by logical tick, without any wall clock', () => {
    const cache = new GeneratedAssetCache(2);
    const a = makeAsset('a', 1);
    const b = makeAsset('b', 2);
    const c = makeAsset('c', 3);

    cache.set('a', a); // tick 1
    cache.set('b', b); // tick 2
    // Touch 'a' so 'b' becomes the least-recently-used — access order alone decides,
    // no timers and no wall-clock spacing between operations.
    expect(cache.get('a')).toBe(a); // tick 3
    cache.set('c', c); // tick 4 → over capacity → evict lowest tick ('b')

    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('evicts by recency of access rather than insertion when a later get reorders usage', () => {
    const cache = new GeneratedAssetCache(2);
    cache.set('a', makeAsset('a', 1));
    cache.set('b', makeAsset('b', 2));
    cache.get('b'); // 'b' now most-recently-used
    cache.set('c', makeAsset('c', 3)); // evicts 'a' (oldest tick)

    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('a')).toBe(false);
  });

  it('has() is a pure membership check and does not affect LRU recency', () => {
    const cache = new GeneratedAssetCache(2);
    cache.set('a', makeAsset('a', 1));
    cache.set('b', makeAsset('b', 2));
    // Probing 'a' with has() must NOT rescue it from eviction.
    expect(cache.has('a')).toBe(true);
    cache.set('c', makeAsset('c', 3));

    expect(cache.has('a')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('serves a cache hit without recomputing (keystroke edit with unchanged source)', () => {
    const cache = new GeneratedAssetCache(4);
    const parts = partsOf();
    const key = computeSourceHash(parts);
    const produce = jest.fn((): GeneratedAsset => makeAsset(key, 7));

    const first = cache.getOrCompute(key, produce);
    // Same block source → same hash → the factory must not run again.
    const second = cache.getOrCompute(computeSourceHash(parts), produce);

    expect(produce).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('recomputes when the key differs (source actually changed)', () => {
    const cache = new GeneratedAssetCache(4);
    const produce = jest.fn((key: string): GeneratedAsset => makeAsset(key, 9));

    cache.getOrCompute('k1', () => produce('k1'));
    cache.getOrCompute('k2', () => produce('k2'));

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new GeneratedAssetCache(0)).toThrow(RangeError);
    expect(() => new GeneratedAssetCache(-1)).toThrow(RangeError);
  });

  it('exposes a positive default capacity', () => {
    expect(DEFAULT_CACHE_CAPACITY).toBeGreaterThan(0);
    expect(new GeneratedAssetCache().size).toBe(0);
  });
});
