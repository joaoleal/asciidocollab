'use client';
import { useState, useEffect, useRef } from 'react';
import type {
  FromWorker,
  PdfSourceMap,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderError,
  RenderMode,
  RenderPhase,
  RenderRequest,
  RenderStats,
  ToWorker,
  PdfExtensionBundle,
} from '@asciidocollab/asciidoc-pdf';
import { isProgressMessage, isResultMessage, isErrorMessage } from '@asciidocollab/asciidoc-pdf';
import {
  PDF_PREVIEW_MAX_DEBOUNCE_MS,
  PREVIEW_ADAPTIVE_MIN_MS,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_MAX_WAIT_MS,
} from '@/lib/editor-config';
import { createPdfWorker } from '@/lib/create-pdf-worker';
import { createMaxWaitDebounce, type MaxWaitDebounce } from '@/lib/max-wait-debounce';
import { adaptiveDelayMs, type AdaptiveDelayBounds } from '@/lib/preview/adaptive-delay';
import {
  createMermaidPrerenderer,
  type MermaidPrerenderer,
  type MermaidPrerenderResult,
} from '@/lib/pdf/prerender-mermaid';
import { documentTextOf } from '@/lib/pdf/document-text';

/**
 * The preview surface renders on screen and never runs the (expensive) optimize pass.
 *
 * The mode is otherwise NOT a cheaper render: the engine reads it in exactly one place — to decide
 * whether to emit assembly provenance for scroll sync — so a preview lays out the whole document,
 * every page of it, exactly as an export does.
 */
const PREVIEW_MODE: RenderMode = 'preview';
const PREVIEW_OPTIMIZE = false;

/**
 * The range this surface's derived trailing delay is clamped into. The floor is the web preview's;
 * the ceiling is its own, because a page-formatted render costs orders of magnitude more — see
 * {@link PDF_PREVIEW_MAX_DEBOUNCE_MS}.
 */
const PDF_DELAY_BOUNDS: AdaptiveDelayBounds = {
  minMs: PREVIEW_ADAPTIVE_MIN_MS,
  maxMs: PDF_PREVIEW_MAX_DEBOUNCE_MS,
};

/**
 * A snapshot to render, or a function producing one when the render is actually due.
 *
 * The function form exists because capturing a project snapshot is not free — it copies every project
 * file and re-runs the sandbox guard over every path — while the identity of the thing that triggers a
 * render changes on every keystroke. Handing the hook a factory moves that capture behind the
 * debounce, so it happens once per render instead of once per character. A caller whose snapshot is
 * small (the theme preview's two files) can keep passing the snapshot itself.
 *
 * Either way it is the IDENTITY of what is passed that schedules a render; the value is read only when
 * the debounce fires. Returning `null` from the factory means "nothing to render".
 */
export type PreviewSnapshotSource = ProjectSnapshot | (() => ProjectSnapshot | null);

/** Materialise a snapshot source, whichever form the caller supplied. */
function resolveSnapshot(source: PreviewSnapshotSource): ProjectSnapshot | null {
  return typeof source === 'function' ? source() : source;
}

/** What a pre-pass that failed contributes: nothing to pre-seed, and no reason to stop the render. */
const NO_PRERENDERED_ASSETS: MermaidPrerenderResult = { assets: [], diagnostics: [], aborted: false };

