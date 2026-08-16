'use client';
// The generated, scoped Asciidoctor stylesheet is imported first so the brand stylesheet
// (asciidoc-preview.css) wins on equal specificity for the few rules we deliberately override.
import '../styles/asciidoctor-style.generated.css';
import '../styles/asciidoc-preview.css';
// Last, and scoped to its own style token: the PDF-look style states the whole page itself rather
// than adjusting the brand style, so nothing above it applies when it is the selected style.
import '../styles/print-preview.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utilities';
import type { PreviewState, ScrollRequest } from '@/hooks/use-asciidoc-preview';
import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { PdfDiagnostics } from '@/components/pdf-diagnostics';
import type { RenderDiagnostic, DiagnosticCode } from '@asciidocollab/asciidoc-pdf';
import type { DiagramWarning } from '@/components/diagrams/render-diagrams';
import { RenderStatsOverlay, type RenderStatRow } from '@/components/preview/render-stats-overlay';
import type { RenderTimings } from '@/workers/render-protocol';
import { PreviewStyleControl, type PreviewStyleValue } from '@/components/preview-style-control';
import { PreviewModeToggle, type PreviewMode } from '@/components/preview-mode-toggle';
import { PreviewZoomControl, usePreviewZoom } from '@/components/preview-zoom-control';
import { usePrintAppearance } from '@/hooks/use-print-appearance';
import { usePrintFonts } from '@/hooks/use-print-fonts';
import { appearanceToCssProperties, pointsToPixels } from '@/lib/print-preview/appearance-to-css';
import { toDiagnosticPropertiesList } from '@/lib/print-preview/to-diagnostic-properties';
import { ShowIncludesControl } from '@/components/show-includes-control';
import { API_BASE_URL } from '@/lib/api/base-url';
import { isSelectionDragClick } from '@/lib/preview-selection';
import {
  INCLUDE_PLACEHOLDER_CLASS,
  INCLUDE_PLACEHOLDER_TARGET_ATTR,
} from '@/lib/asciidoc/include-placeholder';
// Re-exported for back-compat: the AsciiDoc file-name rule now lives in lib/asciidoc/file-name
// (single presentation copy of the domain rule), but existing callers import it from here.
export { isAsciiDocumentFile as isAsciiDocFile } from '@/lib/asciidoc/file-name';

/**
 * The last render's stage costs as overlay rows, or nothing before one has been measured.
 *
 * The mapping lives here rather than in the overlay because the two preview formats report
 * structurally different things, and each is the authority on how to read its own figures.
 */
function webPreviewStatRows(timings: RenderTimings | null | undefined): readonly RenderStatRow[] {
  if (timings === null || timings === undefined) return [];
  // The total leads and the three stages sit under it. They are parts of it, not figures beside it —
  // read as a flat column the four appear to describe a render costing roughly twice what it did.
  return [
    { label: 'total', value: timings.totalMs, unit: 'ms' },
    { label: 'parse', value: timings.parseMs, unit: 'ms', depth: 1 },
    { label: 'convert', value: timings.convertMs, unit: 'ms', depth: 1 },
    { label: 'post-process', value: timings.postProcessMs, unit: 'ms', depth: 1 },
  ];
}

/** The scroll viewport's own inset, subtracted when working out how much width a page may occupy. */
const PRINT_PAGE_PADDING = 16;

/** Sub-pixel measurement jitter to discard, so a resize does not re-render for a fraction of a pixel. */
const PRINT_MEASURE_EPSILON = 0.5;

/** The diagram render-warning code shown as an error (a genuine draw failure); the rest are warnings. */
const DIAGRAM_ERROR_CODE: DiagnosticCode = 'malformed-diagram';

/** Each client diagram-render warning code, mapped to the shared render-diagnostic code it surfaces as. */
const DIAGRAM_WARNING_CODE: Record<DiagramWarning['code'], DiagnosticCode> = {
  'render-failed': DIAGRAM_ERROR_CODE,
  'unsupported-engine': 'diagram-unsupported',
  'remote-resource-blocked': 'remote-skipped',
};

