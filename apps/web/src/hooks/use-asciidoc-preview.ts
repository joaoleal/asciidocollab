'use client';
import { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS } from '@/lib/editor-config';
import { createRenderWorker } from '@/lib/create-render-worker';
import { createMaxWaitDebounce, type MaxWaitDebounce } from '@/lib/max-wait-debounce';

/** Lifecycle state of the preview panel. */
export type PreviewState = 'idle' | 'pending' | 'rendering' | 'up-to-date' | 'error';

interface RenderRequest {
  requestId: number;
  content: string;
  imagesDir?: string;
  mainPath?: string;
  files?: Record<string, string>;
  rootFileId?: string | null;
  openFileId?: string;
  /** When false (default), the assembler hides included bodies and emits placeholders. */
  showIncludes?: boolean;
  /** Project-level render-config attributes (soft-defaulted), seeded beneath the document's own. */
  projectAttributes?: Record<string, string>;
  /** When false, the render omits the `data-source-line` hints this panel navigates by. */
  sourceLineHints?: boolean;
}

interface RenderResult {
  requestId: number;
  ok: boolean;
  html: string | null;
  error: string | null;
  /** True when the worker detected in-effect STEM math (resolved `:stem:` + stem markup). */
  mathPresent?: boolean;
  /** True when the worker emitted ≥1 `adc-diagram` placeholder (a diagram block is present). */
  diagramsPresent?: boolean;
}

/**
 * A scroll request object. Each click in the editor produces a new instance so
 * React always sees a changed value even when the line number is the same.
 *
 * @param line - 1-based line number to scroll the preview to.
 */
export interface ScrollRequest {
  /** 1-based line number to scroll the preview to. */
  line: number;
}

/** Configuration controlling debounce delay and initial content for the AsciiDoc preview. */
export interface UseAsciidocPreviewOptions {
  /** Current AsciiDoc source text. Changing this resets the debounce and transitions state to pending. */
  content: string;
  /** True when the selected file is AsciiDoc and the preview panel is open. False transitions to idle. */
  isEnabled: boolean;
  /** When set, the hook scrolls the preview to the element with the matching data-source-line. */
  scrollToLine: ScrollRequest | null;
  /** Base path Asciidoctor prepends to relative image targets (the project's image endpoint). */
  imagesDir?: string;
  /**
   * Project-relative path of the configured main file. When set with {@link getFiles}, the preview
   * renders the assembled main document (includes inlined, sandbox-confined) instead of `content`.
   * Leave unset to render the open file as-is (exact source-line scroll-sync).
   */
  mainPath?: string;
  /** Returns the path→content snapshot the include assembler needs; read lazily at render time. */
  getFiles?: () => Record<string, string>;
  /**
   * Project main-file path (root) for cross-document attribute resolution: the open
   * file's `{name}` references resolve to the value in effect at its first include-point under this
   * root. `null`/unset ⇒ standalone resolution (the file's own attributes only).
   */
  rootFileId?: string | null;
  /** The previewed open file's path, whose inherited attribute scope the worker seeds. */
  openFileId?: string;
  /** When false (default), the assembler hides included bodies and emits placeholders. */
  showIncludes?: boolean;
  /**
   * Bumps whenever a reachable INCLUDED file's content changes (a collaborator's live edit or save,
   * delivered as a `content-changed` frame) without the open file's own `content` changing. Changing
   * it re-posts a render that reads the fresh {@link getFiles} snapshot, so an included file's new
   * heading level / content propagates into the assembled preview — the preview's counterpart to the
   * outline recomputing on the same signal. Leave unset when the preview has no include dependencies.
   */
  filesVersion?: number;
  /**
   * Project-level render-config attributes (soft-defaulted with a trailing `@`) applied beneath the
   * document's inherited scope and its own header. A stable (memoized) reference; changing it re-posts.
   */
  projectAttributes?: Record<string, string>;
}

/** Return value of the `useAsciidocPreview` hook. */
export interface UseAsciidocPreviewResult {
  /** Latest successfully rendered HTML, or null before the first successful render. */
  html: string | null;
  /** Current lifecycle state. */
  state: PreviewState;
  /** Error message from the last failed render, or null. */
  error: string | null;
  /** Ref to attach to the preview scroll container. */
  previewRef: React.RefObject<HTMLDivElement | null>;
  /**
   * True when the latest rendered HTML contains in-effect STEM math. The preview uses this to
   * lazy-load MathJax and typeset the container only when there is math to render.
   */
  mathPresent: boolean;
  /**
   * True when the latest rendered HTML contains ≥1 diagram placeholder. The preview uses this to
   * lazy-load the heavy diagram engines (mermaid/vega/graphviz) only when a diagram is present.
   */
  diagramsPresent: boolean;
}

