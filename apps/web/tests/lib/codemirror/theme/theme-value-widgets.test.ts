/* @jest-environment jsdom */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  computeThemeValuePreviews,
  createThemeValueWidgets,
  themeColourToCss,
} from '@/lib/codemirror/theme/theme-value-widgets';

// jsdom environment — the previews are rendered by widgets that build DOM nodes.

describe('themeColourToCss', () => {
  it('accepts the bare hex form the theming guide uses', () => {
    expect(themeColourToCss('333333')).toBe('#333333');
    expect(themeColourToCss('428BCA')).toBe('#428BCA');
  });

  it('accepts a hash prefix', () => {
    expect(themeColourToCss('#428BCA')).toBe('#428BCA');
  });

  it('expands the three-digit shorthand', () => {
    expect(themeColourToCss('#abc')).toBe('#aabbcc');
  });

  it('accepts transparent', () => {
    expect(themeColourToCss('transparent')).toBe('transparent');
    expect(themeColourToCss('TRANSPARENT')).toBe('transparent');
  });

  it('converts a CMYK array so print themes get a swatch too', () => {
    expect(themeColourToCss('[0, 0, 0, 100]')).toBe('rgb(0, 0, 0)');
    expect(themeColourToCss('[0, 0, 0, 0]')).toBe('rgb(255, 255, 255)');
  });

  it('ignores surrounding quotes', () => {
    expect(themeColourToCss("'333333'")).toBe('#333333');
  });

  it('refuses a value it cannot render faithfully', () => {
    // A wrong colour shown with the authority of a rendered swatch is worse than no swatch.
    expect(themeColourToCss('$base-font-color')).toBeNull();
    expect(themeColourToCss('dark-blue')).toBeNull();
    expect(themeColourToCss('33333')).toBeNull();
    expect(themeColourToCss('')).toBeNull();
  });

  it('refuses a CMYK array with an out-of-range component', () => {
    expect(themeColourToCss('[0, 0, 0, 300]')).toBeNull();
  });
});

