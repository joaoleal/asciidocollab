/* @jest-environment jsdom */
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { reviewDecorations, setReviewRangesEffect } from '@/lib/codemirror/review-decorations';
import {
  reviewMarkerHoverHandler,
  reviewMarkerClickHandler,
  reviewIdFromEventTarget,
  reviewCommentKeymap,
  commentTargetRange,
  reviewCommentCommand,
  REVIEW_COMMENT_KEY,
} from '@/lib/codemirror/review-interaction';

/** Mounts an editor whose text has one review passage over "world" (offsets 6–11). */
function mount(onHover: (id: string | null) => void) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: 'hello world and more text',
      extensions: [reviewDecorations(() => onHover), reviewMarkerHoverHandler(() => onHover)],
    }),
    parent,
  });
  view.dispatch({ effects: setReviewRangesEffect.of([{ id: 'item-1', from: 6, to: 11 }]) });
  return { view, parent };
}

describe('reviewMarkerHoverHandler', () => {
  test('reports the passage id on hover and null off it', () => {
    const onHover = jest.fn();
    const { view, parent } = mount(onHover);
    const marked = view.dom.querySelector('[data-review-id="item-1"]');
    expect(marked).not.toBeNull();

    marked!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith('item-1');

    // Moving onto a non-review node reports null. (No local dedup — an unchanged value is a React
    // setState no-op — so the shared hovered state never desyncs with the gutter hover path.)
    view.contentDOM.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith(null);

    view.destroy();
    parent.remove();
  });

  test('leaving the editor clears the hovered id', () => {
    const onHover = jest.fn();
    const { view, parent } = mount(onHover);
    const marked = view.dom.querySelector('[data-review-id="item-1"]');

    marked!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith('item-1');

    view.contentDOM.dispatchEvent(new MouseEvent('mouseleave'));
    expect(onHover).toHaveBeenLastCalledWith(null);

    view.destroy();
    parent.remove();
  });

  test('is inert when no hover handler is supplied', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello world and more text',
        // getOnHover returns null → the handlers must no-op without throwing.
        extensions: [reviewDecorations(() => null), reviewMarkerHoverHandler(() => null)],
      }),
      parent,
    });
    view.dispatch({ effects: setReviewRangesEffect.of([{ id: 'item-1', from: 6, to: 11 }]) });
    const marked = view.dom.querySelector('[data-review-id="item-1"]');
    expect(() => {
      marked!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      view.contentDOM.dispatchEvent(new MouseEvent('mouseleave'));
      view.dom.querySelector('.cm-review-gutter')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    }).not.toThrow();
    view.destroy();
    parent.remove();
  });

  test('the gutter marker reports its line review id on hover and clears on leave', () => {
    const onHover = jest.fn();
    const { view, parent } = mount(onHover);
    const gutter = view.dom.querySelector('.cm-review-gutter');
    expect(gutter).not.toBeNull();

    // The passage starts on line 1 (offset 6), so a hover anywhere in the gutter (jsdom coords → line 1)
    // resolves to that item; leaving the gutter clears it.
    gutter!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith('item-1');

    gutter!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith(null);

    view.destroy();
    parent.remove();
  });
});

describe('reviewIdFromEventTarget', () => {
  test('reports nothing for an event that carries no element target', () => {
    // A DOM event's target is typed as EventTarget: a document/window listener firing through the
    // same handler must resolve to "no passage" rather than throwing on `closest`.
    expect(reviewIdFromEventTarget(null)).toBeNull();
  });

  test('reports nothing for a non-HTML element carrying the attribute', () => {
    // SVG content inside the editor (a diagram preview) can carry arbitrary attributes without being
    // an HTML element, and its `dataset` is not the review-marker dataset this reads.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    svg.dataset.reviewId = 'item-1';
    expect(reviewIdFromEventTarget(svg)).toBeNull();
  });
});

/** Mounts an editor whose text has one review passage over "world", wired for clicks. */
function mountClickable(getOnClick: () => ((id: string) => void) | null) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: 'hello world and more text',
      extensions: [reviewDecorations(() => undefined), reviewMarkerClickHandler(getOnClick)],
    }),
    parent,
  });
  view.dispatch({ effects: setReviewRangesEffect.of([{ id: 'item-1', from: 6, to: 11 }]) });
  return { view, parent };
}

