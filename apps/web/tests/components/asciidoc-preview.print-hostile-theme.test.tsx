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

const DOCUMENT_MARKUP = '<h1 id="t">Doc</h1><p id="p">Body text that must survive.</p>';

/**
 * Show the Print preview with a theme, and hand back the page column.
 *
 * @param themeText - The theme document to apply.
 * @returns The page column element.
 */
function renderWithTheme(themeText: string): HTMLElement {
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
      onSelectDiagnosticLocation={jest.fn()}
    />,
  );
  commitToPreviewOutput(DOCUMENT_MARKUP);
  return screen.getByTestId('asciidoc-output');
}

/**
 * The theme test set: malformed, incomplete, and actively hostile documents.
 *
 * `reported` says whether the panel has anything to TELL the author about this document, and it is
 * stated per theme rather than inferred at run time on purpose. The check that used to stand here
 * read `if (surface !== null) expect(surface).toBeVisible()`, which is not a check: an
 * implementation that quietly stopped reporting anything at all — the exact failure the diagnostics
 * surface exists to prevent — ran zero assertions across the whole table and passed. Writing the
 * expectation down is what gives the test something to be wrong about.
 *
 * The `false` entries are a CHARACTERISATION of today's behaviour, not a rule that these documents
 * must stay silent. Several of them arguably should be reported (see the note on the block below).
 * A change that starts reporting one is an improvement, and it should flip the flag beside it in the
 * same commit — that is the flag doing its job, not the flag getting in the way.
 */
const THEMES: readonly { readonly what: string; readonly text: string; readonly reported: boolean }[] = [
  { what: 'a document that is not YAML at all', reported: true, text: '{{{{ not: [ yaml' },
  { what: 'a truncated mapping', reported: false, text: 'base:\n  font_color:' },
  { what: 'a document that is only a scalar', reported: true, text: 'just a string' },
  { what: 'an empty document', reported: false, text: '' },
  { what: 'a document of only comments', reported: false, text: '# nothing here\n# or here\n' },
  { what: 'a tab-indented document', reported: true, text: 'base:\n\tfont_color: FF0000\n' },
  { what: 'a value that is a list where a colour belongs', reported: false, text: 'base:\n  font_color: [1, 2, 3]\n' },
  // Reported since the resolver learned to name a key the document wrote as a GROUP of settings: the
  // export never sets `base_font_size` for this document either, so both show the default size — and
  // now both the page and the author's list agree about why.
  { what: 'a value that is a mapping where a size belongs', reported: true, text: 'base:\n  font_size: {a: 1}\n' },
  // Reported since the theme reader started typing plain scalars the way the export's own reader
  // types them. `1e9` is a NUMBER to the YAML 1.2 core schema and the three characters it spells to
  // Psych, which needs both a dot and a signed exponent; the export therefore falls back to A4
  // (MediaBox `595.28 841.89`, measured from a converted PDF) while this preview laid out a page a
  // billion points square, in silence. It is now the same fallback and the same complaint.
  { what: 'an absurd page size', reported: true, text: 'page:\n  size: [1e9, 1e9]\n' },
  { what: 'a negative margin', reported: false, text: 'page:\n  margin: [-999, -999, -999, -999]\n' },
  { what: 'a colour that is not a colour', reported: true, text: 'base:\n  font_color: "not a colour"\n' },
  {
    what: 'a value trying to close a CSS declaration', reported: true,
    text: 'base:\n  font_family: "Arial; } body { display: none } .x {"\n',
  },
  // Still reported, and for a different reason than it once was. The six-hex-digit gate made this
  // value ACCEPTABLE — `to_color` cuts it to `FF0000`, which is what the exported page is painted
  // with (`1.0 0.0 0.0 scn`, measured, identical to the same key set to `FF0000`) — so refusing it
  // would have shown a page the export does not print, and it went silent instead. What is reported
  // now is the CUT: the value is applied, and the rest of what the author wrote is not.
  { what: 'a value trying to open a comment', reported: true, text: 'base:\n  font_color: "FF0000 /* x"\n' },
  // Reported since the resolver learned to name the page-image keys it does not paint from.
  { what: 'a value naming a remote resource', reported: true, text: 'page:\n  background_image: "https://example.test/x.png"\n' },
  // The family is REFERENCED, not merely declared. A catalogue entry nothing uses never becomes a font
  // requirement, so nothing tries to load it and there is correctly nothing to report — which made the
  // earlier unreferenced fixture pass without exercising the guard at all.
  { what: 'a value escaping the project', reported: true, text: 'font:\n  catalog:\n    X:\n      normal: ../../etc/passwd\nbase:\n  font_family: X\n' },
  { what: 'a self-referencing variable', reported: false, text: 'base:\n  font_size: $base_font_size\n' },
  { what: 'a dangling variable reference', reported: true, text: 'base:\n  font_color: $nonexistent_thing\n' },
  { what: 'an extends chain naming itself', reported: true, text: 'extends: brand-theme.yml\nbase:\n  font_size: 11\n' },
  { what: 'a deeply nested document', reported: false, text: `${'a:\n'.padEnd(2)}${'  '.repeat(0)}${'b:\n  '.repeat(1)}  c: 1\n` },
  { what: 'a document of only keys this preview does not model', reported: false, text: 'running_content:\n  start_at: toc\n' },
  // The two values the renderer genuinely carries as TEXT. Everything else on the page is a colour, a
  // length or a keyword, and could not be anything else; these two could be anything at all.
  {
    what: 'a button template trying to close the declaration it lands in', reported: false,
    text: 'button:\n  content: \'"; } body { display: none } .x { content: "%s\'\n',
  },
  {
    what: 'a menu caret template trying to open a rule of its own', reported: false,
    text: 'menu:\n  caret_content: \'"} * { color: red } .y { content: "\'\n',
  },
  { what: 'a button template with no place for the label', reported: false, text: 'button:\n  content: no placeholder\n' },
];