/** Configuration for the live PDF preview hook. */
export interface UsePdfPreviewOptions {
  /**
   * The project state to render, or a factory that produces it when the render is due (see
   * {@link PreviewSnapshotSource}). Each edit should hand the hook a fresh object; changing its
   * identity schedules a debounced preview render. `null` renders nothing (e.g. No document open).
   */
  snapshot: PreviewSnapshotSource | null;
  /** True when the PDF preview panel is open. False cancels any pending render and stops rendering. */
  isEnabled: boolean;
  /**
   * A re-render delta: the project files that changed since the previous render, for a worker that
   * still holds the previous population.
   *
   * It currently saves nothing. A render VM instance serves exactly one render and is replaced before
   * the next — reusing one was measured to grow until it died mid-render — so the filesystem each
   * render sees is empty and the delta is upgraded to a full population every time. Supplying it is
   * still the correct request to make and costs nothing; it simply has nothing to skip today. Leave
   * unset for a full render.
   */
  changedPaths?: readonly string[];
  /**
   * The mermaid pre-pass driver. Mermaid needs a DOM the PDF worker lacks, so its diagrams are rendered
   * on the main thread and pre-seeded into the worker's asset cache. Defaults to a real coalescing
   * prerenderer; unit tests inject a deterministic one (fake engine + synchronous idle scheduler).
   */
  prerenderer?: MermaidPrerenderer;
  /**
   * The catalogue and Ruby source for the extensions `snapshot.enabledExtensions` names.
   *
   * Rides on the request rather than being worker state: a render posted before a separate
   * "here are the extensions" message landed would render silently without them, which is output
   * that looks correct and is not. Omit when the caller has no project context.
   */
  extensions?: PdfExtensionBundle;
}

/** Return value of {@link usePdfPreview}, shaped for the PDF preview panel. */
export interface UsePdfPreviewResult {
  /** The most recent successfully rendered PDF, or undefined before the first render completes. */
  pdf?: Blob;
  /** True while a preview render is in flight. */
  isRendering: boolean;
  /** The most recent render phase reported by the worker, when known. */
  phase?: RenderPhase;
  /** Non-fatal per-resource diagnostics gathered while producing the latest preview. */
  diagnostics: readonly RenderDiagnostic[];
  /** The last whole-render failure, or undefined when the latest render succeeded. */
  error?: RenderError;
  /**
   * The engine-emitted block source map for the latest preview, when one was produced. Drives the
   * panel's accurate editor→PDF scroll sync; undefined when the render carried no map (the panel then
   * falls back to a proportional sync).
   */
  sourceMap?: PdfSourceMap;
  /**
   * What the latest successful render cost, as the engine measured it, or undefined before the first
   * one completes. The worker has always computed these figures and the result frame has always
   * carried them; nothing on the main thread read them, so no one could see what a render cost.
   */
  stats?: RenderStats;
  /**
   * The snapshot the current {@link pdf} and {@link sourceMap} were produced from — NOT the caller's
   * latest state, which has usually moved on since.
   *
   * Anything derived from the render (notably the include assembly the scroll sync reverse-maps
   * through) has to be computed against this, for two reasons. It is the only version those engine
   * coordinates describe: assembling the live text instead lines a source map up against a document it
   * was not made from. And it changes once per completed render rather than once per keystroke, which
   * is the difference between assembling the whole include tree a few times a minute and doing it ten
   * times a second while someone types.
   */
  renderedSnapshot?: ProjectSnapshot;
}

/**
 * Drives a live, warm-VM PDF preview. A single Web Worker is created on mount and warmed up front so
 * the first real render is fast; every subsequent edit debounces into one render and is tagged with a
 * monotonic `requestId`, so superseded progress/result/error frames are discarded (staleness guard).
 * All heavy work happens in the worker — the hook only posts requests and stores the frames it gets
 * back, so it never blocks the main thread.
 *
 * **At most one render is ever outstanding.** A page-formatted render takes seconds and cannot be
 * interrupted once it starts: the convert is a single synchronous call into the engine, so a request
 * that has been superseded is still paid for in full before anyone notices. Posting a second render
 * while one is running therefore buys nothing and costs a great deal — and costs more than double,
 * because the engine retires a VM instance after each render precisely so that no two renders share
 * one, an invariant a concurrent pair can slip past. So a refresh that comes due while a render is
 * outstanding is HELD, not posted, and the newest held state is what goes out the moment that render
 * reports back — a result or an error alike. Nothing is dropped and nothing stacks.
 *
 * The debounce's own in-progress handling covers the same ground for its maximum-wait cap; this covers
 * the trailing timer too, which deliberately does not consult it (holding the trailing timer back
 * globally would make an explicit, non-typing trigger wait on a run that may never report back — see
 * the debounce). Here that risk is answered by holding at the hook level instead, where a disable or
 * an unmount clears the hold outright.
 */
