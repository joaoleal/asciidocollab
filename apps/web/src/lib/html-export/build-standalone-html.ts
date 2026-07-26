/**
 * @file Assembles the complete, standalone HTML document an export produces.
 *
 * The preview renders an EMBEDDED fragment: body content only, wrapped by the application's own
 * chrome, styled by stylesheets the app has already loaded, and reading images from an authenticated
 * endpoint. None of that survives being saved to a file. This module turns that fragment into a
 * document that stands on its own — a real `<html>` page, its stylesheet inlined, its palette
 * committed to actual colours, and its title block restored.
 *
 * It is deliberately PURE: everything that needs the network or the DOM (fetching images, rendering
 * diagrams, typesetting maths) happens before this is called and arrives as plain strings. That keeps
 * the document assembly — the part with all the escaping and structural rules — testable without a
 * browser.
 */

import type { HtmlExportStyle, HtmlExportTheme } from '@asciidocollab/shared';
import {
  ASCIIDOCOLLAB_CSS,
  ASCIIDOCTOR_CSS,
  DARK_TOKENS_CSS,
  LIGHT_TOKENS_CSS,
} from './export-css.generated';
import { stripRemoteFontFaces } from './font-faces';

/** The container class the preview styles target; the export reuses it so the CSS matches unchanged. */
export const EXPORT_CONTENT_CLASS = 'asciidoc-preview-content';

/**
 * The wrapper the export puts AROUND the content container, owning the page's reading column.
 *
 * A separate element on purpose. The column cannot be set on the content container itself: the preview
 * stylesheet declares `margin: 0` on `.asciidoc-preview-content:not([data-preview-style="asciidoctor"])`
 * — one class plus a `:not()` holding another, so more specific than anything a page rule can say about
 * the same element without resorting to `!important` or a repeated class. In the app that `margin: 0` is
 * right, because the panel around it owns the layout. In a file nothing does, so the export brings its
 * own box rather than fighting a stylesheet that is correct where it lives.
 */
export const EXPORT_PAGE_CLASS = 'adoc-export-page';

/**
 * Font tokens the app supplies through `next/font` (see `app/layout.tsx`), re-declared as plain family
 * names for the exported file.
 *
 * They cannot simply be left out. The stylesheet writes `font-family: var(--font-asciidoctor-serif),
 * "Noto Serif", serif`, and an undefined custom property in a `var()` with no fallback makes the whole
 * declaration invalid at computed-value time — CSS does NOT fall through to the next family in the
 * list, it drops the declaration and inherits instead. So an export missing these loses its typography
 * entirely rather than degrading to the fallback stack the author wrote.
 *
 * The plain names are also what the embedded font FILES are declared under (see `app-fonts.ts`), so a
 * reader who receives the export gets the real family rather than the nearest thing they happen to have
 * installed. Only the basic-Latin subset of each family travels; the fallback chain in the stylesheet
 * covers the rest, which is what it was written for.
 */
export const EXPORT_FONT_TOKENS_CSS = `.${EXPORT_CONTENT_CLASS} {
  --font-asciidoctor-sans: "Open Sans";
  --font-asciidoctor-serif: "Noto Serif";
  --font-asciidoctor-mono: "Ubuntu Mono";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}`;

/**
 * Page-level CSS the app never needs, because in the app something else owns the page.
 *
 * Deliberately minimal: it centres the reading column, gives it breathing room, and paints ONE surface
 * for the whole page. The single surface is the point — the body owns the background and the content
 * container declares none, so the page cannot end up a different colour from the block of text sitting
 * on it. It used to try, but the palette tokens were scoped to the content container only, so
 * `background: hsl(var(--background))` on the body referenced an undefined property and the whole
 * declaration was dropped — a dark export was a dark column on a white page.
 *
 * The body also names the UI sans explicitly. The brand stylesheet sets `font-family: inherit` on the
 * content, meaning "whatever the app's body uses" — which, in a file with no app, is the browser's
 * default serif unless the page says otherwise.
 *
 * Print rules drop the margins so a browser "Print to PDF" does not double up on them.
 */
