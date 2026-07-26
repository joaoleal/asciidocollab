/**
 * The app's product-level render defaults, and the precedence they must NOT break:
 * document header > project render config > app default.
 *
 * The defect these guard is a cross-project inconsistency, not a crash: the bundled guided tour
 * declares `:icons: font` in its header and rendered admonitions with icons, while every other
 * project fell back to Asciidoctor's plain text label — same `NOTE:` line, two different-looking
 * admonitions depending on which project you opened.
 */

import { resolveRenderAttributes, SOFT_DEFAULT_SUFFIX } from '@asciidocollab/shared';
import {
  APP_RENDER_DEFAULT_ATTRIBUTES,
  withAppRenderDefaults,
} from '@/lib/asciidoc/render-app-defaults';

describe('APP_RENDER_DEFAULT_ATTRIBUTES', () => {
  it('defaults admonitions to font icons, so an icons-less project still renders icons', () => {
    // `font` (not `image`): the icon is painted by the preview/export stylesheet's inline-SVG mask and
    // by the PDF engine's baked-in glyphs. `image` would emit <img src="{iconsdir}/note.png"> against a
    // project path that need not exist — a broken-image glyph in every admonition.
    expect(APP_RENDER_DEFAULT_ATTRIBUTES.icons).toBe(`font${SOFT_DEFAULT_SUFFIX}`);
  });

  it('marks every default as an overridable soft-default, so a document header still wins', () => {
    // Without the trailing `@` these become API attributes that OVERRIDE the document header — the
    // exact defect class that once forced every PDF to `doctype: article`.
    for (const [name, value] of Object.entries(APP_RENDER_DEFAULT_ATTRIBUTES)) {
      expect(`${name}=${value}`.endsWith(SOFT_DEFAULT_SUFFIX)).toBe(true);
    }
  });
});

describe('withAppRenderDefaults', () => {
  it('supplies the icons default for a project with no render config at all', () => {
    const attributes = withAppRenderDefaults(resolveRenderAttributes({}).attributes);
    expect(attributes.icons).toBe(`font${SOFT_DEFAULT_SUFFIX}`);
  });

  it('yields to a project that explicitly configures image icons', () => {
    // `icons: image` resolves to the empty (image-admonition) value, so the assertion is also a guard
    // against a naive "truthy wins" merge that would let `font@` beat it.
    const configured = resolveRenderAttributes({ icons: 'image' }).attributes;
    expect(withAppRenderDefaults(configured).icons).toBe(SOFT_DEFAULT_SUFFIX);
  });

  it('yields to a project that explicitly configures font icons (no double marker)', () => {
    const configured = resolveRenderAttributes({ icons: 'font' }).attributes;
    expect(withAppRenderDefaults(configured).icons).toBe(`font${SOFT_DEFAULT_SUFFIX}`);
  });

  it('leaves the rest of the project config untouched and adds nothing else', () => {
    const configured = resolveRenderAttributes({ doctype: 'book', toc: true }).attributes;
    const attributes = withAppRenderDefaults(configured);
    expect(attributes.doctype).toBe(`book${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes.toc).toBe(SOFT_DEFAULT_SUFFIX);
    // The default set is deliberately minimal: anything else the app "helpfully" seeded here would be
    // a silent rewrite of what documents declare.
    expect(Object.keys(attributes).toSorted()).toEqual(['doctype', 'icons', 'toc']);
  });

  it('does not mutate the map it is handed', () => {
    const configured = { doctype: `book${SOFT_DEFAULT_SUFFIX}` };
    withAppRenderDefaults(configured);
    expect(configured).toEqual({ doctype: `book${SOFT_DEFAULT_SUFFIX}` });
  });
});