export function usePdfPreview({
  snapshot,
  isEnabled,
  changedPaths,
  prerenderer,
  extensions,
}: UsePdfPreviewOptions): UsePdfPreviewResult {
  const [pdf, setPdf] = useState<Blob | undefined>(undefined);
  const [isRendering, setIsRendering] = useState(false);
  const [phase, setPhase] = useState<RenderPhase | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<readonly RenderDiagnostic[]>([]);
  const [error, setError] = useState<RenderError | undefined>(undefined);
  const [sourceMap, setSourceMap] = useState<PdfSourceMap | undefined>(undefined);
  const [stats, setStats] = useState<RenderStats | undefined>(undefined);
  const [renderedSnapshot, setRenderedSnapshot] = useState<ProjectSnapshot | undefined>(undefined);

  // Read at post time rather than captured, so the debounced render that eventually fires carries the
  // CURRENT bundle. A bundle arriving while a render was already queued must not send stale sources.
  const extensionsReference = useRef(extensions);
  extensionsReference.current = extensions;

  // The changed-path delta is read lazily at render time so supplying it never independently triggers
  // a render — the snapshot's identity change is the sole render trigger, matching the editor's flow.
  const changedPathsReference = useRef(changedPaths);
  changedPathsReference.current = changedPaths;

  const workerReference = useRef<Worker | null>(null);
  // Monotonic counter; its stringified value is the current request's staleness key.
  const requestCounterReference = useRef(0);
  const latestRequestIdReference = useRef<string | null>(null);
  const debounceReference = useRef<MaxWaitDebounce | null>(null);
  if (debounceReference.current === null) {
    debounceReference.current = createMaxWaitDebounce(PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS);
  }

  // One stable, coalescing mermaid pre-pass for the hook's lifetime (its token state must persist so a
  // newer invocation supersedes an in-flight one). Injected in tests; a real one otherwise.
  const prerendererReference = useRef<MermaidPrerenderer | null>(null);
  if (prerendererReference.current === null) {
    prerendererReference.current = prerenderer ?? createMermaidPrerenderer();
  }
  // Aborts the pre-pass of a render that a newer edit (or a disable) has superseded.
  const prerenderAbortReference = useRef<AbortController | null>(null);

  // True from the moment a request is POSTED until the worker reports back on it. Deliberately not
  // the same thing as `isRendering`, which covers the main-thread pre-pass before the post as well:
  // during that window nothing has been handed to the engine yet, so a newer edit is free to
  // supersede the pre-pass outright rather than queue behind a render that has not started.
  const renderOutstandingReference = useRef(false);
  // The newest state that came due while a render was outstanding, waiting for it to report back.
  const heldSourceReference = useRef<PreviewSnapshotSource | null>(null);
  // The snapshot the outstanding request was posted with, promoted to state when its result lands so
  // what the preview shows and what callers derive from it are the same document.
  const postedSnapshotReference = useRef<ProjectSnapshot | null>(null);
  // What the last SUCCESSFUL render cost, which is what the trailing delay is derived from. A failure
  // leaves it alone: it carries no measurement, and the failure path is usually fast enough to read as
  // "this document is cheap" precisely when nothing has been observed.
  const lastRenderMsReference = useRef<number | null>(null);
  // The worker's message listener is registered once, on mount, so it reaches the CURRENT release
  // routine through this reference rather than closing over the first render's copy of it.
  const settleRenderReference = useRef<() => void>(() => {});

  // Mount the single warm worker; warm the VM up front; tear it down on unmount.
  useEffect(() => {
    const worker = createPdfWorker();
    workerReference.current = worker;

    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      const messageRequestId = isResultMessage(message)
        ? message.result.requestId
        : (isErrorMessage(message)
          ? message.error.requestId
          : message.requestId);
      if (messageRequestId !== latestRequestIdReference.current) return; // stale — discard

      if (isProgressMessage(message)) {
        setPhase(message.phase);
        return;
      }
      if (isResultMessage(message)) {
        setPdf(message.result.pdf);
        setDiagnostics(message.result.diagnostics);
        setSourceMap(message.result.sourceMap);
        setStats(message.result.stats);
        setRenderedSnapshot(postedSnapshotReference.current ?? undefined);
        setError(undefined);
        setIsRendering(false);
        lastRenderMsReference.current = message.result.stats.renderMs;
      } else if (isErrorMessage(message)) {
        setError(message.error);
        setIsRendering(false);
      }
      settleRenderReference.current();
    });

    worker.postMessage({ type: 'warmup' } satisfies ToWorker);

    return () => {
      worker.terminate();
      workerReference.current = null;
    };
  }, []);

  // Start a render for `source` now, unless one is already outstanding — in which case `source`
  // becomes the held state and goes out when that render reports back.
  //
  // The snapshot is materialised HERE, not when the render was scheduled: for the document preview
  // that capture walks the whole project, and doing it per keystroke would spend more on preparing
  // renders than on running them.
  //
  // When the debounce fires, a main-thread mermaid pre-pass renders the document's diagrams and its
  // assets pre-seed the worker's cache. Cancellation rides supersession: each fresh render aborts the
  // previous pre-pass, and a resolved pre-pass posts only while it is still the latest — so a
  // superseded pre-pass can never overwrite a newer preview, and an edit arriving while the pre-pass
  // is still running replaces it outright rather than queueing behind it (nothing has been handed to
  // the engine yet, so there is nothing to wait for).
  const startRender = (source: PreviewSnapshotSource) => {
    if (renderOutstandingReference.current) {
      heldSourceReference.current = source;
      return;
    }
    const pending = resolveSnapshot(source);
    if (pending === null) return;

    requestCounterReference.current += 1;
    const requestId = String(requestCounterReference.current);
    latestRequestIdReference.current = requestId;
    setPhase(undefined);
    setError(undefined);
    setIsRendering(true);

    // Supersede any still-in-flight pre-pass so its (now stale) result can never post.
    prerenderAbortReference.current?.abort();
    const controller = new AbortController();
    prerenderAbortReference.current = controller;

    const delta = changedPathsReference.current;
    void prerendererReference.current!
      .prerender(documentTextOf(pending), { signal: controller.signal })
      // The pre-pass is main-thread work that can fail on its own terms — the mermaid engine failing
      // to load, a block the detector chokes on. Its failure must not take the render with it: the
      // render is posted anyway, simply with nothing pre-seeded, and the worker's own mermaid handling
      // surfaces a per-block diagnostic. Left unhandled this rejected before anything was posted, so
      // no worker reply was ever coming to clear the rendering state — the panel stayed pinned on
      // "rendering", and the in-progress flag latched with it, quietly retiring the maximum-wait
      // refresh guarantee for the rest of the session.
      .catch(() => NO_PRERENDERED_ASSETS)
      .then((prerendered) => {
        // Drop a superseded pre-pass: a newer render (or a disable) has taken over since it began.
        if (prerendered.aborted || latestRequestIdReference.current !== requestId) return;
        const request: RenderRequest = {
          requestId,
          mode: PREVIEW_MODE,
          snapshot: pending,
          optimize: PREVIEW_OPTIMIZE,
          ...(delta === undefined ? {} : { changedPaths: delta }),
          ...(prerendered.assets.length > 0 ? { generatedAssets: prerendered.assets } : {}),
          ...(extensionsReference.current === undefined
            ? {}
            : { extensions: extensionsReference.current }),
        };
        renderOutstandingReference.current = true;
        postedSnapshotReference.current = pending;
        workerReference.current?.postMessage({ type: 'render', request } satisfies ToWorker);
      });
  };

  // The outstanding render has reported back. Release the hold and, if anything came due meanwhile,
  // render it straight away rather than making it wait out another debounce window — it has already
  // waited for a whole render.
  const settleRender = () => {
    renderOutstandingReference.current = false;
    const held = heldSourceReference.current;
    // Nothing came due while the render ran, so there is nothing to release and the debounce keeps
    // whatever schedule it is on. Its pending run, if it has one, is still waiting out a pause that
    // has not finished — forcing it here would mean every completed render immediately started the
    // next one, which is the debounce not happening at all.
    if (held === null) return;
    heldSourceReference.current = null;
    // Between the held state and whatever the debounce is still holding, the debounce's is the newer:
    // a run can only have been scheduled AFTER the state it superseded was set aside, since being set
    // aside is what the debounce firing did. So it is preferred, and firing it now is right — it has
    // already waited out a whole render. Firing also starts a fresh burst window: the burst it was
    // measuring ends here.
    //
    // Cancelling it instead, and rendering the held state, is how an edit went missing. The held
    // state went out, the newer edit behind it was thrown away with the run that carried it, and
    // nothing ever rescheduled it — so the preview sat showing a document one edit out of date, and
    // reporting itself up to date, until the author happened to type again.
    if (debounceReference.current?.flush() === true) return;
    startRender(held);
  };
  settleRenderReference.current = settleRender;

  // Debounce + coalesce: only the latest source is ever sent, after a pause derived from what the last
  // render actually cost (see `adaptiveDelayMs`) rather than a figure fixed for every document.
  const scheduleRender = (source: PreviewSnapshotSource) => {
    debounceReference.current?.schedule(
      () => startRender(source),
      adaptiveDelayMs(lastRenderMsReference.current, PDF_DELAY_BOUNDS),
    );
  };

  // Enable/disable: cancel any pending render and stop rendering when the panel closes; start a fresh
  // render when it (re)opens with a snapshot available.
  useEffect(() => {
    if (!isEnabled) {
      debounceReference.current?.cancel();
      // Cancel a pre-pass that already started so it can't post after the panel closes.
      prerenderAbortReference.current?.abort();
      setIsRendering(false);
      // The state that came due while a render was running is dropped: nobody is looking at the panel
      // any more, and reopening it schedules a render of whatever the document is by then.
      //
      // The HOLD itself deliberately survives. Closing the panel does not reach into the engine — the
      // convert is one synchronous call and the worker lives until unmount — so the render is still
      // running, and its VM instance is still the one that must not be shared. Cleared here, reopening
      // inside that window posted a second render which the worker queued BEHIND the abandoned one, so
      // the first refresh cost two full page renders and the abandoned one was paid for in full
      // anyway. Kept, the reopened panel holds instead, and goes out the moment the render reports.
      // Nothing is stranded by that: no newer request is issued while the panel is closed, so the
      // outstanding render is still the latest and its reply is not discarded as stale — it settles
      // the hold on the way through.
      heldSourceReference.current = null;
      return;
    }
    if (snapshot === null) return;
    scheduleRender(snapshot);
  }, [isEnabled]);

  // Debounce snapshot changes (the primary edit-driven render trigger).
  //
  // Deliberately WITHOUT a cleanup. React runs an effect's cleanup before every re-run, so cancelling
  // here would cancel on every edit — which clears the max-wait cap along with the trailing timer and
  // re-arms it from zero, so the cap could never elapse and the preview never refreshed during
  // sustained typing. It also bought nothing: schedule() already replaces the pending run and restarts
  // the trailing timer, which is all per-edit cancellation was ever achieving. Cancellation belongs to
  // unmount alone, below.
  useEffect(() => {
    if (!isEnabled || snapshot === null) return;
    scheduleRender(snapshot);
  }, [snapshot]);

  // Mirror the render lifecycle into the debounce: while one is in flight the max-wait cap holds its
  // run back instead of stacking a second render on it, and reporting completion — a result or an
  // error alike, both of which clear `isRendering` — releases the held-back refresh immediately.
  // Without that release the guarantee would fire once and then lapse for the rest of the session.
  useEffect(() => {
    debounceReference.current?.setInProgress(isRendering);
  }, [isRendering]);

  // Drop any pending render when the hook goes away, so nothing fires into a torn-down component.
  useEffect(() => () => debounceReference.current?.cancel(), []);

  return { pdf, isRendering, phase, diagnostics, error, sourceMap, stats, renderedSnapshot };
}
