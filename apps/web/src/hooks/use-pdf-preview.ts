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
  ToWorker,
} from '@asciidocollab/asciidoc-pdf';
import { isProgressMessage, isResultMessage, isErrorMessage } from '@asciidocollab/asciidoc-pdf';
import { PREVIEW_DEBOUNCE_MS } from '@/lib/editor-config';
import { createPdfWorker } from '@/lib/create-pdf-worker';
import { createMermaidPrerenderer, type MermaidPrerenderer } from '@/lib/pdf/prerender-mermaid';

/** The preview surface renders a page-limited PDF and never runs the (expensive) optimize pass. */
const PREVIEW_MODE: RenderMode = 'preview';
const PREVIEW_OPTIMIZE = false;

/** The document text the mermaid pre-pass scans — the render root file's contents. */
function documentTextOf(snapshot: ProjectSnapshot): string {
  return snapshot.files[snapshot.rootPath] ?? '';
}

/** Configuration for the live PDF preview hook. */
export interface UsePdfPreviewOptions {
  /**
   * The project state to render. Each edit should hand the hook a fresh snapshot object; changing its
   * identity schedules a debounced preview render. `null` renders nothing (e.g. No document open).
   */
  snapshot: ProjectSnapshot | null;
  /** True when the PDF preview panel is open. False cancels any pending render and stops rendering. */
  isEnabled: boolean;
  /**
   * Warm re-render delta: the project files that changed since the previous render. The caller diffs
   * successive snapshots and supplies the affected paths so the worker rewrites only those `/project`
   * files instead of repopulating the whole VFS. Leave unset for a full render (e.g. The first one).
   */
  changedPaths?: readonly string[];
  /**
   * The mermaid pre-pass driver. Mermaid needs a DOM the PDF worker lacks, so its diagrams are rendered
   * on the main thread and pre-seeded into the worker's asset cache. Defaults to a real coalescing
   * prerenderer; unit tests inject a deterministic one (fake engine + synchronous idle scheduler).
   */
  prerenderer?: MermaidPrerenderer;
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
}

/**
 * Drives a live, warm-VM PDF preview. A single Web Worker is created on mount and warmed up front so
 * the first real render is fast; every subsequent edit debounces into one render and is tagged with a
 * monotonic `requestId`, so superseded progress/result/error frames are discarded (staleness guard).
 * All heavy work happens in the worker — the hook only posts requests and stores the frames it gets
 * back, so it never blocks the main thread.
 */
export function usePdfPreview({
  snapshot,
  isEnabled,
  changedPaths,
  prerenderer,
}: UsePdfPreviewOptions): UsePdfPreviewResult {
  const [pdf, setPdf] = useState<Blob | undefined>(undefined);
  const [isRendering, setIsRendering] = useState(false);
  const [phase, setPhase] = useState<RenderPhase | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<readonly RenderDiagnostic[]>([]);
  const [error, setError] = useState<RenderError | undefined>(undefined);
  const [sourceMap, setSourceMap] = useState<PdfSourceMap | undefined>(undefined);

  // The changed-path delta is read lazily at render time so supplying it never independently triggers
  // a render — the snapshot's identity change is the sole render trigger, matching the editor's flow.
  const changedPathsReference = useRef(changedPaths);
  changedPathsReference.current = changedPaths;

  const workerReference = useRef<Worker | null>(null);
  // Monotonic counter; its stringified value is the current request's staleness key.
  const requestCounterReference = useRef(0);
  const latestRequestIdReference = useRef<string | null>(null);
  const debounceReference = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One stable, coalescing mermaid pre-pass for the hook's lifetime (its token state must persist so a
  // newer invocation supersedes an in-flight one). Injected in tests; a real one otherwise.
  const prerendererReference = useRef<MermaidPrerenderer | null>(null);
  if (prerendererReference.current === null) {
    prerendererReference.current = prerenderer ?? createMermaidPrerenderer();
  }
  // Aborts the pre-pass of a render that a newer edit (or a disable) has superseded.
  const prerenderAbortReference = useRef<AbortController | null>(null);

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
      } else if (isResultMessage(message)) {
        setPdf(message.result.pdf);
        setDiagnostics(message.result.diagnostics);
        setSourceMap(message.result.sourceMap);
        setError(undefined);
        setIsRendering(false);
      } else if (isErrorMessage(message)) {
        setError(message.error);
        setIsRendering(false);
      }
    });

    worker.postMessage({ type: 'warmup' } satisfies ToWorker);

    return () => {
      worker.terminate();
      workerReference.current = null;
    };
  }, []);

  // Debounce + coalesce: only the latest pending snapshot is ever sent. Reused by every trigger below.
  // When the debounce fires, a main-thread mermaid pre-pass renders the document's diagrams and its
  // assets pre-seed the worker's cache. Cancellation rides the debounce/supersession: each fresh render
  // aborts the previous pre-pass, and a resolved pre-pass posts only while it is still the latest — so a
  // superseded pre-pass can never overwrite a newer preview.
  const scheduleRender = (pending: ProjectSnapshot) => {
    if (debounceReference.current !== null) clearTimeout(debounceReference.current);
    debounceReference.current = setTimeout(() => {
      debounceReference.current = null;
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
          };
          workerReference.current?.postMessage({ type: 'render', request } satisfies ToWorker);
        });
    }, PREVIEW_DEBOUNCE_MS);
  };

  // Enable/disable: cancel any pending render and stop rendering when the panel closes; start a fresh
  // render when it (re)opens with a snapshot available.
  useEffect(() => {
    if (!isEnabled) {
      if (debounceReference.current !== null) {
        clearTimeout(debounceReference.current);
        debounceReference.current = null;
      }
      // Cancel a pre-pass that already started so it can't post after the panel closes.
      prerenderAbortReference.current?.abort();
      setIsRendering(false);
      return;
    }
    if (snapshot === null) return;
    scheduleRender(snapshot);
  }, [isEnabled]);

  // Debounce snapshot changes (the primary edit-driven render trigger).
  useEffect(() => {
    if (!isEnabled || snapshot === null) return;
    scheduleRender(snapshot);

    return () => {
      if (debounceReference.current !== null) {
        clearTimeout(debounceReference.current);
        debounceReference.current = null;
      }
    };
  }, [snapshot]);

  return { pdf, isRendering, phase, diagnostics, error, sourceMap };
}
