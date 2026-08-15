import { buildAppearance } from '../../src/print-appearance/resolve-appearance';
import type { AppearanceReaderInput } from '../../src/print-appearance/resolve-appearance';

/** A reader input holding only the values a test names, with no default theme beneath it. */
function input(values: Record<string, unknown>, overrides: Partial<AppearanceReaderInput> = {}): AppearanceReaderInput {
  return {
    values: new Map(Object.entries(values)),
    defaults: new Map(),
    projectKeys: new Set(Object.keys(values)),
    lines: new Map(),
    fontFamilies: [],
    ...overrides,
  };
}

describe('buildAppearance with nothing set at all', () => {
  const { appearance, diagnostics } = buildAppearance(input({}));

  it('still produces a page, because the preview has to show something', () => {
    expect(appearance.page).toEqual({
      widthPt: 595.28,
      heightPt: 841.89,
      marginPt: { top: 36, right: 36, bottom: 36, left: 36 },
      backgroundColor: 'FFFFFF',
    });
  });

  it('falls body text back to the renderer’s own structural floor', () => {
    expect(appearance.base).toEqual({
      fontFamily: 'Helvetica',
      fontSizePt: 12,
      fontColor: '000000',
      lineHeight: 1.15,
    });
  });

  it('leaves every construct it was told nothing about empty rather than inventing values', () => {
    expect(appearance.link).toEqual({});
    expect(appearance.list).toEqual({});
    expect(appearance.codespan).toEqual({});
    expect(appearance.code).toEqual({});
    expect(appearance.quote).toEqual({});
    expect(appearance.example).toEqual({});
    expect(appearance.caption).toEqual({});
    expect(appearance.thematicBreak).toEqual({});
  });

  it('omits a nested group entirely when nothing inside it is set', () => {
    expect(appearance.sidebar.title).toBeUndefined();
    expect(appearance.admonition.label).toBeUndefined();
    expect(appearance.table.head).toBeUndefined();
    expect(appearance.table.body).toBeUndefined();
  });

  it('has nothing to report, because an unset key is not a problem', () => {
    expect(diagnostics).toEqual([]);
  });

  it('still declares the face body text fell back to, so the preview can load it', () => {
    expect(appearance.fonts).toEqual([{ family: 'Helvetica', declaredFaces: {}, declaredByTheme: false }]);
  });
});

