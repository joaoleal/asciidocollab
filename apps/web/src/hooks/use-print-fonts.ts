'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppearanceDiagnostic, FontRequirement } from '@asciidocollab/shared';
import { FontLoadFailure, loadFontFaces, planFontFaces } from '@/lib/print-preview/font-faces';
import { NO_FACE_METRICS, resolveFaceMetrics } from '@/lib/print-preview/font-metrics';
import type { FaceBoxLookup } from '@/lib/print-preview/font-metrics';

/**
 * Load the typefaces the Print preview's appearance references, and report what could not be loaded.
 *
 * The project's own faces come through the application's existing asset mechanism, which the caller
 * owns — this hook is given the two accessors it needs rather than building a reader of its own, so
 * a project font travels the same validated path as every image the PDF pipeline loads.
 *
 * Loading is idempotent per plan: the same set of faces is never registered twice, because a
 * document being typed re-renders the preview constantly and the fonts do not change with it.
 */

/** What to load, and how to reach the bytes. */
export interface PrintFontsInput {
  /** Whether the Print style is selected. Nothing is fetched or registered when it is not. */
  readonly enabled: boolean;
  /** The families the resolved appearance references. */
  readonly fonts: readonly FontRequirement[];
  /** The theme document's path, which its font catalogue's own paths are relative to. */
  readonly themePath?: string;
  /**
   * Schedule background fetches for the project asset paths the plan needs.
   *
   * @param paths - Project-relative paths.
   */
  readonly ensureAssets?: (paths: readonly string[]) => void;
  /**
   * The bytes of one fetched project asset, or undefined when it is not held.
   *
   * @param path - The project-relative path.
   * @returns The asset's bytes, if they have arrived.
   */
  readonly getAssetBytes?: (path: string) => Uint8Array | undefined;
  /** Bumps whenever an asset fetch settles, so the load is retried once the bytes are in. */
  readonly assetVersion?: number;
  /**
   * Whether every one of these paths has been answered — with bytes, or with a failure.
   *
   * A project face whose fetch is still in flight is not a face that could not be loaded; without
   * this the preview would warn about an approximation for every project font on the way to showing
   * the real one.
   *
   * @param paths - Project-relative paths.
   * @returns Whether all of them have settled.
   */
  readonly assetsSettled?: (paths: readonly string[]) => boolean;
}

/** What the load produced. */
export interface PrintFonts {
  /**
   * One per family that could not be supplied. Empty when every family loaded.
   *
   * The families drawn in an approximation are named here and nowhere else. They were also published
   * as a parallel list of family names, which nothing outside this module's own tests ever read: the
   * preview presents these diagnostics, and each of them already carries the family it is about as
   * its `resource`.
   */
  readonly diagnostics: readonly AppearanceDiagnostic[];
  /**
   * The vertical measurements of each face the appearance references.
   *
   * The page needs them as well as the file: the renderer's line box is the face's own height plus
   * the theme's leading, and every box it paints around a run of text is measured from that face's
   * ascender and descender. A preview with the right typeface and none of its numbers still sets its
   * lines at the wrong distance apart and tints the wrong depth behind its codespans.
   */
  readonly faceBox: FaceBoxLookup;
}

