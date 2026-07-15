'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  isProgressMessage,
  isResultMessage,
  isErrorMessage,
  type FromWorker,
  type ProjectSnapshot,
  type RenderDiagnostic,
  type RenderError,
  type RenderPhase,
  type RenderRequest,
  type ToWorker,
} from '@asciidocollab/asciidoc-pdf';
import { createPdfWorker } from '@/lib/create-pdf-worker';
import {
  createMermaidPrerenderer,
  type MermaidPrerenderDiagnostic,
  type MermaidPrerenderer,
} from '@/lib/pdf/prerender-mermaid';
import { documentTextOf } from '@/lib/pdf/document-text';

/** File extension of the produced document. */
const PDF_EXTENSION = '.pdf';
/** Download name when the root path has no usable basename. */
const DEFAULT_DOWNLOAD_NAME = 'document.pdf';
/** Stable empty reference so idle renders share one array identity. */
const NO_DIAGNOSTICS: readonly RenderDiagnostic[] = [];

/**
 * The phase surfaced while the main-thread mermaid pre-pass runs, before the worker request is even
 * posted. It reuses the worker's own `diagrams-math` phase so the progress copy ("Rendering diagrams
 * and math…") reads seamlessly across the main-thread pre-pass and the in-VM diagram stage.
 */
const DIAGRAM_PREPASS_PHASE: RenderPhase = 'diagrams-math';

/**
 * Map a mermaid pre-pass diagnostic onto the shared per-block shape the worker stage emits. A render
 * failure carries no severity/code and defaults to an `error`/`malformed-diagram`; a skip (e.g. a
 * remote-resource reference) carries its own `warning`/`remote-skipped`, preserved here.
 */
function toRenderDiagnostic(
  diagnostic: MermaidPrerenderDiagnostic,
  documentPath: string,
): RenderDiagnostic {
  return {
    severity: diagnostic.severity ?? 'error',
    code: diagnostic.code ?? 'malformed-diagram',
    resource: documentPath,
    location: { path: documentPath, line: diagnostic.line },
    message: diagnostic.message,
  };
}

/** The value and behaviour a one-click PDF export exposes to the UI. */
export interface UsePdfExportResult {
  /**
   * Kick off an export of the given snapshot. Supersedes any in-flight export: only the latest
   * request's result is honoured, and its PDF is downloaded automatically.
   *
   * @param snapshot - The project snapshot to render and download as a PDF.
   */
  exportPdf: (snapshot: ProjectSnapshot) => void;
  /** True from `exportPdf` until the matching result or a fatal error arrives. */
  isExporting: boolean;
  /**
   * The most recent progress phase for the current export, when one has been reported. Reported first
   * by the main-thread mermaid pre-pass ({@link DIAGRAM_PREPASS_PHASE}), then by the worker per stage.
   */
  phase?: RenderPhase;
  /** The fatal error from the last export, if it failed as a whole. */
  error?: RenderError;
  /**
   * Non-fatal per-resource diagnostics for the last export: the main-thread pre-pass failures followed
   * by the worker's own per-resource diagnostics.
   */
  diagnostics: readonly RenderDiagnostic[];
}

/** Injectable seams for {@link usePdfExport}; every unset seam uses its real implementation. */
export interface UsePdfExportDeps {
  /**
   * Builds the coalescing mermaid pre-pass the export awaits before posting its render request. Unit
   * tests inject a deterministic fake so no real (DOM-bound) mermaid render is needed.
   */
  readonly createPrerenderer?: () => MermaidPrerenderer;
}

