/* @jest-environment jsdom */

/**
 * Both preview surfaces navigate the editor on click, and a drag-selection ends with a click. These
 * pin the rule that separates "the reader is copying text" from "the reader clicked a block".
 */
import { isSelectionDragClick } from '@/lib/preview-selection';

/** Select `text`'s content inside `node`, the way a mouse drag would leave the selection. */
function selectInside(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('isSelectionDragClick', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.getSelection()?.removeAllRanges();
  });

  test('a plain click with no selection is not a drag', () => {
    const block = document.createElement('p');
    block.textContent = 'Some prose.';
    document.body.append(block);
    expect(isSelectionDragClick(block)).toBe(false);
  });

  test('a click that ended a selection inside the clicked block is a drag', () => {
    const block = document.createElement('p');
    block.textContent = 'Some prose.';
    document.body.append(block);
    selectInside(block);
    expect(isSelectionDragClick(block)).toBe(true);
  });

  test('a selection somewhere else on the page does not disable navigation', () => {
    // Otherwise a leftover selection in the editor or a sidebar would silently make the whole preview
    // unclickable, with nothing on screen to explain why.
    const block = document.createElement('p');
    block.textContent = 'The block being clicked.';
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'Text selected in another panel.';
    document.body.append(block, elsewhere);
    selectInside(elsewhere);
    expect(isSelectionDragClick(block)).toBe(false);
  });

  test('a whitespace-only selection is not a drag', () => {
    // A plain click on a text node can leave an empty or whitespace range behind; there is nothing to
    // copy, so treating it as a drag would break ordinary clicking.
    const block = document.createElement('p');
    block.textContent = '   ';
    document.body.append(block);
    selectInside(block);
    expect(isSelectionDragClick(block)).toBe(false);
  });
});
