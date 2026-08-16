import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { defaultAppearance, resolveAppearance } from '@asciidocollab/shared';
import type { FontRequirement } from '@asciidocollab/shared';
import { usePrintFonts } from '@/hooks/use-print-fonts';

// jsdom implements neither the font set nor `FontFace`. Both are stubbed with the smallest thing the
// hook actually uses, so what is under test is the hook's decisions rather than a font engine.
const added: string[] = [];
const removed: string[] = [];
/** What the document's font set currently holds, which is what a page actually draws from. */
const inSet = new Set<{ family: string }>();
let failFamilies: string[] = [];
/** Whether the document's font set refuses a face outright, which is how a load comes to REJECT. */
let addThrows = false;
/** How many faces the set accepts before it starts refusing — a load that fails PARTWAY through. */
let addThrowsAfter = Number.POSITIVE_INFINITY;
/**
 * How many of the NEXT additions the set refuses, counted down as it refuses them.
 *
 * What this expresses that `addThrows` cannot is one attempt failing while another succeeds. Two loads
 * can be in flight at once, and the older of the two reaches the font set first — its promise chain is
 * a step ahead of the younger one's at every await — so a count of one is "the stale attempt fails".
 */
let addFailuresLeft = 0;
/** Likewise for removal: how many of the next deletions the set refuses to perform. */
let deleteFailuresLeft = 0;

class StubFontFace {
  constructor(
    readonly family: string,
    readonly source: unknown,
    readonly descriptors: unknown,
  ) {}
  load(): Promise<StubFontFace> {
    return failFamilies.includes(this.family)
      ? Promise.reject(new Error('not a font'))
      : Promise.resolve(this);
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'FontFace', { writable: true, value: StubFontFace });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (face: { family: string }) => {
        if (addFailuresLeft > 0) {
          addFailuresLeft -= 1;
          throw new TypeError('the font set refused this face');
        }
        if (addThrows || added.length >= addThrowsAfter) {
          throw new TypeError('the font set refused this face');
        }
        added.push(face.family);
        inSet.add(face);
      },
      delete: (face: { family: string }) => {
        if (deleteFailuresLeft > 0) {
          deleteFailuresLeft -= 1;
          throw new TypeError('the font set refused to release this face');
        }
        removed.push(face.family);
        return inSet.delete(face);
      },
    },
  });
});

beforeEach(() => {
  added.length = 0;
  removed.length = 0;
  inSet.clear();
  failFamilies = [];
  addThrows = false;
  addThrowsAfter = Number.POSITIVE_INFINITY;
  addFailuresLeft = 0;
  deleteFailuresLeft = 0;
});

// A `console.warn` spy left in place by a test that failed before restoring it is handed BACK by the
// next `jest.spyOn` — same mock, same call history — so one failure made the tests after it report
// warnings they never provoked. The state a test leaves behind is not evidence about the next one.
afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * An asset reader holding nothing, as one stable function — which is what makes it faithful. The real
 * reader is a `useCallback` over a ref, so its identity survives every render and a hook keyed on it
 * cannot notice that its answer has changed.
 *
 * @returns Nothing, always.
 */
const NO_BYTES = (): Uint8Array | undefined => undefined;

/**
 * An asset reader whose fetches have all been answered, likewise as one stable function.
 *
 * @returns True, always.
 */
const ALL_SETTLED = (): boolean => true;

/** A family whose file the project supplies. */
const PROJECT_FONT: FontRequirement = {
  family: 'Bespoke',
  declaredByTheme: true,
  declaredFaces: { normal: 'fonts/bespoke.woff2' },
};

/** The same family with two files, so a load can fail with one of them already registered. */
const TWO_FACE_PROJECT_FONT: FontRequirement = {
  family: 'Bespoke',
  declaredByTheme: true,
  declaredFaces: { normal: 'fonts/bespoke.woff2', bold: 'fonts/bespoke-bold.woff2' },
};

