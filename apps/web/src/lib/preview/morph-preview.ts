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
// The ids the render worker mints from a block's position, declared beside the wire they arrive on so
// that a prefix added there cannot go unrecognised here. See POSITIONAL_ID_PREFIXES.
import { POSITIONAL_ID_PREFIXES } from '@/workers/render-protocol';



/**
 * Attribute each typeset expression carries, holding the delimited source it was produced from
 * (written by the math renderer, which owns the name; mirrored here as the reader of it).
 */
const MATH_SOURCE_ATTRIBUTE = 'data-stem-source';

/**
 * Attribute naming which renderer a diagram placeholder is to be drawn by (written by the render
 * worker, which owns the name; read here and by the diagram renderer).
 */
const DIAGRAM_ENGINE_ATTRIBUTE = 'data-diagram-engine';

/** `overflow-y` values that make an element the one that actually scrolls. */
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/**
 * The attributes stating WHERE a rendered block came from — the pair every jump between the editor
 * and the preview is looked up by, in both directions.
 *
 * Unlike the contents of a block, these are positional: a single inserted line renumbers them, and a
 * change of main file can move a block into a different source file entirely.
 */
const PROVENANCE_ATTRIBUTES: readonly string[] = ['data-source-line', 'data-source-file'];

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
  if (id === '' || POSITIONAL_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return undefined;
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
 * Whether a drawn diagram may be left exactly as it is. Compares what the drawing was made of — the
 * source it was drawn from and the engine that drew it — against what the incoming placeholder asks
 * for, and nothing else: a diagram whose line number moved but whose source and engine did not is the
 * same diagram, and redrawing it would be pure waste.
 *
 * The engine has to be part of that, because it is not derivable from the source. The same text put
 * through mermaid and through Graphviz gives two different pictures — or, more often, a drawing and a
 * failure the author asked to see. Judged on source alone, changing a block's engine would leave the
 * previous engine's drawing on screen for as long as the source went untouched.
 */
function diagramIsUnchanged(fromElement: Element, toElement: Element): boolean {
  const drawnFrom = drawnDiagramSourceOf(fromElement);
  if (drawnFrom === null) return false;
  if (!toElement.classList.contains(PLACEHOLDER_CLASS)) return false;
  if (
    fromElement.getAttribute(DIAGRAM_ENGINE_ATTRIBUTE) !== toElement.getAttribute(DIAGRAM_ENGINE_ATTRIBUTE)
  ) {
    return false;
  }
  // Both sides hold the source verbatim; trimming only guards a stray newline from serialization.
  return drawnFrom.trim() === textOf(toElement).trim();
}

/** Collapse runs of whitespace so two spellings of the same text or markup compare equal. */
function normalizeWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The typeset expressions this element holds directly, in document order. */
function typesetChildrenOf(element: Element): Element[] {
  return [...element.children].filter((child) => child.hasAttribute(MATH_SOURCE_ATTRIBUTE));
}

/**
 * The MARKUP of an element as it would read if its typeset expressions had never been typeset: each
 * one put back as the delimited source it came from, everything else exactly as it stands. This is
 * what makes the comparison content-addressed — the incoming render carries expressions as plain
 * delimited text, because typesetting happens in the browser after the markup arrives, so the two are
 * only comparable once the rendered side is expressed in the same terms.
 *
 * Markup rather than text, because text is not enough to tell two renders apart. Emphasis, a link's
 * target, a cross-reference, a footnote — all of them can change while every word stays where it was,
 * and a comparison that only reads the words would report the block unchanged and leave the author's
 * edit off the screen for as long as they left the expression alone.
 *
 * The string is produced by the DOM's own serializer on both sides, never assembled by hand, so
 * escaping cannot differ between them: an expression containing `<` reaches this side as an attribute
 * value and the other side as text, and only serializing both makes them the same string.
 */
function sourceFormMarkupOf(element: Element): string {
  const rebuilt = element.ownerDocument.createElement(element.tagName);
  for (const child of element.childNodes) {
    const typesetFrom = child instanceof Element ? child.getAttribute(MATH_SOURCE_ATTRIBUTE) : null;
    rebuilt.append(typesetFrom ?? child.cloneNode(true));
  }
  return rebuilt.innerHTML;
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
  const unchanged =
    normalizeWhitespace(sourceFormMarkupOf(fromElement)) === normalizeWhitespace(toElement.innerHTML);
  return unchanged ? typeset.length : 0;
}

/**
 * Move a kept element's provenance to what the incoming render says it is.
 *
 * Refusing an update leaves the element's ATTRIBUTES alone as well as its subtree, and for a diagram
 * the element being kept is the very block that carries the provenance — the placeholder is both the
 * drawing's home and the block's. So a diagram whose source nobody touched would keep the line it was
 * first rendered at for as long as it stays untouched, however far insertions above it have moved it:
 * a click in the preview would jump to a line the diagram has moved off, and a lookup from the editor
 * could match the diagram for a line that now belongs to a different block.
 *
 * Only the provenance is carried across. Everything else about the element is exactly what the skip
 * exists to preserve — the drawn diagram, the typeset expression, and the reader's place among them.
 *
 * @param fromElement - The element on screen, which is being kept.
 * @param toElement - Its counterpart in the incoming render, which is being discarded.
 */
function carryProvenance(fromElement: Element, toElement: Element): void {
  for (const name of PROVENANCE_ATTRIBUTES) {
    const value = toElement.getAttribute(name);
    // Absent in the new render means absent here too: a single-file render states only the line, and a
    // file attribute left over from an assembled one would scope the block to a file this render does
    // not have — matching nothing, where before it matched the wrong thing.
    if (value === null) fromElement.removeAttribute(name);
    else fromElement.setAttribute(name, value);
  }
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
    focusPreviewItself(container);
  }
  const active = container.ownerDocument.activeElement;
  return active !== null && container.contains(active);
}

/**
 * Focus the preview element itself, making it programmatically focusable for exactly as long as it
 * holds the focus.
 *
 * The attribute is borrowed, not kept. This element belongs to React, which does not know about a
 * `tabindex` written behind its back and so will never take it off again — and left on, it outlives
 * by an entire session the one keyboard user, at one refresh, whose focused block did not survive a
 * render. So it is given back the moment focus leaves, and given back at once if focus never landed,
 * which is the only case where no blur is coming to do it.
 *
 * An element that already declares its own `tabindex` is left entirely alone: that one is somebody
 * else's, and handing it back would be taking away something we never lent.
 */
function focusPreviewItself(container: HTMLElement): void {
  if (container.hasAttribute('tabindex')) {
    container.focus();
    return;
  }
  container.setAttribute('tabindex', '-1');
  container.focus();
  if (container.ownerDocument.activeElement !== container) {
    container.removeAttribute('tabindex');
    return;
  }
  container.addEventListener('blur', () => container.removeAttribute('tabindex'), { once: true });
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
    // Returning false leaves this element AND its whole subtree exactly as it is — its attributes
    // included, which is why each skip hands the provenance over by hand before taking it.
    onBeforeElUpdated: (fromElement, toElement) => {
      if (diagramIsUnchanged(fromElement, toElement)) {
        carryProvenance(fromElement, toElement);
        diagramsSkipped += 1;
        return false;
      }
      const preservedMath = preservableMathCount(fromElement, toElement);
      if (preservedMath > 0) {
        // Normally a no-op: the decision is taken on the element that HOLDS the expressions, which is
        // one below the block carrying the provenance, and that block is patched as usual. Stated
        // anyway, so the correctness of the skip does not quietly depend on that staying true.
        carryProvenance(fromElement, toElement);
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
