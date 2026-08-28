/**
 * The catalogue this hook exposes is read-only: the project's SELECTION lives in the render-config
 * draft. These pin the three answers the endpoint can give — a catalogue, a refusal it can explain,
 * and a refusal it cannot — plus the rule that a reply arriving after the caller has gone is dropped.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';
import { pdfExtensionsApi, type PdfExtensionCatalogue } from '@/lib/api/pdf-extensions';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

jest.mock('@/lib/api/pdf-extensions', () => ({ pdfExtensionsApi: { get: jest.fn() } }));

const mockGet = pdfExtensionsApi.get as jest.MockedFunction<typeof pdfExtensionsApi.get>;

const CATALOGUE: PdfExtensionCatalogue = {
  entries: [],
  staleSelections: ['gone'],
  excluded: [],
  conflicts: [],
};

/** A reply body carrying no `data` at all — what an endpoint answering with `{}` sends. */
const NO_DATA: Awaited<ReturnType<typeof pdfExtensionsApi.get>> = JSON.parse('{}');

/** Let the pending promise chain settle without asserting on any particular render. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('usePdfExtensions', () => {
  it('starts loading and hands over the assembled catalogue', async () => {
    mockGet.mockResolvedValue({ data: CATALOGUE });

    const { result } = renderHook(() => usePdfExtensions('p1'));
    expect(result.current.loading).toBe(true);
    expect(result.current.catalogue).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalogue).toEqual(CATALOGUE);
    expect(result.current.error).toBeNull();
  });

  it('falls back to an empty catalogue when the reply carries none', async () => {
    mockGet.mockResolvedValue(NO_DATA);

    const { result } = renderHook(() => usePdfExtensions('p1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalogue).toEqual({
      entries: [],
      staleSelections: [],
      excluded: [],
      conflicts: [],
    });
    expect(result.current.error).toBeNull();
  });

  it('surfaces the message of a refusal the server explained', async () => {
    mockGet.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'That project has no catalogue.'));

    const { result } = renderHook(() => usePdfExtensions('p1'));

    await waitFor(() => expect(result.current.error).toBe('That project has no catalogue.'));
    expect(result.current.loading).toBe(false);
    expect(result.current.catalogue).toBeNull();
  });

  it('surfaces a generic message when the request never reached the server', async () => {
    mockGet.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => usePdfExtensions('p1'));

    await waitFor(() => expect(result.current.error).toBe('Failed to load PDF extensions.'));
    expect(result.current.loading).toBe(false);
  });

  it('refetches when the project changes', async () => {
    mockGet.mockResolvedValue({ data: CATALOGUE });
    const { result, rerender } = renderHook(({ id }: { id: string }) => usePdfExtensions(id), {
      initialProps: { id: 'p1' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ id: 'p2' });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGet.mock.calls.map((call) => call[0])).toEqual(['p1', 'p2']);
  });

  it('drops a catalogue that arrives after the caller has gone', async () => {
    let release: (value: { data: PdfExtensionCatalogue }) => void = noop;
    mockGet.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => usePdfExtensions('p1'));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    unmount();
    release({ data: CATALOGUE });
    await flush();

    expect(result.current.catalogue).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('drops a refusal that arrives after the caller has gone', async () => {
    let reject: (reason: unknown) => void = noop;
    mockGet.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const { result, unmount } = renderHook(() => usePdfExtensions('p1'));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    unmount();
    reject(new ApiError(500, 'BOOM', 'Server error.'));
    await flush();

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
