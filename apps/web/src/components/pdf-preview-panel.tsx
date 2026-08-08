"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowUpDown, ChevronRight, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import {
  AnnotationLayer,
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import type {
  PdfSourceMap,
  RenderDiagnostic,
  RenderError,
  RenderPhase,
  RenderStats,
} from "@asciidocollab/asciidoc-pdf";
import { Button } from "@/components/ui/button";
import { PdfDiagnostics } from "@/components/pdf-diagnostics";
import { RenderStatsOverlay, type RenderStatRow } from "@/components/preview/render-stats-overlay";
import { PreviewModeToggle, type PreviewMode } from "@/components/preview-mode-toggle";
import type { ScrollRequest } from "@/hooks/use-asciidoc-preview";
import { assembledEntryAtPdfPosition } from "@/lib/pdf/pdf-click-to-source";
import { isSelectionDragClick } from "@/lib/preview-selection";
import { cn } from "@/lib/utilities";
// The pdf.js text/annotation layers are DOM overlays styled by the library's own global classes; the
// stylesheet co-locates only the rules the three-layer page stack needs (see the file's header). It is
// imported by relative path (matching asciidoc-preview.tsx) so the jest css stub matches it.
import "../styles/pdf-preview.css";
import { createPreviewLinkService } from "@/lib/pdf-preview-link-service";
import { clamp } from "@/lib/utilities";


/** A source location the editor can reveal when a diagnostic carries one. */
type DiagnosticLocation = NonNullable<RenderDiagnostic["location"]>;

/**
 * Same-origin path the pdf.js parsing worker is served from. Pdf.js parses the document off the main
 * thread; pointing it at a bundled worker keeps the editor responsive during a preview render.
 */
const PDF_WORKER_SOURCE = "/vendor/pdfjs/pdf.worker.min.mjs";

/**
 * Fallback render scale used only before the panel's width has been measured (1 = intrinsic 72dpi
 * point size). Once a width is known the pages fit to it, or to the user's explicit zoom factor.
 */
const FALLBACK_SCALE = 1.5;

/** Smallest zoom factor the control allows (a quarter of the intrinsic point size). */
const MIN_ZOOM = 0.25;

/** Largest zoom factor the control allows (four times the intrinsic point size). */
const MAX_ZOOM = 4;

/** Multiplicative step each zoom-in/zoom-out press applies to the current scale. */
const ZOOM_STEP = 1.25;

/**
 * Horizontal padding, in CSS pixels, the pages container reserves on each side (mirrors its `p-4`
 * class). It is subtracted from the scroll viewport's width to find the space a page may occupy.
 */
const PAGE_PADDING = 16;

/**
 * Minimum width change, in CSS pixels, that forces a re-fit. Sub-pixel resizes below this threshold
 * are ignored so a drag does not spawn a render per pixel.
 */
const WIDTH_EPSILON = 2;

/**
 * Vertical gap, in CSS pixels, between stacked pages (mirrors the container's `gap-4` class). Used to
 * predict where each page will land before the stack is in the document, so the pages a reader can
 * actually see are painted before the swap rather than after it.
 */
const PAGE_GAP = 16;

/**
 * How far beyond the visible viewport, in CSS pixels, a page is still painted eagerly.
 *
 * Rasterizing a page is the most expensive thing this component does — a canvas at the device pixel
 * ratio is several megabytes of pixels, and a preview refresh used to redraw every page of the
 * document whether or not anyone could see it. On a long document that is most of the cost of a
 * refresh spent on pages nobody is looking at. Pages outside this band are laid out at their true
 * size (so the scrollbar, the scroll sync and the page indicator are all exactly as they were) and
 * painted when the reader approaches them.
 *
 * The band is generous on purpose: roughly two screens either way, so scrolling at a normal speed
 * always meets a page that is already drawn, and a document short enough to fit inside it is painted
 * in full exactly as before. It doubles as the observer's margin, which is what starts a page
 * painting before it comes into view rather than as it arrives.
 */
const EAGER_PAINT_MARGIN_PX = 2000;

/**
 * How far beyond the visible viewport, in CSS pixels, a page that HAS been drawn keeps its drawing.
 *
 * A drawing is not free to hold on to. Each one is a canvas at the device pixel ratio — several
 * megabytes of pixels for a single page, more on a HiDPI screen — and a document drawn page by page as
 * the reader scrolls accumulates every one of them, because nothing here ever asks a second time for a
 * page it has already drawn. Far enough down a long document the browser stops backing new canvases,
 * and from that point every page the reader scrolls to is blank with nothing on screen to say why.
 *
 * Released pages keep their measured size, so the stack's geometry never changes: the scrollbar, the
 * page indicator and the scroll sync read the same numbers whether or not a page currently carries a
 * drawing, and approaching it again draws it back.
 *
 * Deliberately WIDER than the paint margin. Drawing and releasing at one boundary would redraw a page
 * every time the reader crossed it; with the release boundary further out, scrolling back and forth
 * around a page meets it already drawn.
 */
const RETAINED_PAINT_MARGIN_PX = EAGER_PAINT_MARGIN_PX * 2;

/**
 * Quiet period, in milliseconds, the crisp pdf.js re-paint waits for after the last zoom or resize
 * change. A burst of zoom clicks or a resize drag collapses into one re-render at the settled scale;
 * in the meantime the already-painted pages are scaled with a CSS transform for instant feedback.
 */
const RENDER_DEBOUNCE_MS = 180;

/**
 * Fraction of the viewport height left ABOVE a source-map-synced line, so the target block lands a
 * little below the top edge instead of glued to it. This breathing room also absorbs the engine source
 * map's block-position granularity: the engine reports each block's `(page, yFraction)` from a layout
 * cursor captured a few lines off the block's actual glyphs, so a synced line can render up to ~one
 * short paragraph away from the exact computed offset — most visible for content past an `include::`,
 * where the assembled coordinate is furthest from the file's own line. Placing the target a little down
 * from the top keeps it comfortably on-screen despite that drift, rather than just above the fold.
 */
const SYNC_TOP_FRACTION = 0.18;

/**
 * Floor for the synced-line top gap, in CSS pixels, so a very short viewport still leaves a little room
 * above the target. The applied margin is the larger of this and {@link SYNC_TOP_FRACTION} of the height.
 */
const SYNC_TOP_MARGIN = 12;


/**
 * The zoom control's state: `fit` scales each page to the panel's current width, while `custom` pins
 * every page to an explicit factor of its intrinsic point size.
 */
type ZoomState = { mode: "fit" } | { mode: "custom"; scale: number };

/** Sentinel `<select>` value the preset control uses for fit-to-width mode. */
const FIT_PRESET_VALUE = "fit";

