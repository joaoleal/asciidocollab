// In-place DOM update for the live preview.
//
// A refresh used to publish its markup by replacing the preview's entire contents. That discards
// every node in the document, including the ones nothing asked to change and the ones the client
// spent real time producing — a drawn diagram, a typeset expression — plus everything the browser
// hangs off node identity: which element has keyboard focus, where the reader had scrolled to. This
// module patches the existing tree into the shape of the new render instead, so an edit costs only
// the difference between the two.
//
// The tree walk itself is `morphdom`'s. What lives here are the two decisions it delegates: which
// elements are "the same element" across two renders, and which subtrees it must not touch at all.
// Both answers turn on one rule — identity in this document is the CONTENT of a block, never its
// POSITION. Everything positional in the rendered output (`data-source-line`, the synthetic
// `__src_<context>_<line>` ids) is derived from line numbers, and a single inserted line renumbers
// the whole document below it.

import morphdom from 'morphdom';

import { FAILED_ATTRIBUTE, OUTPUT_CLASS, PLACEHOLDER_CLASS, SOURCE_CLASS } from '@/components/diagrams/render-diagrams';

/**
 * Prefix of the ids the render worker invents for blocks the author gave no id. The line number is
 * baked into the identifier itself, so these change under any edit above them.
 */
const SYNTHETIC_ID_PREFIX = '__src_';

/**
 * Attribute each typeset expression carries, holding the delimited source it was produced from
 * (written by the math renderer, which owns the name; mirrored here as the reader of it).
 */
const MATH_SOURCE_ATTRIBUTE = 'data-stem-source';

/** `overflow-y` values that make an element the one that actually scrolls. */
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/** What one commit of a new render into the live preview changed, and what it deliberately did not. */
export interface MorphOutcome {
  /**
   * Drawn diagrams left untouched because their source was unchanged. Every one of these is an
   * engine render (mermaid, Graphviz, Vega) that did not have to happen again.
   */
  readonly diagramsSkipped: number;
  /**
   * Typeset expressions left untouched because their source was unchanged, counted per expression
   * rather than per element, since one paragraph can hold several.
   */
  readonly mathSkipped: number;
  /**
   * Whether keyboard focus was inside the preview before the commit and is still inside it after —
   * either on the same element, or on the preview itself when that element is no longer in the
   * document. False when nothing inside the preview was focused, which is the ordinary case: the
   * author is normally typing in the editor, not tabbing through the preview.
   */
  readonly focusRestored: boolean;
}

/**
 * The identity `morphdom` should match an element by across two renders, or `undefined` to let it
 * fall back to matching by structural position.
 *
 * Author-written anchors and generated heading ids derive from title text, so they survive an
 * insertion and name the same block in both renders — exactly what a key is for.
 *
 * Returning `undefined` for the synthetic line-derived ids is not an omission, and it is not the same
 * as "we could not be bothered": it is the whole point. Those ids renumber whenever a line is added
 * above them, and a key that changes is read as a DIFFERENT ELEMENT — so the library would discard the
 * block and build a replacement, rather than patch the one already on screen. Insert one paragraph at
 * the top of a document and every block below it would be rebuilt from scratch, taking every drawn
 * diagram, every typeset expression and the focused element down with it. Withholding the key leaves
 * those blocks to be matched by position and patched where they stand, which is both correct and far
 * cheaper. The same reasoning is why `data-source-line` is never consulted here.
 *
 * @param node - A node from either tree.
 * @returns A stable identity for the node, or `undefined` when it has none worth trusting.
 */
function morphKeyOf(node: Node): string | undefined {
  if (!(node instanceof Element)) return undefined;
  const id = node.id;
  if (id === '' || id.startsWith(SYNTHETIC_ID_PREFIX)) return undefined;
  return id;
}

/** The text of a node, as a string — `textContent` is only ever null for nodes this never sees. */
function textOf(node: Node): string {
  return node.textContent ?? '';
}

/**
 * The source a drawn diagram was produced from, or null when this element is not a diagram holding a
 * drawing. The drawing replaced the placeholder's own text, so the source is read from the copy the
 * diagram renderer preserved for exactly this purpose.
 *
 * A placeholder recorded as having failed to draw reports null as well, however intact its source
 * looks. "Unchanged" and "drawn" are different conditions: treating a failure as unchanged would leave
 * it on screen untouched at every future refresh, so a diagram that failed once could never be
 * retried and the reader would be left looking at the failure for the rest of the session.
 */
function drawnDiagramSourceOf(element: Element): string | null {
  if (!element.classList.contains(PLACEHOLDER_CLASS)) return null;
  if (element.hasAttribute(FAILED_ATTRIBUTE)) return null;
  if (element.querySelector(`.${OUTPUT_CLASS}`) === null) return null;
  const preserved = element.querySelector(`.${SOURCE_CLASS}`);
  return preserved === null ? null : textOf(preserved);
}

/**
 * Whether a drawn diagram may be left exactly as it is. Compares the source it was drawn from against
 * the source of the incoming placeholder, and nothing else — a diagram whose line number moved but
 * whose source did not is the same diagram, and redrawing it would be pure waste.
 */
function diagramIsUnchanged(fromElement: Element, toElement: Element): boolean {
  const drawnFrom = drawnDiagramSourceOf(fromElement);
  if (drawnFrom === null) return false;
  if (!toElement.classList.contains(PLACEHOLDER_CLASS)) return false;
  // Both sides hold the source verbatim; trimming only guards a stray newline from serialization.
  return drawnFrom.trim() === textOf(toElement).trim();
}

