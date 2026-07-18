'use client';
// The generated, scoped Asciidoctor stylesheet is imported first so the brand stylesheet
// (asciidoc-preview.css) wins on equal specificity for the few rules we deliberately override.
import '../styles/asciidoctor-style.generated.css';
import '../styles/asciidoc-preview.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utilities';
import type { PreviewState, ScrollRequest } from '@/hooks/use-asciidoc-preview';
import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { PdfDiagnostics } from '@/components/pdf-diagnostics';
import type { RenderDiagnostic, DiagnosticCode } from '@asciidocollab/asciidoc-pdf';
import type { DiagramWarning } from '@/components/diagrams/render-diagrams';
import { PreviewStyleControl, type PreviewStyleValue } from '@/components/preview-style-control';
import { PreviewModeToggle, type PreviewMode } from '@/components/preview-mode-toggle';
import { ShowIncludesControl } from '@/components/show-includes-control';
import { API_BASE_URL } from '@/lib/api/base-url';
import {
  INCLUDE_PLACEHOLDER_CLASS,
  INCLUDE_PLACEHOLDER_TARGET_ATTR,
} from '@/lib/asciidoc/include-placeholder';
// Re-exported for back-compat: the AsciiDoc file-name rule now lives in lib/asciidoc/file-name
// (single presentation copy of the domain rule), but existing callers import it from here.
export { isAsciiDocumentFile as isAsciiDocFile } from '@/lib/asciidoc/file-name';

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
  /** When false (default), included bodies are hidden behind placeholders. Passed to the preview hook. */
  showIncludedFiles?: boolean;
  /**
   * Called when the user clicks/activates a placeholder to open the included file.
   *
   * @param path - The project-relative path of the included file.
   */
  onOpenInclude?: (path: string) => void;
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
  showIncludedFiles = false,
  onOpenInclude,
  onShowIncludedFilesChange,
  previewMode = 'html',
  onPreviewModeChange,
}: AsciiDocPreviewProperties) {
  // Default image base path: AsciiDoc image macros reference files by path, so point Asciidoctor's
  // `imagesdir` at the project's image endpoint (see GET /projects/:id/images/*).
  const imagesDirectory = `${API_BASE_URL}/projects/${projectId}/images`;
  const { html, state, error, previewRef, mathPresent, diagramsPresent } = useAsciidocPreview({
    content,
    isEnabled,
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

  // Ref to the rendered-output container — the scoped `.asciidoc-preview-content` element whose
  // sanitized HTML may carry STEM delimiters MathJax typesets in place.
  const outputReference = useRef<HTMLDivElement | null>(null);

  // Per-diagram render diagnostics for the CURRENT preview (skipped remote data, unsupported engine, a
  // draw failure). Surfaced in the shared diagnostics panel so a diagram that fails to generate is
  // reported with what + where, exactly like the PDF export — not swallowed by a console log.
  const [diagramDiagnostics, setDiagramDiagnostics] = useState<readonly RenderDiagnostic[]>([]);

  // Keep a stable ref to the latest onOpenInclude callback so the delegated listener closure never
  // captures a stale function reference (avoids re-attaching the listener just because the callback
  // identity changed, while still calling the most-recent version on each interaction).
  const onOpenIncludeReference = useRef(onOpenInclude);
  onOpenIncludeReference.current = onOpenInclude;

  // Stable `dangerouslySetInnerHTML` payload, keyed on `html`. A fresh `{ __html }` object literal
  // every render would make React treat the prop as changed and RE-APPLY innerHTML on every re-render
  // (even an unrelated one, e.g. an editor click), wiping the client-typeset math (`<math>`/
  // `mjx-container`) that `renderMath` inserted — and since `[html, mathPresent]` are unchanged the
  // typeset effect would not re-run, leaving the raw `\$…\$` delimiters on screen. Memoizing keeps the
  // object referentially stable while `html` is unchanged, so React only re-applies innerHTML (and the
  // effect re-typesets) when the rendered HTML actually changes.
  const htmlMarkup = useMemo(() => (html === null ? null : { __html: html }), [html]);

  // Render math client-side AFTER the sanitized HTML is committed to the DOM, and only when the
  // worker flagged in-effect STEM (resolved `:stem:` + stem markup). MathJax is lazy-imported inside
  // `renderMath`, so its bundle cost is paid only on a math-bearing preview. Re-runs on
  // html/mathPresent change; `renderMath` clears prior typeset state so re-renders don't double-render.
  // Output stays within the scoped container (Constitution VI) — we only ever typeset that node.
  useEffect(() => {
    if (!mathPresent || html === null) return;
    const container = outputReference.current;
    if (!container) return;
    let cancelled = false;
    void import('@/components/math/render-math').then(({ renderMath }) => {
      if (cancelled) return;
      void renderMath(container);
    });
    return () => {
      cancelled = true;
    };
  }, [html, mathPresent]);

  // Render diagram placeholders client-side AFTER the sanitized HTML is committed, and only when the
  // worker flagged a native diagram block (`diagramsPresent`). The heavy engines (mermaid/vega/
  // graphviz) are lazy-imported inside `renderDiagrams`, so their bundle cost is paid only on a
  // diagram-bearing preview — mirroring the MathJax effect above. Re-runs on html/diagramsPresent
  // change; `renderDiagrams` re-derives each diagram from its preserved inert source, so a re-run does
  // not double-inject. Fail-soft: `renderDiagrams` never throws and returns per-diagram warnings
  // (unsupported/offline engine, blocked remote resource, render failure) — we log those and leave the
  // rest of the preview intact; a rejected import/promise is caught so it can never crash the preview.
  // Output stays within the scoped container (Constitution VI) — we only ever render into that node.
  useEffect(() => {
    if (!diagramsPresent || html === null) {
      // No diagrams in the current render ⇒ clear any diagnostics left from a previous one so a fixed
      // document's stale warnings never linger (mirrors the PDF panel clearing on each fresh render).
      setDiagramDiagnostics([]);
      return;
    }
    const container = outputReference.current;
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
  }, [html, diagramsPresent, openFilePath]);

  // Delegated listener for include-placeholder interactions (click + keyboard).
  // A single listener on the container handles all placeholders — even those added
  // after re-render — via `.closest()` delegation (Constitution IV: no per-element handlers).
  // Re-attaches only when `html` changes (innerHTML is rewritten each render). The ref pattern
  // above ensures handlers always call the latest `onOpenInclude` without needing it in deps.
  useEffect(() => {
    const container = outputReference.current;
    if (!container || !onOpenIncludeReference.current) return;

    const handleClick = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest(`.${INCLUDE_PLACEHOLDER_CLASS}[${INCLUDE_PLACEHOLDER_TARGET_ATTR}]`)
          : null;
      if (!target) return;
      const path = target.getAttribute(INCLUDE_PLACEHOLDER_TARGET_ATTR);
      if (path) onOpenIncludeReference.current?.(path);
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
  }, [html]);

  return (
    <div className="flex flex-col h-full">
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

      <div ref={previewRef} className="flex-1 overflow-auto p-4" data-testid="preview-scroll-container">
        {!isEnabled || state === 'idle' ? (
          <p className="text-muted-foreground text-sm">Preview not available for this file type</p>
        ) : (
          html !== null && (
            <div
              ref={outputReference}
              data-testid="asciidoc-output"
              className="asciidoc-preview-content"
              data-preview-style={previewStyle}
              // dangerouslySetInnerHTML is intentional: content is sanitized by DOMPurify in
              // useAsciidocPreview. The payload is the memoized `htmlMarkup` (stable while `html` is
              // unchanged) so React does not re-apply innerHTML — and wipe client-typeset math — on
              // unrelated re-renders. `html !== null` here, so `htmlMarkup` is non-null.
              dangerouslySetInnerHTML={htmlMarkup ?? undefined}
            />
          )
        )}
      </div>
    </div>
  );
}
