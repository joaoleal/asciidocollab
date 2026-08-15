import React from 'react';
import { render, screen } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';

jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';

const mockUsePreview = useAsciidocPreview as jest.Mock;

class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: MockResizeObserver });
});

beforeEach(() => mockUsePreview.mockReset());

/**
 * Render the Print preview with a theme applied, and read the values that reached the page.
 *
 * The assertion is deliberately made against the element the document is on rather than against the
 * resolver's output: what this covers is the whole carry — theme text, through resolution, through
 * the CSS projection, onto the page — and every earlier link in that chain has its own test already.
 *
 * @param themeText - The theme document to apply.
 * @returns The custom properties set on the page column.
 */
function pageValues(themeText: string): Record<string, string> {
  mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce: 1 }));
  render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      previewStyle="print"
      themeText={themeText}
      themePath="brand-theme.yml"
      onPreviewStyleChange={jest.fn()}
    />,
  );
  commitToPreviewOutput('<h1>Doc</h1>');

  const style = screen.getByTestId('asciidoc-output').style;
  const values: Record<string, string> = {};
  for (let index = 0; index < style.length; index++) {
    const name = style.item(index);
    if (name.startsWith('--print-')) values[name] = style.getPropertyValue(name);
  }
  return values;
}

/** One construct's theme keys, and what those keys must produce on the page. */
interface ConstructCase {
  /** The construct, as the requirement names it. */
  readonly construct: string;
  /** The theme fragment setting it. */
  readonly theme: string;
  /** Custom property → the value it must carry once the theme is applied. */
  readonly expected: Readonly<Record<string, string>>;
}

