'use client';

/**
 * @file The "fetch what this render references, without blocking it" pattern, in one place.
 *
 * Both PDF previews need the same three steps: work out which binary assets the current content
 * references, schedule fetches for the ones not cached yet, and rebuild the snapshot each time more
 * bytes land. The document preview had this inline in the project layout; the theme preview needs it
 * too, and a second hand-rolled copy is how the two would drift — one remembering to depend on
 * `assetVersion` and the other quietly rendering with whatever happened to be cached at mount.
 *
 * Everything underneath is {@link useProjectAssetCache} unchanged: the same per-project cache, the
 * same de-duplication by path, the same fire-and-forget fetches. This adds no fetching of its own.
 */

import { useEffect, useMemo } from 'react';
import type { ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import type { SnapshotFile } from '@/lib/pdf/build-project-snapshot';

/** No assets — a stable identity, so a caller with nothing referenced never rebuilds its snapshot. */
const NO_ASSETS: readonly SnapshotFile[] = [];

/**
 * Schedule fetches for `paths` and return the subset that has arrived.
 *
 * Fire-and-forget by design: the editor thread is never blocked on a font, and each asset that lands
 * bumps the cache's `assetVersion`, which re-runs the memo here and hands the caller a new array so
 * its snapshot rebuilds and the next render includes the file.
 *
 * @param cache - The project's asset cache, or undefined outside a project (nothing is fetched).
 * @param paths - The project-relative paths the current render references.
 * @param isEnabled - False while the preview is closed; nothing is fetched.
 * @returns The referenced assets fetched so far, in `paths` order.
 */
export function useReferencedAssets(
  cache: ProjectAssetCache | undefined,
  paths: readonly string[],
  isEnabled: boolean,
): readonly SnapshotFile[] {
  const ensureAssets = cache?.ensureAssets;
  const getAssets = cache?.getAssets;
  const assetVersion = cache?.assetVersion ?? 0;
  // Keyed on the CONTENTS of the path list: callers derive it per render, so a fresh array naming the
  // same files must not schedule a fetch or rebuild a snapshot.
  const pathKey = paths.join('\n');

  useEffect(() => {
    if (!isEnabled || ensureAssets === undefined) return;
    if (pathKey !== '') ensureAssets(pathKey.split('\n'));
  }, [isEnabled, ensureAssets, pathKey]);

  return useMemo(() => {
    if (!isEnabled || getAssets === undefined || pathKey === '') return NO_ASSETS;
    const wanted = new Set(pathKey.split('\n'));
    const available = new Map(getAssets().map((asset) => [asset.path, asset]));
    // Built by walking `paths`, not the cache: the order is then the caller's and is stable, so a
    // snapshot rebuilt after an unrelated asset arrives is identical rather than merely equivalent.
    return [...wanted].flatMap((path) => {
      const asset = available.get(path);
      return asset === undefined ? [] : [asset];
    });
    // `assetVersion` is the arrival signal: `getAssets` is referentially stable across it by design,
    // so without it the memo would never see newly fetched bytes.
  }, [isEnabled, getAssets, pathKey, assetVersion]);
}
