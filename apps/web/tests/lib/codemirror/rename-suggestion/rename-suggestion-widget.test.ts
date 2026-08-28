/*
 * @jest-environment jsdom
 */
import type { EditorView } from '@codemirror/view';
import { RenameSuggestionWidget } from '@/lib/codemirror/rename-suggestion/rename-suggestion-widget';
import {
  applyRequestEffect,
  dismissRequestEffect,
  undoRequestEffect,
} from '@/lib/codemirror/rename-suggestion/rename-suggestion-effects';

/** A minimal fake view capturing dispatched effects. */
function fakeView(): { view: EditorView; dispatch: jest.Mock } {
  const dispatch = jest.fn();
  return { view: { dispatch } as unknown as EditorView, dispatch };
}

describe('RenameSuggestionWidget', () => {
  test('renders old→new, kind and impact, and Apply dispatches the apply request', () => {
    const { view, dispatch } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'edition', newName: 'release', kind: 'attribute', usageCount: 7, fileCount: 3, collision: false, revalidating: false, applied: false,
    });
    const dom = widget.toDOM(view);
    expect(dom.textContent).toContain('edition');
    expect(dom.textContent).toContain('release');
    expect(dom.textContent).toContain('7');
    expect(dom.textContent).toContain('3');
    dom.querySelector<HTMLButtonElement>('[data-testid="rename-suggestion-apply"]')!.click();
    expect(dispatch.mock.calls[0][0].effects.is(applyRequestEffect)).toBe(true);
  });

  test('while revalidating, Apply is disabled and clicking it dispatches nothing', () => {
    const { view, dispatch } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'edition', newName: 'releases', kind: 'attribute', usageCount: 7, fileCount: 3, collision: false, revalidating: true, applied: false,
    });
    const dom = widget.toDOM(view);
    const apply = dom.querySelector<HTMLButtonElement>('[data-testid="rename-suggestion-apply"]')!;
    expect(apply.disabled).toBe(true);
    apply.click();
    // A click routed straight to the listener — an assistive technology activating the control, or a
    // synthetic event — must be refused too, not only the one the browser already suppresses.
    apply.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('swallows the editor’s own handling of events inside the widget', () => {
    // The buttons manage their own clicks; letting the events reach the editor underneath would move
    // the cursor (or start a selection) every time the author reached for Apply.
    const widget = new RenameSuggestionWidget({
      oldName: 'a', newName: 'b', kind: 'attribute', usageCount: 1, fileCount: 1, collision: false, revalidating: false, applied: false,
    });
    expect(widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(true);
  });

  test('keeps the offer compact: shows the ref count but omits the file count for a single file', () => {
    const { view } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'subdocvar', newName: 'subdocvar2', kind: 'attribute', usageCount: 1, fileCount: 1, collision: false, revalidating: false, applied: false,
    });
    const text = widget.toDOM(view).textContent ?? '';
    expect(text).toContain('subdocvar');
    expect(text).toContain('subdocvar2');
    expect(text).toContain('1 ref');
    expect(text).not.toContain('file'); // the noisy "1 file" is dropped in the single-file case
    expect(text).not.toContain('across'); // and the wordy phrasing is gone
  });

  test('collision state warns and offers no Apply', () => {
    const { view } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'edition', newName: 'intro', kind: 'anchor', usageCount: 2, fileCount: 1, collision: true, revalidating: false, applied: false,
    });
    const dom = widget.toDOM(view);
    expect(dom.dataset.collision).toBe('true');
    expect(dom.querySelector('[data-testid="rename-suggestion-apply"]')).toBeNull();
    expect(dom.textContent?.toLowerCase()).toContain('already exists');
  });

  test('applied state Undo dispatches the undo request', () => {
    const { view, dispatch } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'edition', newName: 'release', kind: 'attribute', usageCount: 7, fileCount: 3, collision: false, revalidating: false, applied: true,
    });
    const dom = widget.toDOM(view);
    dom.querySelector<HTMLButtonElement>('[data-testid="rename-suggestion-undo"]')!.click();
    expect(dispatch.mock.calls[0][0].effects.is(undoRequestEffect)).toBe(true);
  });

  test('applied HEADING state offers no Undo (a heading rename cannot be reversed by the tool)', () => {
    const { view } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: '_intro', newName: '_overview', kind: 'heading', usageCount: 2, fileCount: 1, collision: false, revalidating: false, applied: true,
    });
    const dom = widget.toDOM(view);
    expect(dom.querySelector('[data-testid="rename-suggestion-undo"]')).toBeNull();
    expect(dom.textContent).toContain('Renamed');
    expect(dom.querySelector('[data-testid="rename-suggestion-dismiss"]')).not.toBeNull(); // still dismissable
  });

  test('Dismiss dispatches the dismiss request', () => {
    const { view, dispatch } = fakeView();
    const widget = new RenameSuggestionWidget({
      oldName: 'a', newName: 'b', kind: 'attribute', usageCount: 1, fileCount: 1, collision: false, revalidating: false, applied: false,
    });
    widget.toDOM(view).querySelector<HTMLButtonElement>('[data-testid="rename-suggestion-dismiss"]')!.click();
    expect(dispatch.mock.calls[0][0].effects.is(dismissRequestEffect)).toBe(true);
  });

  test('eq() is true only when the visible data matches (decoration reuse)', () => {
    const data = { oldName: 'a', newName: 'b', kind: 'attribute' as const, usageCount: 1, fileCount: 1, collision: false, revalidating: false, applied: false };
    expect(new RenameSuggestionWidget(data).eq(new RenameSuggestionWidget({ ...data }))).toBe(true);
    expect(new RenameSuggestionWidget(data).eq(new RenameSuggestionWidget({ ...data, newName: 'c' }))).toBe(false);
  });
});