/** Derive a download filename from the render root path (basename with a `.pdf` extension). */
function downloadNameFor(rootPath: string): string {
  const base = rootPath.slice(rootPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === '' ? DEFAULT_DOWNLOAD_NAME : `${stem}${PDF_EXTENSION}`;
}

/** Trigger a browser download of a PDF blob via a transient object URL and `<a download>` click. */
function triggerDownload(pdf: Blob, fileName: string): void {
  const url = URL.createObjectURL(pdf);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The `requestId` a worker→main message pertains to, wherever it sits in the message shape. */
function requestIdOf(message: FromWorker): string {
  if (isResultMessage(message)) return message.result.requestId;
  if (isErrorMessage(message)) return message.error.requestId;
  return message.requestId;
}

/**
 * Drives a one-click, fully client-side PDF export. Owns ONE long-lived PDF Web Worker (created
 * lazily on mount, warmed ahead of the first export, reused across exports, terminated on unmount).
 *
 * Each `exportPdf` posts a render request tagged with a monotonic `requestId`; only the latest id is
 * honoured, so a superseded export's late `progress`/`result`/`error` messages are discarded (the
 * staleness guard mirrors {@link useAsciidocPreview}). A matching `result` downloads the PDF and
 * exposes its diagnostics; a matching `error` surfaces the failure. The UI supplies the snapshot and
 * renders the button/diagnostics from the returned state.
 */
export function usePdfExport(deps: UsePdfExportDeps = {}): UsePdfExportResult {
  const [isExporting, setIsExporting] = useState(false);
  const [phase, setPhase] = useState<RenderPhase | undefined>(undefined);
  const [error, setError] = useState<RenderError | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<readonly RenderDiagnostic[]>(NO_DIAGNOSTICS);

  const workerReference = useRef<Worker | null>(null);
  // Monotonic counter feeding the request id, and the latest id issued (the staleness key).
  const requestCounterReference = useRef(0);
  const latestRequestIdReference = useRef<string | null>(null);
  // The filename captured at request time, applied when that request's result comes back.
  const downloadNameReference = useRef(DEFAULT_DOWNLOAD_NAME);
  // The current export's pre-pass diagnostics, held so the worker result can prepend them to its own.
  const prepassDiagnosticsReference = useRef<readonly RenderDiagnostic[]>(NO_DIAGNOSTICS);
  // Aborts a superseded export's in-flight pre-pass at the next slice boundary.
  const prepassAbortReference = useRef<AbortController | null>(null);

  // The (lazily built) single, coalescing pre-pass; the latest injected factory is read at build time.
  const createPrerendererReference = useRef(deps.createPrerenderer);
  createPrerendererReference.current = deps.createPrerenderer;
  const prerendererReference = useRef<MermaidPrerenderer | null>(null);

  // Create the worker once, warm it, and tear it down on unmount.
  useEffect(() => {
    const worker = createPdfWorker();
    workerReference.current = worker;

    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (requestIdOf(message) !== latestRequestIdReference.current) return; // stale

      if (isProgressMessage(message)) {
        setPhase(message.phase);
        return;
      }
      if (isResultMessage(message)) {
        triggerDownload(message.result.pdf, downloadNameReference.current);
        setDiagnostics([...prepassDiagnosticsReference.current, ...message.result.diagnostics]);
        setError(undefined);
        setIsExporting(false);
        return;
      }
      if (isErrorMessage(message)) {
        setError(message.error);
        setIsExporting(false);
      }
    });

    const warmup: ToWorker = { type: 'warmup' };
    worker.postMessage(warmup);

    return () => {
      worker.terminate();
      workerReference.current = null;
    };
  }, []);

  const exportPdf = useCallback((snapshot: ProjectSnapshot) => {
    const worker = workerReference.current;
    if (worker === null) return;

    requestCounterReference.current += 1;
    const requestId = String(requestCounterReference.current);
    latestRequestIdReference.current = requestId;
    downloadNameReference.current = downloadNameFor(snapshot.rootPath);
    prepassDiagnosticsReference.current = NO_DIAGNOSTICS;

    // Supersede any pre-pass still in flight for an earlier export.
    prepassAbortReference.current?.abort();
    const abort = new AbortController();
    prepassAbortReference.current = abort;

    if (prerendererReference.current === null) {
      prerendererReference.current = (createPrerendererReference.current ?? createMermaidPrerenderer)();
    }
    const prerenderer = prerendererReference.current;

    setIsExporting(true);
    // Mermaid renders on the main thread first, so the diagram phase surfaces before the worker starts.
    setPhase(DIAGRAM_PREPASS_PHASE);
    setError(undefined);
    setDiagnostics(NO_DIAGNOSTICS);

    // Render mermaid diagrams (the one engine the worker's DOM-less VM cannot draw) up front, then hand
    // the resulting content-addressed assets to the worker to pre-seed as cache hits.
    void (async () => {
      // Scan the RENDER-ROOT file (matching the preview): the worker assembles the document from the
      // root, so root-document mermaid must be pre-rendered here or it drops from the export. Only the
      // top-level root text is scanned — includes aren't resolved on the main thread, so mermaid inside
      // an included file isn't pre-seeded and degrades to a surfaced worker render diagnostic.
      const documentPath = snapshot.rootPath;
      const text = documentTextOf(snapshot);
      const prepass = await prerenderer.prerender(text, { signal: abort.signal });

      // A newer export superseded this one while its pre-pass ran; drop it silently.
      if (latestRequestIdReference.current !== requestId) return;

      const prepassDiagnostics = prepass.diagnostics.map((diagnostic) =>
        toRenderDiagnostic(diagnostic, documentPath),
      );
      prepassDiagnosticsReference.current = prepassDiagnostics;
      if (prepassDiagnostics.length > 0) setDiagnostics(prepassDiagnostics);

      const request: RenderRequest = {
        requestId,
        mode: 'export',
        snapshot,
        optimize: true,
        ...(prepass.assets.length > 0 ? { generatedAssets: prepass.assets } : {}),
      };
      worker.postMessage({ type: 'render', request } satisfies ToWorker);
    })();
  }, []);

  return { exportPdf, isExporting, phase, error, diagnostics };
}