describe('loading the typefaces the appearance references', () => {
  test('the catalogue families of the default appearance all load', async () => {
    const fonts = defaultAppearance().fonts;
    const { result } = renderHook(() => usePrintFonts({ enabled: true, fonts }));
    // ALL of them, which is what the title says: `added.length > 0` was satisfied by one face of one
    // family, so a hook that loaded the body face and silently dropped the mono one passed. Asserted
    // as containment rather than equality because the set carries more than the model's names — each
    // family whose metrics the renderer reads is registered a second time under a derived name.
    const wanted = fonts.map((font) => font.family);
    expect(wanted.length).toBeGreaterThan(1);
    await waitFor(() => expect(wanted.filter((family) => !added.includes(family))).toEqual([]));
    // The diagnostics are the whole report — a family drawn in an approximation is named in one of
    // them, and there is no second list of family names saying the same thing.
    expect(result.current.diagnostics).toEqual([]);
  });

  test('nothing is fetched or registered while another style is selected', () => {
    const ensureAssets = jest.fn();
    const { result } = renderHook(() =>
      usePrintFonts({ enabled: false, fonts: [PROJECT_FONT], ensureAssets }),
    );
    expect(ensureAssets).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    expect(result.current.diagnostics).toEqual([]);
  });

  test("a project's own faces are asked for through the caller's asset mechanism", async () => {
    const ensureAssets = jest.fn();
    renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: [PROJECT_FONT],
        ensureAssets,
        getAssetBytes: () => new Uint8Array([1, 2, 3]),
        assetVersion: 1,
      }),
    );
    await waitFor(() => expect(ensureAssets).toHaveBeenCalledWith(['fonts/bespoke.woff2']));
  });

  test('a project face whose bytes have not arrived falls back, and is retried when they do', async () => {
    let bytes: Uint8Array | undefined = undefined;
    const { result, rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({
          enabled: true,
          fonts: [PROJECT_FONT],
          getAssetBytes: () => bytes,
          // The fetch has answered — it came back with nothing. That is a font that is genuinely
          // unavailable, which is the case this covers; the one still in flight is the next test.
          assetsSettled: () => true,
          ...props,
        }),
      { initialProps: { assetVersion: 1 } },
    );

    await waitFor(() =>
      expect(result.current.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual([
        'Bespoke',
      ]),
    );
    expect(result.current.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'theme-font-unavailable',
    ]);

    // The bytes land, and the asset version bumps — which is the signal, and the only one that may
    // cause a second attempt. Without it the page would keep an approximation it no longer needs.
    bytes = new Uint8Array([1, 2, 3]);
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(added).toContain('Bespoke'));
    // The family draws in its own face again: nothing is reported about supplying it, only that three
    // stub bytes carry no metric tables — which they do not. Which family that is about comes from
    // `resource`; the message is the application's own sentence and names no font.
    expect(
      result.current.diagnostics.map((diagnostic) => [diagnostic.resource, diagnostic.message]),
    ).toEqual([['Bespoke', expect.stringContaining('The vertical metrics of this font')]]);
  });

  test('a file the browser will not decode is reported, not thrown', async () => {
    failFamilies = ['Bespoke'];
    const { result } = renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: [PROJECT_FONT],
        getAssetBytes: () => new Uint8Array([1, 2, 3]),
        assetsSettled: () => true,
        assetVersion: 1,
      }),
    );
    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));
    expect(result.current.diagnostics[0].resource).toBe('Bespoke');
  });

  test('a fetch still in flight is not a font that could not be loaded', async () => {
    // Selecting Print used to warn about an approximation for every project font on the way to
    // showing the real one — a true-looking statement about a font that was merely still arriving.
    //
    // Asserting a SILENCE is only evidence if the thing being waited for has had time to speak. This
    // flushed one microtask, and the diagnostic it is about is set several promises deep inside
    // `loadFontFaces(...).then(...)`: it returned before any load could have reported anything, so
    // deleting the wait the hook performs left it passing. The control below is what makes the
    // silence mean something — the same plan and the same flush, with the fetch SETTLED, names the
    // family well inside it.
    const settled = renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: [PROJECT_FONT],
        getAssetBytes: NO_BYTES,
        assetsSettled: ALL_SETTLED,
        assetVersion: 1,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(settled.result.current.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual([
      'Bespoke',
    ]);

    const { result } = renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: [PROJECT_FONT],
        getAssetBytes: NO_BYTES,
        assetsSettled: () => false,
        assetVersion: 1,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.diagnostics).toEqual([]);
    expect(added).toEqual([]);
  });

  test('a fetch that comes back EMPTY releases the plan rather than stranding it', async () => {
    // The other side of the wait above, and the one nothing drove: a fetch settling with NOTHING.
    //
    // Every accessor here is stable, because every accessor the asset cache hands out is: `getAssetBytes`
    // and `assetsSettled` are `useCallback`s over refs, so their identity never changes and their ANSWER
    // changes without React being told. When the fetch comes back empty the bytes are still absent, so
    // the plan's asset key reads `path@absent` — exactly what it read while the fetch was in flight —
    // and `assetVersion`, the one thing that did change, is only an input to that key. Nothing React
    // compares differed, so the effect that gave up waiting never ran again: the whole plan stayed
    // unloaded, the CATALOGUE faces beside the project one included, and the diagnostics said nothing
    // was wrong while the page was drawn in browser substitutes at the theme's metrics and leading. It
    // held until the theme text changed or the style was switched off and on.
    const fonts: FontRequirement[] = [...defaultAppearance().fonts, PROJECT_FONT];
    let settled = false;
    const assetsSettled = (): boolean => settled;
    const { result, rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({ enabled: true, fonts, getAssetBytes: NO_BYTES, assetsSettled, ...props }),
      { initialProps: { assetVersion: 1 } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(added).toEqual([]);

    // The fetch answers, with nothing. `assetVersion` bumping is the whole of the notification.
    settled = true;
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(added.length).toBeGreaterThan(0));

    // Every catalogue family in the same plan is registered — they never needed a fetch at all.
    for (const font of defaultAppearance().fonts) expect(added).toContain(font.family);
    // And the family that really is unavailable is the one the author is told about.
    expect(result.current.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual(['Bespoke']);
    expect(added).not.toContain('Bespoke');
  });

  test('a fetch that arrives releases the plan, and the face is the project’s own', async () => {
    // The same false → true transition, settling the other way. Together with the test above this is
    // the whole of what a fetch can do, driven the way the cache really drives it: one stable accessor
    // whose answer changes, and one version bump to say that it has.
    let bytes: Uint8Array | undefined = undefined;
    let settled = false;
    const assetsSettled = (): boolean => settled;
    const getAssetBytes = (): Uint8Array | undefined => bytes;
    const { result, rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({ enabled: true, fonts: [PROJECT_FONT], getAssetBytes, assetsSettled, ...props }),
      { initialProps: { assetVersion: 1 } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(added).toEqual([]);
    expect(result.current.diagnostics).toEqual([]);

    bytes = new Uint8Array([1, 2, 3]);
    settled = true;
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(added).toEqual(['Bespoke']));
    // Nothing is said about supplying the family — only that three stub bytes carry no metric tables.
    // The family is identified by `resource`, which is the field that may carry a font's name.
    expect(
      result.current.diagnostics.map((diagnostic) => [diagnostic.resource, diagnostic.message]),
    ).toEqual([['Bespoke', expect.stringContaining('The vertical metrics of this font')]]);
  });

  test('a keystroke in the theme document does not read the project’s font file again', async () => {
    // `resolveAppearance` builds a fresh `fonts` array on every call, so the plan the preview's face
    // metrics are keyed on changes identity on every keystroke in a theme document — and each of
    // those re-parsed every project font from raw bytes, on the thread painting the editor, between
    // the key going down and the character appearing. The parse is a pure function of the bytes.
    //
    // Counted at the one place a parse begins: `parseFaceMetrics` opens a `DataView` over the asset's
    // buffer and nothing else in this test does.
    const bytes = new Uint8Array([1, 2, 3]);
    const getAssetBytes = (): Uint8Array => bytes;
    const realDataView = globalThis.DataView;
    let reads = 0;
    Object.defineProperty(globalThis, 'DataView', {
      configurable: true,
      writable: true,
      value: new Proxy(realDataView, {
        construct: (target, constructorArguments: readonly unknown[]) => {
          if (constructorArguments[0] === bytes.buffer) reads += 1;
          return Reflect.construct(target, constructorArguments);
        },
      }),
    });

    try {
      const { rerender } = renderHook(() =>
        usePrintFonts({
          enabled: true,
          // A fresh requirement per render, which is what the resolver hands the preview per keystroke.
          fonts: [{ ...PROJECT_FONT }],
          getAssetBytes,
          assetsSettled: ALL_SETTLED,
          assetVersion: 1,
        }),
      );
      await waitFor(() => expect(added).toEqual(['Bespoke']));
      // Once for the first paint, and not once per render of it.
      expect(reads).toBe(1);

      for (let keystroke = 0; keystroke < 10; keystroke += 1) act(() => rerender());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(reads).toBe(1);
      // And nothing was re-registered either: the file is the same file.
      expect(added).toEqual(['Bespoke']);
    } finally {
      Object.defineProperty(globalThis, 'DataView', {
        configurable: true,
        writable: true,
        value: realDataView,
      });
    }
  });

  test('an unrelated asset settling does not register the catalogue faces again', async () => {
    // `assetVersion` bumps whenever ANY asset settles, images included. A plan with no project faces
    // has nothing waiting on that, and re-registering on it grows the document's font set for the
    // rest of the session.
    const fonts = defaultAppearance().fonts;
    const { rerender } = renderHook(
      (props: { assetVersion: number }) => usePrintFonts({ enabled: true, fonts, ...props }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(added.length).toBeGreaterThan(0));
    const afterFirst = added.length;

    for (let version = 2; version <= 6; version++) act(() => rerender({ assetVersion: version }));
    // Flushed, not merely stepped: the loader is asynchronous, and counting on the next microtask
    // would find any re-registration still in flight and report a clean run either way.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(added.length).toBe(afterFirst);
  });

  test('a re-registration takes the previous faces out of the document first', async () => {
    let bytes = new Uint8Array([1, 2, 3]);
    const { rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({
          enabled: true,
          fonts: [PROJECT_FONT],
          getAssetBytes: () => bytes,
          assetsSettled: () => true,
          ...props,
        }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(added.length).toBe(1));
    expect([...inSet].map((face) => face.family)).toEqual(['Bespoke']);

    // The author replaces the file. Same family, same path, different bytes — so nothing about the
    // plan changes, and the only thing standing between them and the old typeface is this.
    bytes = new Uint8Array([4, 5, 6]);
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(added.length).toBe(2));
    expect(removed).toEqual(['Bespoke']);
    expect([...inSet]).toHaveLength(1);
  });

  test('a re-render with the same families registers nothing again', async () => {
    // Written against `defaultAppearance().fonts` this test could not fail, twice over.
    //
    // That accessor hands back ONE shared array, so every re-render passed the SAME reference: the
    // plan memo never changed identity, the load effect never re-ran, and the scenario in the title —
    // a hook asked again for families it already has — was never constructed. What constructs it is
    // `resolveAppearance`, which builds a fresh `fonts` array on every call, so one keystroke in the
    // theme document hands this hook a plan of new identity naming the same faces. That is the shape
    // the guard being tested exists for, and it is the shape the preview really produces.
    //
    // And `added` grows inside an `async` function that awaits `FontFace.load()`, so no microtask can
    // run between a synchronous `rerender()` and an `expect` on the next line: the count was provably
    // unchanged whatever the hook decided. It is flushed here, as every other counting test in this
    // file flushes.
    const themeText = 'base:\n  font-size: 11\n';
    const { rerender } = renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: resolveAppearance({ themeText, themePath: 'theme/x-theme.yml' }).appearance.fonts,
      }),
    );
    // Settled rather than started: `waitFor(added.length > 0)` is satisfied by the FIRST face to
    // arrive, so a baseline taken there is whatever the loader happened to have reached — an
    // indeterminate number to compare the second count against.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const afterFirst = added.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(inSet.size).toBe(afterFirst);

    for (let keystroke = 0; keystroke < 3; keystroke += 1) act(() => rerender());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(added.length).toBe(afterFirst);
    // And nothing went out either. A set torn down and rebuilt identically registers nothing NEW on
    // balance, so the count alone would not notice it — and it is the expensive half: every face
    // re-created, and every length on the scaled page re-derived from a new metrics object.
    expect(removed).toEqual([]);
    expect(inSet.size).toBe(afterFirst);
  });

  test('a re-render while the faces are still loading leaves them in the document', async () => {
    // The same strand the `assetsHaveSettled` memo was written to remove, reached through a different
    // door — and through the workflow this feature exists for. `resolveAppearance` builds a fresh
    // `fonts` array on every call, so ONE KEYSTROKE in the theme document re-runs this effect with a
    // plan of new identity and identical value, while the sixteen catalogue faces are still being
    // fetched. The re-run found the key already recorded as loaded and returned; the attempt it had
    // just cancelled then deleted every face it had added, and nothing was left to register them
    // again. Reproduced as `faces in document: 0, created: 16, diagnostics: []` — the page drawn in
    // browser substitutes with the theme's metrics applied to them, silently, for the session.
    //
    // Every other case in this file either awaits the load before re-rendering, or passes
    // `defaultAppearance()`'s shared-identity array, so none of them could reach it.
    //
    // Nothing is awaited between the renders on purpose: the loader settles on the microtask queue,
    // so a re-render in this synchronous block is a re-render DURING the load, which is the case.
    const { result, rerender } = renderHook(() =>
      usePrintFonts({
        enabled: true,
        // Resolved per render, which is what the preview does: `defaultAppearance()` hands back one
        // shared object, so a test written against it re-renders with the SAME array and the effect
        // never re-runs at all — which is why every case above missed this.
        fonts: resolveAppearance({ themeText: 'base:\n  font-size: 11\n', themePath: 'theme/x-theme.yml' })
          .appearance.fonts,
      }),
    );
    rerender();
    rerender();

    await waitFor(() => expect(inSet.size).toBeGreaterThan(0));
    // Everything that was created is in the document, and nothing was taken back out of it: one load,
    // adopted. The defect ended with the first two true and the third at zero.
    expect(added.length).toBe(inSet.size);
    expect(removed).toEqual([]);
    expect(result.current.diagnostics).toEqual([]);
  });

  test('a load that fails outright does not leave the plan marked as loaded', async () => {
    // `void loadFontFaces(...)` had no `.catch`, so a rejection left the key recorded as loaded with
    // nothing registered — the same strand again — plus an unhandled rejection. Nothing known throws
    // today; what this pins is that a load which does cannot take the preview's typefaces with it
    // permanently.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = new Uint8Array([1, 2, 3]);
    addThrows = true;
    const { rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({
          enabled: true,
          fonts: [PROJECT_FONT],
          getAssetBytes: () => bytes,
          assetsSettled: () => true,
          ...props,
        }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect([...inSet]).toEqual([]);

    // Whatever it was recovers, and the faces arrive rather than the preview staying in substitutes.
    addThrows = false;
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect([...inSet].map((face) => face.family)).toEqual(['Bespoke']));
    warn.mockRestore();
  });

  test('a load that fails AFTER registering a face takes that face out of the document too', async () => {
    // The `.catch` above releases the in-flight mark, and for a while that was all it did. But
    // `loadFontFaces` hands its faces back only when it RESOLVES: a throw after `fontSet.add` had
    // already accepted one lost the record of it, so `registered.current` never learned it existed
    // and neither the supersede branch nor `unregisterFaces` could ever remove it. It stayed in the
    // document for the life of the page, and every Print → elsewhere → Print cycle stacked another —
    // which is the "two faces of one family in the set, and the page may keep drawing the older one"
    // hazard this hook is otherwise careful about. Measured as: 1 face added, 0 deleted.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let bytes = new Uint8Array([1, 2, 3]);
    addThrowsAfter = 1;
    const { rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({
          enabled: true,
          fonts: [TWO_FACE_PROJECT_FONT],
          getAssetBytes: () => bytes,
          assetsSettled: () => true,
          ...props,
        }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(added).toEqual(['Bespoke']);
    expect(removed).toEqual(['Bespoke']);
    expect([...inSet]).toEqual([]);

    // And the next attempt dresses the page with one full set rather than adding to an orphan.
    addThrowsAfter = Number.POSITIVE_INFINITY;
    bytes = new Uint8Array([4, 5, 6]);
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(inSet.size).toBe(2));
    expect([...inSet].map((face) => face.family)).toEqual(['Bespoke', 'Bespoke']);
    warn.mockRestore();
  });

  test('a load that fails after being superseded takes nothing with it', async () => {
    // The other side of the branch above: the attempt was already replaced — here by the style being
    // switched off — so releasing the in-flight mark would release SOMEBODY ELSE'S. It is left alone.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = new Uint8Array([1, 2, 3]);
    addThrows = true;
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePrintFonts({
          fonts: [PROJECT_FONT],
          getAssetBytes: () => bytes,
          assetsSettled: () => true,
          assetVersion: 1,
          ...props,
        }),
      { initialProps: { enabled: true } },
    );
    // Switched off before the load can fail, so by the time it does nothing is in flight any more.
    act(() => rerender({ enabled: false }));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect([...inSet]).toEqual([]);

    // And the hook is not left believing a load is under way: turning the style back on loads again.
    addThrows = false;
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect([...inSet].map((face) => face.family)).toEqual(['Bespoke']));
    warn.mockRestore();
  });

  test('a stale attempt failing does not cancel the live attempt that replaced it', async () => {
    // Two loads can be in flight at once, working towards the SAME faces. Every place that releases
    // the in-flight mark does so without cancelling the attempt holding it, so switching the Print
    // style off and straight back on inside one load leaves the first attempt running beside the
    // second — and while an attempt was identified by its plan's key, the two were indistinguishable.
    //
    // The first one then failed, released what it took to be its own mark, and the mark it released
    // belonged to the second. The second resolved, found itself apparently superseded, and deleted
    // every face it had just put into the document. Nothing registers them again: `registered` is
    // empty, the plan is unmarked, and no dependency of the load effect ever changes again — so the
    // page is drawn in browser substitutes at the theme's metrics until the theme text is edited or
    // the style is switched off and on. Measured as `inSet = []` with a single benign diagnostic.
    //
    // Every accessor and the font list are declared once, as the preview's own memoised ones are: a
    // fresh array per render would re-run the load effect and start a THIRD attempt, which repairs
    // the page by accident and hides what happened.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = new Uint8Array([1, 2, 3]);
    const fonts = [PROJECT_FONT];
    const getAssetBytes = (): Uint8Array => bytes;
    // The first attempt's registration is refused; the second's is not. The older attempt reaches the
    // font set first, its promise chain being a step ahead of the younger one's at every await.
    addFailuresLeft = 1;

    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePrintFonts({ fonts, getAssetBytes, assetsSettled: ALL_SETTLED, assetVersion: 1, ...props }),
      { initialProps: { enabled: true } },
    );
    // Nothing is awaited between these: the first attempt is still inside its own load, which is what
    // makes the attempt started below a second live one rather than a replacement for a finished one.
    act(() => rerender({ enabled: false }));
    act(() => rerender({ enabled: true }));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The attempt that succeeded keeps what it registered.
    expect([...inSet].map((face) => face.family)).toEqual(['Bespoke']);
    // And it stays that way: there is no later render that would put it right.
    for (let render = 0; render < 3; render++) act(() => rerender({ enabled: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...inSet].map((face) => face.family)).toEqual(['Bespoke']);
    warn.mockRestore();
  });

  test('a font set that will not release a face still adopts the one that replaces it', async () => {
    // `FontFaceSet.delete` is a DOM call, and the adopt branch used to let a refusal from it abandon
    // the adoption halfway: the faces just loaded were never recorded, so nothing could ever remove
    // them, and the throw arrived at the load's `.catch` as a plain `Error` — past the branch that
    // cleans an attempt's faces up. That is the leak `FontLoadFailure` closed, reached through the
    // resolve path. No browser is known to throw here; what is pinned is that one face the document
    // will not give back cannot cost the page the registration that replaces it.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let bytes = new Uint8Array([1, 2, 3]);
    const fonts = [PROJECT_FONT];
    const getAssetBytes = (): Uint8Array => bytes;
    const { rerender, unmount } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({ enabled: true, fonts, getAssetBytes, assetsSettled: ALL_SETTLED, ...props }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(inSet.size).toBe(1));
    const first = [...inSet][0];

    // The author replaces the file, and the set refuses to let go of the face it replaces.
    deleteFailuresLeft = 1;
    bytes = new Uint8Array([4, 5, 6]);
    act(() => rerender({ assetVersion: 2 }));
    await waitFor(() => expect(inSet.size).toBe(2));
    // The adoption completed: this is not a load that failed.
    expect(warn).not.toHaveBeenCalled();

    // And the new face is held, not orphaned — which is only observable by taking it out again.
    unmount();
    expect([...inSet]).toEqual([first]);
    warn.mockRestore();
  });

  test('a caller that supplies no asset reader is told the project face is unavailable', async () => {
    // `getAssetBytes` is optional on the input, and a plan that needs project bytes with no way to
    // reach them is a real configuration — the preview surfaces on pages that have no asset cache.
    // It has to end in a diagnostic rather than in a face registered from nothing.
    const { result } = renderHook(() =>
      usePrintFonts({ enabled: true, fonts: [PROJECT_FONT], assetsSettled: () => true, assetVersion: 1 }),
    );
    await waitFor(() =>
      expect(result.current.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual(['Bespoke']),
    );
    expect(added).toEqual([]);
  });

  test('switching away from the Print style forgets what was loaded', async () => {
    const fonts = defaultAppearance().fonts;
    const { result, rerender } = renderHook((props: { enabled: boolean }) =>
      usePrintFonts({ fonts, ...props }),
    { initialProps: { enabled: true } });
    await waitFor(() => expect(added.length).toBeGreaterThan(0));

    act(() => rerender({ enabled: false }));
    expect(result.current.diagnostics).toEqual([]);
    // And the faces go out of the document with the style, rather than staying in it.
    expect([...inSet]).toEqual([]);
  });

  test('a family nothing can supply is reported without any load being attempted', async () => {
    const { result } = renderHook(() =>
      usePrintFonts({
        enabled: true,
        fonts: [{ family: 'Nonesuch Display', declaredByTheme: false, declaredFaces: {} }],
      }),
    );
    await waitFor(() =>
      expect(result.current.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual([
        'Nonesuch Display',
      ]),
    );
    expect(added).toEqual([]);
  });

  test('an unrelated asset settling does not re-register a project face whose bytes are unchanged', async () => {
    // `assetVersion` counts every asset that settles, images included. Keyed on it, a document with
    // twenty pictures and one project font tore the whole face set down and built it again twenty
    // times as the pictures streamed in — re-parsing the font and re-laying-out the scaled page each
    // time. What may cause a second registration is the FONT's bytes changing, and nothing else.
    const bytes = new Uint8Array([1, 2, 3]);
    const { rerender } = renderHook(
      (props: { assetVersion: number }) =>
        usePrintFonts({
          enabled: true,
          fonts: [PROJECT_FONT],
          getAssetBytes: () => bytes,
          assetsSettled: () => true,
          ...props,
        }),
      { initialProps: { assetVersion: 1 } },
    );
    await waitFor(() => expect(added.length).toBe(1));

    for (let version = 2; version <= 21; version++) act(() => rerender({ assetVersion: version }));
    // Let every load these renders could have started run to completion before counting them. The
    // loader is asynchronous, so counting on the next microtask would find nothing registered yet and
    // pass whatever the hook decided.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(added.length).toBe(1);
    expect(removed).toEqual([]);
    expect([...inSet]).toHaveLength(1);
  });
});

describe('what leaves the document when the hook does', () => {
  test("unmounting takes this hook's faces out of the document", async () => {
    // The preview unmounts on ordinary actions — collapsing the pane, switching to the PDF preview,
    // opening a file that is not AsciiDoc, leaving the project — and the removal used to run only
    // when the Print style was DESELECTED, so each Print → elsewhere → Print cycle left another full
    // set of faces behind. Two faces of one family in the set is a page that may keep drawing the
    // older of the two.
    const fonts = defaultAppearance().fonts;
    const { unmount } = renderHook(() => usePrintFonts({ enabled: true, fonts }));
    await waitFor(() => expect(inSet.size).toBeGreaterThan(0));
    const registered = inSet.size;

    unmount();
    expect([...inSet]).toEqual([]);
    expect(removed.length).toBe(registered);
  });

  test('a mount that is immediately unmounted and mounted again still dresses the page', async () => {
    // What StrictMode does to every mount in development: mount, unmount, mount, in one commit. The
    // ref recording "these faces are already in the document" survives that (it belongs to the fiber,
    // which is reused), so it has to be cleared when the faces go — otherwise the second mount reads
    // it, believes the work is done, and the first mount's in-flight load deletes the faces it added
    // on the way out. The page is then set in whatever the browser has instead.
    const fonts = defaultAppearance().fonts;
    renderHook(() => usePrintFonts({ enabled: true, fonts }), { wrapper: StrictMode });
    // "Still dresses the page" is every family, not one face of one: the failure this guards against
    // deletes faces the second mount believes are already there, and it can leave some of them
    // behind. Asked of the document's own set rather than of the `added` log, because a face that was
    // added and then deleted on the way out is the whole defect.
    await waitFor(() => {
      const registered = new Set([...inSet].map((face) => face.family));
      expect(fonts.map((font) => font.family).filter((family) => !registered.has(family))).toEqual([]);
    });
  });
});
