import { renderHook, waitFor } from '@testing-library/react';
import { usePdfExtensionBundle } from '@/hooks/use-pdf-extension-bundle';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';
import { pdfExtensionsApi } from '@/lib/api/pdf-extensions';

jest.mock('@/hooks/use-pdf-extensions', () => ({ usePdfExtensions: jest.fn() }));
jest.mock('@/lib/api/pdf-extensions', () => ({
  pdfExtensionsApi: { getSource: jest.fn() },
}));

const mockCatalogue = usePdfExtensions as jest.MockedFunction<typeof usePdfExtensions>;
const mockGetSource = pdfExtensionsApi.getSource as jest.MockedFunction<
  typeof pdfExtensionsApi.getSource
>;

/** Placeholder resolver, replaced once the deferred fetch hands over its real one. */
function noop(): void {}

/** A catalogue entry for `id`, available and shipped. */
function entry(id: string) {
  return {
    manifest: { id, displayName: id, description: '', targeting: '', themeKeys: [], sampleContent: '' },
    origin: 'shipped' as const,
    available: true,
  };
}

/** Report the catalogue as still loading, or as carrying `ids`. */
function catalogueOf(ids: readonly string[] | undefined): void {
  mockCatalogue.mockReturnValue({
    catalogue: ids === undefined ? undefined : { entries: ids.map(entry), staleSelections: [], excluded: [], conflicts: [] },
    loading: ids === undefined,
    error: null,
  } as unknown as ReturnType<typeof usePdfExtensions>);
}

beforeEach(() => {
  mockCatalogue.mockReset();
  mockGetSource.mockReset();
});

describe('usePdfExtensionBundle — readiness', () => {
  // WHY THIS EXISTS. The bundle starts empty and fills in asynchronously, and a render started
  // against an empty bundle DOES NOT FAIL: the registry refuses each id with "no source was
  // supplied" and the document renders without the extensions the project enabled. A live preview
  // recovers on its next render; a downloaded PDF does not.
  //
  // Found by an end-to-end test that exported twice in quick succession and got two different
  // documents from one selection — which is what a silent drop looks like from outside.

  it('is ready immediately when nothing is selected', async () => {
    catalogueOf(['alpha']);
    const { result } = renderHook(() => usePdfExtensionBundle('p1', []));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bundle.sources).toEqual([]);
    expect(mockGetSource).not.toHaveBeenCalled();
  });

  it('is NOT ready while the selected extension’s source is still being fetched', async () => {
    catalogueOf(['alpha']);
    // A source that never resolves: the window this test is about is exactly the one where the
    // selection is known and the code for it is not.
    mockGetSource.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    await waitFor(() => expect(mockGetSource).toHaveBeenCalled());
    expect(result.current.ready).toBe(false);
    // And the bundle really is empty meanwhile — so a render taken now would silently drop it.
    expect(result.current.bundle.sources).toEqual([]);
  });

  it('becomes ready once every selected source has arrived', async () => {
    catalogueOf(['alpha', 'beta']);
    mockGetSource.mockImplementation(async (_project, id) => `# ${id}\n`);
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha', 'beta']));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bundle.sources.map((source) => source.id).toSorted()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('is NOT ready while the CATALOGUE is still loading and something is selected', async () => {
    // The subtler half of the same window. Before the catalogue arrives there is nothing to filter
    // the selection against, so no source has even been requested yet — reporting ready here would
    // gate on a question that has not been asked.
    catalogueOf(undefined);
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    await waitFor(() => expect(result.current.ready).toBe(false));
    expect(mockGetSource).not.toHaveBeenCalled();
  });

  it('becomes ready again after a fetch fails, rather than latching off', async () => {
    // A failure must not disable the control it gates for ever. The render reports an extension it
    // could not load as a per-extension rejection, which is where that is attributable.
    catalogueOf(['alpha']);
    mockGetSource.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bundle.sources).toEqual([]);
  });

  it('keeps the catalogue exposed when a selected source fails, so the reason is attributable', async () => {
    // A failed fetch leaves `sources` empty, but the catalogue must NOT collapse to EMPTY_BUNDLE:
    // an empty catalogue makes the registry reject each id with "no catalogue entry offers this",
    // misattributing the cause. With the catalogue kept, it reports the accurate "no source supplied".
    catalogueOf(['alpha']);
    mockGetSource.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bundle.sources).toEqual([]);
    expect(result.current.bundle.catalogue.map((entry) => entry.manifest.id)).toEqual(['alpha']);
  });

  it('goes back to not-ready when the selection changes', async () => {
    // The case the end-to-end test actually hit: a selection is changed and a render is taken before
    // the new code arrives. Readiness has to fall for the NEW selection, not stay true from the old.
    catalogueOf(['alpha', 'beta']);
    mockGetSource.mockImplementation(async (_project, id) => `# ${id}\n`);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => usePdfExtensionBundle('p1', ids),
      { initialProps: { ids: ['alpha'] as readonly string[] } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Only `beta` is held back. Deferring BOTH would leave the `Promise.all` waiting on the id this
    // test never releases, so it would report not-ready for the wrong reason.
    let releaseBeta: (value: string) => void = noop;
    mockGetSource.mockImplementation(async (_project, id) =>
      id === 'beta'
        ? new Promise<string>((resolve) => {
            releaseBeta = resolve;
          })
        : `# ${id}\n`,
    );
    rerender({ ids: ['alpha', 'beta'] });
    await waitFor(() => expect(result.current.ready).toBe(false));

    releaseBeta('# beta\n');
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it('ignores the order a selection is given in', async () => {
    // The registry loads by sorted id, so two spellings of one selection must not refetch or produce
    // a different bundle — which is what made the end-to-end order-independence check meaningful.
    catalogueOf(['alpha', 'beta']);
    mockGetSource.mockImplementation(async (_project, id) => `# ${id}\n`);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => usePdfExtensionBundle('p1', ids),
      { initialProps: { ids: ['alpha', 'beta'] as readonly string[] } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const callsAfterFirst = mockGetSource.mock.calls.length;

    rerender({ ids: ['beta', 'alpha'] });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mockGetSource.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('usePdfExtensionBundle — a catalogue that could not be fetched', () => {
  it('becomes ready rather than waiting for ever', async () => {
    // A catalogue that FAILED is not a catalogue still loading. Treating the two alike left `ready`
    // false for the rest of the session, and the export control this gates disabled with no message
    // — from one failed request, or from hitting the catalogue rate limit.
    mockCatalogue.mockReturnValue({
      catalogue: undefined,
      loading: false,
      error: 'Failed to load extensions.',
    } as unknown as ReturnType<typeof usePdfExtensions>);

    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    await waitFor(() => expect(result.current.ready).toBe(true));
    // Nothing could be fetched, so the render proceeds without them and the registry reports each
    // id as a rejection — which is attributable, unlike a permanently greyed-out button.
    expect(result.current.bundle.sources).toEqual([]);
  });

  it('still waits while the catalogue is genuinely loading', () => {
    // The distinction this fix turns on: absent-because-loading must still hold the render back.
    catalogueOf(undefined);
    const { result } = renderHook(() => usePdfExtensionBundle('p1', ['alpha']));
    expect(result.current.ready).toBe(false);
  });
});