/**
 * The zoom presets offered by the header selector, in display order. `fit` maps to fit-to-width mode;
 * each numeric preset pins a `custom` scale factor. The `<option>` value is the stringified factor so
 * the selected preset round-trips through the native control without a lookup table.
 */
const ZOOM_PRESETS: readonly { value: string; label: string; scale: number }[] = [
  { value: "0.75", label: "75%", scale: 0.75 },
  { value: "1", label: "100%", scale: 1 },
  { value: "1.25", label: "125%", scale: 1.25 },
  { value: "1.5", label: "150%", scale: 1.5 },
  { value: "2", label: "200%", scale: 2 },
];

/** Human-readable copy per render phase, keyed to the protocol so it cannot drift. */
const PHASE_LABELS: Record<RenderPhase, string> = {
  "vm-init": "Starting the preview engine…",
  preprocessing: "Preparing the document…",
  citations: "Resolving citations…",
  "diagrams-math": "Rendering diagrams and math…",
  converting: "Rendering the preview…",
  optimizing: "Finalising the preview…",
  done: "Updating the preview…",
};

/** Shown while a render is in flight before the first phase update lands. */
const PENDING_LABEL = "Preparing the preview…";

/** Idle empty-state copy shown before any PDF exists. */
const EMPTY_LABEL = "The PDF preview will appear here as you edit.";

/** Configure the pdf.js worker once, without clobbering a source the host app already set. */
function ensurePdfWorkerConfigured(): void {
  if (GlobalWorkerOptions.workerSrc === "") {
    GlobalWorkerOptions.workerSrc = PDF_WORKER_SOURCE;
  }
}


/**
 * Whether two byte sequences are the same document.
 *
 * Every completed render hands the panel a fresh `Blob`, so object identity says nothing about
 * whether the document changed — and an edit very often leaves the rendered PDF byte-for-byte
 * identical (a change inside a comment, a re-render forced by an unrelated setting, an edit undone
 * before the render fired). Redrawing the page stack for one of those costs a full rasterization of
 * everything on screen and produces pixels indistinguishable from the ones already there.
 *
 * @param left - The bytes just produced, or `null` when nothing has been painted yet.
 * @param right - The bytes the pages currently on screen were painted from.
 * @returns True when the two are the same length and the same content.
 */
function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/** One page of the loaded document: its element and where that element will sit in the stack. */
interface PageSlot {
  /** 1-based page number, mirrored onto the element's `data-page`. */
  readonly number: number;
  /** The loaded pdf.js page, kept so the layers can be painted later, on approach. */
  readonly page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
  /** The viewport the page is painted through, at the committed scale. */
  readonly viewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getViewport']>;
  /** The positioned container holding this page's three layers. */
  readonly element: HTMLDivElement;
  /** Predicted distance, in CSS pixels, from the top of the stack to this page's top edge. */
  readonly top: number;
  /** The page's laid-out height in CSS pixels. */
  readonly height: number;
}

/** The pdf.js work behind one page's drawing, held so that releasing the page can let go of it. */
interface PageWork {
  /** The canvas render, once started. Cancelling it is also what lets go of the canvas it drew into. */
  task?: RenderTask;
  /** The selectable-text overlay, once started. */
  layer?: TextLayer;
}

/**
 * Find the entry in a line-sorted source map that governs `targetLine`: the last entry whose `line` is
 * `≤ targetLine` (binary search). When every entry starts after the target, the first entry is returned
 * so a line above the first mapped block still scrolls to the document's top.
 *
 * A line may carry SEVERAL entries — lifting each entry to its block's visual start merges distinct
 * blocks onto one key (see `liftSourceMapToBlockStarts`, which keeps them rather than discarding the
 * extras the reverse click lookup needs). The group is ordered by layout position, so the search walks
 * back to the group's first member: the highest-rendered block on that line, which is where a cursor
 * sitting on it should scroll to.
 *
 * @param sourceMap - The engine source map, sorted by line and then by layout position.
 * @param targetLine - The assembled-document line to locate.
 * @returns The governing entry, or `null` when the map is empty.
 */
function findSourceMapEntry(
  sourceMap: PdfSourceMap,
  targetLine: number,
): PdfSourceMap[number] | null {
  if (sourceMap.length === 0) return null;
  let low = 0;
  let high = sourceMap.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sourceMap[mid].line <= targetLine) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) return sourceMap[0];
  while (found > 0 && sourceMap[found - 1].line === sourceMap[found].line) found -= 1;
  return sourceMap[found];
}

/**
 * The page-formatted render's figures as overlay rows, ordered and nested the way they contain one
 * another: the render total, the four main-thread stages inside it, the in-VM stages inside the
 * convert, and the counters — which measure no time at all — last.
 *
 * The containment is stated rather than left to the reader because these figures overlap almost
 * entirely. `convert` is nearly all of `render`, and the in-VM stages are nearly all of `convert`, so
 * a flat column of them appears to account for two or three times the time the render actually took.
 *
 * A stage the render could not measure is left out entirely rather than shown as `0 ms`. The in-VM
 * stages are optional precisely because "not measured" and "took no time" are different facts, and
 * a breakdown that renders them the same way invites the wrong conclusion about where the time goes.
 */
function pageRenderStatRows(stats: RenderStats | undefined): readonly RenderStatRow[] {
  if (stats === undefined) return [];
  const { stages } = stats;
  const rows: RenderStatRow[] = [
    { label: "render", value: stats.renderMs, unit: "ms" },
    { label: "vm boot", value: stages.vmBootMs, unit: "ms", depth: 1 },
    { label: "populate", value: stages.populateMs, unit: "ms", depth: 1 },
    { label: "pipeline", value: stages.pipelineMs, unit: "ms", depth: 1 },
    { label: "convert", value: stages.convertMs, unit: "ms", depth: 1 },
  ];
  // Inside the convert, and siblings of one another: each is SELF time, so the walk already excludes
  // the dry runs, font work and serialisation that happen during it.
  const inVm: readonly (readonly [string, number | undefined])[] = [
    ["parse", stages.parseMs],
    ["converter walk", stages.converterWalkMs],
    ["dry runs", stages.dryRunMs],
    ["fonts", stages.fontMs],
    ["serialize", stages.serializeMs],
  ];
  for (const [label, value] of inVm) {
    if (value !== undefined) rows.push({ label, value, unit: "ms", depth: 2 });
  }
  // Counts, not durations: nothing contains them and they contain nothing, so they read last rather
  // than in among figures that add up.
  rows.push(
    { label: "cache hits", value: stats.cacheHits },
    { label: "raster fallbacks", value: stats.rasterFallbacks },
  );
  return rows;
}

