import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HEADING_LEVELS,
  MAX_FONT_FAMILY_LENGTH,
  defaultAppearance,
  resolveAppearance,
} from '@asciidocollab/shared';
import type { AppearanceModel } from '@asciidocollab/shared';
import {
  PRINT_CSS_PROPERTIES,
  appearanceToCssProperties,
} from '@/lib/print-preview/appearance-to-css';
import { metricFamilyOf } from '@/lib/print-preview/font-faces';
import type { FaceBoxLookup } from '@/lib/print-preview/font-metrics';

const STYLESHEET = path.resolve(__dirname, '../../../src/styles/print-preview.css');

/**
 * The stylesheet with its comments removed.
 *
 * The comments describe the vocabulary — `var(--print-x, <default>)` appears in the file header as
 * prose — so scanning the raw text finds names nothing actually reads. Explaining the contract must
 * not be able to break the test that enforces it.
 */
function stylesheetRules(): string {
  return readFileSync(STYLESHEET, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `--print-*` property the stylesheet reads, including those read as a nested fallback. */
function propertiesReadByStylesheet(): Set<string> {
  return new Set([...stylesheetRules().matchAll(/var\(\s*(--print-[a-z\d-]+)/g)].map((m) => m[1]));
}

/** Resolve an appearance from theme text, failing the test if the resolver rejected the theme. */
function appearanceFrom(themeText: string): AppearanceModel {
  const resolved = resolveAppearance({ themeText });
  expect(resolved.themeApplied).toBe(true);
  return resolved.appearance;
}

/**
 * The same group with one optional field left out.
 *
 * Groups like `quote.cite` and `table.head` are declared optional on the model and BUILT conditionally
 * by the resolver — `...(Object.keys(quoteCite).length === 0 ? {} : { cite: quoteCite })` and its
 * neighbours — so a model that carries none of them is a shape the producer already emits. It does not
 * arrive from the vendored default theme today only because that theme happens to set one key of each,
 * which is a fact about `default-theme.generated.ts` and changes with the gem it is generated from.
 *
 * @param group - The group to copy.
 * @param key - The field to leave out.
 * @returns The group without it.
 */
function without<T extends object, K extends keyof T>(group: T, key: K): Omit<T, K> {
  const rest = { ...group };
  Reflect.deleteProperty(rest, key);
  return rest;
}

/** The default appearance, with every group a theme may leave unset left unset. */
function withoutOptionalGroups(): AppearanceModel {
  const model = defaultAppearance();
  return {
    ...model,
    code: without(model.code, 'paddingPt'),
    quote: without(model.quote, 'cite'),
    verse: without(model.verse, 'cite'),
    sidebar: without(model.sidebar, 'title'),
    admonition: without(model.admonition, 'label'),
    table: without(without(without(model.table, 'head'), 'foot'), 'body'),
    kbd: without(model.kbd, 'separator'),
    button: without(model.button, 'content'),
    menu: without(model.menu, 'caretContent'),
  };
}

/**
 * A face lookup that answers for every family, so an absent value is the only thing missing.
 *
 * The numbers are a face's, not a real face's: what the assertions below are about is which face a
 * construct is measured against and whether a property is written at all, and a single answer for
 * every family keeps a missing group from being confused with a missing font.
 */
const measuredFace: FaceBoxLookup = () => ({
  lineHeight: 1.2,
  ascender: 1,
  descender: 0.2,
  lineGap: 0,
});

describe('the custom-property vocabulary is one contract, not two', () => {
  // `appearance-to-css.ts` writes these names and `print-preview.css` reads them, and neither file
  // imports the other. Nothing would fail to compile if a name were changed on one side alone — the
  // page would simply lose that value in silence. This test is the only thing that notices.
  test('the stylesheet reads exactly the properties the writer can write', () => {
    const read = propertiesReadByStylesheet();
    const written = new Set(PRINT_CSS_PROPERTIES);

    expect([...written].filter((name) => !read.has(name)).toSorted()).toEqual([]);
    expect([...read].filter((name) => !written.has(name)).toSorted()).toEqual([]);
  });

  test('every property the stylesheet reads carries a literal fallback', () => {
    // Without a fallback, a theme that does not carry a value degrades the page to nothing rather
    // than to the default — which is how a construct silently disappears instead of looking plain.
    const rules = stylesheetRules();
    const withoutFallback = [...rules.matchAll(/var\(\s*(--print-[a-z\d-]+)\s*\)/g)].map((m) => m[1]);
    expect(withoutFallback).toEqual([]);
  });

  test('the vocabulary carries no name outside its own namespace', () => {
    expect(PRINT_CSS_PROPERTIES.filter((name) => !name.startsWith('--print-'))).toEqual([]);
  });

  test('no property is declared twice', () => {
    expect(new Set(PRINT_CSS_PROPERTIES).size).toBe(PRINT_CSS_PROPERTIES.length);
  });
});

describe('projecting the default appearance', () => {
  const properties = appearanceToCssProperties(defaultAppearance());

  test('the page geometry arrives in CSS pixels, converted once from points', () => {
    // A4 is 595.28 x 841.89pt, which at 96/72 is 793.7 x 1122.52px.
    expect(properties['--print-page-width']).toBe('793.7067px');
    expect(properties['--print-page-height']).toBe('1122.52px');
  });

  test('the values the renderer always resolves are always present', () => {
    for (const name of [
      '--print-page-width',
      '--print-page-height',
      '--print-page-background-color',
      '--print-base-font-family',
      '--print-base-font-size',
      '--print-base-font-color',
      '--print-base-line-height',
    ]) {
      expect(properties[name]).toBeDefined();
    }
  });

  test('no value is an empty string', () => {
    // An empty custom property beats the stylesheet's own `var(--x, default)` fallback with nothing,
    // so writing one would degrade the page to blank rather than to the default. Absent, never empty.
    expect(Object.values(properties).filter((value) => value === '')).toEqual([]);
  });

  test('the same appearance projects to the same properties every time', () => {
    expect(appearanceToCssProperties(defaultAppearance())).toEqual(properties);
  });
});

describe('formatting a resolved value', () => {
  test('a length becomes pixels at 96/72, rounded finer than a display can show', () => {
    const model = appearanceFrom('base:\n  font_size: 12\ncode:\n  border_width: 1\n');
    expect(model.base.fontSizePt).toBe(12);
    expect(appearanceToCssProperties(model)['--print-base-font-size']).toBe('16px');
    expect(appearanceToCssProperties(model)['--print-code-border-width']).toBe('1.3333px');
  });

  test('a colour becomes six hexadecimal digits behind a hash', () => {
    const properties = appearanceToCssProperties(appearanceFrom('base:\n  font_color: 3C763D\n'));
    expect(properties['--print-base-font-color']).toBe('#3C763D');
  });

  test('the transparent keyword survives as a keyword rather than becoming a colour', () => {
    const properties = appearanceToCssProperties(
      appearanceFrom('code:\n  background_color: transparent\n'),
    );
    expect(properties['--print-code-background-color']).toBe('transparent');
  });

  test('a family name is quoted, so a name with spaces stays one family', () => {
    const properties = appearanceToCssProperties(
      appearanceFrom('base:\n  font_family: M+ 1p Fallback\n'),
    );
    expect(properties['--print-base-font-family']).toBe('"M+ 1p Fallback"');
  });

  test("the renderer's single font-style keyword becomes CSS's two declarations", () => {
    const bold = appearanceToCssProperties(appearanceFrom('heading:\n  font_style: bold_italic\n'));
    expect(bold['--print-heading-2-font-weight']).toBe('700');
    expect(bold['--print-heading-2-font-style']).toBe('italic');

    const plain = appearanceToCssProperties(appearanceFrom('heading:\n  font_style: normal\n'));
    expect(plain['--print-heading-2-font-weight']).toBe('400');
    expect(plain['--print-heading-2-font-style']).toBe('normal');
  });

  test("an inline category's keyword settles only the axis it names", () => {
    // A block's keyword is a prawn font selection — `theme_font :heading` calls `font family,
    // style: :bold`, and `:bold` is a FACE, so it names upright as much as it names heavy. An inline
    // category's is a set of fragment styles instead: `transform.rb` builds it with `to_styles` and
    // `update_fragment` MERGES it into whatever the markup around the fragment contributed. So `bold`
    // on a codespan adds weight and says nothing about slant, and a codespan inside `_…_` under such
    // a theme is drawn in the mono face's bold_italic — which the reference for the
    // `inline-context-styled` fidelity anchor draws, and which a projection writing both axes could
    // never produce, because the `normal` it would write for the slant overrides the inheritance the
    // stylesheet sets up for exactly that case.
    const bold = appearanceToCssProperties(appearanceFrom('codespan:\n  font_style: bold\n'));
    expect(bold['--print-codespan-font-weight']).toBe('700');
    expect(bold['--print-codespan-font-style']).toBeUndefined();

    const italic = appearanceToCssProperties(appearanceFrom('kbd:\n  font_style: italic\n'));
    expect(italic['--print-kbd-font-weight']).toBeUndefined();
    expect(italic['--print-kbd-font-style']).toBe('italic');

    const both = appearanceToCssProperties(appearanceFrom('codespan:\n  font_style: bold_italic\n'));
    expect(both['--print-codespan-font-weight']).toBe('700');
    expect(both['--print-codespan-font-style']).toBe('italic');

    // `normal_italic` is the one keyword that settles both, and only because `to_styles` spells it
    // `[:normal, :italic]` — the `:normal` being an instruction to `update_fragment` to SUBTRACT the
    // inherited bold and italic before merging, which is a forced 400 rather than an absent one.
    const subtracted = appearanceToCssProperties(
      appearanceFrom('codespan:\n  font_style: normal_italic\n'),
    );
    expect(subtracted['--print-codespan-font-weight']).toBe('400');
    expect(subtracted['--print-codespan-font-style']).toBe('italic');

    // A plain `normal` has no branch in `to_styles` at all, so it produces no set, and `.compact`
    // drops the key from the category's settings: it forces neither axis, exactly as an absent key
    // does. The stylesheet's own defaults are what a reader then sees.
    const plain = appearanceToCssProperties(appearanceFrom('codespan:\n  font_style: normal\n'));
    expect(plain['--print-codespan-font-weight']).toBeUndefined();
    expect(plain['--print-codespan-font-style']).toBeUndefined();
  });

  test('a button and a menu path go through the fragment merge, not the block selection', () => {
    // `build_fragment` has ONE branch for all five inline constructs: `when :button, :code, :kbd,
    // :mark, :menu then update_fragment fragment, @theme_settings[tag_name]` (transform.rb:276), and
    // `update_fragment` merges `:styles` into what the markup contributed. Both of these were left on
    // the block axes, and both are `bold` in the renderer's own default theme — so the projection
    // wrote `--print-button-font-style: normal` and `--print-menu-font-style: normal` outright, and
    // `_press btn:[Save] to continue_` came out upright here against an export that draws it
    // bold-italic.
    const preset = appearanceToCssProperties(defaultAppearance());
    expect(preset['--print-button-font-weight']).toBe('700');
    expect(preset['--print-button-font-style']).toBeUndefined();
    expect(preset['--print-menu-font-weight']).toBe('700');
    expect(preset['--print-menu-font-style']).toBeUndefined();

    const slanted = appearanceToCssProperties(
      appearanceFrom('button:\n  font_style: italic\nmenu:\n  font_style: italic\n'),
    );
    expect(slanted['--print-button-font-weight']).toBeUndefined();
    expect(slanted['--print-button-font-style']).toBe('italic');
    expect(slanted['--print-menu-font-weight']).toBeUndefined();
    expect(slanted['--print-menu-font-style']).toBe('italic');

    // The one keyword that settles both, because its `:normal` is a subtraction rather than a value.
    const subtracted = appearanceToCssProperties(
      appearanceFrom('button:\n  font_style: normal_italic\nmenu:\n  font_style: normal_italic\n'),
    );
    expect(subtracted['--print-button-font-weight']).toBe('400');
    expect(subtracted['--print-button-font-style']).toBe('italic');
    expect(subtracted['--print-menu-font-weight']).toBe('400');
    expect(subtracted['--print-menu-font-style']).toBe('italic');
  });

  test('the shared heading alignment is carried apart from the six levels', () => {
    // A level-1 SECTION heading — a part, in book doctype — takes `heading.h1.text-align ||
    // heading.text-align || base.text-align` (`converter.rb:653`), while the DOCUMENT TITLE takes the
    // h1 key alone and centres without it (`converter.rb:194`). `--print-heading-1-text-align` is the
    // second of those, so the middle step of the first needs a name of its own; without it the
    // stylesheet had nothing to give a part but the title's centre.
    const shared = appearanceToCssProperties(appearanceFrom('heading:\n  text_align: right\n'));
    expect(shared['--print-heading-text-align']).toBe('right');
    // And it is NOT the level-1 property, which is what the title reads.
    expect(shared['--print-heading-1-text-align']).toBeUndefined();
    // The level's own key still wins the first step, for the title and the part alike.
    expect(shared['--print-heading-2-text-align']).toBe('right');

    const level = appearanceToCssProperties(
      appearanceFrom('heading:\n  text_align: right\n  h1:\n    text_align: center\n'),
    );
    expect(level['--print-heading-1-text-align']).toBe('center');
    expect(level['--print-heading-text-align']).toBe('right');
  });

  test('no construct the renderer reads no alignment for is given one', () => {
    // Seven of them were: a `--print-<construct>-text-align` was written, the stylesheet applied it,
    // and none of the seven keys appears anywhere in the gem. See `UNREAD_TEXT_ALIGN_KEYS` in
    // `packages/shared`. Asserted over the whole vocabulary rather than construct by construct, so a
    // group added later cannot quietly bring one back.
    const reads = new Set([
      '--print-base-text-align',
      ...HEADING_LEVELS.map((level) => `--print-heading-${level}-text-align`),
      '--print-heading-text-align',
      '--print-sidebar-title-text-align',
      '--print-toc-title-text-align',
      '--print-caption-text-align',
    ]);
    const aligning = PRINT_CSS_PROPERTIES.filter((name) => name.endsWith('-text-align'));
    expect(aligning.filter((name) => !reads.has(name))).toEqual([]);
    // Both directions: every name above is really in the vocabulary, so the set cannot be padded.
    expect(aligning.toSorted()).toEqual([...reads].toSorted());
  });

  test("a block alignment becomes the margins that produce it, not the word for it", () => {
    // `margin: center` is not a declaration. A property whose value the stylesheet cannot use is
    // indistinguishable, on screen, from a property that was never written — the block just stays
    // where it was, and every test that only checks the property EXISTS goes on passing.
    const centred = appearanceToCssProperties(appearanceFrom('image:\n  align: center\n'));
    expect(centred['--print-image-align']).toBe('0 auto');

    const right = appearanceToCssProperties(appearanceFrom('image:\n  align: right\n'));
    expect(right['--print-image-align']).toBe('0 0 0 auto');
  });

  test('a group the renderer’s own theme leaves unset is written the moment a theme sets it', () => {
    // The contents title is the group that really is absent by default — the renderer's theme gives
    // `toc.title` nothing at all. Both halves matter: a projection that dropped the group entirely
    // would look identical to this one on the default theme, and only differ for the themes that set it.
    expect(defaultAppearance().toc.title).toBeUndefined();

    const model = appearanceFrom(
      'toc:\n  title:\n    font_family: M+ 1mn\n    font_size: 20\n' +
        '    font_color: 112233\n    font_style: bold_italic\n    text_align: center\n',
    );
    expect(model.toc.title?.fontSizePt).toBe(20);

    const properties = appearanceToCssProperties(model);
    expect(properties['--print-toc-title-font-family']).toBe('"M+ 1mn"');
    expect(properties['--print-toc-title-font-size']).toBe('26.6667px');
    expect(properties['--print-toc-title-font-color']).toBe('#112233');
    expect(properties['--print-toc-title-font-weight']).toBe('700');
    expect(properties['--print-toc-title-font-style']).toBe('italic');
    expect(properties['--print-toc-title-text-align']).toBe('center');
  });

  test('a value the resolver could not read is a value this projection does not write', () => {
    // `button.content` is a PAIR, so a theme that writes something else there loses both halves at
    // once. They have to go missing rather than empty: the stylesheet's own brackets are the fallback,
    // and an empty custom property beats a `var(--x, default)` with nothing at all.
    const model = appearanceFrom('button:\n  content: nonsense\n');
    expect(model.button.content).toBeUndefined();

    const properties = appearanceToCssProperties(model);
    expect(properties).not.toHaveProperty('--print-button-content-before');
    expect(properties).not.toHaveProperty('--print-button-content-after');
  });

  test('a four-edge measurement becomes four properties in the CSS edge order', () => {
    const properties = appearanceToCssProperties(
      appearanceFrom('code:\n  padding: [3, 6, 9, 12]\n'),
    );
    expect(properties['--print-code-padding-top']).toBe('4px');
    expect(properties['--print-code-padding-right']).toBe('8px');
    expect(properties['--print-code-padding-bottom']).toBe('12px');
    expect(properties['--print-code-padding-left']).toBe('16px');
  });
});

describe('the air the renderer puts around the sign between two key caps', () => {
  // Asciidoctor's HTML backend writes a bare `+` between two caps; the renderer joins them with the
  // theme's separator, whose air is most of what a reader sees of it. So the separator is carried as
  // its two ends and the stylesheet sets them either side of the sign the markup already has.

  test('a separator that is all air and no sign is not carried at all', () => {
    // There is nothing for the air to sit around. Putting it either side of the markup's own `+`
    // would draw a sign the export does not draw — and would space it out as though it were the one
    // the theme asked for.
    const properties = appearanceToCssProperties(appearanceFrom('kbd:\n  separator: "   "\n'));
    expect(properties).not.toHaveProperty('--print-kbd-separator-before');
    expect(properties).not.toHaveProperty('--print-kbd-separator-after');
  });

  test('a separator with air at one end only writes an empty string at the other', () => {
    // An empty string rather than nothing, and the difference is visible: an unwritten property lets
    // the stylesheet's own fallback through, which would put the default's narrow no-break space back
    // on the end this theme deliberately cleared.
    const properties = appearanceToCssProperties(appearanceFrom('kbd:\n  separator: "+ "\n'));
    expect(properties['--print-kbd-separator-before']).toBe('""');
    expect(properties['--print-kbd-separator-after']).toBe(String.raw`"\20 "`);
  });
});

describe('a group the model does not carry', () => {
  // The file's central promise: "A property is written only for a value the model actually carries.
  // A missing value is absent, never an empty string." The failure mode is specific and quiet — an
  // empty custom property BEATS the stylesheet's own `var(--x, default)` fallback with nothing, and a
  // `${undefined}px` is a declaration the browser discards without a word. Either way the construct
  // does not fall back to the default appearance; it loses its value outright.
  const properties = appearanceToCssProperties(withoutOptionalGroups(), measuredFace);

  test('every property the group alone could supply is left unwritten', () => {
    for (const name of [
      '--print-code-padding-top',
      '--print-code-padding-right',
      '--print-code-padding-bottom',
      '--print-code-padding-left',
      '--print-quote-cite-font-family',
      '--print-quote-cite-font-size',
      '--print-quote-cite-font-color',
      '--print-quote-cite-font-weight',
      '--print-quote-cite-font-style',
      '--print-verse-cite-font-family',
      '--print-verse-cite-font-size',
      '--print-verse-cite-font-color',
      '--print-verse-cite-font-weight',
      '--print-verse-cite-font-style',
      '--print-sidebar-title-font-family',
      '--print-sidebar-title-font-size',
      '--print-sidebar-title-font-color',
      '--print-sidebar-title-font-weight',
      '--print-sidebar-title-font-style',
      '--print-sidebar-title-text-align',
      '--print-sidebar-title-margin-bottom',
      '--print-admonition-label-font-weight',
      '--print-admonition-label-font-style',
      '--print-admonition-label-text-transform',
      '--print-admonition-label-min-width',
      '--print-table-head-background-color',
      '--print-table-head-font-weight',
      '--print-table-head-font-style',
      '--print-table-head-border-bottom-width',
      '--print-table-body-stripe-background-color',
      '--print-button-content-before',
      '--print-button-content-after',
      '--print-kbd-separator-before',
      '--print-kbd-separator-after',
      '--print-menu-caret-content',
    ]) {
      expect(properties).not.toHaveProperty(name);
    }
  });

  test('nothing is written empty, and no value carries the word for a value that was not there', () => {
    // Both spellings of the same mistake, and both are invisible from the page: an empty property
    // beats the stylesheet's fallback with nothing, and `undefinedpx` is thrown away by the browser.
    // Filtered rather than asserted one at a time so a failure names the properties it found.
    const broken = Object.entries(properties).filter(
      ([, value]) => value === '' || /undefined|NaN/.test(value),
    );
    expect(broken).toEqual([]);
  });

  test("a construct whose own group is gone is still typeset at the body's, in the body's face", () => {
    // Absent is not the answer to everything: `theme_font` swaps in a category's own size and line
    // height only when it HAS them, and typesets the construct at the body's otherwise. So the line
    // box and the face measurements are still written — from body text — where the values that only
    // the group could have supplied are not.
    const model = defaultAppearance();
    expect(Number.parseFloat(properties['--print-sidebar-title-line-height'])).toBeCloseTo(
      model.base.fontSizePt * (1.2 + model.base.lineHeight - 1) * (96 / 72),
      3,
    );
    expect(properties['--print-sidebar-title-face-ascender']).toBe('1');
    expect(properties['--print-sidebar-title-face-descender']).toBe('0.2');
  });
});

describe('the family a construct is set in when it names none of its own', () => {
  // The renderer's own chain, and the metric-bearing name has to follow it: a second registration
  // under a name derived from the WRONG family is a name nothing was registered under, so the
  // stylesheet's stack falls through and the box behind the run is the browser's own reading again —
  // 1.395em of tint where the export paints 1.0em, and nothing anywhere says so.
  const model = defaultAppearance();

  test("a key cap with no family of its own takes the codespan's, and is measured against it", () => {
    const inherited: AppearanceModel = { ...model, kbd: without(model.kbd, 'fontFamily') };
    const properties = appearanceToCssProperties(inherited, measuredFace);
    expect(model.codespan.fontFamily).toBeDefined();
    expect(properties['--print-kbd-metric-font-family']).toBe(
      `"${metricFamilyOf(model.codespan.fontFamily ?? '')}"`,
    );
    // And the pair the tint behind the cap is drawn from comes off that same inherited face.
    expect(properties['--print-kbd-face-ascender']).toBe('1');
  });

  test('a codespan with no family of its own takes body text’s, and the cap follows it there', () => {
    const inherited: AppearanceModel = {
      ...model,
      kbd: without(model.kbd, 'fontFamily'),
      codespan: without(model.codespan, 'fontFamily'),
    };
    const properties = appearanceToCssProperties(inherited, measuredFace);
    const expected = `"${metricFamilyOf(model.base.fontFamily)}"`;
    expect(properties['--print-codespan-metric-font-family']).toBe(expected);
    expect(properties['--print-kbd-metric-font-family']).toBe(expected);
  });

  test('a callout digit is measured against the conum’s own face, not against body text’s', () => {
    // The conum's metric name had no test at all, only the ink-centre comparison in
    // `print-constructs.spec.ts` — which needs the whole stack and a reference PDF. Replacing the
    // read with `metricFamily(model.base.fontFamily)` left all 196 unit tests green, and under the
    // gem's own default theme that resolves to `"Noto Serif·print-metrics"`, which IS a registered
    // family: it would win the `::after` stack outright and draw the digit in the serif face at
    // serif metrics, inside a ring sized from the mono one.
    const properties = appearanceToCssProperties(model, measuredFace);
    expect(model.conum.fontFamily).toBeDefined();
    expect(model.conum.fontFamily).not.toBe(model.base.fontFamily);
    expect(properties['--print-conum-metric-font-family']).toBe(
      `"${metricFamilyOf(model.conum.fontFamily ?? '')}"`,
    );
    // And the ordinary family beside it, so the two entries of the stylesheet's stack are pinned
    // together: the metric name is the FIRST of them, and a name derived from a different family
    // from the one below it is the same failure as a name nothing registered.
    expect(properties['--print-conum-font-family']).toBe(`"${model.conum.fontFamily ?? ''}"`);
  });

  test('a conum with no family of its own takes the codespan’s, which is where the gem sends it', () => {
    // `theme_data.conum_font_family ||= (theme_data.codespan_font_family || 'Courier')`
    // (`theme_loader.rb:87`). The resolver applies that derivation for a project theme, so a model
    // reaching here without a conum family is the gem's own default theme having named none — and
    // the projection has to make the same step rather than fall to body text.
    const inherited: AppearanceModel = { ...model, conum: without(model.conum, 'fontFamily') };
    const properties = appearanceToCssProperties(inherited, measuredFace);
    expect(properties['--print-conum-metric-font-family']).toBe(
      `"${metricFamilyOf(model.codespan.fontFamily ?? '')}"`,
    );
  });

  test('a conum whose whole chain names no family writes no metric name at all', () => {
    // The end of the chain, which is a different answer from a wrong one: with nothing to derive
    // from, the property is left unwritten and the stylesheet's own literal — the renderer's mono
    // default — stands. Writing body text's name here would put a registered serif family at the
    // head of the digit's stack, which is the failure the test above describes.
    //
    // The gem's own last step is `|| 'Courier'` rather than body text's family, and the projection's
    // chain ends at `base.fontFamily` instead. The two can only differ for a model carrying neither
    // a `conum` nor a `codespan` family, which `deriveLoaderSettings` makes unreachable for a project
    // theme and which the gem's own default theme is not; it is stated here rather than corrected
    // because correcting it means teaching the projection a family name the appearance model does not
    // carry, and nothing has been measured that reaches it.
    const inherited: AppearanceModel = {
      ...model,
      conum: without(model.conum, 'fontFamily'),
      codespan: without(model.codespan, 'fontFamily'),
      base: without(model.base, 'fontFamily') as AppearanceModel['base'],
    };
    const properties = appearanceToCssProperties(inherited, measuredFace);
    expect(properties).not.toHaveProperty('--print-conum-metric-font-family');
  });
});

describe('what a theme cannot do through this projection', () => {
  // The resolver has already parsed every value to a typed value; this is the second wall. A value
  // that is not what its formatter can produce is dropped, not escaped and hoped for — which is what
  // makes escaping the previewed page structurally impossible rather than filtered.
  //
  // Every case here builds the model BY HAND, and that is the whole point of the describe. Routed
  // through `resolveAppearance` these were tests of the FIRST wall: the resolver replaced each
  // hostile value with the key's default before the projection ever saw it, so the assertions were
  // about `Noto Serif` and `left`. Three of them passed with this file's own family check deleted.
  //
  // The model shapes below are not hypothetical. Every field is optional or a plain `string` on
  // `AppearanceModel`, so a producer that stopped parsing one key — or a second producer — reaches
  // this function with exactly these values, and this function is the last thing between them and a
  // declaration on the page.

  test('no projected value carries a character that could close a declaration', () => {
    const model = defaultAppearance();
    const hostile: AppearanceModel = {
      ...model,
      base: {
        ...model.base,
        fontFamily: 'Arial; } body { display: none',
        fontColor: 'red; }',
        textAlign: 'left; position: fixed',
      },
      codespan: { ...model.codespan, fontFamily: 'Menlo"; }' },
      kbd: { ...model.kbd, fontFamily: 'Menlo"; }' },
      code: { ...model.code, backgroundColor: 'url(https://example.test/x)' },
      thematicBreak: { ...model.thematicBreak, borderStyle: 'solid; position: fixed' },
      admonition: {
        ...model.admonition,
        label: { ...model.admonition.label, textTransform: 'none) ; a{b:c' },
      },
      image: { ...model.image, align: 'center; position: fixed' },
      table: { ...model.table, align: 'center; position: fixed' },
    };

    const properties = appearanceToCssProperties(hostile, measuredFace);
    for (const value of Object.values(properties)) expect(value).not.toMatch(/[;{}()<>]/);
    // And dropped rather than trimmed to something that merely passes the check above: the
    // stylesheet's own `var(--x, default)` fallback is the appearance a rejected value falls to.
    for (const name of [
      '--print-base-font-family',
      '--print-base-font-color',
      '--print-base-text-align',
      '--print-codespan-font-family',
      '--print-codespan-metric-font-family',
      '--print-kbd-font-family',
      '--print-kbd-metric-font-family',
      '--print-code-background-color',
      '--print-thematic-break-border-style',
      '--print-admonition-label-text-transform',
      '--print-image-align',
      '--print-table-align',
    ]) {
      expect(properties).not.toHaveProperty(name);
    }
  });

  test('a colour outside the one shape a colour can have is dropped rather than written', () => {
    // The second wall, exercised from the far side of the resolver. Every colour arriving here has
    // already been parsed to six hexadecimal digits or the transparent keyword, so this states what
    // holds if that ever stops being true: `#red` is only a declaration the browser discards, but
    // `#red; }` would not be, and this regular expression is the whole of the difference.
    const model = defaultAppearance();
    const suspect: AppearanceModel = { ...model, base: { ...model.base, fontColor: 'red; }' } };
    expect(appearanceToCssProperties(suspect)).not.toHaveProperty('--print-base-font-color');
  });

  test('a family name outside the shape a family can have is dropped rather than quoted', () => {
    const model = defaultAppearance();
    for (const name of [
      // The quote is the one that matters: everything this file emits is quoted, so a name carrying
      // one closes its own string and everything after it is a declaration the theme wrote.
      'a"; }',
      'Noto Serif, sans-serif',
      String.raw`Noto\Serif`,
      'Noto;Serif',
      '</style><script>',
      'A'.repeat(MAX_FONT_FAMILY_LENGTH + 1),
      '',
    ]) {
      const suspect: AppearanceModel = { ...model, base: { ...model.base, fontFamily: name } };
      expect(appearanceToCssProperties(suspect)).not.toHaveProperty('--print-base-font-family');
    }
  });

  test('a keyword outside the fixed set is dropped rather than passed through', () => {
    const model = defaultAppearance();
    const suspect: AppearanceModel = {
      ...model,
      base: { ...model.base, textAlign: 'nowhere' },
      thematicBreak: { ...model.thematicBreak, borderStyle: 'groove' },
      admonition: {
        ...model.admonition,
        label: { ...model.admonition.label, textTransform: 'small-caps' },
      },
      toc: { ...model.toc, title: { ...model.toc.title, textAlign: 'end' } },
    };
    const properties = appearanceToCssProperties(suspect);
    for (const name of [
      '--print-base-text-align',
      '--print-thematic-break-border-style',
      '--print-admonition-label-text-transform',
      '--print-toc-title-text-align',
    ]) {
      expect(properties).not.toHaveProperty(name);
    }
  });

  test('an alignment that is a property of every object is not one of the three', () => {
    // The three keywords used to be an object literal, indexed with an unguarded string. `constructor`
    // and `__proto__` are keys EVERY object answers to, and each answers with something truthy that
    // this file then wrote into a `margin` declaration — a value no theme supplied and no whitelist
    // admitted. Nothing reaches here with one today; the resolver's own whitelist is upstream of it,
    // and this is the place that decides.
    const model = defaultAppearance();
    for (const align of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const suspect: AppearanceModel = {
        ...model,
        image: { ...model.image, align },
        table: { ...model.table, align },
      };
      const properties = appearanceToCssProperties(suspect);
      expect(properties).not.toHaveProperty('--print-image-align');
      expect(properties).not.toHaveProperty('--print-table-align');
    }
  });

  test('a family long enough for the projection gets its metric registration too', () => {
    // Two budgets that had to agree and were written twice. The theme's own family is bounded by the
    // resolver at `MAX_FONT_FAMILY_LENGTH`; the name the same file is registered a second time under
    // is that plus a fixed suffix — so a family of 51 to 64 characters was emitted as a family and
    // dropped as a metric name. The stylesheet reads a missing metric name as "no such registration"
    // and falls back to the catalogue's own mono face, which IS registered and therefore wins the
    // stack ahead of the theme's real family: inline code measured at another typeface's widths, and
    // broken into lines somewhere other than the page breaks them.
    const longest = 'A'.repeat(MAX_FONT_FAMILY_LENGTH);
    // The resolver really does hand a name this long through, so this is a reachable model.
    const resolved = resolveAppearance({ themeText: `codespan:\n  font_family: ${longest}\n` });
    expect(resolved.appearance.codespan.fontFamily).toBe(longest);

    const model = defaultAppearance();
    const suspect: AppearanceModel = {
      ...model,
      codespan: { ...model.codespan, fontFamily: longest },
      kbd: { ...model.kbd, fontFamily: longest },
    };
    const properties = appearanceToCssProperties(suspect);
    // Both, or neither. Never the family without the face its metrics are declared on.
    expect(properties['--print-codespan-font-family']).toBe(`"${longest}"`);
    expect(properties['--print-codespan-metric-font-family']).toBe(`"${metricFamilyOf(longest)}"`);
    expect(properties['--print-kbd-font-family']).toBe(`"${longest}"`);
    expect(properties['--print-kbd-metric-font-family']).toBe(`"${metricFamilyOf(longest)}"`);
  });

  test('a theme cannot name a family that would collide with another family’s metric registration', () => {
    // The derived name goes into `document.fonts` beside the theme's own names, and a font set has no
    // notion of who added what. A theme declaring both `Foo` and whatever `Foo`'s metric registration
    // is called would put two DIFFERENT FILES under one name at one weight and slant — measured in
    // Chromium, the last one declared wins, and declaration order is the order `resolveAppearance`
    // emits `fonts` in. Which typeface a codespan is drawn and measured with would then be decided by
    // the order two keys happen to appear in a theme document.
    //
    // What makes that unreachable is not a check but the alphabet: the separator is a character the
    // resolver's own family parser rejects, so no name a theme can write is the derived name of any
    // other. Asserted through `resolveAppearance` rather than against the regular expression, because
    // the parser is the thing that decides and this has to fail if IT widens.
    for (const family of ['Foo', 'M+ 1mn', 'Noto Serif', 'A'.repeat(MAX_FONT_FAMILY_LENGTH)]) {
      const derived = metricFamilyOf(family);
      const resolved = resolveAppearance({ themeText: `codespan:\n  font_family: "${derived}"\n` });
      expect(resolved.appearance.codespan.fontFamily).not.toBe(derived);
    }
  });

  test('the derived name is emitted even though the projection would refuse it as a family', () => {
    // The other side of the same coin, and the reason the check runs on the theme's name rather than
    // on the derived one: put through the family formatter, every metric name would be dropped —
    // which is exactly the "no such registration" state the stylesheet reads as a licence to fall
    // back to the catalogue's mono face. So the formatter is asked about the string a theme wrote,
    // and the suffix is appended afterwards.
    const model = defaultAppearance();
    const properties = appearanceToCssProperties(model, measuredFace);
    const emitted = properties['--print-codespan-metric-font-family'];
    expect(emitted).toBe(`"${metricFamilyOf(model.codespan.fontFamily ?? '')}"`);
    // Nothing inside the quotes can close a declaration, which is the whole of what the formatter
    // established about the theme's own half of the name and what the literal suffix cannot undo.
    expect(emitted?.slice(1, -1)).not.toMatch(/["';{}()<>\\]/);
    // And it is not a name a theme could have written, so it cannot be one.
    const round = resolveAppearance({
      themeText: `codespan:\n  font_family: "${emitted?.slice(1, -1) ?? ''}"\n`,
    });
    expect(round.appearance.codespan.fontFamily).not.toBe(emitted?.slice(1, -1));
  });
});

describe('the line box each construct is set in', () => {
  // The renderer's line box is the FACE's own built-in height plus `(line-height - 1) x font-size`;
  // CSS `line-height` is the whole box. Writing the theme's number straight into CSS therefore sets
  // lines about a fifth too close on the renderer's own default theme.
  const NOTO = 1.36;
  const MPLUS = 1.09;
  // The pair the renderer reads off each face, beside the height it adds them into: Noto Serif is
  // 1.068/0.292 in prawn's 1000-unit em, M+ 1mn 0.86/0.14 with a 0.09 gap.
  const faceLineHeight = (family: string | undefined) => {
    if (family === 'Noto Serif') return { lineHeight: NOTO, ascender: 1.068, descender: 0.292, lineGap: 0 };
    if (family === 'M+ 1mn') return { lineHeight: MPLUS, ascender: 0.86, descender: 0.14, lineGap: 0.09 };
    return undefined;
  };

  test("each construct carries the reach of its OWN face above and below the baseline", () => {
    // The renderer raises a superscript by `0.85 x ascender` and paints a codespan's tint from the
    // fragment's own top to its own bottom, both measured off the face the text is set in — so a
    // construct in the mono face must not be handed the body face's numbers.
    const properties = appearanceToCssProperties(defaultAppearance(), faceLineHeight);
    expect(properties['--print-base-face-ascender']).toBe('1.068');
    expect(properties['--print-base-face-descender']).toBe('0.292');
    expect(properties['--print-code-face-ascender']).toBe('0.86');
    expect(properties['--print-code-face-descender']).toBe('0.14');
  });

  test('a face with no metrics leaves the pair unwritten rather than guessing at it', () => {
    const properties = appearanceToCssProperties(defaultAppearance(), () => undefined);
    expect(properties['--print-base-face-ascender']).toBeUndefined();
    expect(properties['--print-base-face-descender']).toBeUndefined();
  });

  test("body text is the face's own height plus the theme's leading, not the theme's ratio", () => {
    const model = defaultAppearance();
    const properties = appearanceToCssProperties(model, faceLineHeight);
    const expected = model.base.fontSizePt * (NOTO + model.base.lineHeight - 1) * (96 / 72);
    expect(Number.parseFloat(properties['--print-base-line-height'])).toBeCloseTo(expected, 3);
    // …and not the ratio, which is what it was and what the browser would have read as the whole box.
    expect(properties['--print-base-line-height']).not.toBe(String(model.base.lineHeight));
  });

  test('a construct with its own family is measured against that family, not against the body', () => {
    const model = defaultAppearance();
    const properties = appearanceToCssProperties(model, faceLineHeight);
    const code = model.code;
    const sizePt = code.fontSizePt ?? model.base.fontSizePt;
    const multiple = code.lineHeight ?? model.base.lineHeight;
    expect(Number.parseFloat(properties['--print-code-line-height'])).toBeCloseTo(
      sizePt * (MPLUS + multiple - 1) * (96 / 72),
      3,
    );
  });

  test('a construct with no line height of its own takes the body\'s, at its own size', () => {
    // `theme_font` swaps in a category's line height only when it has one, so a quote — which has no
    // `quote.line-height` in the renderer's default theme — is typeset at the body's multiple in the
    // quote's own face and at the quote's own size.
    const model = defaultAppearance();
    const properties = appearanceToCssProperties(model, faceLineHeight);
    const sizePt = model.quote.fontSizePt ?? model.base.fontSizePt;
    expect(model.quote.lineHeight).toBeUndefined();
    expect(Number.parseFloat(properties['--print-quote-line-height'])).toBeCloseTo(
      sizePt * (NOTO + model.base.lineHeight - 1) * (96 / 72),
      3,
    );
  });

  test('a face with no metrics leaves the theme\'s ratio, rather than a guessed length', () => {
    const model = defaultAppearance();
    const properties = appearanceToCssProperties(model, () => undefined);
    expect(properties['--print-base-line-height']).toBe(String(model.base.lineHeight));
    // A construct with no line height of its own writes nothing at all, so the stylesheet's own
    // fallback applies rather than an empty custom property beating it.
    expect(properties['--print-quote-line-height']).toBeUndefined();
  });

  test("the conum's line box is a length or nothing, never the theme's ratio", () => {
    // Every other line height is APPLIED as a `line-height`, where a bare ratio is still a valid
    // declaration and is the honest degradation. This one is a term in the `calc()` that places a
    // callout ring in its cell — `calc(<number> / 2 + <length>)` is invalid at computed-value time,
    // so a ratio here does not degrade the ring's position, it throws the whole `padding-top` away
    // and drops every ring to the top of its cell.
    //
    // Reachable without a broken theme: `resolveFaceMetrics` skips a project face whose bytes the
    // preview does not hold yet, so any project naming its own file for the codespan or the conum
    // arrives here on its first paint, and permanently if the file cannot be read.
    const model = defaultAppearance();
    expect(model.conum.lineHeight ?? model.base.lineHeight).toBeGreaterThan(0);

    const measured = appearanceToCssProperties(model, faceLineHeight)['--print-conum-line-height'];
    expect(measured).toMatch(/^[\d.]+px$/);

    expect(appearanceToCssProperties(model, () => undefined)['--print-conum-line-height']).toBeUndefined();
  });
});