const PAGE_CSS = `
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 2rem 1rem 4rem;
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.${EXPORT_PAGE_CLASS} {
  max-width: 46rem;
  margin: 0 auto;
}
.${EXPORT_PAGE_CLASS}[data-preview-style="asciidoctor"] {
  /* Asciidoctor's own stylesheet lays its content out in a 62.5em column; the scoped copy the export
     ships had that rule overridden away with the app's panel in mind, so the page restores it here. */
  max-width: 62.5rem;
}
.adoc-export-details {
  margin: 0 0 2rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.9em;
}
.adoc-export-details > span + span::before { content: " · "; }
img, svg, table { max-width: 100%; }
pre { overflow-x: auto; }
@media print {
  body { padding: 0; background: none; }
  .${EXPORT_PAGE_CLASS} { max-width: none; }
  .${EXPORT_CONTENT_CLASS} { background: none; }
}
`.trim();

/**
 * Rules that have to come AFTER the chosen stylesheet, because they correct it.
 *
 * Only the vendored Asciidoctor stylesheet needs correcting, and only where the app's own preview makes
 * the same corrections in `asciidoc-preview.css` — which the export does not ship alongside the vendored
 * file, so they would otherwise be lost:
 *
 *   - The vendored stylesheet paints the content `#fff`, a fixed surface meant to sit inside the app's
 *     panel. In a file that leaves a white block on a page painted from the palette; the export makes
 *     the container transparent so both are the one surface.
 *   - It asks for "Droid Sans Mono", which Google Fonts does not publish and which the app substitutes
 *     with Ubuntu Mono. Without this the one monospace family the export actually embeds is the one
 *     family its CSS never names.
 */
const STYLE_CORRECTIONS_CSS = `
.${EXPORT_CONTENT_CLASS}[data-preview-style="asciidoctor"] { background: transparent; }
.${EXPORT_CONTENT_CLASS}[data-preview-style="asciidoctor"] :is(code, kbd, pre, samp) {
  font-family: var(--font-asciidoctor-mono), "Ubuntu Mono", "DejaVu Sans Mono", monospace;
}
`.trim();

/** The document's header metadata, as Asciidoctor resolves it. Every part is optional. */
export interface ExportDocumentDetails {
  /** The author line (`author`/`authors`). */
  readonly author?: string;
  /** The revision number (`revnumber`), rendered with a leading `v`. */
  readonly revnumber?: string;
  /** The revision date (`revdate`). */
  readonly revdate?: string;
}

/** Everything {@link buildStandaloneHtml} needs; all of it already resolved. */
export interface StandaloneHtmlInput {
  /** The converted, sanitized body fragment — exactly what the preview renders. */
  readonly bodyHtml: string;
  /** The document title, used for `<title>`. Falls back to a generic name when blank. */
  readonly title?: string;
  /** The author/revision line, when the document declares one. */
  readonly details?: ExportDocumentDetails;
  /** Which stylesheet to dress the document in. */
  readonly style: HtmlExportStyle;
  /** Which palette to bake in. */
  readonly theme: HtmlExportTheme;
  /** The document language, for the `lang` attribute. */
  readonly lang?: string;
  /** Extra stylesheet text to append (e.g. MathJax's own CHTML rules when the document has maths). */
  readonly extraCss?: string;
  /**
   * Link the stylesheet from this path instead of inlining it.
   *
   * Set for a zip export, whose whole shape is "the document beside the things it needs" — a reader can
   * open `styles.css`, edit it, and see the change. Left unset for a single-file export, where an
   * external stylesheet would defeat the point of the format. The path is relative to the document, so
   * it resolves under `file://` exactly as it does over HTTP.
   */
  readonly stylesheetHref?: string;
}

/** Used when a document declares no title — a file still needs a name in the browser's tab. */
const FALLBACK_TITLE = 'Document';

/** Escape text for use in element content or a double-quoted attribute value. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Guard the inlined stylesheet against a premature `</style>`.
 *
 * CSS cannot contain `</style>` — the parser ends the element at that point regardless of context —
 * so a stylesheet carrying it (via a `content:` string, say) would spill the rest of itself into the
 * document as text. Escaping the slash keeps the CSS valid and the element intact.
 */
function escapeStyleText(css: string): string {
  return css.replaceAll('</style', String.raw`<\/style`);
}

/**
 * The palette rules for a theme: one block, or both under `prefers-color-scheme` for `auto`.
 *
 * The Asciidoctor style is pinned to the light palette whatever was asked for, because the vendored
 * stylesheet IS light — it paints its own fixed white surface and near-black text, on screen and in a
 * file, and the app's preview says so too. Baking the dark palette around it produced the one thing the
 * export must not do: a page whose background disagrees with the text sitting on it.
 */