/**
 * Manages the Web Worker lifecycle, debounce timer, PreviewState machine, and
 * click-to-scroll.
 */
export function useAsciidocPreview({
  content,
  isEnabled,
  scrollToLine,
  imagesDir,
  mainPath,
  getFiles,
  rootFileId,
  openFileId,
  showIncludes,
  filesVersion,
  projectAttributes,
}: UseAsciidocPreviewOptions): UseAsciidocPreviewResult {
  const [state, setState] = useState<PreviewState>('idle');
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mathPresent, setMathPresent] = useState(false);
  const [diagramsPresent, setDiagramsPresent] = useState(false);

  // Held in a ref so the debounced render always posts the current base path without
  // re-running the debounce effects when it changes (it is stable per editor session).
  const imagesDirectoryReference = useRef(imagesDir);
  imagesDirectoryReference.current = imagesDir;
  // Include-assembly inputs, read lazily at render time (the files snapshot changes identity often).
  const mainPathReference = useRef(mainPath);
  mainPathReference.current = mainPath;
  const getFilesReference = useRef(getFiles);
  getFilesReference.current = getFiles;
  // Cross-document attribute-scope inputs, read lazily at render time so editing a
  // parent's attribute re-resolves on the next debounced render without re-running the debounce effect.
  const rootFileIdReference = useRef(rootFileId);
  rootFileIdReference.current = rootFileId;
  const openFileIdReference = useRef(openFileId);
  openFileIdReference.current = openFileId;
  const showIncludesReference = useRef(showIncludes);
  showIncludesReference.current = showIncludes;
  const projectAttributesReference = useRef(projectAttributes);
  projectAttributesReference.current = projectAttributes;

  const workerReference = useRef<Worker | null>(null);
  const requestIdReference = useRef(0);
  const debounceReference = useRef<MaxWaitDebounce | null>(null);
  if (debounceReference.current === null) {
    debounceReference.current = createMaxWaitDebounce(PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS);
  }
  const previewReference = useRef<HTMLDivElement | null>(null);

  // Mount Worker; teardown on unmount.
  useEffect(() => {
    const worker = createRenderWorker();
    workerReference.current = worker;

    worker.addEventListener('message', (event: MessageEvent<RenderResult>) => {
      const result = event.data;
      if (result.requestId !== requestIdReference.current) return; // stale

      if (result.ok && result.html !== null) {
        const sanitized = DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true } });
        setHtml(sanitized);
        // The worker gates this on the resolved `:stem:`; MathJax delimiters (`\(`, `\[`, `\$`) are
        // plain text and survive DOMPurify, so the sanitized HTML still carries the math to typeset.
        setMathPresent(result.mathPresent === true);
        // The `adc-diagram` placeholders survive DOMPurify (a plain div with data-* attributes), so
        // the sanitized HTML still carries the blocks the lazily-loaded engine will hydrate.
        setDiagramsPresent(result.diagramsPresent === true);
        setError(null);
        setState('up-to-date');
      } else {
        setError(result.error);
        setState('error');
      }
    });

    return () => {
      worker.terminate();
      workerReference.current = null;
    };
  }, []);

  // Shared debounce helper — captured in effects via closure over current content. Trailing debounce
  // (PREVIEW_DEBOUNCE_MS) with a PREVIEW_MAX_WAIT_MS cap so a sustained edit still refreshes the preview.
  const scheduleRender = (currentContent: string) => {
    debounceReference.current?.schedule(() => {
      requestIdReference.current += 1;
      setState('rendering');
      // When a main file is configured, assemble its include tree; the worker confines
      // every target via resolveSandboxedPath and renders the assembled document. Only assemble once
      // the root file's content is actually available — otherwise fall back to rendering `content`
      // (the open file = the main file here), so the preview never blanks while the tree loads.
      const mainFilePath = mainPathReference.current;
      const rootId = rootFileIdReference.current;
      const openId = openFileIdReference.current;
      // Always fetch files when any open file has an id (for assembly + scope), not only for main file.
      const needsFiles = openId !== undefined || mainFilePath !== undefined || (rootId != null);
      const files = needsFiles ? getFilesReference.current?.() : undefined;
      // Assemble rooted at the OPEN file for any file: the worker takes openFileId as the
      // root. Assembly runs when the open file's content is in the snapshot (even if it's not main).
      const canAssemble = openId !== undefined && files !== undefined && files[openId] !== undefined;
      // Resolve the inherited scope only when the open file is reachable in the snapshot AND is not
      // itself the root (the root's own attributes Asciidoctor parses from the source). The worker
      // still revalidates and falls back to standalone if these inputs are incomplete.
      const canResolveScope =
        rootId != null && openId !== undefined && openId !== rootId && files !== undefined && files[rootId] !== undefined;
      workerReference.current?.postMessage({
        requestId: requestIdReference.current,
        content: currentContent,
        imagesDir: imagesDirectoryReference.current,
        showIncludes: showIncludesReference.current,
        // The preview navigates by these: `revealLine` below looks the block up with
        // `[data-source-line="N"]`. Stated rather than left to the default, because the export sets it
        // the other way and the pair only makes sense read together.
        sourceLineHints: true,
        ...(projectAttributesReference.current ? { projectAttributes: projectAttributesReference.current } : {}),
        ...(canAssemble ? { files, openFileId: openId } : {}),
        ...(canResolveScope ? { rootFileId: rootId, openFileId: openId, files } : {}),
      } satisfies RenderRequest);
    });
  };

  // Handle isEnabled changes.
  useEffect(() => {
    if (!isEnabled) {
      debounceReference.current?.cancel();
      setState('idle');
      return;
    }
    if (!content) return;
    // Re-enabled with current content — start fresh render.
    setState('pending');
    scheduleRender(content);
  }, [isEnabled]);

  // Debounce content changes.
  useEffect(() => {
    if (!isEnabled || !content) return;
    setState('pending');
    scheduleRender(content);

    return () => {
      debounceReference.current?.cancel();
    };
  }, [content]);

  // Re-render when the assembled-main view is toggled on/off (the open file became, or stopped
  // being, the configured main file) so the preview switches between assembled and open-file modes,
  // and when the project main-file setting changes the resolution root (rootFileId) so an open CHILD
  // file re-resolves its inherited cross-document attribute scope under the new root with no document
  // edit — live re-resolution on main-file change for every open file. `filesVersion` bumps when a
  // reachable INCLUDED file changed (collaborator edit/save) with no open-file edit, so the assembled
  // preview picks up the fresh snapshot — the counterpart to the outline recomputing on that signal.
  useEffect(() => {
    if (!isEnabled || !content) return;
    scheduleRender(content);
  }, [mainPath, rootFileId, showIncludes, filesVersion, projectAttributes]);

  // Scroll to line when scrollToLine changes.
  useEffect(() => {
    if (!scrollToLine || !previewReference.current) return;
    const { line } = scrollToLine;

    // Match on the FILE as well as the line. The rendered document can span several files (an assembled
    // include tree), so a line number alone is ambiguous: the open file's line 5 and an included file's
    // line 5 are different places, and whichever happened to come first in the DOM won. That ambiguity is
    // what made clicking a line scroll to the wrong block — every element now states which file it came
    // from, so the candidates are restricted to the file the editor is actually showing.
    const openPath = openFileIdReference.current;
    // Scope only when THIS render actually carried file provenance. A single-file render states just the
    // line (there is only one file it could mean), so insisting on the attribute would match nothing and
    // silently stop scrolling — worse than the ambiguity being fixed.
    const scoped = openPath === undefined ? '' : `[data-source-file="${CSS.escape(openPath)}"]`;
    const scope =
      scoped !== '' && previewReference.current.querySelector(scoped) !== null ? scoped : '';
    let target = previewReference.current.querySelector<HTMLElement>(
      `${scope}[data-source-line="${line}"]`,
    );
    if (!target) {
      // Nearest preceding block in the SAME file: a click between blocks (a blank line, a line inside a
      // block's body) has no element of its own and should land on the block it belongs to.
      const all = previewReference.current.querySelectorAll<HTMLElement>(`${scope}[data-source-line]`);
      let best: HTMLElement | null = null;
      let bestLine = 0;
      for (const element of all) {
        const elementLine = Number(element.dataset['sourceLine']);
        if (elementLine <= line && elementLine > bestLine) {
          best = element;
          bestLine = elementLine;
        }
      }
      target = best;
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollToLine]);

  return { html, state, error, previewRef: previewReference, mathPresent, diagramsPresent };
}