describe('reviewMarkerClickHandler', () => {
  test('focuses the thread of the passage that was clicked', () => {
    const onClick = jest.fn();
    const { view, parent } = mountClickable(() => onClick);

    view.dom.querySelector('[data-review-id="item-1"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClick).toHaveBeenCalledWith('item-1');
    view.destroy();
    parent.remove();
  });

  test('ignores a click that lands outside every passage', () => {
    const onClick = jest.fn();
    const { view, parent } = mountClickable(() => onClick);

    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClick).not.toHaveBeenCalled();
    view.destroy();
    parent.remove();
  });

  test('is inert when no click handler is supplied', () => {
    const { view, parent } = mountClickable(() => null);
    expect(() => {
      view.dom.querySelector('[data-review-id="item-1"]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }).not.toThrow();
    view.destroy();
    parent.remove();
  });
});

// doc lines: 1="hello world" [0-11], 2="and more" [12-20].
const COMMENT_DOC = 'hello world\nand more';

function mountCommentView(selection: { anchor: number; head: number }) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: COMMENT_DOC, selection }),
    parent,
  });
  return { view, parent };
}

describe('commentTargetRange', () => {
  test('returns the selection when it is non-empty', () => {
    const state = EditorState.create({ doc: COMMENT_DOC, selection: { anchor: 2, head: 7 } });
    expect(commentTargetRange(state)).toEqual({ from: 2, to: 7 });
  });

  test('orders a backward selection so from ≤ to', () => {
    const state = EditorState.create({ doc: COMMENT_DOC, selection: { anchor: 7, head: 2 } });
    expect(commentTargetRange(state)).toEqual({ from: 2, to: 7 });
  });

  test('falls back to the whole line when the selection is collapsed', () => {
    const state = EditorState.create({ doc: COMMENT_DOC, selection: { anchor: 15, head: 15 } }); // caret on line 2
    expect(commentTargetRange(state)).toEqual({ from: 12, to: 20 });
  });
});

describe('reviewCommentCommand', () => {
  const mountView = mountCommentView;

  test('comments the selection and reports it handled', () => {
    const onComment = jest.fn();
    const { view, parent } = mountView({ anchor: 2, head: 7 });
    const handled = reviewCommentCommand(() => onComment)(view);
    expect(handled).toBe(true);
    expect(onComment).toHaveBeenCalledWith(2, 7);
    view.destroy();
    parent.remove();
  });

  test('comments the current line when the selection is collapsed', () => {
    const onComment = jest.fn();
    const { view, parent } = mountView({ anchor: 15, head: 15 });
    reviewCommentCommand(() => onComment)(view);
    expect(onComment).toHaveBeenCalledWith(12, 20);
    view.destroy();
    parent.remove();
  });

  test('falls through (returns false) when no comment handler is available', () => {
    const { view, parent } = mountView({ anchor: 2, head: 7 });
    expect(reviewCommentCommand(() => null)(view)).toBe(false);
    view.destroy();
    parent.remove();
  });
});

/** The bindings a keymap extension contributes, read back through the keymap facet. */
function bindingsOf(extension: ReturnType<typeof reviewCommentKeymap>) {
  return EditorState.create({ extensions: extension }).facet(keymap).flat();
}

describe('reviewCommentKeymap', () => {
  test('binds the comment shortcut, which is the accessible path to the gutter affordance', () => {
    const bindings = bindingsOf(reviewCommentKeymap(() => undefined));
    expect(bindings.map((binding) => binding.key)).toContain(REVIEW_COMMENT_KEY);
  });

  test('the bound key comments the current selection', () => {
    const onComment = jest.fn();
    const { view, parent } = mountCommentView({ anchor: 2, head: 7 });
    const binding = bindingsOf(reviewCommentKeymap(() => onComment)).find(
      (candidate) => candidate.key === REVIEW_COMMENT_KEY,
    );

    expect(binding?.run?.(view)).toBe(true);
    expect(onComment).toHaveBeenCalledWith(2, 7);
    // The browser default for the combo must not also fire, or the shortcut would type a character.
    expect(binding?.preventDefault).toBe(true);
    view.destroy();
    parent.remove();
  });
});