/** What the asynchronous load settled on, before the synchronously-known metrics are added to it. */
interface LoadedFamilies {
  /** One per family that could not be supplied. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

/** Nothing loaded, nothing wrong — the state while another preview style is selected. */
const NO_FAMILIES: LoadedFamilies = { diagnostics: [] };

/**
 * Identity tokens for asset byte arrays, so "these are the same bytes as last time" can be asked
 * without hashing a font file on every render.
 *
 * The asset cache holds one `Uint8Array` per path and hands the same instance back until the bytes
 * are replaced (a project switch empties it), so instance identity IS the answer. A `WeakMap` keeps
 * the tokens from holding any font in memory after the cache has let go of it, and asking twice for
 * one array always gives the same token — so this is a memo, not a state, and reading it during a
 * render that is later thrown away changes nothing.
 */
const byteTokens = new WeakMap<Uint8Array, number>();
let nextByteToken = 0;

/**
 * Take faces back out of the document's font set, every one of them.
 *
 * `FontFaceSet.delete` is a DOM call, and a refusal from it used to travel further than the face it
 * was about. From the supersede branch it reached the load's `.catch` as an ordinary `Error`, which
 * skips the cleanup that branch is there to perform; from the adopt branch it abandoned the adoption
 * halfway — the faces just loaded never recorded in `registered`, the plan never marked as loaded, and
 * the faces of both attempts left in the document with nothing holding a reference to either. That is
 * the leak the `FontLoadFailure` list closed, reached through the resolve path instead.
 *
 * A face the set will not release cannot be released by anyone. What the faces beside it can do about
 * that is go out anyway.
 *
 * @param fontSet - The document's font set.
 * @param faces - The faces to remove from it.
 */
function removeFaces(fontSet: FontFaceSet, faces: readonly FontFace[]): void {
  for (const face of faces) {
    try {
      fontSet.delete(face);
    } catch {
      // Nothing here can make the set give a face back, and nothing here should stop the next one.
    }
  }
}

/**
 * A stable token for one asset's bytes.
 *
 * @param bytes - The bytes held for a path, or undefined when none are.
 * @returns A token that changes only when the bytes are a different array.
 */
function byteToken(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return 'absent';
  const existing = byteTokens.get(bytes);
  if (existing !== undefined) return String(existing);
  nextByteToken += 1;
  byteTokens.set(bytes, nextByteToken);
  return String(nextByteToken);
}

/**
 * Load the appearance's typefaces into the document.
 *
 * @param input - What to load and how to reach project bytes.
 * @returns Which families fell back, and what to report about them.
 */
export function usePrintFonts(input: PrintFontsInput): PrintFonts {
  const { enabled, fonts, themePath, ensureAssets, getAssetBytes, assetVersion, assetsSettled } =
    input;
  const [result, setResult] = useState<LoadedFamilies>(NO_FAMILIES);
  // The plan whose faces are IN the document right now, so a re-render with the same fonts registers
  // nothing again. Written when a load has finished and its faces have been adopted — never before.
  //
  // It used to be written when the load STARTED, and that stranded the preview in browser substitutes
  // for the rest of the session. A re-render while the fetches were in flight cancelled the attempt
  // and re-ran the effect; the re-run found this already set to the very key it was about to load and
  // returned; the cancelled attempt then deleted every face it had added. Nothing was left to register
  // them again. One keystroke in the theme document was enough to reach it, because `resolveAppearance`
  // builds a fresh `fonts` array on every call, so the effect re-runs with a same-valued key while the
  // sixteen catalogue faces are still being fetched.
  const loadedKey = useRef<string | null>(null);
  // The live load: which plan it is working towards, and which ATTEMPT is doing the working. Null when
  // no load is under way.
  //
  // The key is what makes a re-render that wants exactly the faces already being fetched leave them
  // alone: an attempt is superseded when something else has taken over the load — a different plan,
  // the style being switched off, the hook going away — and NOT merely because the effect that started
  // it was torn down.
  //
  // The attempt token is what makes "this attempt" a thing an attempt can ask about ITSELF. Identity
  // rather than value, because two live attempts can share a key: every place that releases the mark
  // does so without cancelling anything, so switching the Print style off and straight back on while
  // the first load is still in flight leaves two attempts running towards the same faces. Compared by
  // key alone they were indistinguishable, and the older one's failure released the younger one's
  // mark — after which the younger one, finding itself apparently superseded, deleted every face it
  // had just registered. Nothing was left to register them again and no dependency here changes to
  // start another load, so the page stayed in browser substitutes for the session.
  const inFlight = useRef<{ readonly key: string; readonly attempt: symbol } | null>(null);
  // What this hook put into the document's font set, so it can take it back out. See `LoadedFonts.added`.
  const registered = useRef<readonly FontFace[]>([]);

  const plan = useMemo(
    () => (enabled ? planFontFaces(fonts, themePath ?? '') : null),
    [enabled, fonts, themePath],
  );

  // What the plan's FONT bytes currently are, as a value that changes when they do and at no other
  // time.
  //
  // `assetVersion` cannot be that value: it counts every asset that settles, images included, so a
  // document with twenty pictures and one project face bumps it twenty times while the font stands
  // still. Keyed on it, the whole face set was deleted and registered again once per picture — and
  // `faceMetrics` and the CSS projection built from it changed identity alongside, re-laying out the
  // scaled page each time. It is still the SIGNAL to look again (nothing else says bytes have
  // arrived); it is just not the answer.
  const assetKey = useMemo(
    () =>
      plan === null
        ? ''
        : plan.assetPaths.map((path) => `${path}@${byteToken(getAssetBytes?.(path))}`).join(','),
    // `assetVersion` is read by nothing here on purpose: it is what makes this look again.
    [plan, assetVersion, getAssetBytes],
  );

  // Whether every project asset this plan needs has been ANSWERED — with bytes, or with a failure.
  //
  // Held as a value React can compare, because the accessor cannot be: `assetsSettled` is a callback
  // over the cache's refs, so its identity never changes and its answer changes without React being
  // told. Nothing else here can stand in for it either. A fetch that comes back EMPTY leaves the bytes
  // absent, so `assetKey` reads `path@absent` — character for character what it read while the fetch
  // was still in flight — and `assetVersion` is only an input to that key. So the load effect, which
  // gives up and returns while the assets have not settled, had nothing to bring it back: it never ran
  // again, and the gate is per-PLAN, so the catalogue faces beside the failed project one were never
  // registered either. The page was drawn in browser substitutes with the theme's metrics and leading
  // applied to them, and the diagnostics surface said nothing was wrong, until the theme text changed
  // or the style was switched off and on.
  //
  // A boolean is safe to key the load on where `assetVersion` is not: it moves from false to true once
  // per plan and never back, so it cannot tear the face set down and build it again per picture.
  const assetsHaveSettled = useMemo(
    () => plan === null || plan.assetPaths.length === 0 || assetsSettled?.(plan.assetPaths) !== false,
    // `assetVersion` is read by nothing here on purpose: it is what makes this look again.
    [plan, assetVersion, assetsSettled],
  );

  // Read synchronously rather than alongside the load: a catalogue face's metrics are in the
  // committed manifest and need no fetch at all, so waiting for the loader would lay the first paint
  // out with the wrong leading and then move every line of the page once the faces arrived.
  //
  // Keyed on the bytes rather than on the plan alone, because a project face's bytes arrive later
  // than the plan does and the accessor's identity does not change when they do — without that, a
  // project font would be drawn at the catalogue's rhythm for the rest of the session.
  const faceMetrics = useMemo(
    () =>
      plan === null
        ? { boxOf: NO_FACE_METRICS, overridesOf: () => undefined, diagnostics: [] }
        : resolveFaceMetrics(plan, (path) => getAssetBytes?.(path)),
    [plan, assetKey, getAssetBytes],
  );

  useEffect(() => {
    if (plan === null || plan.assetPaths.length === 0) return;
    ensureAssets?.(plan.assetPaths);
  }, [plan, ensureAssets]);

  useEffect(() => {
    if (plan === null) {
      loadedKey.current = null;
      inFlight.current = null;
      setResult(NO_FAMILIES);
      return;
    }
    if (typeof document === 'undefined' || document.fonts === undefined) return;

    // What is registered is a function of the planned faces and the bytes behind them, so the key is
    // exactly those two things. A plan of catalogue faces has no bytes to speak of and its key never
    // changes at all.
    const key = `${assetKey}|${plan.faces.map((face) => `${face.family}/${face.style}/${face.source}`).join(',')}`;
    // Already in the document, or already on its way there. Either way there is nothing to start.
    if (loadedKey.current === key || inFlight.current?.key === key) return;

    // A project face whose bytes have not arrived is not a face that failed. Waiting for the fetch to
    // settle is what keeps "an approximation is shown" a statement about a font that is genuinely
    // unavailable rather than about one that is merely still on its way.
    //
    // Read from `assetsHaveSettled` rather than by calling the accessor, so that giving up here leaves
    // something behind that changes when the answer does. See its declaration.
    if (!assetsHaveSettled) return;
    // This attempt, as something only this attempt holds. See {@link inFlight}.
    const attempt = Symbol('print-fonts-load');
    inFlight.current = { key, attempt };
    // The set this attempt registered into is the set it has to be removable from, whatever the
    // document does afterwards.
    const fontSet = document.fonts;

    void loadFontFaces(plan, {
      getAssetBytes: (path) => getAssetBytes?.(path),
      fontSet,
      createFace: (family, source, descriptors) => new FontFace(family, source, descriptors),
      // The renderer's own reading of each file's vertical metrics, declared on the face rather than
      // left to the browser's: the two read different tables, and in the gem's catalogue they
      // disagree by a third of an em. One lookup answers for both of a face's registrations — see
      // `faceLineOverrides` and `faceBoxOverrides` in font-metrics.ts.
      metricOverridesOf: faceMetrics.overridesOf,
    })
      .then((loaded) => {
        // Something else has taken over since this started — a newer plan, the style being switched
        // off, or the hook unmounting, each of which leaves `inFlight` holding something other than
        // this attempt. Its own faces go back out; nobody else's are touched.
        if (inFlight.current?.attempt !== attempt) {
          removeFaces(fontSet, loaded.added);
          return;
        }
        // Out with the previous registration before the new one takes over. Two faces of one family in
        // the set is a page that may keep drawing the older of the two.
        //
        // What this attempt loaded is recorded FIRST, and the faces it replaces are taken out after:
        // a face that is in the document and in no list is a face nothing can ever remove, so the
        // window in which that is true of the new ones is closed before anything else is attempted.
        const superseded = registered.current;
        registered.current = loaded.added;
        inFlight.current = null;
        loadedKey.current = key;
        removeFaces(fontSet, superseded);
        setResult({ diagnostics: loaded.diagnostics });
      })
      .catch((error: unknown) => {
        // Not a font that failed — `loadFontFaces` reports those as diagnostics and resolves — so a
        // rejection here is this module being wrong about something. What must not happen either way
        // is the plan being left marked as loaded with nothing registered, which is the strand above
        // reached through a second door. Releasing the mark lets the next change try again.
        //
        // This attempt's own mark, compared by identity: released by key it released whichever attempt
        // happened to be live, and a live attempt whose mark is gone throws its own faces away.
        if (inFlight.current?.attempt === attempt) inFlight.current = null;
        // And whatever this attempt had already put into the document goes back out with it. A load
        // that throws AFTER registering a family — the font set refusing a later face, a metric
        // lookup throwing — used to leave those faces behind with nothing holding a reference to
        // them: `registered.current` never learned of them, so neither the supersede branch nor
        // `unregisterFaces` could ever remove them, and every Print → elsewhere → Print cycle stacked
        // another set. They are this attempt's own, never a live registration's: the faces the page is
        // drawing with are in `registered.current`, which a failed attempt never reaches.
        if (error instanceof FontLoadFailure) {
          removeFaces(fontSet, error.added);
        }
        // eslint-disable-next-line no-console -- a load that neither registered a face nor reported one.
        console.warn('The Print preview could not load its typefaces.', error);
      });
  }, [plan, assetKey, getAssetBytes, assetsHaveSettled, faceMetrics]);

  // Leaving the Print style, or leaving the page, takes this hook's faces out of the document with it.
  //
  // The key goes with them. It is the record that these faces are ALREADY in the document, and once
  // they are not, a hook that mounts again has to register them again — which is also what makes a
  // StrictMode remount (mount, unmount, mount, in one commit, on every development render) come back
  // with a page that has its typefaces.
  const unregisterFaces = useCallback(() => {
    if (typeof document === 'undefined' || document.fonts === undefined) return;
    const held = registered.current;
    registered.current = [];
    loadedKey.current = null;
    // A load still in flight is superseded by this rather than by its own effect being torn down, so
    // releasing the mark here is what stops it registering its faces into a document that has just
    // been cleared of them — and it is the only thing that does. See {@link inFlight}.
    inFlight.current = null;
    removeFaces(document.fonts, held);
  }, []);

  useEffect(() => {
    // Leaving the style: take them out now, and there is nothing to undo later.
    if (!enabled) {
      unregisterFaces();
      return;
    }
    // Leaving the page: the cleanup is the only thing that runs on unmount, and without one every
    // Print → elsewhere → Print cycle left another full set of faces behind. Two faces of one family
    // in the document's set is a page that may keep drawing the older of the two.
    return unregisterFaces;
  }, [enabled, unregisterFaces]);

  return useMemo(() => {
    // A family already reported as unavailable is one problem, not two. A file the browser will not
    // decode is also a file no metrics can be read out of, and telling an author twice about one
    // broken font would make the count in the diagnostics panel say something untrue.
    const reported = new Set(result.diagnostics.map((diagnostic) => diagnostic.resource));
    return {
      diagnostics: [
        ...result.diagnostics,
        ...faceMetrics.diagnostics.filter((diagnostic) => !reported.has(diagnostic.resource)),
      ],
      faceBox: faceMetrics.boxOf,
    };
  }, [result, faceMetrics]);
}
