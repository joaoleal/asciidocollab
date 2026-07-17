import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import { macroFromDropPayload, padBlockMacro, macroPathRange } from '@/lib/codemirror/asciidoc-file-drop';
import { xrefHoverPreview } from '@/lib/codemirror/asciidoc-link-handler';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';

/**
 * Builds the DOM-level event handlers and the Ctrl+click hover tooltip that the editor wires onto
 * its CodeMirror view. Each builder closes over live accessors (refs) supplied by the hook so the
 * handlers always observe the latest props without rebinding — the behaviour is identical to the
 * inline definitions that previously lived in {@link import('@/hooks/use-editor-mount')}.
 */

/**
 * Builds a mousedown handler that reports the clicked line number through a live `onLineClick`
 * accessor. Resolves the document position from the pointer coordinates and maps it to a 1-based line.
 *
 * @param getOnLineClick - Returns the current `onLineClick` callback (or undefined when unwired).
 * @returns A CodeMirror extension wiring the mousedown handler.
 */
export function createLineClickHandler(
  getOnLineClick: () => ((line: number) => void) | undefined,
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const onLineClick = getOnLineClick();
      if (!onLineClick) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;
      const lineNumber = view.state.doc.lineAt(pos).number;
      onLineClick(lineNumber);
    },
  });
}

/**
 * Builds a drop handler that inserts a macro (image:: for images, include:: otherwise) when a file
 * is dragged from the tree. The tree sets the project-relative path on a custom dataTransfer type
 * (see file-tree.tsx). Returns false for non-tree drags / read-only views so CodeMirror handles
 * them normally; returns true once it has consumed a tree drop.
 *
 * @param getFromPath - Returns the open file's project-relative path (to relativize the macro target), or null.
 * @param getAttributes - Returns the project attribute map (supplies `imagesdir` for image targets).
 * @returns A CodeMirror extension wiring the drop handler.
 */
export function createFileDropHandler(
  getFromPath: () => string | null = () => null,
  getAttributes: () => ReadonlyMap<string, string> = () => new Map(),
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    drop(event, view) {
      const raw = event.dataTransfer?.getData('application/x-asciidoc-node');
      if (!raw) return false; // not a tree-file drag — let CodeMirror handle it normally
      if (!view.state.facet(EditorView.editable)) return false; // read-only
      event.preventDefault();
      const macro = macroFromDropPayload(raw, getFromPath(), getAttributes());
      if (macro === null) return true;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      const { doc } = view.state;
      const charBefore = pos > 0 ? doc.sliceString(pos - 1, pos) : null;
      const charAfter = pos < doc.length ? doc.sliceString(pos, pos + 1) : null;
      const insert = padBlockMacro(macro, charBefore, charAfter);
      view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
      view.focus();
      return true;
    },
  });
}

/**
 * Renders a small tooltip DOM node carrying the given text, applying the shared affordance styling.
 *
 * @param text - The tooltip text content.
 * @returns A tooltip view exposing the styled DOM node.
 */
function tooltipView(text: string): { dom: HTMLElement } {
  const dom = document.createElement('div');
  dom.textContent = text;
  dom.style.padding = '2px 6px';
  dom.style.fontSize = '12px';
  return { dom };
}

/**
 * Hover tooltip over include::/image:: paths advertising the Ctrl+click affordance, plus an
 * index-backed cross-reference preview when an xref sits under the cursor.
 *
 * @param projectIndexAccessor - Returns the latest project symbol index (or null for current-file scope).
 * @returns A CodeMirror hover-tooltip extension.
 */
export function createCtrlClickTooltip(
  projectIndexAccessor: () => ProjectSymbolIndex | null,
): ReturnType<typeof hoverTooltip> {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    // Cross-reference preview: resolve the xref under the cursor against the project
    // index and show its definition location (or an "unknown reference" notice).
    const index = projectIndexAccessor();
    if (index) {
      const preview = xrefHoverPreview(line.text, pos - line.from, index);
      if (preview) {
        return {
          pos: line.from + preview.from,
          end: line.from + preview.to,
          above: true,
          create: () => tooltipView(preview.text),
        };
      }
    }
    const range = macroPathRange(line.text);
    if (!range) return null;
    const start = line.from + range.start;
    const end = line.from + range.end;
    if (pos < start || pos > end) return null;
    const affordance = `${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+click to open in the file tree`;
    return {
      pos: start,
      end,
      above: true,
      create: () => tooltipView(affordance),
    };
  });
}

/**
 * Wires a debounced scroll listener onto the view's scroll container that reports the 1-based line
 * at the top of the viewport through a live `onScrollLine` accessor.
 *
 * A caret/selection move auto-scrolls the editor to reveal the caret, which would otherwise fire this
 * top-of-viewport sync and clobber the precise line the SELECTION sync just sent to the preview (the
 * scroll fires slightly later, so it wins the race). The `isSuppressed` predicate — true for a short
 * window after a selection-driven move — lets that reveal scroll pass without emitting, so the preview
 * stays on the selected line. A genuine user scroll (wheel/drag), with no recent selection move, is
 * never suppressed.
 *
 * @param view - The mounted editor view.
 * @param getOnScrollLine - Returns the current `onScrollLine` callback (or undefined when unwired).
 * @param isSuppressed - Optional predicate; when it returns true the pending emit is skipped (a
 *   selection reveal is in flight). Checked at emit time so only the reveal scroll is swallowed.
 * @returns A teardown function that removes the listener and clears any pending debounce.
 */
export function wireScrollSync(
  view: EditorView,
  getOnScrollLine: () => ((line: number) => void) | undefined,
  isSuppressed?: () => boolean,
): () => void {
  let scrollDebounce: ReturnType<typeof setTimeout> | null = null;
  const handleEditorScroll = (): void => {
    if (!getOnScrollLine()) return;
    if (scrollDebounce !== null) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      scrollDebounce = null;
      if (isSuppressed?.()) return;
      const rect = view.scrollDOM.getBoundingClientRect();
      const pos = view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 });
      if (pos !== null) {
        getOnScrollLine()?.(view.state.doc.lineAt(pos).number);
      }
    }, 50);
  };
  view.scrollDOM.addEventListener('scroll', handleEditorScroll, { passive: true });
  return () => {
    if (scrollDebounce !== null) clearTimeout(scrollDebounce);
    view.scrollDOM.removeEventListener('scroll', handleEditorScroll);
  };
}