/**
 * Map a fail-soft client-side diagram render warning to the shared render-diagnostic shape, so the
 * preview surfaces "what and where" in the SAME collapsible panel the PDF export uses — instead of a
 * silent `console.warn`. A render failure is an error; a skipped remote resource or an unsupported
 * engine is a (non-fatal) warning. The block's source line, when known, rides in the resource label.
 *
 * @param warning - One per-diagram warning returned by the client renderer.
 * @param filePath - The previewed file's path, used as the resource label (defaults to "diagram").
 * @returns The equivalent render diagnostic for the shared diagnostics panel.
 */
function toPreviewDiagnostic(warning: DiagramWarning, filePath = 'diagram'): RenderDiagnostic {
  return {
    severity: warning.code === 'render-failed' ? 'error' : 'warning',
    code: DIAGRAM_WARNING_CODE[warning.code],
    resource: warning.sourceLine === null ? filePath : `${filePath}:${warning.sourceLine}`,
    message: `${warning.engine}: ${warning.message}`,
  };
}

/**
 * Follow a link clicked inside the rendered preview. An internal cross-reference (`#id`) scrolls the
 * preview to its target element; any other link opens in a hardened new tab. Default navigation is always
 * prevented — the preview is injected into the app document, so a same-tab navigation would unload the
 * editor.
 *
 * @param event - The originating click event (its default is prevented).
 * @param anchor - The anchor element that was clicked.
 * @param container - The preview output container to resolve internal `#id` targets within.
 */