describe('computeThemeValuePreviews', () => {
  // The widgets ignore the view they are handed, but `toDOM` takes one, so the suite keeps a single
  // mounted editor rather than a fresh one per assertion.
  let editor: EditorView;
  beforeAll(() => {
    editor = new EditorView({ state: EditorState.create({ doc: '' }), parent: document.body });
  });
  afterAll(() => editor.destroy());

  it('previews a colour value', () => {
    const text = 'base:\n  font-color: 333333';
    const previews = computeThemeValuePreviews(text);
    expect(previews).toHaveLength(1);
    expect(text.slice(previews[0].from, previews[0].to)).toBe('333333');
  });

  it('previews a font family', () => {
    const text = 'base:\n  font-family: Noto Serif';
    const previews = computeThemeValuePreviews(text);
    expect(previews).toHaveLength(1);
    expect(text.slice(previews[0].from, previews[0].to)).toBe('Noto Serif');
  });

  it('covers exactly the value, never the key or the colon', () => {
    const text = 'link:\n  font-color: 428BCA';
    const [preview] = computeThemeValuePreviews(text);
    expect(text.slice(preview.from, preview.to)).toBe('428BCA');
  });

  it('leaves a value it cannot resolve undecorated', () => {
    expect(computeThemeValuePreviews('heading:\n  font-color: $base-font-color')).toEqual([]);
    expect(computeThemeValuePreviews('base:\n  font-family: $codespan-font-family')).toEqual([]);
  });

  it('previews nothing for a setting that is neither a colour nor a font', () => {
    expect(computeThemeValuePreviews('page:\n  layout: landscape')).toEqual([]);
    expect(computeThemeValuePreviews('base:\n  font-size: 10.5')).toEqual([]);
  });

  it('previews nothing for a key the renderer does not recognise', () => {
    // Without a descriptor there is no basis for calling the value a colour.
    expect(computeThemeValuePreviews('made-up-color: 333333')).toEqual([]);
  });

  it('stops at the comment, so a swatch never swallows one', () => {
    const text = 'base:\n  font-color: #333333  # body text';
    const [preview] = computeThemeValuePreviews(text);
    expect(text.slice(preview.from, preview.to)).toBe('#333333');
  });

  it('renders a colour value as a swatch that keeps the written text beside it', () => {
    const [preview] = computeThemeValuePreviews('base:\n  font-color: 333333');
    const dom = preview.widget.toDOM(editor);
    expect(dom.textContent).toBe('333333');
    const swatch = dom.querySelector('.cm-theme-colour-swatch');
    expect(swatch).toBeInstanceOf(HTMLElement);
    // The swatch is decoration; the value beside it is what a screen reader should read.
    expect(swatch?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a font value in the face it names, so the author sees what they selected', () => {
    const [preview] = computeThemeValuePreviews('base:\n  font-family: Noto Serif');
    const dom = preview.widget.toDOM(editor);
    expect(dom.textContent).toBe('Noto Serif');
    // Quoted so a multi-word family resolves, with a generic fallback so an unavailable one still
    // renders rather than disappearing.
    expect(dom.style.fontFamily).toBe('"Noto Serif", serif');
  });

  it('treats two previews of the same colour as the same widget, and differing ones as different', () => {
    // CodeMirror reuses a widget's DOM when the old and new compare equal; comparing only the
    // rendered colour would leave the raw text stale after an edit that keeps the colour.
    const [bare] = computeThemeValuePreviews('base:\n  font-color: 333333');
    const [hashed] = computeThemeValuePreviews('base:\n  font-color: #333333');
    const [quoted] = computeThemeValuePreviews("base:\n  font-color: '333333'");
    const [other] = computeThemeValuePreviews('base:\n  font-color: 428BCA');

    expect(bare.widget.eq(hashed.widget)).toBe(false);
    expect(bare.widget.eq(other.widget)).toBe(false);
    // Same rendered colour, different written text — still a different widget.
    expect(bare.widget.eq(quoted.widget)).toBe(false);
    expect(bare.widget.eq(computeThemeValuePreviews('base:\n  font-color: 333333')[0].widget)).toBe(true);
  });

  it('treats two previews of the same font family as the same widget', () => {
    const [serif] = computeThemeValuePreviews('base:\n  font-family: Noto Serif');
    const [sans] = computeThemeValuePreviews('base:\n  font-family: Noto Sans');
    expect(serif.widget.eq(sans.widget)).toBe(false);
    expect(serif.widget.eq(computeThemeValuePreviews('base:\n  font-family: Noto Serif')[0].widget)).toBe(true);
  });

  it('lets a click through both widgets so the cursor can land on the raw value', () => {
    // The widget replaces the value's text; swallowing the click would make the value uneditable.
    const [colour] = computeThemeValuePreviews('base:\n  font-color: 333333');
    const [font] = computeThemeValuePreviews('base:\n  font-family: Noto Serif');
    expect(colour.widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(false);
    expect(font.widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(false);
  });

  it('previews every value in a realistic theme, in document order', () => {
    const text = [
      'page:',
      '  layout: portrait',
      'base:',
      '  font-family: Noto Serif',
      '  font-color: 333333',
      'link:',
      '  font-color: 428BCA',
    ].join('\n');
    const previews = computeThemeValuePreviews(text);
    expect(previews.map((p) => text.slice(p.from, p.to))).toEqual([
      'Noto Serif',
      '333333',
      '428BCA',
    ]);
  });
});

describe('createThemeValueWidgets', () => {
  const THEME = 'base:\n  font-color: 333333\n';

  /** Mounts the theme with the widget extension, with the caret at `anchor`. */
  function mount(anchor: number): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc: THEME,
        selection: { anchor },
        extensions: [createThemeValueWidgets(() => [])],
      }),
      parent: document.body,
    });
  }

  it('shows a swatch in place of a colour the caret is nowhere near', () => {
    const view = mount(0);
    expect(view.dom.querySelector('.cm-theme-colour')).not.toBeNull();
    view.destroy();
  });

  it('reveals the raw value while the caret is inside it, so it stays editable', () => {
    // A replaced value cannot be typed into. Standing the widget down whenever the selection touches
    // the range is what makes an author able to change the colour they just previewed.
    const view = mount(THEME.indexOf('333333') + 2);
    expect(view.dom.querySelector('.cm-theme-colour')).toBeNull();
    expect(view.dom.textContent).toContain('333333');

    // Moving the caret away puts the swatch back without a document edit.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.cm-theme-colour')).not.toBeNull();
    view.destroy();
  });
});