// The closed enumeration of what the style claims, one case per construct. A construct with no case
// here is one the preview says it applies and nothing checks — which is precisely what this file
// exists to make impossible.
const CONSTRUCTS: readonly ConstructCase[] = [
  {
    construct: 'page size, orientation, margins and background',
    theme: 'page:\n  size: LETTER\n  layout: landscape\n  margin: [10, 20, 30, 40]\n  background_color: FAFAFA\n',
    expected: {
      // LETTER is 612 x 792pt; landscape swaps them, and 96/72 turns points into pixels.
      '--print-page-width': '1056px',
      '--print-page-height': '816px',
      '--print-page-margin-top': '13.3333px',
      '--print-page-margin-right': '26.6667px',
      '--print-page-margin-bottom': '40px',
      '--print-page-margin-left': '53.3333px',
      '--print-page-background-color': '#FAFAFA',
    },
  },
  {
    construct: 'body typography and colour',
    theme: 'base:\n  font_size: 12\n  font_color: 202020\n  font_style: italic\n  line_height: 1.6\n  text_align: justify\n',
    expected: {
      '--print-base-font-size': '16px',
      '--print-base-font-color': '#202020',
      '--print-base-font-style': 'italic',
      '--print-base-font-weight': '400',
      // Not `1.6`: the renderer's line box is the FACE's own built-in height plus
      // `(line-height - 1) x font-size`, so the theme's 1.6 over 12pt Noto Serif — whose built-in
      // height is 1.36 — is 12 x 1.96 = 23.52pt, which is 31.36px.
      '--print-base-line-height': '31.36px',
      '--print-base-text-align': 'justify',
    },
  },
  {
    construct: 'heading typography and colour, per level',
    theme:
      'heading:\n  font_color: 111111\n  h3:\n    font_size: 18\n    font_color: 336699\n    font_style: bold\n    margin_top: 9\n    margin_bottom: 3\n',
    expected: {
      '--print-heading-3-font-size': '24px',
      '--print-heading-3-font-color': '#336699',
      '--print-heading-3-font-weight': '700',
      '--print-heading-3-margin-top': '12px',
      '--print-heading-3-margin-bottom': '4px',
      // A level with no override of its own still takes the group's colour.
      '--print-heading-5-font-color': '#111111',
    },
  },
  {
    construct: 'link colour',
    theme: 'link:\n  font_color: 0B5FFF\n',
    expected: { '--print-link-font-color': '#0B5FFF' },
  },
  {
    construct: 'inline code typography, colour, background and border',
    theme:
      'codespan:\n  font_size: 9\n  font_color: B12146\n  background_color: F7F7F7\n  border_color: E0E0E0\n',
    expected: {
      '--print-codespan-font-size': '12px',
      '--print-codespan-font-color': '#B12146',
      '--print-codespan-background-color': '#F7F7F7',
      '--print-codespan-border-color': '#E0E0E0',
    },
  },
  {
    construct: 'code block typography, colour, background and border',
    theme:
      'code:\n  font_size: 9\n  font_color: 333333\n  background_color: F5F5F5\n  border_color: CCCCCC\n  border_width: 0.75\n  border_radius: 3\n  padding: 6\n',
    expected: {
      '--print-code-font-size': '12px',
      '--print-code-font-color': '#333333',
      '--print-code-background-color': '#F5F5F5',
      '--print-code-border-color': '#CCCCCC',
      '--print-code-border-width': '1px',
      '--print-code-border-radius': '4px',
      '--print-code-padding-top': '8px',
      '--print-code-padding-left': '8px',
    },
  },
  {
    construct: 'list marker colour',
    theme: 'list:\n  marker_font_color: 8A2BE2\n',
    expected: { '--print-list-marker-font-color': '#8A2BE2' },
  },
  {
    construct: 'quote block treatment',
    theme:
      'quote:\n  font_color: 5F5F5F\n  font_size: 11\n  background_color: FBFBFB\n  border_color: DDDDDD\n  border_left_width: 3\n  padding: [6, 12, 6, 12]\n',
    expected: {
      '--print-quote-font-color': '#5F5F5F',
      '--print-quote-font-size': '14.6667px',
      '--print-quote-background-color': '#FBFBFB',
      '--print-quote-border-color': '#DDDDDD',
      '--print-quote-border-left-width': '4px',
      '--print-quote-padding-left': '16px',
    },
  },
  {
    // The frame and the rule are very nearly exclusive in the renderer, and the choice is made in
    // the appearance rather than here: the stylesheet draws each mark at the width it is given, and
    // a width of zero is how it is told the export strokes only the rule. Measured against the
    // pinned reference toolchain, a quotation with both keys carries one mark —
    // `4 w  0.10196 0.30588 0.54118 SCN  50.24 758.37 m  50.24 707.30714 l  S` — and no rectangle.
    construct: 'quote block that asks for a frame as well as its rule',
    theme: 'quote:\n  border_color: 1A4E8A\n  border_width: 1\n  border_left_width: 4\n',
    expected: {
      '--print-quote-border-color': '#1A4E8A',
      '--print-quote-border-left-width': '5.3333px',
      '--print-quote-border-width': '0px',
    },
  },
  {
    construct: 'sidebar treatment',
    theme:
      'sidebar:\n  background_color: EEEEEE\n  border_color: CCCCCC\n  border_width: 1\n  border_radius: 4\n  padding: 9\n  title:\n    font_size: 13\n    font_color: 222222\n    text_align: center\n',
    expected: {
      '--print-sidebar-background-color': '#EEEEEE',
      '--print-sidebar-border-color': '#CCCCCC',
      '--print-sidebar-border-width': '1.3333px',
      '--print-sidebar-border-radius': '5.3333px',
      '--print-sidebar-padding-top': '12px',
      '--print-sidebar-title-font-size': '17.3333px',
      '--print-sidebar-title-font-color': '#222222',
      '--print-sidebar-title-text-align': 'center',
    },
  },
  {
    construct: 'example block treatment',
    theme:
      'example:\n  background_color: FFFFFF\n  border_color: AAAAAA\n  border_width: 0.5\n  border_radius: 2\n  padding: 12\n',
    expected: {
      '--print-example-background-color': '#FFFFFF',
      '--print-example-border-color': '#AAAAAA',
      '--print-example-border-width': '0.6667px',
      '--print-example-border-radius': '2.6667px',
      '--print-example-padding-bottom': '16px',
    },
  },
  {
    construct: 'admonition treatment',
    theme:
      'admonition:\n  background_color: F0F8FF\n  column_rule_color: 999999\n  column_rule_width: 1.5\n  padding: [6, 9, 6, 9]\n  label:\n    font_style: bold_italic\n    text_transform: lowercase\n',
    expected: {
      '--print-admonition-background-color': '#F0F8FF',
      '--print-admonition-column-rule-color': '#999999',
      '--print-admonition-column-rule-width': '2px',
      '--print-admonition-padding-left': '12px',
      '--print-admonition-label-font-weight': '700',
      '--print-admonition-label-font-style': 'italic',
      '--print-admonition-label-text-transform': 'lowercase',
    },
  },
  {
    construct: 'table borders, grid, header and stripe',
    theme:
      'table:\n  background_color: FFFFFF\n  border_color: 111111\n  border_width: 1\n  grid_color: DDDDDD\n  grid_width: 0.5\n  cell_padding: 3\n  head:\n    background_color: EFEFEF\n    font_style: bold\n    border_bottom_width: 1.25\n  body:\n    stripe_background_color: F9F9F9\n',
    expected: {
      '--print-table-background-color': '#FFFFFF',
      '--print-table-border-color': '#111111',
      '--print-table-border-width': '1.3333px',
      '--print-table-grid-color': '#DDDDDD',
      '--print-table-grid-width': '0.6667px',
      '--print-table-cell-padding-top': '4px',
      '--print-table-head-background-color': '#EFEFEF',
      '--print-table-head-font-weight': '700',
      '--print-table-head-border-bottom-width': '1.6667px',
      '--print-table-body-stripe-background-color': '#F9F9F9',
    },
  },
  {
    construct: 'caption treatment',
    theme:
      'caption:\n  font_size: 9\n  font_color: 666666\n  font_style: italic\n  text_align: center\n  margin_inside: 3\n  margin_outside: 6\n',
    expected: {
      '--print-caption-font-size': '12px',
      '--print-caption-font-color': '#666666',
      '--print-caption-font-style': 'italic',
      '--print-caption-text-align': 'center',
      '--print-caption-margin-inside': '4px',
      '--print-caption-margin-outside': '8px',
    },
  },
  {
    construct: 'thematic break treatment',
    theme:
      'thematic_break:\n  border_color: BBBBBB\n  border_style: dashed\n  border_width: 1\n  padding: [12, 0, 12, 0]\n',
    expected: {
      '--print-thematic-break-border-color': '#BBBBBB',
      '--print-thematic-break-border-style': 'dashed',
      '--print-thematic-break-border-width': '1.3333px',
      '--print-thematic-break-padding-top': '16px',
    },
  },
];