describe.each(THEMES)('a theme that cannot be trusted: $what', ({ text, reported }) => {
  test('the document is still shown, whole', () => {
    const column = renderWithTheme(text);
    expect(column.textContent).toBe('DocBody text that must survive.');
    expect(column.querySelector('#p')).not.toBeNull();
  });

  test('the page is still a page, at a real size', () => {
    const column = renderWithTheme(text);
    const width = column.style.getPropertyValue('--print-page-width');
    // Always a length, never empty: an empty custom property beats the stylesheet's own fallback with
    // nothing, which is how a page ends up with no width at all rather than with its default one.
    expect(width).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(width)).toBeGreaterThan(0);
  });

  test('nothing the theme said escapes the page', () => {
    const column = renderWithTheme(text);
    const style = column.getAttribute('style') ?? '';
    // Every value on the page went through a formatter that can produce one shape. Anything that
    // could close a declaration, open a block, or start a comment never became a value at all.
    expect(style).not.toMatch(/[{}<>]/);
    expect(style).not.toContain('/*');
    expect(style).not.toMatch(/url\(/i);
    expect(style).not.toMatch(/https?:/);
    expect(style).not.toMatch(/\.\.\//);
    // …and nothing was written outside the page column. Stated as the CLOSED set of property names
    // the viewport carries rather than as "no `--print-` among them": the viewport is sized from the
    // page's own dimensions, so `not.toContain('--print-')` was a question about a value nothing has
    // ever put there and could not have failed for any theme in the table. What can go wrong here is
    // a theme's value arriving on the element that frames the page instead of on the page, and that
    // is a statement about which names appear at all.
    expect(screen.getByTestId('preview-scroll-container').getAttribute('style')).toBeNull();
    const viewport = screen.getByTestId('print-page-viewport').getAttribute('style') ?? '';
    const framed = [...viewport.matchAll(/(^|;)\s*([\w-]+)\s*:/g)].map((match) => match[2]);
    // The width is always written and the height only where the page has one to write, so the closed
    // set is stated as "these two and nothing else" rather than as an exact pair.
    expect(framed).toContain('width');
    expect(framed.filter((name) => name !== 'width' && name !== 'height')).toEqual([]);
  });

  test('the application does not fail, and says what it could not do', () => {
    renderWithTheme(text);
    // Reaching here at all is part of the assertion: a throw during render would fail the test.
    const surface = screen.queryByLabelText('Print preview appearance diagnostics');
    if (reported) {
      expect(surface).toBeVisible();
      // A surface with nothing written on it tells the author as little as no surface at all.
      expect(surface?.textContent?.trim()).not.toBe('');
    } else {
      expect(surface).toBeNull();
    }
  });
});

// What the `false` entries above actually are, measured rather than assumed.
//
// This note used to say that each of them is a value the author wrote that the page then does not
// carry, and list nine shapes as dropped in silence. That was an overstatement, and the direction it
// overstated in is the one that matters: it made a set of faithful readings look like a set of
// failures, which is the reading that invites "fixing" them into divergences from the export.
//
// FOUR of the nine are CARRIED, and carried correctly — the export does the same thing with them:
//   * a colour given as a list — `[1, 2, 3]` is the renderer's own RGB form, and the page is 010203;
//   * a negative margin — `[-999, -999, -999, -999]` reaches the page as four negative edges, which
//     is what `str_to_pt` makes of them too;
//   * a variable defined as itself — `$base_font_size` expands against what the cascade has already
//     loaded, so it resolves to the INHERITED size exactly as `expand_vars` resolves it;
//   * the two text templates carrying CSS syntax — both reach the page, as escaped code points
//     rather than as characters, which the last three tests in this file assert directly.
// There is nothing to report about any of the four: the preview shows the page the export prints.
//
// THREE more are no longer silent at all, and their flags above have been flipped: a size written as
// a group of settings, an off-the-page page size, and a `background_image` naming a remote host.
//
// That leaves NO shape genuinely dropped in silence. A font path climbing out of the project was
// believed to be one, and is not: measured directly, `../../etc/passwd` and `/etc/passwd` are both
// refused AND reported as `theme-font-unavailable`, while `fonts/..bold.ttf` still loads — the guard
// matches `..` segment-wise rather than as a substring. The belief came from a fixture that declared
// the family without REFERENCING it, so nothing ever asked for the face; that fixture is now fixed.
//
// The remaining `false` entries are not values at all — an empty document, a document of only
// comments, a truncated mapping, a document of keys this preview does not model — and a preview with
// nothing to say about them is correct rather than quiet.

describe('the two values that are genuinely text', () => {
  test("a theme's own button brackets reach the page, as escapes rather than as characters", () => {
    const column = renderWithTheme('extends: default\nbutton:\n  content: "{%s}"\n');
    const before = column.style.getPropertyValue('--print-button-content-before');
    const after = column.style.getPropertyValue('--print-button-content-after');
    // The theme said `{` and `}`; the page carries their code points. Both facts matter: the value
    // was CARRIED (so a theme that changes its brackets changes the page) and not one character of
    // it appears verbatim (so there is nothing for a brace to open or a quote to close).
    expect(before).toBe(String.raw`"\7b "`);
    expect(after).toBe(String.raw`"\7d "`);
  });

  test('a caret template keeps its glyph and loses its markup', () => {
    const column = renderWithTheme(
      'extends: default\nmenu:\n  caret_content: " <font color=\\"#00FF00\\">\\u2192</font> "\n',
    );
    // The markup is the renderer's way of colouring the caret; here the colour is a property and the
    // markup has no meaning, so what is carried is the glyph and the spaces around it.
    expect(column.style.getPropertyValue('--print-menu-caret-content')).toBe(String.raw`"\20 \2192 \20 "`);
    expect(column.style.getPropertyValue('--print-menu-caret-font-color')).toBe('#00FF00');
  });

  test('a template with nowhere to put the label is not carried at all', () => {
    const column = renderWithTheme('extends: default\nbutton:\n  content: no placeholder\n');
    expect(column.style.getPropertyValue('--print-button-content-before')).toBe('');
    expect(column.style.getPropertyValue('--print-button-content-after')).toBe('');
  });
});

describe('what the diagnostics surface does and does not do', () => {
  test('a theme with nothing wrong shows no surface at all', () => {
    renderWithTheme('extends: default\nbase:\n  font_color: 3C763D\n');
    expect(screen.queryByLabelText('Print preview appearance diagnostics')).toBeNull();
  });

  test('an unreadable theme is reported, and the document keeps its place', () => {
    const column = renderWithTheme('base:\n  - [\n');
    expect(screen.getByLabelText('Print preview appearance diagnostics')).toBeVisible();
    expect(column.textContent).toBe('DocBody text that must survive.');
  });

  test('the surface sits outside the page column, so it can never displace the page', () => {
    renderWithTheme('base:\n  - [\n');
    const surface = screen.getByLabelText('Print preview appearance diagnostics');
    const column = screen.getByTestId('asciidoc-output');
    expect(column.contains(surface)).toBe(false);
    expect(screen.getByTestId('print-page-viewport').contains(surface)).toBe(false);
    expect(screen.getByTestId('preview-scroll-container').contains(surface)).toBe(false);
  });

  test('a rejected value names the file and the line it was written on', () => {
    renderWithTheme('extends: default\nbase:\n  font_color: not-a-colour\n');
    expect(screen.getByLabelText('Print preview appearance diagnostics')).toBeVisible();
    // Both halves: the file the value is in, and the line it was written on — a rejected value the
    // author cannot find is a rejected value they cannot fix.
    expect(screen.getAllByText(/brand-theme\.yml/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Go to brand-theme.yml:3' })).toBeInTheDocument();
  });
});