function followPreviewLink(event: MouseEvent, anchor: HTMLAnchorElement, container: HTMLElement): void {
  const href = anchor.getAttribute('href') ?? '';
  if (!href) return;
  event.preventDefault();
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const target = id ? container.querySelector(`[id="${CSS.escape(id)}"]`) : null;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

function SyncIndicator({ state, isEnabled }: { state: PreviewState; isEnabled: boolean }) {
  if (!isEnabled || state === 'idle') {
    return <span className="text-xs text-muted-foreground" aria-label="not available">–</span>;
  }
  if (state === 'up-to-date') {
    return <span className="text-xs text-[hsl(var(--success))]" aria-label="up to date">✓</span>;
  }
  if (state === 'error') {
    return <span className="text-xs text-destructive" aria-label="preview error">⚠ Preview error</span>;
  }
  return (
    <span data-testid="sync-indicator" className="text-xs text-muted-foreground animate-pulse" aria-label="rendering">
      ●
    </span>
  );
}

interface AsciiDocPreviewProperties {
  content: string;
  isEnabled: boolean;
  /**
   * Whether `content` for the open file is still being fetched, so an empty buffer means "not here
   * yet" rather than "this file is empty". Passed straight through — see the hook option of the same
   * name for why nothing downstream can work it out for itself.
   */
  contentPending?: boolean;
  /** Project id, used to resolve the base path for image macros in the preview. */
  projectId: string;
  /** When set with {@link getFiles}, render the assembled main document with includes inlined. */
  mainPath?: string;
  /** Returns the path→content snapshot for include assembly; read lazily at render time. */
  getFiles?: () => Record<string, string>;
  /**
   * Bumps when a reachable INCLUDED file's content changes (a collaborator's live edit or save) with
   * no edit to the open file itself. Forwarded to the preview hook so the assembled render re-reads the
   * fresh {@link getFiles} snapshot — keeping the preview consistent with the outline on the same signal.
   */
  filesVersion?: number;
  /** Project-level render-config attributes (soft-defaulted), applied beneath the document's own. */
  projectAttributes?: Record<string, string>;
  /**
   * Project main-file path (root) for cross-document attribute resolution. When set
   * with {@link openFilePath} and {@link getFiles}, the open file's `{name}` references resolve to the
   * value in effect at its include-point under this root. Null/unset ⇒ standalone resolution.
   */
  rootFilePath?: string | null;
  /** Project-relative path of the previewed open file, whose inherited attribute scope is seeded. */
  openFilePath?: string;
  /**
   * True when the open file is NOT part of the configured main document's include tree, so it is being
   * previewed on its own. Surfaces a short, non-intrusive notice in the header. Never set when no main
   * document is configured (there is then no tree to be outside of).
   */
  outsideMainTree?: boolean;
  scrollToLine?: ScrollRequest | null;
  /** When provided, a collapse button is rendered in the header. */
  onCollapse?: () => void;
  /** Whether the preview scrolls to match editor scroll position. */
  scrollSyncEnabled?: boolean;
  /** Called when the user toggles the scroll sync option. */
  onToggleScrollSync?: () => void;
  /** Currently selected preview rendering style. Defaults to the brand look. */
  previewStyle?: PreviewStyleValue;
  /**
   * Called when the user picks a different preview style in the header control.
   *
   * @param style - The newly selected style token.
   */
  onPreviewStyleChange?: (style: PreviewStyleValue) => void;
  /**
   * The project's PDF theme document, as the export would resolve it. Read only by the Print style,
   * which dresses the page in it; the other two styles ignore it entirely.
   */
  themeText?: string;
  /** That theme document's project-relative path, used to attribute a diagnostic to a file. */
  themePath?: string;
  /**
   * Schedule background fetches for the project asset paths the Print style's fonts need. The
   * application's existing asset mechanism, passed in rather than rebuilt here.
   *
   * @param paths - Project-relative asset paths.
   */
  ensureAssets?: (paths: readonly string[]) => void;
  /**
   * The bytes of one fetched project asset, or undefined when it has not arrived.
   *
   * @param path - The project-relative asset path.
   * @returns The asset's bytes, if held.
   */
  getAssetBytes?: (path: string) => Uint8Array | undefined;
  /** Bumps whenever an asset fetch settles, so a font waiting on its bytes is retried. */
  assetVersion?: number;
  /**
   * Whether every one of these asset paths has been answered, with bytes or with a failure.
   *
   * @param paths - Project-relative asset paths.
   * @returns Whether all of them have settled.
   */
  assetsSettled?: (paths: readonly string[]) => boolean;
  /**
   * Reveal a diagnostic's source location in the editor.
   *
   * @param location - Where the problem is.
   * @param location.path - The project-relative document it is in.
   * @param location.line - The 1-based line, when the problem has one.
   */
  onSelectDiagnosticLocation?: (location: { path: string; line?: number }) => void;
  /** When false (default), included bodies are hidden behind placeholders. Passed to the preview hook. */
  showIncludedFiles?: boolean;
  /**
   * Called when the user clicks/activates a placeholder to open the included file.
   *
   * @param path - The project-relative path of the included file.
   */
  onOpenInclude?: (path: string) => void;
  /**
   * Called when the user clicks a rendered block (not a link) so the editor can reveal that block's
   * source. Receives the block's `data-source-line` — a line in the ASSEMBLED (open-file-rooted)
   * document the worker converts; the layout reverse-maps it to a `{file, line}` and jumps there.
   *
   * @param assembledLine - The clicked block's 1-based assembled-document line.
   */
  onNavigateToSource?: (assembledLine: number) => void;
  /**
   * Called when the user toggles the show-included-files control; when provided, the control renders.
   *
   * @param value - The new value (true = show bodies inline, false = hide behind placeholders).
   */
  onShowIncludedFilesChange?: (value: boolean) => void;
  /** The active preview mode; rendered in the header's shared HTML/PDF switch. */
  previewMode?: PreviewMode;
  /**
   * Called when the user switches the preview mode from the header.
   *
   * @param mode - The newly selected preview mode.
   */
  onPreviewModeChange?: (mode: PreviewMode) => void;
}

/** Live preview panel that renders AsciiDoc source as styled HTML via a Web Worker. */
export function AsciiDocPreview({
  content,
  isEnabled,
  contentPending,
  projectId,
  mainPath,
  getFiles,
  filesVersion,
  projectAttributes,
  rootFilePath,
  openFilePath,
  outsideMainTree = false,
  scrollToLine = null,
  onCollapse,
  scrollSyncEnabled = false,
  onToggleScrollSync,
  previewStyle = 'asciidocollab',
  onPreviewStyleChange,
  themeText,
  themePath,
  ensureAssets,
  getAssetBytes,
  assetVersion,
  assetsSettled,
  onSelectDiagnosticLocation,
  showIncludedFiles = false,
  onOpenInclude,
  onNavigateToSource,
  onShowIncludedFilesChange,
  previewMode = 'html',
  onPreviewModeChange,
}: AsciiDocPreviewProperties) {
  // Default image base path: AsciiDoc image macros reference files by path, so point Asciidoctor's
  // `imagesdir` at the project's image endpoint (see GET /projects/:id/images/*).
  const imagesDirectory = `${API_BASE_URL}/projects/${projectId}/images`;
  const {
    state,
    error,
    previewRef,
    outputRef,
    mathPresent,
    diagramsPresent,
    timings,
    engineFailed,
    retryEngine,
    renderNonce,
  } = useAsciidocPreview({
    content,
    isEnabled,
    contentPending,
    scrollToLine,
    imagesDir: imagesDirectory,
    mainPath,
    getFiles,
    filesVersion,
    projectAttributes,
    rootFileId: rootFilePath,
    openFileId: openFilePath,
    showIncludes: showIncludedFiles,
  });

  // Per-diagram render diagnostics for the CURRENT preview (skipped remote data, unsupported engine, a
  // draw failure). Surfaced in the shared diagnostics panel so a diagram that fails to generate is
  // reported with what + where, exactly like the PDF export — not swallowed by a console log.
  const [diagramDiagnostics, setDiagramDiagnostics] = useState<readonly RenderDiagnostic[]>([]);

  // ── The Print style's page frame ───────────────────────────────────────────────────────────────
  //
  // The page is a fixed-width column at the theme's own page size, scaled to fit the pane. Scaling
  // rather than reflowing is what makes the preview's line breaks the PDF's line breaks: the column
  // is laid out once at its intrinsic size, and the zoom only changes how large that layout is drawn.
  //
  // Nothing here paginates. The column is one continuous flow with no page breaks, no running header
  // or footer and no page number — the preview shows a page's appearance, not a paginated document.
  const isPrintStyle = previewStyle === 'print';
  const printAppearance = usePrintAppearance({
    enabled: isPrintStyle,
    projectId,
    ...(themeText === undefined ? {} : { themeText }),
    ...(themePath === undefined ? {} : { themePath }),
  });
  const printFonts = usePrintFonts({
    enabled: isPrintStyle,
    fonts: printAppearance.appearance.fonts,
    ...(themePath === undefined ? {} : { themePath }),
    ...(ensureAssets === undefined ? {} : { ensureAssets }),
    ...(getAssetBytes === undefined ? {} : { getAssetBytes }),
    ...(assetVersion === undefined ? {} : { assetVersion }),
    ...(assetsSettled === undefined ? {} : { assetsSettled }),
  });
  // The page's own values, projected once the fonts are known: every line-height among them is a
  // length built from the FACE's built-in height, so the projection cannot happen before the metrics
  // of the faces the appearance names have been resolved.
  const printCssProperties = useMemo(
    () =>
      isPrintStyle
        ? appearanceToCssProperties(printAppearance.appearance, printFonts.faceBox)
        : undefined,
    [isPrintStyle, printAppearance.appearance, printFonts.faceBox],
  );
  // Everything the Print style has to say about the appearance it is showing: a theme it could not
  // read, a value it had to reject, a typeface it had to approximate. One surface, the PDF's own.
  const printDiagnostics = useMemo(
    () =>
      isPrintStyle
        ? toDiagnosticPropertiesList([...printAppearance.diagnostics, ...printFonts.diagnostics])
        : [],
    [isPrintStyle, printAppearance.diagnostics, printFonts.diagnostics],
  );
  const printPageWidth = pointsToPixels(printAppearance.appearance.page.widthPt);
  // The scaler's own (unscaled) height, measured; `0` until the first render has been laid out.
  const [printPageHeight, setPrintPageHeight] = useState(0);
  // The width a page may occupy inside the scroll viewport; `0` until the first measurement.
  const [printViewportWidth, setPrintViewportWidth] = useState(0);
  const printPageReference = useRef<HTMLDivElement | null>(null);

  // Fit-to-width never exceeds 100%: a pane wider than the page leaves the page at its own width
  // rather than blowing it up to fill the pane, which is what keeps a page looking like a page.
  const printFitScale =
    printViewportWidth > 0 && printPageWidth > 0
      ? Math.min(1, printViewportWidth / printPageWidth)
      : undefined;
  const printZoom = usePreviewZoom(isPrintStyle ? printFitScale : undefined, 1);
  const printScale = printZoom.targetScale;

  // Watch the scroll viewport and the laid-out page, and keep both measurements in state: the first
  // decides the fit, the second gives the scaled column a box of the right size to scroll inside.
  // Both are rAF-guarded so a resize drag coalesces into one update per frame.
  useEffect(() => {
    if (!isPrintStyle) return;
    const viewport = previewRef.current;
    if (viewport === null) return;

    let frame = 0;
    const measure = (): void => {
      const available = Math.max(0, viewport.clientWidth - PRINT_PAGE_PADDING * 2);
      setPrintViewportWidth((previous) =>
        Math.abs(available - previous) < PRINT_MEASURE_EPSILON ? previous : available,
      );
      const page = printPageReference.current;
      if (page !== null) {
        const height = page.offsetHeight;
        setPrintPageHeight((previous) =>
          Math.abs(height - previous) < PRINT_MEASURE_EPSILON ? previous : height,
        );
      }
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    if (printPageReference.current !== null) observer.observe(printPageReference.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // NOT `renderNonce`. The page's height is the document's height and the document changes with
    // every keystroke, so this used to be rebuilt per render to re-measure — which tore down the
    // observer, built another, re-observed both boxes (an observation reports itself, so that is a
    // second measurement of its own) and forced a layout read out of the effect that ran straight
    // after the DOM patch. All of it for a measurement the observer was about to make anyway: the
    // observed box IS the page, and a render that changes the page's height changes the box the
    // observer is watching. One that does not change it needs no measurement.
    //
    // `isEnabled` is here for the only thing that can put a DIFFERENT page element under the ref: it
    // is what mounts and unmounts the page frame (a file this panel cannot preview shows a notice
    // instead), so an effect that missed it would be left observing an element no longer in the
    // document. The style is not such a thing — both wrappers are mounted under every style, which is
    // what stops a style switch throwing away the rendered document — but this effect measures
    // nothing outside Print, so it still turns on and off with it.
  }, [isPrintStyle, previewRef, isEnabled]);

  // Keep a stable ref to the latest onOpenInclude callback so the delegated listener closure never
  // captures a stale function reference (avoids re-attaching the listener just because the callback
  // identity changed, while still calling the most-recent version on each interaction).
  const onOpenIncludeReference = useRef(onOpenInclude);
  onOpenIncludeReference.current = onOpenInclude;
  const onNavigateToSourceReference = useRef(onNavigateToSource);
  onNavigateToSourceReference.current = onNavigateToSource;

  // Render math client-side AFTER a render has been committed to the DOM, and only when the worker
  // flagged in-effect STEM (resolved `:stem:` + stem markup). MathJax is lazy-imported inside
  // `renderMath`, so its bundle cost is paid only on a math-bearing preview. `renderMath` is
  // incremental: it typesets the delimited expressions this commit brought in and leaves every
  // expression that is already typeset exactly as it is — the same node, not a fresh one that looks
  // the same. Output stays within the scoped container (Constitution VI) — we only ever typeset that
  // node.
  //
  // Keyed on the commit, NOT on the rendered markup: the hook patches the output element in place, so
  // markup that happens to be unchanged says nothing about whether the element now holds expressions
  // that still need typesetting. A pass gated on the markup would silently skip such a commit and
  // leave the raw delimiters on screen. `renderNonce === 0` is the genuine "nothing committed yet".
  useEffect(() => {
    if (!mathPresent || renderNonce === 0) return;
    const container = outputRef.current;
    if (!container) return;
    let cancelled = false;
    void import('@/components/math/render-math').then(({ renderMath }) => {
      if (cancelled) return;
      void renderMath(container);
    });
    return () => {
      cancelled = true;
    };
  }, [renderNonce, mathPresent]);

  // Render diagram placeholders client-side AFTER a render has been committed, and only when the
  // worker flagged a native diagram block (`diagramsPresent`). The heavy engines (mermaid/vega/
  // graphviz) are lazy-imported inside `renderDiagrams`, so their bundle cost is paid only on a
  // diagram-bearing preview — mirroring the MathJax effect above. Keyed on the commit for the same
  // reason it is: a patch can put an undrawn placeholder on screen without changing the markup, and a
  // pass gated on the markup would never draw it. `renderDiagrams` is incremental in the same way the
  // math pass is: a placeholder that already holds a drawing of its current source is left untouched,
  // so a refresh costs one engine run per diagram the author changed rather than one per diagram in
  // the document. Fail-soft: `renderDiagrams` never throws and returns per-diagram warnings
  // (unsupported/offline engine, blocked remote resource, render failure) — we log those and leave the
  // rest of the preview intact; a rejected import/promise is caught so it can never crash the preview.
  // Output stays within the scoped container (Constitution VI) — we only ever render into that node.
  useEffect(() => {
    if (!diagramsPresent || renderNonce === 0) {
      // No diagrams in the current render ⇒ clear any diagnostics left from a previous one so a fixed
      // document's stale warnings never linger (mirrors the PDF panel clearing on each fresh render).
      setDiagramDiagnostics([]);
      return;
    }
    const container = outputRef.current;
    if (!container) return;
    let cancelled = false;
    void import('@/components/diagrams/render-diagrams')
      .then(({ renderDiagrams }) => {
        if (cancelled) return;
        return renderDiagrams(container).then((result) => {
          if (cancelled) return;
          setDiagramDiagnostics(
            result.warnings.map((warning) => toPreviewDiagnostic(warning, openFilePath)),
          );
        });
      })
      .catch(() => {
        // Defence in depth: `renderDiagrams` is fail-soft by contract, but a failed dynamic import (or
        // an unexpected rejection) must still never break the preview. Surface it as a single diagnostic
        // rather than crashing; the rest of the preview stays rendered.
        if (cancelled) return;
        setDiagramDiagnostics([
          {
            severity: 'warning',
            code: DIAGRAM_ERROR_CODE,
            resource: openFilePath ?? 'diagram',
            message: 'Diagram rendering could not run; the diagram source is shown instead.',
          },
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [renderNonce, diagramsPresent, openFilePath]);

  // Delegated listener for include-placeholder interactions (click + keyboard).
  // A single listener on the container handles all placeholders — even those added
  // after re-render — via `.closest()` delegation (Constitution IV: no per-element handlers).
  // The ref pattern above ensures handlers always call the latest `onOpenInclude` without needing it
  // in deps.
  //
  // Re-attached on each commit, and on the panel becoming previewable again. The commit is the same
  // signal the passes above use; `isEnabled` is here because it is what mounts and unmounts the
  // container, and a listener attached to a container that has since been replaced is a listener on a
  // node no longer in the document — clicks in the preview would simply stop being answered.
  useEffect(() => {
    const container = outputRef.current;
    if (!container) return;

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      // A link inside the preview is followed (internal xref scroll / external new tab) rather than
      // treated as a jump-to-source click.
      const anchor = event.target.closest('a[href]');
      if (anchor instanceof HTMLAnchorElement) {
        followPreviewLink(event, anchor, container);
        return;
      }

      // An include placeholder opens the included file.
      const placeholder = event.target.closest(
        `.${INCLUDE_PLACEHOLDER_CLASS}[${INCLUDE_PLACEHOLDER_TARGET_ATTR}]`,
      );
      if (placeholder) {
        const path = placeholder.getAttribute(INCLUDE_PLACEHOLDER_TARGET_ATTR);
        if (path) onOpenIncludeReference.current?.(path);
        return;
      }

      // Any other rendered block jumps the editor to that block's source line — unless the click was
      // the end of a drag-selection, in which case the reader is copying text, not navigating.
      const sourced = event.target.closest('[data-source-line]');
      if (sourced instanceof HTMLElement && !isSelectionDragClick(sourced)) {
        const line = Number(sourced.dataset['sourceLine']);
        if (Number.isFinite(line) && line > 0) onNavigateToSourceReference.current?.(line);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target =
        event.target instanceof Element
          ? event.target.closest(`.${INCLUDE_PLACEHOLDER_CLASS}[${INCLUDE_PLACEHOLDER_TARGET_ATTR}]`)
          : null;
      if (!target) return;
      event.preventDefault();
      const path = target.getAttribute(INCLUDE_PLACEHOLDER_TARGET_ATTR);
      if (path) onOpenIncludeReference.current?.(path);
    };

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [renderNonce, isEnabled]);

  return (
    // `relative` positions the development-only render-cost overlay against the whole panel.
    <div className="relative flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        {/* Left anchor: the HTML/PDF switch sits in the SAME position in both preview modes so the
            header stays stable when the mode changes. Falls back to a static label when this preview
            is used without a mode switch. */}
        {onPreviewModeChange ? (
          <PreviewModeToggle mode={previewMode} onModeChange={onPreviewModeChange} />
        ) : (
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Preview</span>
        )}
        <div className="flex items-center gap-1">
          {/* The zoom control appears only for the style that presents a page to zoom, and offers the
              same default, presets and limits the PDF preview offers — one model drives both. */}
          {isPrintStyle && <PreviewZoomControl zoom={printZoom} testIdPrefix="print" />}
          {onPreviewStyleChange && (
            <PreviewStyleControl value={previewStyle} onChange={onPreviewStyleChange} compact />
          )}
          <SyncIndicator state={state} isEnabled={isEnabled} />
          {onShowIncludedFilesChange && (
            <ShowIncludesControl value={showIncludedFiles} onChange={onShowIncludedFilesChange} />
          )}
          {onToggleScrollSync && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onToggleScrollSync}
              className={cn('h-6 w-6 text-muted-foreground', scrollSyncEnabled && 'bg-accent text-foreground')}
              aria-label={scrollSyncEnabled ? 'disable scroll sync' : 'enable scroll sync'}
              aria-pressed={scrollSyncEnabled}
              title="Scroll preview with editor"
              data-testid="scroll-sync-toggle"
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
      {outsideMainTree && (
        <div
          role="status"
          data-testid="outside-main-tree-notice"
          className="px-3 py-1 text-xs border-b shrink-0 text-[hsl(var(--warning))] bg-[hsl(var(--warning-bg))] border-[hsl(var(--warning-border))]"
        >
          This file isn&apos;t part of the main document; it&apos;s previewed on its own.
        </div>
      )}

      {/* Error callout — shown below header, preserves previous html underneath */}
      {state === 'error' && error && (
        <div className="px-3 py-1.5 text-xs text-destructive border-b bg-destructive/10 shrink-0">
          {error}
        </div>
      )}

      {/* The render engine died repeatedly and supervision has stopped rebuilding it, so nothing will
          bring the preview back on its own. Said plainly and left standing — an engine that quietly
          stops updating looks identical to a document that has nothing new to show. The retry is here
          because only the author can decide the document is worth another attempt.

          Panel chrome, deliberately outside `.asciidoc-preview-content`: those styles belong to the
          rendered document, and this notice is the app talking, not the document. */}
      {engineFailed && (
        <div
          role="alert"
          data-testid="engine-failure-notice"
          className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs border-b shrink-0 text-destructive bg-destructive/10"
        >
          <span>The preview engine stopped and could not restart itself. The preview is out of date.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={retryEngine}
          >
            Restart preview engine
          </Button>
        </div>
      )}

      {/* The Print style's own appearance problems, on the SAME surface the PDF export reports its
          problems on — and deliberately here, outside the scroll container: a surface that appeared
          inside the page column would displace and resize the very page it is reporting about. */}
      {printDiagnostics.length > 0 && (
        <div className="px-3 py-1.5 border-b shrink-0">
          <PdfDiagnostics
            diagnostics={printDiagnostics}
            title="Appearance diagnostics"
            ariaLabel="Print preview appearance diagnostics"
            intro="The document is shown. Some of the theme could not be applied exactly."
            {...(onSelectDiagnosticLocation === undefined
              ? {}
              : { onSelectLocation: onSelectDiagnosticLocation })}
          />
        </div>
      )}

      {/* Per-diagram render diagnostics, surfaced in the same collapsible panel the PDF export uses so a
          diagram that could not be drawn is reported with what + where instead of failing silently. */}
      {diagramDiagnostics.length > 0 && (
        <div className="px-3 py-1.5 border-b shrink-0">
          <PdfDiagnostics
            diagnostics={diagramDiagnostics}
            title="Preview diagnostics"
            ariaLabel="Preview diagnostics"
            intro="The preview rendered. Some diagrams were skipped or could not be drawn."
          />
        </div>
      )}

      {/* Outside the scroll container, and so outside `.asciidoc-preview-content`: the document's own
          styles stay scoped to the document, and this chrome cannot be mistaken for part of it. */}
      <RenderStatsOverlay title="Web preview" rows={webPreviewStatRows(timings)} />

      <div
        ref={previewRef}
        // The Print backdrop is the PDF panel's own: the same muted wash behind the same white sheet,
        // so the two previews read as two views of one document rather than two different surfaces.
        //
        // `scrollbar-gutter: stable` is not cosmetic, and it is here rather than in
        // `print-preview.css` because this element is OUTSIDE `.asciidoc-preview-content` — every rule
        // in that sheet is confined to the container asked for the Print style, which this is an
        // ancestor of.
        //
        // What it prevents is a loop with no fixed point. Under Print the fit scale is measured from
        // this element's `clientWidth`, and the scaled page's box is `pageHeight × scale` — so where a
        // scrollbar takes layout space, its appearance narrows the pane, which shrinks the scale,
        // which shortens the box, which can take the content back under the pane's height and remove
        // the scrollbar again. Simulated against the panel's own arithmetic: a 700px pane showing a
        // 1000px column is 873.6px tall without the bar and 854.7px with it, so every pane height in
        // [855, 873] alternates for ever, one flip per animation frame — a band of `pageHeight ×
        // scrollbarWidth / pageWidth` ≈ 1.9% of the document's height, reachable whenever the whole
        // scaled document is about as tall as the pane. Reserving the gutter takes `clientWidth` out
        // of the loop: the measurement no longer depends on what the measurement causes.
        className={cn(
          'flex-1 overflow-auto p-4',
          isPrintStyle && 'bg-muted/30 [scrollbar-gutter:stable]',
        )}
        data-testid="preview-scroll-container"
      >
        {/* Reserved for a file this panel genuinely cannot render — that is what `isEnabled` states.
            It used to be shown for an idle panel as well, which made every switch between two
            perfectly previewable files announce that the preview was unavailable: the panel was
            remounted on each switch, and a freshly mounted panel is idle until its first render lands.
            Being between two renders is not the same as having nothing to render. */}
        {isEnabled ? (
          // The two wrappers are here under EVERY style, carrying nothing at all unless Print is the
          // selected one. Rendering them conditionally would remount the output element on each style
          // switch, and the output element's contents belong to the preview hook rather than to React
          // — a remount would throw away the rendered document and leave the pane blank until the next
          // render happened to arrive, which for a document nobody is typing in is never.
          //
          // Outer: the scaled page's box, so the pane scrolls by what is actually on screen.
          // Inner: the page at its intrinsic size, scaled about its top-left corner.
          <div
            data-testid="print-page-viewport"
            // `rounded-sm shadow-sm` is what the PDF preview draws around each of its pages, and it
            // is here rather than on the scaled column so the sheet's edge stays the same weight at
            // every zoom instead of thickening with the page.
            className={cn(isPrintStyle && 'mx-auto rounded-sm shadow-sm')}
            style={
              isPrintStyle
                ? {
                    width: printPageWidth * printScale,
                    ...(printPageHeight > 0 ? { height: printPageHeight * printScale } : {}),
                  }
                : undefined
            }
          >
            <div
              ref={printPageReference}
              style={
                isPrintStyle
                  ? {
                      width: printPageWidth,
                      transform: `scale(${printScale})`,
                      transformOrigin: 'top left',
                    }
                  : undefined
              }
            >
              {/* Deliberately childless, and deliberately mounted before there is anything to show. Its
                  contents belong to the preview hook, which patches each render into it directly: React
                  must not be given a say in what is inside it, or it would reconcile away the diagrams and
                  typeset expressions the client put there. Mounting it up front is what gives the very
                  first render something to be committed INTO — gate it on having rendered something and it
                  could never render anything.

                  `aria-busy` covers the whole render, not just the moment it lands: a reader on a screen
                  reader is told the region is being updated for as long as that is true, instead of being
                  read a document that is about to change under them. */}
              <div
                ref={outputRef}
                data-testid="asciidoc-output"
                className="asciidoc-preview-content"
                data-preview-style={previewStyle}
                aria-busy={state === 'pending' || state === 'rendering'}
                // The theme's resolved values, and only under the Print style. Every one of them has
                // been parsed to a typed value and formatted by something that can produce one shape,
                // so no theme text reaches the page as CSS.
                style={printCssProperties}
              />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Preview not available for this file type</p>
        )}
      </div>
    </div>
  );
}
