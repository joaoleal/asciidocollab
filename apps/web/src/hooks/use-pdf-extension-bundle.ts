'use client';

/**
 * @file Fetches the catalogue and Ruby source a render needs to load a project's enabled extensions.
 *
 * This is the browser half of the composition root. `@asciidocollab/asciidoc-pdf` is bundled into a
 * Web Worker with no filesystem and no knowledge of the API, so it can only ever be GIVEN extension
 * code; deciding what to give it — and refusing to give it anything a project could have written — is
 * the application's job, and this is where it happens.
 *
 * Two properties matter and are easy to lose:
 *
 *  - **Only enabled, available extensions are fetched.** A stale selection (an id the project still
 *    names but nothing offers any more) is not requested at all, so a removed extension costs a 404
 *    per render rather than being quietly retried.
 *  - **The bundle keeps a stable identity while its contents are unchanged.** It rides on every render
 *    request, and a fresh object per render would defeat the preview's snapshot-identity debounce.
 *
 * It also reports whether it is READY, which a one-shot render must wait for. Until the sources
 * arrive the bundle is empty, and a render started against an empty bundle does not fail — the
 * registry refuses each id with "no source was supplied" and the document renders WITHOUT the
 * extensions the project enabled. A live preview recovers on the next render; a downloaded PDF does
 * not, so the export is gated on {@link PdfExtensionBundleState.ready}. Found by an end-to-end test
 * that exported twice in quick succession and got two different documents from one selection.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PdfExtensionBundle, PdfExtensionSource } from '@asciidocollab/asciidoc-pdf';
import { pdfExtensionsApi } from '@/lib/api/pdf-extensions';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';

/** Nothing to load. Shared so a project with no extensions keeps one stable bundle identity. */
const EMPTY_BUNDLE: PdfExtensionBundle = { catalogue: [], sources: [] };

/** The bundle plus whether it is complete, so a one-shot render can wait for it. */
export interface PdfExtensionBundleState {
  /** The catalogue and sources to attach to a render request. */
  readonly bundle: PdfExtensionBundle;
  /**
   * True once the bundle reflects the requested selection — including when that selection is empty,
   * and when fetching it FAILED. A failure must not leave this false for ever, or the control it
   * gates would never re-enable; the render reports an unloadable extension as a rejection instead.
   */
  readonly ready: boolean;
}

/**
 * The extension bundle for a project's current selection.
 *
 * @param projectId - The project whose catalogue and selection to read. Empty means no project
 *   context — a theme opened outside one — and yields an empty bundle.
 * @param enabledIds - The ids the render should load, already filtered by the caller (the theme
 *   editor's comparison control holds one out here).
 * @returns The bundle and whether it is complete.
 */
export function usePdfExtensionBundle(
  projectId: string,
  enabledIds: readonly string[],
): PdfExtensionBundleState {
  const { catalogue, error: catalogueError } = usePdfExtensions(projectId);
  const [sources, setSources] = useState<readonly PdfExtensionSource[]>([]);
  /** The `wanted` key the last fetch finished on, successfully or not. */
  const [settledFor, setSettledFor] = useState<string | null>(null);

  const entries = catalogue?.entries;

  // The ids actually worth fetching, as a stable string. Keyed on CONTENTS rather than identity so a
  // caller deriving the list per render (which the comparison control does) does not refetch.
  const wanted = useMemo(() => {
    if (entries === undefined) return '';
    const available = new Set(
      entries.filter((entry) => entry.available).map((entry) => entry.manifest.id),
    );
    return [...new Set(enabledIds)]
      .filter((id) => available.has(id))
      .toSorted((a, b) => a.localeCompare(b))
      .join(' ');
  }, [entries, enabledIds]);

  useEffect(() => {
    if (projectId === '' || wanted === '') {
      setSources([]);
      setSettledFor(wanted);
      return;
    }
    let active = true;
    const ids = wanted.split(' ');
    const byId = new Map((entries ?? []).map((entry) => [entry.manifest.id, entry.origin]));

    void Promise.all(
      ids.map(async (id) => {
        const source = await pdfExtensionsApi.getSource(projectId, id);
        // The origin comes from the CATALOGUE, not from the fetch. The registry refuses a source
        // whose origin disagrees with its catalogue entry, and inventing one here would defeat that
        // check by making the two agree by construction.
        return { id, origin: byId.get(id) ?? 'shipped', source } satisfies PdfExtensionSource;
      }),
    )
      .then((fetched) => {
        if (!active) return;
        setSources(fetched);
        setSettledFor(wanted);
      })
      .catch(() => {
        // A source that will not load is reported by the registry as a per-extension rejection when
        // the render runs, which is where it is attributable. Clearing here — rather than keeping a
        // partial set — is what makes that happen instead of a render that silently loads some.
        if (!active) return;
        setSources([]);
        // Settled all the same: a failure that left this unsettled would disable the export for ever
        // rather than letting the render report what it could not load.
        setSettledFor(wanted);
      });

    return () => {
      active = false;
    };
  }, [projectId, wanted, entries]);

  const bundle = useMemo(() => {
    // `wanted === ''` is the true "nothing to load" case (no available selection) and keeps the stable
    // EMPTY_BUNDLE identity a no-extension project relies on. When a selection DOES exist but its
    // sources are empty — a fetch that failed, or is still in flight (gated by `ready`) — the catalogue
    // is still exposed, so the render's registry rejects each id with the accurate "no source supplied"
    // reason rather than the misleading "no catalogue entry offers this" that an empty catalogue yields.
    if (entries === undefined || wanted === '') return EMPTY_BUNDLE;
    return { catalogue: entries, sources };
  }, [entries, wanted, sources]);

  return useMemo(
    () => ({
      bundle,
      // Not ready while the CATALOGUE is still loading and something is selected: `wanted` is empty
      // in that window for want of a catalogue to filter against, so settling on it would report
      // ready for a selection nothing has been fetched for yet.
      //
      // A catalogue that FAILED is a different thing from one still loading, and has to end the wait
      // — otherwise "still loading" never ends and whatever this gates (the export control) stays
      // disabled for the rest of the session over one failed request, with nothing said. That is the
      // same rule the source fetch already follows above, and what this hook's contract promises.
      ready:
        (entries !== undefined || catalogueError !== null || enabledIds.length === 0) &&
        settledFor === wanted,
    }),
    [bundle, entries, catalogueError, enabledIds.length, settledFor, wanted],
  );
}
