/**
 * Tells a click-to-navigate handler when the click it just received was really the end of a
 * drag-selection, so it can stand down.
 *
 * Selecting text with the mouse ends with a `click` on the common ancestor of the selected range,
 * which is indistinguishable from a deliberate click on that element. Both preview surfaces navigate
 * the editor on click, so without this a reader who selects a paragraph to copy it also gets jumped
 * (and scrolled) somewhere else — often out from under the selection they were making.
 */

/**
 * Whether an in-progress text selection produced this click, rather than a plain click on the element.
 *
 * The selection must be non-empty AND anchored inside the clicked subtree: a stale selection elsewhere
 * on the page (a sidebar, the editor) must not silently disable navigation in the preview.
 *
 * @param clicked - The element the handler is about to act on.
 * @returns True when the click ended a selection inside `clicked` and should be ignored.
 */
export function isSelectionDragClick(clicked: Node): boolean {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  // A selection of only whitespace is what a plain click on a text node can leave behind in some
  // browsers; it carries no copyable text, so it is not a drag.
  if (selection.toString().trim() === '') return false;
  return clicked.contains(selection.anchorNode) || clicked.contains(selection.focusNode);
}