function paletteCss(theme: HtmlExportTheme, style: HtmlExportStyle): string {
  if (style === 'asciidoctor') return LIGHT_TOKENS_CSS;
  if (theme === 'dark') return DARK_TOKENS_CSS;
  if (theme === 'light') return LIGHT_TOKENS_CSS;
  // `auto`: light is the base so a browser that does not support the query still gets a readable
  // document, with the dark palette layered on only for readers who asked for one.
  return `${LIGHT_TOKENS_CSS}\n@media (prefers-color-scheme: dark) {\n${DARK_TOKENS_CSS}\n}`;
}

/** The stylesheet for a style choice. */
function styleCss(style: HtmlExportStyle): string {
  return style === 'asciidoctor' ? ASCIIDOCTOR_CSS : ASCIIDOCOLLAB_CSS;
}

/**
 * The author/revision line, or an empty string when the document declares none.
 *
 * The preview omits this because the app shows the document's identity in its own chrome; a file has
 * no chrome, so it is restored here rather than left to the reader to infer.
 */
function detailsHtml(details: ExportDocumentDetails | undefined): string {
  if (!details) return '';
  const parts: string[] = [];
  if (details.author) parts.push(escapeHtml(details.author));
  if (details.revnumber) parts.push(escapeHtml(`v${details.revnumber.replace(/^v/i, '')}`));
  if (details.revdate) parts.push(escapeHtml(details.revdate));
  if (parts.length === 0) return '';
  return `<p class="adoc-export-details">${parts.map((part) => `<span>${part}</span>`).join('')}</p>\n`;
}

/**
 * The complete stylesheet for an export, in cascade order.
 *
 * Exported so a zip can write the very same text to its own file: both packagings go through this one
 * function, so "the zip looks like the single file" is structural rather than something to keep in step
 * by hand.
 *
 * The order matters. The palette first, because everything after it reads those tokens. Then the page
 * rules, then the chosen stylesheet, then the corrections that only make sense on top of it, and last
 * whatever the rendered content brought with it (MathJax's CHTML rules, the embedded `@font-face`s).
 *
 * Anything still pointing at a font nobody can reach is stripped at the end. Every path into this
 * function is supposed to have resolved its URLs already; the strip is here so that a path which did not
 * produces an export with missing typography rather than an export that phones home.
 *
 * @param input - The style and theme choice, plus any stylesheet text the content needs.
 * @returns The stylesheet text, ready to inline or write out.
 */
export function composeExportCss(
  input: Pick<StandaloneHtmlInput, 'style' | 'theme' | 'extraCss'>,
): string {
  return stripRemoteFontFaces(
    [
      paletteCss(input.theme, input.style),
      EXPORT_FONT_TOKENS_CSS,
      PAGE_CSS,
      styleCss(input.style),
      STYLE_CORRECTIONS_CSS,
      input.extraCss ?? '',
    ]
      .filter((part) => part.length > 0)
      .join('\n\n'),
  );
}

/**
 * Assemble a complete standalone HTML document around an already-rendered body fragment.
 *
 * The content container carries the preview's own class and `data-preview-style` attribute, so every
 * selector in the inlined stylesheets matches without being rewritten — which is what makes the
 * exported file look like the panel it came from rather than an approximation of it. The page wrapper
 * around it owns the reading column; see {@link EXPORT_PAGE_CLASS}.
 *
 * @param input - The rendered body plus the resolved style, theme and document metadata.
 * @returns The full HTML document, ready to be written to a file.
 */
export function buildStandaloneHtml(input: StandaloneHtmlInput): string {
  const title = input.title?.trim() ?? '';
  const style = escapeHtml(input.style);

  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(input.lang?.trim() || 'en')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title || FALLBACK_TITLE)}</title>`,
    input.stylesheetHref === undefined
      ? `<style>\n${escapeStyleText(composeExportCss(input))}\n</style>`
      : `<link rel="stylesheet" href="${escapeHtml(input.stylesheetHref)}">`,
    '</head>',
    '<body>',
    `<div class="${EXPORT_PAGE_CLASS}" data-preview-style="${style}">`,
    `<div class="${EXPORT_CONTENT_CLASS}" data-preview-style="${style}">`,
    detailsHtml(input.details) + input.bodyHtml,
    '</div>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