/** Collapse runs of whitespace so two spellings of the same text compare equal. */
function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The typeset expressions this element holds directly, in document order. */
function typesetChildrenOf(element: Element): Element[] {
  return [...element.children].filter((child) => child.hasAttribute(MATH_SOURCE_ATTRIBUTE));
}

/**
 * The text of an element as it would read if its typeset expressions had never been typeset: each one
 * put back as the delimited source it came from, everything else as written. This is what makes the
 * comparison content-addressed — the incoming render carries expressions as plain delimited text,
 * because typesetting happens in the browser after the markup arrives, so the two are only comparable
 * once the rendered side is expressed in the same terms.
 */
function sourceFormOf(element: Element): string {
  let text = '';
  for (const child of element.childNodes) {
    const typesetFrom = child instanceof Element ? child.getAttribute(MATH_SOURCE_ATTRIBUTE) : null;
    text += typesetFrom ?? textOf(child);
  }
  return text;
}

/**
 * How many typeset expressions this element may keep — the count when nothing around them changed
 * either, and zero otherwise. Zero also covers the element holding no typeset math at all.
 *
 * The decision is made on the element that HOLDS the expressions rather than on an expression itself,
 * because that is the smallest element whose contents would otherwise be rewritten: the incoming
 * render has plain text where the typeset node sits, so nothing pairs the two up directly. Keeping it
 * that small matters — every enclosing block is still patched normally, so provenance attributes
 * elsewhere in the document stay current.
 */
function preservableMathCount(fromElement: Element, toElement: Element): number {
  const typeset = typesetChildrenOf(fromElement);
  if (typeset.length === 0) return 0;
  const unchanged = normalizeText(sourceFormOf(fromElement)) === normalizeText(textOf(toElement));
  return unchanged ? typeset.length : 0;
}

/**
 * The nearest ancestor (or the element itself) that actually scrolls — the element holding the
 * reader's position, which is never the preview output itself but the pane around it.
 */
function scrollingAncestorOf(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current !== null) {
    if (SCROLLING_OVERFLOW.has(getComputedStyle(current).overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

/** The focused element when the focus is inside `container`, otherwise null. */
function focusedWithin(container: HTMLElement): HTMLElement | null {
  const active = container.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return container.contains(active) ? active : null;
}

/**
 * Put focus back where it was, or on the preview itself when that element did not survive the new
 * render — landing on the document body instead would drop a keyboard or screen-reader user out of
 * the document they were reading. The preview is made programmatically focusable if it is not already;
 * `-1` keeps it out of the tab order, so this adds a target for the fallback without adding a stop.
 *
 * @returns Whether focus ended up inside the preview.
 */
function restoreFocus(container: HTMLElement, focused: HTMLElement): boolean {
  if (focused.isConnected && container.contains(focused)) {
    focused.focus();
  } else {
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    container.focus();
  }
  const active = container.ownerDocument.activeElement;
  return active !== null && container.contains(active);
}

/**
 * Adapt an incoming fragment to what `morphdom` will accept as a target tree.
 *
 * Handed a `DocumentFragment` the library narrows it to its first element child, which would quietly
 * publish a one-block document at every refresh — every block after the first simply gone. Moving the
 * fragment's nodes into an element of the container's own kind, and morphing children only, sidesteps
 * that: the container element itself is then preserved too, which matters because it carries the
 * preview's own attributes and the listeners delegated to it.
 */
function incomingRootOf(container: HTMLElement, incoming: DocumentFragment): HTMLElement {
  const root = container.ownerDocument.createElement(container.tagName);
  root.append(incoming);
  return root;
}

/**
 * Patch `container` in place so it matches `incoming`, preserving unchanged diagram and math
 * subtrees, keyboard focus, and scroll position.
 *
 * `incoming` must already be sanitized — this never sanitizes, and never accepts markup as a string:
 * a string parameter would reintroduce the parse this exists to remove, and open a second route to
 * the live DOM that could bypass the sanitizer entirely. The fragment is consumed (its nodes are
 * moved into the preview), so it cannot be committed twice.
 *
 * Order matters and is fixed: focus and scroll position are read BEFORE the patch, because the patch
 * is what can disturb them, and restored AFTER it, because that is when the tree has settled.
 *
 * @param container - The live preview element to patch; the element itself is kept, only its contents change.
 * @param incoming - The already-sanitized new render.
 * @returns What was preserved, and whether focus stayed in the preview.
 */
export function morphPreview(container: HTMLElement, incoming: DocumentFragment): MorphOutcome {
  const focused = focusedWithin(container);
  const scroller = scrollingAncestorOf(container);
  const scrollTop = scroller === null ? 0 : scroller.scrollTop;

  let diagramsSkipped = 0;
  let mathSkipped = 0;

  morphdom(container, incomingRootOf(container, incoming), {
    childrenOnly: true,
    getNodeKey: morphKeyOf,
    // Returning false leaves this element AND its whole subtree exactly as it is.
    onBeforeElUpdated: (fromElement, toElement) => {
      if (diagramIsUnchanged(fromElement, toElement)) {
        diagramsSkipped += 1;
        return false;
      }
      const preservedMath = preservableMathCount(fromElement, toElement);
      if (preservedMath > 0) {
        mathSkipped += preservedMath;
        return false;
      }
      return true;
    },
  });

  const focusRestored = focused === null ? false : restoreFocus(container, focused);
  if (scroller !== null) scroller.scrollTop = scrollTop;

  return { diagramsSkipped, mathSkipped, focusRestored };
}