/** Presentational contract for the live PDF preview surface; all behaviour is injected. */
export interface PdfPreviewPanelProperties {
  /** The most recent rendered PDF, or `null` before the first render completes. */
  pdf: Blob | null;
  /** Whether a preview render is currently in flight. */
  isRendering: boolean;
  /** The most recent render phase, when known, driving the progress copy. */
  phase?: RenderPhase;
  /** Non-fatal warnings gathered while producing the preview. */
  diagnostics?: readonly RenderDiagnostic[];
  /**
   * The failure that ended the latest render, when one did. Distinct from {@link diagnostics}, which
   * ride alongside a preview that was nevertheless produced: this is the render not happening, so the
   * panel says so instead of leaving its "the preview will appear here" invitation on screen — an
   * invitation that, after a refusal, is a promise the panel is never going to keep. The message is
   * the engine layer's own author-facing text and is shown verbatim; it is where a refusal explains
   * itself, such as a document past the supported size naming that size and the ways around it.
   */
  error?: RenderError;
  /** What the latest render cost, for the development-only cost overlay. */
  stats?: RenderStats;
  /**
   * Invoked with a diagnostic's source location so the editor can reveal it.
   *
   * @param location - The diagnostic's source location to reveal in the editor.
   */
  onSelectLocation?: (location: DiagnosticLocation) => void;
  /**
   * Called when the user clicks somewhere on a rendered page that is NOT a link, so the editor can
   * reveal the corresponding source. Receives the best-effort assembled-document line of the block at the
   * click position (from the engine {@link sourceMap}); the layout reverse-maps it to a `{file, line}`.
   * Link clicks are handled by pdf.js (internal destination scroll / external new tab) and never call this.
   *
   * @param assembledLine - The 1-based assembled-document line of the block at the click position.
   */
  onNavigateToSource?: (assembledLine: number) => void;
  /**
   * Called when the clicked block carries an EXACT source origin (preview renders stamp each block's
   * `{path, sourceLine}` at render time), so the editor jumps to the precise file+line with no client-side
   * reverse mapping and no staleness. Preferred over {@link onNavigateToSource} whenever an origin is present.
   *
   * @param path - Project-relative source file of the clicked block.
   * @param line - 1-based line of the block within `path`.
   */
  onNavigateToExactSource?: (path: string, line: number) => void;
  /** The active preview mode; rendered in the header's HTML/PDF switch. */
  previewMode?: PreviewMode;
  /**
   * Called when the user switches the preview mode from the header.
   *
   * @param mode - The newly selected preview mode.
   */
  onPreviewModeChange?: (mode: PreviewMode) => void;
  /**
   * A new scroll request the editor emits as it scrolls. The PDF has no source-line map, so the panel
   * mirrors the HTML preview's sync proportionally (see the sync effect). Unset disables the behaviour.
   */
  scrollToLine?: ScrollRequest | null;
  /**
   * The engine-emitted block source map for the current PDF. When present (with {@link assembledLine}),
   * the panel scrolls to the exact rendered position of the editor's line instead of a proportional
   * guess; when absent it falls back to the proportional sync below.
   */
  sourceMap?: PdfSourceMap;
  /**
   * The editor's current line already translated into the ASSEMBLED (include-expanded) document's line
   * coordinates — the space {@link sourceMap} entries are keyed in. Recomputed by the layout for each
   * new {@link scrollToLine} request. Unset (or with no source map) selects the proportional fallback.
   */
  assembledLine?: number;
  /** Total number of source lines in the previewed document, used to compute the proportional offset. */
  totalLines?: number;
  /**
   * True when the open file is NOT part of the configured main document's include tree, so the panel is
   * rendering it on its own. Surfaces a short, non-intrusive notice below the header. Never set when no
   * main document is configured (there is then no tree to be outside of).
   */
  outsideMainTree?: boolean;
  /** Whether the preview scrolls to follow the editor's scroll position. */
  scrollSyncEnabled?: boolean;
  /** Called when the user toggles the scroll-sync option in the header. */
  onToggleScrollSync?: () => void;
  /** When provided, a collapse button is rendered in the header. */
  onCollapse?: () => void;
  /** Extra design-token classes merged onto the panel's root element. */
  className?: string;
}

/**
 * A live PDF preview surface. Every page of the most recent render is painted by pdf.js as the standard
 * three-layer stack — a sharp HiDPI `<canvas>`, a transparent text layer that makes the text selectable,
 * and an annotation layer that turns link annotations into clickable anchors — inside its own positioned
 * container stacked vertically, so the document's own fonts and styles cannot leak into the app chrome.
 * Rendering happens entirely in an effect that loads the document once and paints each page; every
 * superseded or unmounted render cancels all of its page render and text-layer tasks and destroys its
 * loading task, so nothing is leaked. The pdf.js library rejects a superseded render with a cancellation
 * error, which is expected and swallowed rather than surfaced as a failure. Zooming and resizing give
 * instant feedback by CSS-transforming the already-painted pages, while the crisp pdf.js re-paint is
 * debounced and swapped in atomically, so a burst of changes never blanks or flickers the panel.
 *
 * @param properties - The rendered PDF, render status, header controls, and scroll-sync inputs.
 * @returns The panel element with its header controls and stacked page canvases.
 */