describe.each(CONSTRUCTS)('the theme reaches the page: $construct', ({ theme, expected }) => {
  test('every value this construct claims arrives on the page column', () => {
    const values = pageValues(`extends: default\n${theme}`);
    for (const [name, value] of Object.entries(expected)) {
      expect([name, values[name]]).toEqual([name, value]);
    }
  });
});

describe('what a theme may carry that this page cannot show', () => {
  test('values with no on-screen counterpart are ignored, and stop nothing else applying', () => {
    // A paginated document's running content, page numbering and title page have no counterpart in a
    // continuous column. They must cost nothing: not an error, and not the rest of the theme.
    const values = pageValues(
      'extends: default\n' +
        'running_content:\n  start_at: toc\n' +
        'header:\n  height: 0.75in\n  font_color: FF0000\n' +
        'footer:\n  height: 0.75in\n  recto:\n    right:\n      content: "{page-number}"\n' +
        'title_page:\n  logo:\n    image: image:cover.png[]\n' +
        'toc:\n  dot_leader:\n    content: "."\n' +
        'base:\n  font_color: 123456\n',
    );
    expect(values['--print-base-font-color']).toBe('#123456');
    expect(Object.keys(values).filter((name) => name.includes('running'))).toEqual([]);
    expect(Object.keys(values).filter((name) => name.includes('footer'))).toEqual([]);
    expect(Object.keys(values).filter((name) => name.includes('title-page'))).toEqual([]);
  });
});

describe('the theme cannot reach past the page', () => {
  test('every theme value is set on the page column itself, and on nothing above it', () => {
    // The chrome around the page — the pane, the header, the diagnostics surface — is the application
    // talking, and stays token-driven. Setting the theme's values on an ancestor would put them in
    // scope for all of it, which is how a theme comes to restyle the interface around the document.
    pageValues('extends: default\npage:\n  background_color: 102030\nbase:\n  font_color: 405060\n');

    const column = screen.getByTestId('asciidoc-output');
    expect(column.style.getPropertyValue('--print-page-background-color')).toBe('#102030');

    for (let ancestor = column.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const names = Array.from({ length: ancestor.style.length }, (_, index) =>
        ancestor.style.item(index),
      );
      expect(names.filter((name) => name.startsWith('--print-'))).toEqual([]);
    }
  });

  test('the pane behind the page is styled by the application, not by the theme', () => {
    pageValues('extends: default\npage:\n  background_color: 102030\n');
    const pane = screen.getByTestId('preview-scroll-container');
    // A token class: it follows the interface's own light/dark, which is what a backdrop should do.
    expect(pane.className).toContain('bg-muted');
    expect(pane.getAttribute('style')).toBeNull();
  });
});
