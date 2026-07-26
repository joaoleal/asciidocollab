/**
 * @file Finds the app's own webfaces in the running page, so an export can take its typography with it.
 *
 * The families come from `next/font` (`app/layout.tsx`), which downloads them at build time and serves
 * them from `/_next/static/media/…` under a stylesheet the app loads. A saved file has neither, so
 * without this an export falls back to whatever the reader happens to have installed — and the
 * Asciidoctor style, whose whole point is looking like Asciidoctor, stops doing so.
 *
 * Reading the faces out of the live page rather than hard-coding them is deliberate: the file names are
 * content-hashed, the subsets are Next's choice, and a build that changes either would otherwise
 * silently ship an export pointing at files that no longer exist.
 *
 * Only what the chosen style renders in is collected, and only its basic-Latin subset — see
 * {@link EXPORT_WEBFONT_FAMILIES} and `coversBasicLatin`. The URLs come back ABSOLUTE; turning them
 * into something an export can carry is `resolveFontFaces`'s job.
 */

import type { HtmlExportStyle } from '@asciidocollab/shared';
import { coversBasicLatin, fontFaceDescriptor, parseFontFaces, rewriteFontFaceUrls } from './font-faces';

/**
 * The families each export style actually renders text in.
 *
 * `asciidocollab` inherits the application's UI sans (Inter) for prose and resolves `--font-mono` to a
 * system monospace stack, so Inter is the only file it needs. `asciidoctor` is the vendored stylesheet,
 * which names "Open Sans", "Noto Serif" and a monospace by literal family name — exactly the families
 * `next/font` registers, so embedding them under those names is all it takes for the vendored CSS to
 * find them.
 *
 * Kept to what is used on purpose: every family here is 25–50 KB of the reader's download, and a
 * family the stylesheet never names is 25–50 KB nobody ever sees.
 */
export const EXPORT_WEBFONT_FAMILIES: Record<HtmlExportStyle, readonly string[]> = {
  asciidocollab: ['Inter'],
  asciidoctor: ['Open Sans', 'Noto Serif', 'Ubuntu Mono'],
};

/**
 * The `@font-face` rules the export needs, with absolute URLs, or an empty string when the page
 * declares none.
 *
 * Never throws: a page whose stylesheets cannot be read is a document without embedded fonts, not a
 * failed export.
 *
 * @param style - The style the document is being dressed in, selecting the families.
 * @param root - The document to read; defaults to the running page.
 * @returns The collected rules as stylesheet text.
 */
export function collectAppFontFaceCss(style: HtmlExportStyle, root?: Document): string {
  const document_ = root ?? (typeof document === 'undefined' ? undefined : document);
  if (document_ === undefined) return '';

  const wanted = new Set(EXPORT_WEBFONT_FAMILIES[style].map((family) => family.toLowerCase()));
  const collected: string[] = [];
  const seen = new Set<string>();

  // `StyleSheetList` and `CSSRuleList` are iterable: WebIDL gives array iteration to any interface with
  // an indexed getter, which both have.
  for (const sheet of document_.styleSheets) {
    const rules = readRules(sheet);
    if (rules === null) continue;
    const base = sheet.href ?? document_.baseURI;
    for (const rule of rules) {
      const text = rule.cssText?.trim() ?? '';
      if (!text.toLowerCase().startsWith('@font-face')) continue;
      for (const block of parseFontFaces(text)) {
        if (!wanted.has(block.family.toLowerCase())) continue;
        if (!coversBasicLatin(block.unicodeRange)) continue;
        // The same face can be declared by more than one loaded stylesheet (a dev server serves the font
        // CSS in more than one chunk, each with its own hashed file name). The reader needs one copy of
        // the file, so the key is the FACE, not the rule text — see `fontFaceDescriptor`.
        const descriptor = fontFaceDescriptor(block);
        if (seen.has(descriptor)) continue;
        seen.add(descriptor);
        collected.push(rewriteFontFaceUrls(block, (url) => absoluteUrl(url, base)));
      }
    }
  }
  return collected.join('\n');
}

/**
 * One stylesheet's rules, or null when it will not give them up.
 *
 * A cross-origin stylesheet throws on `cssRules`. Nothing of ours is served from another origin, so
 * there is nothing here to lose by skipping it — and an export must not fail over a third-party sheet
 * some extension injected.
 *
 * @param sheet - The stylesheet to read.
 * @returns Its rules, or null.
 */
function readRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    return null;
  }
}

/**
 * Resolve one `url()` value against the stylesheet that declared it.
 *
 * `next/font` writes its `src` relative to its own stylesheet (`../media/…`), which is a different
 * directory from the document — so resolving against the page would find nothing. Values that are
 * already embedded or already absolute are left exactly as they are.
 *
 * @param url - The value as written in the rule.
 * @param base - The stylesheet's own URL.
 * @returns The absolute URL, or null when it cannot be resolved (leaving the value untouched).
 */
function absoluteUrl(url: string, base: string): string | null {
  if (url.startsWith('data:')) return null;
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}