export function PdfPreviewPanel({
  pdf,
  isRendering,
  phase,
  diagnostics,
  error,
  stats,
  onSelectLocation,
  onNavigateToSource,
  onNavigateToExactSource,
  previewMode = "pdf",
  onPreviewModeChange,
  scrollToLine = null,
  sourceMap,
  assembledLine,
  totalLines,
  outsideMainTree = false,
  scrollSyncEnabled = false,
  onToggleScrollSync,
  onCollapse,
  className,
}: PdfPreviewPanelProperties) {
  // The scrollable viewport (drives proportional scroll-sync) and the stack the page canvases are
  // appended into. Canvases are created imperatively so a single effect owns the whole render and can
  // cancel every in-flight page task on supersede/unmount.
  const scrollReference = useRef<HTMLDivElement>(null);
  const pagesReference = useRef<HTMLDivElement>(null);
  // The last scroll request already applied, so an unrelated re-render never re-scrolls (mirrors how
  // the HTML preview only reacts to a genuinely new request object from the editor).
  const lastScrollReference = useRef<ScrollRequest | null>(null);
  // The scale the pages currently in the DOM were actually painted at (`null` before the first paint),
  // and the latest target scale — both read imperatively so the paint can reconcile the CSS transform
  // the moment it swaps in freshly painted pages, without waiting for a React re-render.
  const renderedScaleReference = useRef<number | null>(null);
  const targetScaleReference = useRef<number>(FALLBACK_SCALE);
  // Tracks which rendered page is most in view; re-created after every re-paint since the paint swaps
  // in fresh page elements. Held in a ref so the paint effect's cleanup can disconnect it.
  const pageObserverReference = useRef<IntersectionObserver | null>(null);
  // Draws pages as the reader approaches them — the ones outside the eagerly-painted band. Held in a
  // ref for the same reason, and separate from the tracking observer above because it watches an
  // inflated root: a margin that starts a page painting early would make every page look "in view" to
  // the indicator.
  const paintObserverReference = useRef<IntersectionObserver | null>(null);
  // Takes a page's drawing back once the reader is well past it, so the panel does not accumulate
  // every canvas it has ever drawn. A third observer rather than a branch inside the painting one:
  // they watch differently-sized roots on purpose, and the gap between the two is the hysteresis that
  // stops a page being redrawn each time the reader crosses one boundary.
  const releaseObserverReference = useRef<IntersectionObserver | null>(null);
  // The bytes the page stack is showing, or is being painted from. `null` until the first PDF arrives.
  const documentBytesReference = useRef<Uint8Array | null>(null);

  // The space (in CSS pixels) a page may occupy inside the scroll viewport, measured by a
  // ResizeObserver; `0` until the first measurement, which falls back to the fixed scale.
  const [containerWidth, setContainerWidth] = useState(0);
  // The active zoom: fit-to-width by default, or an explicit factor once the user zooms.
  const [zoom, setZoom] = useState<ZoomState>({ mode: "fit" });
  // A page's intrinsic (scale 1) width from the loaded document, used to turn fit-to-width into a
  // scale factor; `0` until the first page is measured.
  const [basePageWidth, setBasePageWidth] = useState(0);
  // The scale the crisp pdf.js re-paint uses. It lags the target scale by the debounce so a burst of
  // zoom/resize changes collapses to one re-render; the paint effect keys off it.
  const [committedScale, setCommittedScale] = useState(FALLBACK_SCALE);
  // Total pages in the loaded document and the page currently most in view, for the header indicator.
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  // The pending text in the jump-to-page field; empty unless the user is typing a destination.
  const [jumpValue, setJumpValue] = useState("");
  // Bumped only when a PDF arrives whose bytes differ from the ones the stack already holds. The paint
  // effect keys off this rather than off `pdf` directly, so a refresh that produced an identical
  // document does not re-run it at all — see the effect below for why "does not re-run" has to mean
  // exactly that.
  const [documentRevision, setDocumentRevision] = useState(0);

  // The scale the user is currently asking for (fit-to-width or an explicit factor), known
  // synchronously so the header readout and the CSS transform can respond without a render round-trip.
  const isFitMeasured = containerWidth > 0 && basePageWidth > 0;
  const fitScale = isFitMeasured
    ? clamp(containerWidth / basePageWidth, MIN_ZOOM, MAX_ZOOM)
    : FALLBACK_SCALE;
  const targetScale = zoom.mode === "custom" ? zoom.scale : fitScale;
  targetScaleReference.current = targetScale;

  // Instant feedback: whenever the target scale diverges from the scale the visible pages were painted
  // at, transform those pages with `scale(target / painted)` (anchored top-centre). The user sees a
  // smooth resize with no blank flash while the debounced crisp re-render below catches up; the paint
  // resets the transform to identity once the fresh pages match the target exactly.
  useEffect(() => {
    const pagesContainer = pagesReference.current;
    if (pagesContainer === null) return;
    const painted = renderedScaleReference.current;
    const ratio = painted !== null && painted > 0 ? targetScale / painted : 1;
    pagesContainer.style.transformOrigin = "top center";
    pagesContainer.style.transform = ratio === 1 ? "" : `scale(${ratio})`;
  }, [targetScale]);

  // Debounce the crisp re-render: commit the settled target scale only after the changes go quiet, so a
  // burst of zoom clicks or a resize drag produces a single repaint rather than one per step.
  useEffect(() => {
    if (targetScale === committedScale) return;
    const timer = setTimeout(() => setCommittedScale(targetScale), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [targetScale, committedScale]);

  // Fit-to-width: watch the scroll viewport and keep the available page width in state. The measure is
  // rAF-guarded so a resize drag coalesces into one update per frame, and the threshold discards
  // sub-pixel jitter so the paint effect below re-renders only when the width changes materially.
  useEffect(() => {
    const container = scrollReference.current;
    if (container === null) return;

    let frame = 0;
    const measure = (): void => {
      const available = Math.max(0, container.clientWidth - PAGE_PADDING * 2);
      setContainerWidth((previous) =>
        Math.abs(available - previous) < WIDTH_EPSILON ? previous : available
      );
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Decide whether a newly-arrived PDF is a new document at all, WITHOUT disturbing the paint below.
  //
  // Every completed render hands the panel a fresh `Blob`, so object identity says nothing about
  // whether the document changed — and an edit very often leaves the rendered PDF byte-for-byte
  // identical (a change inside a comment, an edit undone before the render fired, a re-render forced
  // by an unrelated setting). Repainting for one of those rasterizes everything on screen to arrive at
  // the pixels already there.
  //
  // The comparison has to live in an effect of its own, ahead of the paint. React runs an effect's
  // cleanup before every re-run, so a paint effect keyed on `pdf` has ALREADY torn its document and
  // both its observers down by the time it could notice there was nothing to do — leaving a panel
  // that no longer tracks the current page and no longer paints pages the reader scrolls to. Deciding
  // out here means an unchanged document never re-runs the paint, so nothing is torn down to begin
  // with.
  useEffect(() => {
    if (pdf === null) return;
    let cancelled = false;
    void pdf
      .arrayBuffer()
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (cancelled || sameBytes(bytes, documentBytesReference.current)) return;
        documentBytesReference.current = bytes;
        setDocumentRevision((previous) => previous + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  useEffect(() => {
    const pagesContainer = pagesReference.current;
    const data = documentBytesReference.current;
    if (data === null || pagesContainer === null) return;

    ensurePdfWorkerConfigured();

    // Every page renders at the debounced committed scale, so one CSS transform ratio describes the
    // whole stack while a re-render is pending.
    const scale = committedScale;

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    /**
     * The drawing work for each page that currently carries a drawing, by page number.
     *
     * Keyed, and emptied as pages are released, because pdf.js's render task keeps a reference to the
     * canvas it drew into (`InternalRenderTask._canvas`). Merely appending every task to a list kept
     * for the cleanup — which is what this was — held every canvas the run had ever drawn alive no
     * matter how many pages were released, so the memory releasing them exists to bound grew anyway,
     * and far enough down a long document the blank pages it prevents arrived on schedule.
     *
     * Effect-scoped rather than paint-scoped so the cleanup can reach it however far the paint got.
     */
    const pageWork = new Map<number, PageWork>();
    // Freshly painted pages are built off-DOM and swapped in atomically at the end, so the currently
    // visible (transformed) pages are never detached mid-render — the panel never flashes empty.
    const buffer: HTMLDivElement[] = [];
    let firstPageWidth = 0;

    const paint = async (): Promise<void> => {
      // A COPY, because pdf.js takes ownership of what it is given: the array's buffer is transferred
      // to its worker and left detached here. Handed the panel's own bytes, the first paint emptied
      // them — and every paint after that got a zero-length document.
      //
      // That is not a slow degradation, it is the panel silently ceasing to work, and it happened on
      // the FIRST document every time. The initial paint runs at the fallback scale, measures the page
      // and publishes its width; fit-to-width then resolves to a different scale, which re-runs this
      // effect — whose cleanup has already disconnected both observers, and which now cannot load the
      // document at all. Nothing re-attaches them, so from that moment no page is ever painted again:
      // the reader is left with the handful of pages the first pass drew and blank paper below them.
      //
      // It also quietly retired the unchanged-document check: `sameBytes` compared every new render
      // against an emptied array, never matched, and repainted the whole stack each time.
      loadingTask = getDocument({ data: new Uint8Array(data) });
      const pdfDocument = await loadingTask.promise;
      if (cancelled) return;
      setPageCount(pdfDocument.numPages);

      // Build the link service ONCE per loaded document, closing over it plus the live page-stack and
      // scroll containers so internal links (cross-references, TOC, figure refs) can resolve a
      // destination to a page and scroll it into view. External URLs stay hardened new-tab anchors.
      const scrollContainer = scrollReference.current;
      const linkService = createPreviewLinkService({
        pdfDocument,
        pagesContainer,
        scrollContainer: scrollContainer ?? pagesContainer,
      });

      // Pass one: lay every page out at its true size without drawing anything into it. The stack ends
      // up exactly as tall as the finished document, so the scrollbar, the scroll sync's offsetTop
      // maths and the page indicator behave identically whether or not a page has been drawn yet.
      const slots: PageSlot[] = [];
      let nextTop = 0;
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        // Record the first page's intrinsic point size so fit-to-width can derive its scale factor.
        if (pageNumber === 1) firstPageWidth = page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);

        // The positioned container holds the three layers in one CSS coordinate space; `--scale-factor`
        // (inherited by both overlays) tells pdf.js how to size the text runs and link annotations.
        const pageContainer = document.createElement("div");
        pageContainer.className = "pdfPageLayers mx-auto rounded-sm bg-white shadow-sm";
        // The page-tracking observer reads this to map an intersecting element back to its page number.
        pageContainer.dataset.page = String(pageNumber);
        pageContainer.style.width = `${cssWidth}px`;
        pageContainer.style.height = `${cssHeight}px`;
        pageContainer.style.setProperty("--scale-factor", String(viewport.scale));

        slots.push({
          number: pageNumber,
          page,
          viewport,
          element: pageContainer,
          top: nextTop,
          height: cssHeight,
        });
        nextTop += cssHeight + PAGE_GAP;
        buffer.push(pageContainer);
      }

      // The pages currently carrying a drawing, and whatever is still drawing them.
      const painted = new Set<number>();

      /**
       * Take a page's drawing away again: stop whatever is still drawing it, strip its three layers,
       * and mark it undrawn so approaching it once more draws it afresh.
       *
       * The container keeps the width and height measured for it, so this changes nothing about the
       * stack's geometry — only whether there are pixels in it.
       */
      const releasePage = (slot: PageSlot): void => {
        if (!painted.delete(slot.number)) return;
        const work = pageWork.get(slot.number);
        // Both halves, and then the entry itself: the canvas is only actually let go of once nothing
        // holds the render task that drew it, and this map is the last thing that does.
        work?.task?.cancel();
        work?.layer?.cancel();
        pageWork.delete(slot.number);
        slot.element.replaceChildren();
      };

      // Draw one page's three layers into its already-positioned container. Idempotent while the
      // drawing stands: the first call marks the page drawn, so an observer firing for it repeatedly
      // costs nothing.
      const drawPage = async (slot: PageSlot): Promise<void> => {
        const { page, viewport, element } = slot;

        // Paint at the device pixel ratio so the canvas stays sharp on HiDPI screens, then downscale it
        // to the viewport's CSS size so the three layers line up in the same coordinate space.
        const outputScale = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-label", `Rendered PDF page ${slot.number}`);
        canvas.className = "block rounded-sm";
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d");
        // Without a 2D context this page cannot be drawn at all. Reported as a failure so its caller
        // hands the page back undrawn rather than filing it as done: a browser that would not back
        // this canvas may well back the next one, and one undrawable page must not cost the reader
        // every page after it.
        if (context === null) {
          throw new Error(`PDF page ${slot.number}: no 2D canvas context`);
        }

        // Middle layer: selectable text. Top layer: clickable link annotations. Both overlay the canvas
        // exactly (the stylesheet pins them with `inset: 0`), so selection and clicks map to the glyphs.
        const textDiv = document.createElement("div");
        textDiv.className = "textLayer";
        const annotationDiv = document.createElement("div");
        annotationDiv.className = "annotationLayer";
        element.append(canvas, textDiv, annotationDiv);

        // Registered before the work starts, so that a release arriving mid-drawing finds it.
        const work: PageWork = {};
        pageWork.set(slot.number, work);

        const renderTask = page.render({
          // pdfjs-dist 6 requires the canvas itself alongside its context.
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        work.task = renderTask;
        await renderTask.promise;
        if (cancelled) return;

        // Selectable text overlay: pdf.js lays transparent, positioned glyph spans over the canvas.
        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textDiv,
          viewport,
        });
        work.layer = textLayer;
        await textLayer.render();
        if (cancelled) return;

        // Clickable-link overlay: render only the page's link annotations through the minimal service.
        const annotations = await page.getAnnotations();
        if (cancelled) return;
        // pdfjs-dist 6 moved `linkService` onto the constructor and added `commentManager` /
        // `annotationStorage`; the preview supplies neither editing nor comments, so both are null.
        const annotationLayer = new AnnotationLayer({
          div: annotationDiv,
          page,
          viewport,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
          commentManager: null,
          linkService,
          annotationStorage: null,
        });
        await annotationLayer.render({
          annotations,
          div: annotationDiv,
          page,
          viewport,
          // Dead weight at runtime in pdfjs-dist 6 (the layer uses the copy it took in its
          // constructor), but still required by the declared parameter type.
          linkService,
          renderForms: false,
        });
      };

      /**
       * Draw a page if it is not already drawn, and hand it back undrawn if the drawing fails.
       *
       * The second half is what stops a failure being permanent. A page is marked drawn BEFORE the work
       * starts, so that an observer firing for it a dozen times during a scroll costs one drawing rather
       * than a dozen — but that same mark means nothing ever asks for the page again. A drawing that
       * then failed left the reader a blank page with no way back to it for as long as the document
       * stayed open, and no sign anywhere that anything had gone wrong. Unmarked, the next approach
       * simply tries again.
       *
       * Cancellation is not a failure of that kind: the whole run is being torn down and its stack
       * replaced wholesale, so there is nothing to hand back and nothing to retry.
       */
      const paintPage = async (slot: PageSlot): Promise<void> => {
        if (cancelled || painted.has(slot.number)) return;
        painted.add(slot.number);
        try {
          await drawPage(slot);
        } catch (error) {
          if (!cancelled) releasePage(slot);
          throw error;
        }
      };

      // Pass two: draw what the reader can see, plus the band either side of it, BEFORE the swap — so
      // the stack replacing the current one is already painted where it matters and the panel does not
      // flash. The predicted offsets from pass one are what make this possible while still off-DOM.
      const viewportTop = (scrollContainer?.scrollTop ?? 0) - PAGE_PADDING;
      const bandTop = viewportTop - EAGER_PAINT_MARGIN_PX;
      const bandBottom = viewportTop + (scrollContainer?.clientHeight ?? 0) + EAGER_PAINT_MARGIN_PX;
      for (const slot of slots) {
        if (slot.top < bandBottom && slot.top + slot.height > bandTop) await paintPage(slot);
        if (cancelled) return;
      }

      // Swap the completed pages in atomically, replacing the previous (transformed) stack in one step.
      pagesContainer.replaceChildren(...buffer);

      // Everything below the band is painted on approach. The observer's margin starts a page drawing
      // while it is still off screen, so scrolling at a normal speed meets pages already drawn.
      paintObserverReference.current?.disconnect();
      const paintObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const slot = slots.find((candidate) => candidate.element === entry.target);
            // pdf.js rejects a superseded page render with a cancellation error, as on the eager path.
            if (slot !== undefined) void paintPage(slot).catch(() => undefined);
          }
        },
        { root: scrollReference.current, rootMargin: `${EAGER_PAINT_MARGIN_PX}px 0px` }
      );
      for (const slot of slots) paintObserver.observe(slot.element);
      paintObserverReference.current = paintObserver;

      // And everything well behind the reader gives its drawing back. Without this the panel holds
      // every page it has ever drawn — several megabytes of canvas each — until the document changes,
      // and far enough down a long document the browser stops backing new ones: from there on, every
      // page scrolled to is blank, with nothing on screen to say why. See RETAINED_PAINT_MARGIN_PX for
      // why the boundary is further out than the one that draws them.
      releaseObserverReference.current?.disconnect();
      const releaseObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) continue;
            const slot = slots.find((candidate) => candidate.element === entry.target);
            if (slot !== undefined) releasePage(slot);
          }
        },
        { root: scrollReference.current, rootMargin: `${RETAINED_PAINT_MARGIN_PX}px 0px` }
      );
      for (const slot of slots) releaseObserver.observe(slot.element);
      releaseObserverReference.current = releaseObserver;

      // (Re-)attach the page-tracking observer to the fresh page elements: the swap discarded the ones
      // the previous observer watched. The most-intersecting page within the viewport is the current
      // one, so scrolling updates the header indicator without a manual scroll handler.
      pageObserverReference.current?.disconnect();
      const ratios = new Map<number, number>();
      const pageObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.target instanceof HTMLElement) {
              ratios.set(Number(entry.target.dataset.page), entry.intersectionRatio);
            }
          }
          let best = 1;
          let bestRatio = -1;
          for (const [number, ratio] of ratios) {
            if (ratio > bestRatio) {
              bestRatio = ratio;
              best = number;
            }
          }
          setCurrentPage(best);
        },
        { root: scrollReference.current, threshold: [0, 0.25, 0.5, 0.75, 1] }
      );
      for (const element of buffer) pageObserver.observe(element);
      pageObserverReference.current = pageObserver;

      renderedScaleReference.current = scale;
      // Publish the first page's intrinsic width so the header readout and fit maths stay in sync.
      if (firstPageWidth > 0) setBasePageWidth(firstPageWidth);
      // Reconcile the transform against the scale just painted: identity when the target has settled,
      // or the residual ratio if the user has already moved on to a new target mid-render.
      const ratio = scale > 0 ? targetScaleReference.current / scale : 1;
      pagesContainer.style.transformOrigin = "top center";
      pagesContainer.style.transform = ratio === 1 ? "" : `scale(${ratio})`;
    };

    // pdf.js rejects a superseded render with a cancellation error; that is expected, not a failure —
    // the run is being torn down and its stack replaced wholesale.
    //
    // Anything else is reported. A paint that does not finish never reaches the lines that attach the
    // two observers, and its cleanup has already disconnected the previous run's, so the panel is left
    // showing an earlier stack that will never paint another page however far the reader scrolls.
    // Swallowed, that looks exactly like a preview quietly deciding to stop working.
    void paint().catch((error: unknown) => {
      if (cancelled) return;
      // eslint-disable-next-line no-console -- a paint that never happened must not fail silently.
      console.error('PDF preview: the page stack could not be painted.', error);
    });

    return () => {
      cancelled = true;
      for (const work of pageWork.values()) {
        work.task?.cancel();
        work.layer?.cancel();
      }
      pageWork.clear();
      loadingTask?.destroy();
      pageObserverReference.current?.disconnect();
      paintObserverReference.current?.disconnect();
      releaseObserverReference.current?.disconnect();
    };
  }, [documentRevision, committedScale]);

  // Scroll-sync: react only to a genuinely new request (a fresh object from the editor) so an unrelated
  // re-render never fights the user's manual scroll. When the engine emitted a source map AND the layout
  // supplied the editor's line translated into assembled-document coordinates, scroll to the EXACT
  // rendered position of that block; otherwise fall back to the proportional mirror of the HTML preview
  // (map the editor's line onto the same fraction of the page stack).
  useEffect(() => {
    if (!scrollSyncEnabled || !scrollToLine) return;
    if (scrollToLine === lastScrollReference.current) return;
    lastScrollReference.current = scrollToLine;

    const container = scrollReference.current;
    if (container === null) return;

    if (sourceMap !== undefined && assembledLine !== undefined) {
      const entry = findSourceMapEntry(sourceMap, assembledLine);
      // The page elements carry `data-page`; find the one this entry maps to and offset within it.
      const pageElement =
        entry === null
          ? null
          : (pagesReference.current?.querySelector<HTMLElement>(`[data-page="${entry.page}"]`) ?? null);
      if (entry !== null && pageElement !== null) {
        // offsetTop/offsetHeight are layout metrics that ignore the zoom transform, so the target stays
        // correct even while a debounced crisp re-paint is pending. Leave a fraction of the viewport
        // above the target (floored at SYNC_TOP_MARGIN) so the engine's block-position granularity
        // cannot push the synced line off the top edge — see SYNC_TOP_FRACTION.
        const topGap = Math.max(SYNC_TOP_MARGIN, Math.round(container.clientHeight * SYNC_TOP_FRACTION));
        container.scrollTop = pageElement.offsetTop + entry.yFraction * pageElement.offsetHeight - topGap;
        return;
      }
      if (entry !== null) {
        // The map resolved a block but its page is not in the page stack, so the entry describes a
        // position that does not exist in this document. That used to fall through silently to the
        // proportional guess, which lands at an unrelated fraction and can even scroll BACKWARDS — a
        // broken lookup wearing the costume of a working one. The engine's source map should never
        // name a page beyond the render (it is filtered against the real page count), so reaching here
        // means the map and the rendered document have gone out of step; say so, then degrade.
        // eslint-disable-next-line no-console -- a broken lookup must surface rather than silently misscroll.
        console.warn(
          `PDF scroll sync: source-map entry for assembled line ${entry.line} names page ${entry.page}, ` +
            `which is not in the ${pageCount}-page render; falling back to a proportional scroll.`,
        );
      }
      // Fall through to the proportional sync when the map is empty or the mapped page is not in the DOM.
    }

    const span = Math.max(1, (totalLines ?? 1) - 1);
    const fraction = clamp((scrollToLine.line - 1) / span, 0, 1);
    container.scrollTop = fraction * (container.scrollHeight - container.clientHeight);
  }, [scrollToLine, scrollSyncEnabled, totalLines, sourceMap, assembledLine, pageCount]);

  const hasDiagnostics = diagnostics !== undefined && diagnostics.length > 0;
  const statusLabel = phase ? PHASE_LABELS[phase] : PENDING_LABEL;
  // The empty state and the failure notice are alternatives, never both: one says a preview is coming,
  // the other says this one is not. A refusal that left the invitation underneath it would read as the
  // panel still working on something.
  const showEmptyState = pdf === null && !isRendering && error === undefined;

  // The readout follows the target scale the user is asking for so it updates instantly on zoom/resize,
  // ahead of the debounced crisp re-render. Before a fit measurement lands it reads "Fit".
  const isFit = zoom.mode === "fit";
  const livePercentLabel = `${Math.round(targetScale * 100)}%`;
  const canZoomIn = targetScale < MAX_ZOOM;
  const canZoomOut = targetScale > MIN_ZOOM;

  // The Fit option shows the resulting live percentage once measured, e.g. "Fit (92%)". A custom scale
  // that matches a preset selects it; any other custom scale (from the +/- steps) surfaces as a
  // transient option so the native control always reflects the real state.
  const fitOptionLabel = isFit && isFitMeasured ? `Fit (${livePercentLabel})` : "Fit";
  const matchedPreset =
    zoom.mode === "custom"
      ? ZOOM_PRESETS.find((preset) => Math.abs(preset.scale - zoom.scale) < 1e-6)
      : undefined;
  const presetValue = isFit ? FIT_PRESET_VALUE : (matchedPreset?.value ?? "custom");

  /**
   * Apply a preset selection: the fit sentinel returns to width-fitting, a numeric preset pins that
   * scale, and the reflective "custom" entry (a non-preset scale from the steppers) is a no-op.
   *
   * @param value - The selected `<option>` value.
   */
  const selectPreset = (value: string): void => {
    if (value === FIT_PRESET_VALUE) {
      setZoom({ mode: "fit" });
      return;
    }
    if (value === "custom") return;
    setZoom({ mode: "custom", scale: clamp(Number(value), MIN_ZOOM, MAX_ZOOM) });
  };

  /** Switch to an explicit zoom one step above the scale currently on screen, clamped to the range. */
  const zoomIn = (): void => {
    setZoom({ mode: "custom", scale: clamp(targetScale * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) });
  };

  /** Switch to an explicit zoom one step below the scale currently on screen, clamped to the range. */
  const zoomOut = (): void => {
    setZoom({ mode: "custom", scale: clamp(targetScale / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) });
  };

  /**
   * Scroll the page named in the jump field into view, clamped to the document's range; ignore an empty
   * or non-numeric entry. The field is cleared afterwards so it always invites a fresh destination.
   */
  const commitJump = (): void => {
    const requested = Number(jumpValue);
    if (jumpValue.trim() === "" || !Number.isFinite(requested)) {
      setJumpValue("");
      return;
    }
    const target = clamp(Math.round(requested), 1, Math.max(1, pageCount));
    const pagesContainer = pagesReference.current;
    const element = pagesContainer?.children[target - 1];
    element?.scrollIntoView({ block: "start" });
    setCurrentPage(target);
    setJumpValue("");
  };

  /**
   * Commit a jump on Enter so the numeric field behaves like a go-to-page box.
   *
   * @param event - The keyboard event from the jump input.
   */
  const handleJumpKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitJump();
    }
  };

  /**
   * Reveal the editor source of the block at a click position on a rendered page (best-effort). Clicks on
   * a link annotation are left to pdf.js (internal destination scroll / external new tab). Otherwise the
   * click's page and vertical fraction are mapped back through the engine source map to the block's
   * assembled-document line, which the layout reverse-maps to a source `{file, line}`.
   *
   * @param event - The click event on the page stack.
   */
  const handlePagesClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (sourceMap === undefined || sourceMap.length === 0) return;
    if (onNavigateToSource === undefined && onNavigateToExactSource === undefined) return;
    if (!(event.target instanceof Element)) return;
    // A link annotation renders as an anchor; let pdf.js follow it rather than jumping to source.
    if (event.target.closest("a") !== null) return;
    const pageElement = event.target.closest<HTMLElement>("[data-page]");
    if (pageElement === null) return;
    // A click that ended a drag-selection over the text layer is a copy, not a request to navigate.
    if (isSelectionDragClick(pageElement)) return;
    const page = Number(pageElement.dataset.page);
    if (!Number.isFinite(page)) return;
    const rect = pageElement.getBoundingClientRect();
    const yFraction = rect.height > 0 ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0;
    const entry = assembledEntryAtPdfPosition(sourceMap, page, yFraction);
    if (entry === undefined) return;
    // Prefer the block's exact render-time origin when present (no reverse mapping, no staleness);
    // otherwise fall back to the assembled line for the layout to reverse-map.
    if (entry.path !== undefined && entry.sourceLine !== undefined && onNavigateToExactSource !== undefined) {
      onNavigateToExactSource(entry.path, entry.sourceLine);
    } else {
      onNavigateToSource?.(entry.line);
    }
  };

  return (
    <section
      aria-label="PDF preview"
      aria-busy={isRendering}
      className={cn(
        // `relative` positions the development-only render-cost overlay against the whole panel.
        "relative flex h-full flex-col overflow-hidden rounded-md border border-border bg-muted/30",
        className
      )}
    >
      {/* Header mirrors the HTML preview's: the HTML/PDF switch is the left anchor and the collapse
          button the right anchor, so the two modes share one stable header layout. */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        {onPreviewModeChange ? (
          <PreviewModeToggle mode={previewMode} onModeChange={onPreviewModeChange} />
        ) : (
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</span>
        )}
        <div className="flex items-center gap-1">
          {pageCount > 0 && (
            // Page group: the live "current / total" indicator plus a go-to-page field.
            <div className="mr-1 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
              {/* Fixed-width, digit-reserving cells so the indicator never jitters as page/total grow. */}
              <span data-testid="pdf-page-current" className="inline-block min-w-[1.75rem] text-right">
                {currentPage}
              </span>
              <span aria-hidden="true">/</span>
              <span
                data-testid="pdf-page-total"
                aria-label="total pages"
                className="inline-block min-w-[1.75rem] text-left"
              >
                {pageCount}
              </span>
              <input
                type="number"
                min={1}
                max={pageCount}
                inputMode="numeric"
                value={jumpValue}
                onChange={(event) => setJumpValue(event.target.value)}
                onKeyDown={handleJumpKeyDown}
                onBlur={commitJump}
                placeholder="#"
                aria-label="go to page"
                title="Go to page"
                data-testid="pdf-page-jump"
                className="h-6 w-10 rounded border border-border bg-transparent px-1 text-center text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}
          {/* Zoom control: a preset selector is the primary affordance; +/- fine-tune around it. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={zoomOut}
            disabled={!canZoomOut}
            className="h-6 w-6 text-muted-foreground"
            aria-label="zoom out"
            title="Zoom out"
            data-testid="pdf-zoom-out"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <select
            value={presetValue}
            onChange={(event) => selectPreset(event.target.value)}
            aria-label="zoom level"
            title="Zoom level"
            data-testid="pdf-zoom-preset"
            // Snug fixed width sized for the widest label ("Fit (100%)"), right-aligned, so the control
            // stays compact next to the steppers and never shifts as the selection/percentage changes.
            className="h-6 min-w-[5.5rem] whitespace-nowrap rounded-md border border-border bg-transparent px-1 text-right text-xs tabular-nums text-muted-foreground"
          >
            <option value={FIT_PRESET_VALUE} data-testid="pdf-zoom-fit">
              {fitOptionLabel}
            </option>
            {ZOOM_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
            {presetValue === "custom" && <option value="custom">{livePercentLabel}</option>}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={zoomIn}
            disabled={!canZoomIn}
            className="h-6 w-6 text-muted-foreground"
            aria-label="zoom in"
            title="Zoom in"
            data-testid="pdf-zoom-in"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          {onToggleScrollSync && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onToggleScrollSync}
              className={cn("h-6 w-6 text-muted-foreground", scrollSyncEnabled && "bg-accent text-foreground")}
              aria-label={scrollSyncEnabled ? "disable scroll sync" : "enable scroll sync"}
              aria-pressed={scrollSyncEnabled}
              title="Scroll preview with editor"
              data-testid="pdf-scroll-sync-toggle"
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          )}
          {onCollapse && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="collapse preview"
              onClick={onCollapse}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Not-part-of-main notice: the open file is outside the configured main document's include tree,
          so it is previewed on its own. Short and non-intrusive; only shown when a main file is set. */}
      {outsideMainTree ? (
        <div
          role="status"
          data-testid="outside-main-tree-notice"
          className="shrink-0 border-b px-3 py-1 text-xs text-[hsl(var(--warning))] bg-[hsl(var(--warning-bg))] border-[hsl(var(--warning-border))]"
        >
          This file isn&apos;t part of the main document; it&apos;s previewed on its own.
        </div>
      ) : null}

      {/* The render that did not happen, and why. Above the page stack rather than inside it, because
          whatever is still painted below belongs to an earlier document — the notice has to be readable
          without scrolling past pages it does not describe. The engine's message is shown as written:
          it is the layer that knows the reason, and a refusal an author cannot act on is the thing this
          surface exists to prevent. */}
      {error === undefined ? null : (
        <div
          role="alert"
          data-testid="pdf-preview-error"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error.message}
        </div>
      )}

      {/* Panel chrome, outside the scrolling page stack, so it never scrolls away from what it
          describes and never sits among the rendered pages. */}
      <RenderStatsOverlay title="Page preview" rows={pageRenderStatRows(stats)} />

      <div ref={scrollReference} className="relative flex-1 overflow-auto">
        {/* The stack grows to `max-content` (as wide as the widest page) but never narrower than the
            viewport, so a zoomed page never overflows its own container and its left edge stays
            scrollable; each page wrapper's `mx-auto` centres it while it still fits. */}
        <div
          ref={pagesReference}
          aria-label="Rendered PDF pages"
          onClick={handlePagesClick}
          className={cn(
            "flex min-h-full w-max min-w-full flex-col gap-4 p-4",
            pdf === null && "hidden"
          )}
        />
        {showEmptyState ? (
          <div className="flex min-h-full items-start justify-center p-4">
            <p className="mt-8 text-sm text-muted-foreground">{EMPTY_LABEL}</p>
          </div>
        ) : null}

        {isRendering ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <Loader2
                className="h-4 w-4 animate-spin text-primary"
                aria-hidden="true"
              />
              <span role="status" className="text-sm text-muted-foreground">
                {statusLabel}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {hasDiagnostics ? (
        <div className="border-t border-border p-3">
          <PdfDiagnostics
            diagnostics={diagnostics}
            onSelectLocation={onSelectLocation}
          />
        </div>
      ) : null}
    </section>
  );
}