describe('buildAppearance page geometry', () => {
  it('reads an explicit two-dimension page size', () => {
    const { appearance } = buildAppearance(input({ page_size: [612, 792] }));
    expect(appearance.page.widthPt).toBe(612);
    expect(appearance.page.heightPt).toBe(792);
  });

  it('reads an explicit size written with units, converting to points', () => {
    const { appearance } = buildAppearance(input({ page_size: ['8.5in', '11in'] }));
    expect(appearance.page.widthPt).toBe(612);
    expect(appearance.page.heightPt).toBe(792);
  });

  it('treats a one-dimension size as square, as the renderer does', () => {
    const { appearance } = buildAppearance(input({ page_size: [500] }));
    expect(appearance.page).toMatchObject({ widthPt: 500, heightPt: 500 });
  });

  it('swaps the dimensions of a named size in landscape', () => {
    const { appearance } = buildAppearance(input({ page_size: 'A5', page_layout: 'landscape' }));
    expect(appearance.page).toMatchObject({ widthPt: 595.28, heightPt: 419.53 });
  });

  it('swaps the dimensions of an explicit size in landscape too', () => {
    const { appearance } = buildAppearance(input({ page_size: [612, 792], page_layout: 'landscape' }));
    expect(appearance.page).toMatchObject({ widthPt: 792, heightPt: 612 });
  });

  it('accepts a name in any case, as the renderer upper-cases before looking it up', () => {
    const { appearance } = buildAppearance(input({ page_size: 'letter' }));
    expect(appearance.page).toMatchObject({ widthPt: 612, heightPt: 792 });
  });

  it.each([
    ['a size with no positive area', [0, 792]],
    ['a negative dimension', [-612, 792]],
    ['a dimension that is not a length', ['wide', 792]],
    ['a name the renderer does not know', 'Foolscap'],
    ['an empty list', []],
    ['a mapping', { width: 612 }],
  ])('falls %s back to A4 and reports it', (_label, size) => {
    const { appearance, diagnostics } = buildAppearance(input({ page_size: size }));
    expect(appearance.page).toMatchObject({ widthPt: 595.28, heightPt: 841.89 });
    expect(diagnostics.map((diagnostic) => diagnostic.themeKey)).toEqual(['page_size']);
  });

  it('does not report a page size the project did not set', () => {
    const { diagnostics } = buildAppearance(
      input({}, { values: new Map([['page_size', 'Foolscap']]), projectKeys: new Set() }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('attributes a rejected page size to the theme document when it knows its path', () => {
    const { diagnostics } = buildAppearance(input({ page_size: 'Foolscap' }, { themePath: 'theme/x-theme.yml' }));
    expect(diagnostics[0]).toMatchObject({
      resource: 'theme/x-theme.yml',
      location: { path: 'theme/x-theme.yml' },
    });
  });

  it('names no document when there is no path to name', () => {
    const { diagnostics } = buildAppearance(input({ page_size: 'Foolscap' }));
    expect(diagnostics[0].resource).toBe('theme');
    expect(diagnostics[0].location).toBeUndefined();
  });
});

describe('buildAppearance rejection accounting', () => {
  it('leaves a key unset when neither its value nor its default can be read', () => {
    const { appearance, diagnostics } = buildAppearance(
      input({ link_font_color: 'not-a-colour' }, { defaults: new Map([['link_font_color', 'also-not']]) }),
    );
    expect(appearance.link.fontColor).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
  });

  it('uses the default for that key alone when the default can be read', () => {
    const { appearance } = buildAppearance(
      input({ link_font_color: 'not-a-colour' }, { defaults: new Map([['link_font_color', '428BCA']]) }),
    );
    expect(appearance.link.fontColor).toBe('428BCA');
  });

  it('reports the line the key was written on when it knows one', () => {
    const { diagnostics } = buildAppearance(
      input({ link_font_color: 'nope' }, { themePath: 'a-theme.yml', lines: new Map([['link_font_color', 17]]) }),
    );
    expect(diagnostics[0].location).toEqual({ path: 'a-theme.yml', line: 17 });
  });
});

describe('buildAppearance font requirements', () => {
  it('declares a family the appearance references but the catalogue does not', () => {
    const { appearance } = buildAppearance(input({ base_font_family: 'Brand Serif' }));
    expect(appearance.fonts).toEqual([
      { family: 'Brand Serif', declaredFaces: {}, declaredByTheme: false },
    ]);
  });

  it('does not ask for a catalogue family nothing names, because nothing is set in it', () => {
    // Every requirement is a file the delivery layer fetches. A catalogue is a list of faces the
    // theme SUPPLIES, not of faces it uses: the export loads one when a setting names it, and a
    // theme may declare thousands within the size a theme document is allowed to be. Promoting the
    // catalogue wholesale turned that into one request per declaration, from a single effect.
    const { appearance } = buildAppearance(
      input({}, { fontFamilies: [{ name: 'Unused Face', styles: { normal: 'fonts/u.woff2' } }] }),
    );
    expect(appearance.fonts.map((font) => font.family)).not.toContain('Unused Face');
  });

  it('asks for a catalogue family named only by a role, which no key of the model reads', () => {
    // Role names are the author's own, so the families a theme can name are not enumerable — which
    // is why "referenced" is decided by scanning the cascade for the `font-family` suffix rather
    // than by the model's own fields. A face named only in a role is a face the export inks text in.
    const { appearance } = buildAppearance(
      input(
        { role_brandish_font_family: 'Unused Face' },
        { fontFamilies: [{ name: 'Unused Face', styles: { normal: 'fonts/u.woff2' } }] },
      ),
    );
    expect(appearance.fonts).toContainEqual({
      family: 'Unused Face',
      declaredFaces: { normal: 'fonts/u.woff2' },
      declaredByTheme: true,
    });
  });

  it('asks for a catalogue family named only as a fallback, which the renderer loads too', () => {
    const { appearance } = buildAppearance(
      input(
        {},
        {
          fontFamilies: [{ name: 'Unused Face', styles: { normal: 'fonts/u.woff2' } }],
          fontFallbacks: ['Unused Face'],
        },
      ),
    );
    expect(appearance.fonts).toContainEqual({
      family: 'Unused Face',
      declaredFaces: { normal: 'fonts/u.woff2' },
      declaredByTheme: true,
    });
  });

  it('bounds how many faces one appearance asks for, keeping the ones the page is set in', () => {
    // A theme sets a font family per role and roles are unbounded, so the number of families a
    // theme can name is a function of its SIZE. The bound is on requests; what survives it is the
    // families the model itself names, whatever they sort as.
    const values: Record<string, unknown> = { base_font_family: 'Zzz Body' };
    for (let index = 0; index < 200; index++) values[`role_r${index}_font_family`] = `Aaa ${index}`;
    const { appearance, diagnostics } = buildAppearance(input(values, { themePath: 'a-theme.yml' }));
    expect(appearance.fonts.length).toBeLessThanOrEqual(64);
    expect(appearance.fonts[0]).toMatchObject({ family: 'Zzz Body' });
    expect(diagnostics.some((diagnostic) => diagnostic.code === 'theme-font-unavailable')).toBe(true);
  });

  it('pairs a referenced family with the faces the catalogue declares for it', () => {
    const { appearance } = buildAppearance(
      input(
        { base_font_family: 'Brand Serif', code_font_family: 'Brand Mono' },
        {
          fontFamilies: [
            {
              name: 'Brand Serif',
              styles: { normal: 'f/r.woff2', bold: 'f/b.woff2', italic: 'f/i.woff2', bold_italic: 'f/bi.woff2' },
            },
          ],
        },
      ),
    );
    expect(appearance.fonts).toEqual([
      {
        family: 'Brand Mono',
        declaredFaces: {},
        declaredByTheme: false,
      },
      {
        family: 'Brand Serif',
        declaredFaces: { normal: 'f/r.woff2', bold: 'f/b.woff2', italic: 'f/i.woff2', boldItalic: 'f/bi.woff2' },
        declaredByTheme: true,
      },
    ]);
  });

  it('lists families in a fixed order, so the same theme always declares the same faces', () => {
    const families = buildAppearance(
      input({ base_font_family: 'Zeta', code_font_family: 'Alpha', codespan_font_family: 'Mu' }),
    ).appearance.fonts.map((font) => font.family);
    expect(families).toEqual(['Alpha', 'Mu', 'Zeta']);
  });
});

describe('buildAppearance sidebar title', () => {
  // `convert_sidebar` inks the title with `line_height: heading.line-height || base.line-height` and
  // `margin_bottom: heading.margin-bottom`. Neither has a `sidebar.title` key, so a resolver that read
  // only the sidebar's own group would leave the delivery layer to invent both — which is what it did:
  // the title was set at body leading and given half an em of space under it, against a page that sets
  // it at heading leading with a heading's margin below.
  it("takes the heading category's leading and bottom margin, which have no sidebar key", () => {
    const { appearance } = buildAppearance(
      input({ heading_line_height: 1, heading_margin_bottom: 10.8, sidebar_title_font_size: 13 }),
    );
    expect(appearance.sidebar.title).toEqual({ lineHeight: 1, marginBottomPt: 10.8, fontSizePt: 13 });
  });

  it("ignores the sidebar's own line height, which the renderer never reaches", () => {
    // CHANGED EXPECTATION: this asserted 1.4, with a comment saying the renderer reads the sidebar's
    // key first. It reads it LAST and only if it gets that far. `convert_sidebar` (converter.rb:1379)
    // passes `line_height: (@theme.heading_line_height || @theme.base_line_height)` to `ink_prose`
    // EXPLICITLY, and `ink_prose` resolves `(opts.delete :line_height) || @base_line_height`
    // (converter.rb:3384) — so the value `theme_font :sidebar_title` put into `@base_line_height` is
    // only consulted when the explicit argument is nil, which needs both heading AND base leading
    // unset. The loader forces `base_line_height ||= 1` onto every project theme
    // (theme_loader.rb:84) and every bundled theme sets it, so that never happens.
    const { appearance } = buildAppearance(
      input({ heading_line_height: 1, sidebar_title_line_height: 1.4 }),
    );
    expect(appearance.sidebar.title?.lineHeight).toBe(1);
  });

  it("falls back to base leading when the heading category has none, as ink_prose's chain does", () => {
    const { appearance } = buildAppearance(input({ base_line_height: 1.6, sidebar_title_line_height: 1.4 }));
    expect(appearance.sidebar.title?.lineHeight).toBe(1.6);
  });

  it('carries neither when the theme sets no heading values, rather than inventing one', () => {
    const { appearance } = buildAppearance(input({ sidebar_title_font_color: '112233' }));
    expect(appearance.sidebar.title).toEqual({ fontColor: '112233' });
  });

  it("takes the heading category's alignment, which the title falls back to before body text", () => {
    // `align: (sidebar_title_text_align || heading_text_align || base_text_align)` — the middle step
    // was missing, so a theme that centred its headings centred sidebar titles in the export and left
    // them ranged left in the preview.
    const { appearance } = buildAppearance(input({ heading_text_align: 'center' }));
    expect(appearance.sidebar.title?.textAlign).toBe('center');
  });

  it("lets the sidebar title's own alignment win over the heading category's", () => {
    const { appearance } = buildAppearance(
      input({ heading_text_align: 'center', sidebar_title_text_align: 'right' }),
    );
    expect(appearance.sidebar.title?.textAlign).toBe('right');
  });

  it('leaves the alignment unset when neither names one, so body text decides', () => {
    const { appearance } = buildAppearance(input({ base_text_align: 'justify' }));
    expect(appearance.sidebar.title).toBeUndefined();
  });
});

describe('buildAppearance and a colour the export cut short', () => {
  const CUT = 'FF0000 /* x';

  it('reports the cut when the project’s own theme wrote the key', () => {
    // `to_color` sizes anything to six characters, so the export inks pure red and discards the rest
    // without a word — measured, `1.0 0.0 0.0 scn` from a converted PDF. Saying what was cut is the
    // only answer that is both true to the export and useful to its author.
    const { appearance, diagnostics } = buildAppearance(input({ base_font_color: CUT }));
    expect(appearance.base.fontColor).toBe('FF0000');
    expect(diagnostics.map((each) => [each.code, each.themeKey])).toEqual([
      ['theme-value-truncated', 'base_font_color'],
    ]);
  });

  it('says nothing when the key came from beneath the project’s theme', () => {
    // The gate, over the same value: a cut colour the project did not write is not its author's to
    // fix, and a diagnostic naming a key they cannot find in their document is worse than silence.
    // Fails with the `projectKeys` test removed from `AppearanceReader.colour` — the same row comes
    // back — which is the mutant this exists to catch.
    const { appearance, diagnostics } = buildAppearance(
      input({ base_font_color: CUT }, { projectKeys: new Set() }),
    );
    expect(appearance.base.fontColor).toBe('FF0000');
    expect(diagnostics).toEqual([]);
  });
});
