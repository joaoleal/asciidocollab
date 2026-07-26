/**
 * @file The `@font-face` side of an export: which faces travel with the document, and what their
 * `src` points at once the file is no longer on the app's origin.
 *
 * Every webfont the app uses is served from the app itself — `next/font` writes the files under
 * `/_next/static/media/…` and MathJax resolves its CHTML fonts against its own bundle URL. Those URLs
 * are ABSOLUTE by the time they reach a stylesheet (`http://localhost:3000/vendor/mathjax/…`), so an
 * export that copies the CSS verbatim ships a document whose typography only works for a reader
 * sitting in front of the dev server that produced it. This module is the one place that guarantees
 * otherwise: every `url()` inside an `@font-face` is either resolved into the export (a `data:` URI or
 * a file in the zip) or the whole face is dropped. Nothing in between reaches the output.
 *
 * The parsing is pure string work, deliberately kept apart from the fetching and from the DOM read
 * that discovers the app's own faces (see `app-fonts.ts`), so the fiddly parts — which faces are
 * worth their bytes, what a rewritten block looks like — are testable without a network or a browser.
 */

import {
  assetPath,
  sourceLeaf,
  toDataUri,
  type AssetFailure,
  type AssetFetcher,
  type ExportAsset,
} from './inline-assets';

/** One `@font-face` rule, as found in a stylesheet. */
export interface FontFaceBlock {
  /** The whole rule, verbatim, including the `@font-face` keyword and braces. */
  readonly text: string;
  /** The declared family, unquoted and trimmed; empty when the rule declares none. */
  readonly family: string;
  /** The declared `unicode-range`, or undefined when the face covers everything. */
  readonly unicodeRange?: string;
  /** Every `url()` value in the rule, in order, exactly as written. */
  readonly urls: readonly string[];
}

/**
 * The keyword that opens a font-face rule. Found by plain string scanning rather than by a pattern: a
 * rule is "the keyword, anything up to the next brace, then the block", and a pattern for that needs two
 * unbounded quantifiers in a row — exactly the shape a ReDoS check rejects.
 */
const FONT_FACE_KEYWORD = '@font-face';
/** The `font-family` declaration inside one rule. */
const FAMILY_DECLARATION = /font-family\s*:\s*([^;}]+)/i;
/** The `unicode-range` declaration inside one rule. */
const UNICODE_RANGE_DECLARATION = /unicode-range\s*:\s*([^;}]+)/i;
/**
 * One `url()` value, quoted or bare.
 *
 * A single unbounded quantifier, with the quotes (if any) stripped afterwards by {@link unquote}. The
 * obvious alternation over the three quoting styles is a third-degree polynomial, and a CSS URL cannot
 * contain an unescaped parenthesis anyway — including inside the `data:` URIs this module writes, whose
 * base64 alphabet has none.
 */
const URL_VALUE = /url\(([^()]*)\)/gi;

/** The codepoint a face must cover to count as the document's main Latin face: `A`. */
const BASIC_LATIN_PROBE = 0x41;

/** Font MIME types → the extension a file in the zip should carry. */
const FONT_EXTENSION_BY_TYPE: Record<string, string> = {
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
};

/** Strip one layer of matching quotes from a CSS value. */
export function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length > 1) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Every `@font-face` rule in a stylesheet, in source order.
 *
 * @param css - The stylesheet text to scan.
 * @returns The parsed rules; an empty array when the stylesheet declares no faces.
 */
export function parseFontFaces(css: string): FontFaceBlock[] {
  const blocks: FontFaceBlock[] = [];
  const lower = css.toLowerCase();
  for (let at = lower.indexOf(FONT_FACE_KEYWORD); at !== -1; at = lower.indexOf(FONT_FACE_KEYWORD, at + 1)) {
    const open = css.indexOf('{', at);
    const close = open === -1 ? -1 : css.indexOf('}', open);
    // An unterminated rule is the end of anything useful in this stylesheet.
    if (close === -1) break;
    // Anything between the keyword and the brace belongs to the rule: MathJax numbers its faces with a
    // comment there (`@font-face /* 3 */ { … }`), and dropping that would corrupt the text a rewrite
    // has to find again.
    const text = css.slice(at, close + 1);
    const family = unquote(FAMILY_DECLARATION.exec(text)?.[1] ?? '');
    const unicodeRange = UNICODE_RANGE_DECLARATION.exec(text)?.[1]?.trim();
    const urls = [...text.matchAll(URL_VALUE)]
      .map((match) => unquote(match[1] ?? ''))
      .filter((url) => url.length > 0);
    blocks.push({ text, family, urls, ...(unicodeRange === undefined ? {} : { unicodeRange }) });
    at = close;
  }
  return blocks;
}

/**
 * Whether a `unicode-range` includes the letter `A`, which is to say whether this is the face that
 * renders ordinary Latin prose.
 *
 * `next/font` splits a Google family into one face per subset (Cyrillic, Greek, Vietnamese, Latin
 * Extended…), and the extended-Latin faces alone are larger than everything else put together —
 * 182 KB for Noto Serif against 36 KB for basic Latin. An export embeds the basic-Latin face only;
 * a character outside it falls back, per glyph, to whatever the reader has, which is what the
 * stylesheet's own fallback chain is for. Probing with `A` rather than U+0000 is deliberate: some
 * subsets cover the control range (`U+1-C`) without covering a single letter.
 *
 * @param unicodeRange - The declared range, or undefined for a face that covers everything.
 * @returns True when the face covers basic Latin.
 */
export function coversBasicLatin(unicodeRange: string | undefined): boolean {
  if (unicodeRange === undefined || unicodeRange.trim().length === 0) return true;
  for (const token of unicodeRange.split(',')) {
    const range = parseCodepointRange(token.trim());
    if (range && BASIC_LATIN_PROBE >= range[0] && BASIC_LATIN_PROBE <= range[1]) return true;
  }
  return false;
}

/** Parse one `unicode-range` token (`U+41`, `U+0-FF`, `U+2??`) into inclusive bounds. */
function parseCodepointRange(token: string): [number, number] | null {
  const body = token.replace(/^u\+/i, '');
  if (!/^[\da-f?]{1,6}(-[\da-f]{1,6})?$/i.test(body)) return null;
  const [start, end] = body.split('-');
  if (start.includes('?')) {
    // Wildcard form: `U+2??` means U+200 through U+2FF.
    return [Number.parseInt(start.replaceAll('?', '0'), 16), Number.parseInt(start.replaceAll('?', 'F'), 16)];
  }
  const from = Number.parseInt(start, 16);
  return [from, end === undefined ? from : Number.parseInt(end, 16)];
}

/**
 * Keep only the `@font-face` rules a predicate accepts, leaving every other rule in the stylesheet
 * untouched.
 *
 * Used to drop faces an export has no reason to carry — a family the document never renders in, or a
 * subset outside basic Latin. Dropping the RULE, not just the file, is what keeps the promise that no
 * unresolved URL survives.
 *
 * @param css - The stylesheet text.
 * @param keep - Decides one rule's fate.
 * @returns The stylesheet with the rejected rules removed.
 */
export function filterFontFaces(css: string, keep: (block: FontFaceBlock) => boolean): string {
  const blocks = parseFontFaces(css);
  let result = css;
  for (const block of blocks) {
    if (!keep(block)) result = result.replace(block.text, '');
  }
  return result;
}

/**
 * Replace the `url()` values inside one `@font-face` rule.
 *
 * Only the rule's own URLs are touched, and the rest of the declaration — weight, style,
 * `unicode-range`, the `format()` hint next to each `src` — is preserved verbatim, because the
 * browser needs all of it to match the face it now has locally.
 *
 * @param block - The rule to rewrite.
 * @param replace - Maps one original URL to its replacement, or null to leave it alone.
 * @returns The rewritten rule text.
 */
export function rewriteFontFaceUrls(
  block: FontFaceBlock,
  replace: (url: string) => string | null,
): string {
  return block.text.replaceAll(URL_VALUE, (whole, value: string) => {
    const replacement = replace(unquote(value ?? ''));
    return replacement === null ? whole : `url("${replacement}")`;
  });
}

/**
 * A key identifying the FACE a rule declares, ignoring where its file lives.
 *
 * Two declarations of the same family, weight, style and range are the same face however they are
 * spelled, and a dev server hands out the same font under a different hashed name in each chunk it
 * serves. Deduplicating on the rule text alone would then embed the file twice — 47 KB of Inter turning
 * into 95 KB for no reason at all.
 *
 * @param block - The rule to identify.
 * @returns A normalised key for its descriptors.
 */
export function fontFaceDescriptor(block: FontFaceBlock): string {
  const open = block.text.indexOf('{');
  const body = block.text.slice(open + 1, block.text.lastIndexOf('}')).replaceAll(URL_VALUE, 'url()');
  return body
    .split(';')
    .map((declaration) => declaration.trim().replaceAll(/\s+/g, ' ').toLowerCase())
    .filter((declaration) => declaration.length > 0 && !declaration.startsWith('src'))
    .toSorted()
    .join(';');
}

/** Whether a `url()` value is already self-contained and needs no resolution. */
function isEmbedded(url: string): boolean {
  return url.startsWith('data:');
}

/** The outcome of resolving a stylesheet's font files. */
export interface ResolvedFontFaces {
  /** The stylesheet with every surviving face pointing at something the export carries. */
  readonly css: string;
  /** Font files to place beside the document; empty for a single-file export. */
  readonly assets: readonly ExportAsset[];
  /** Faces that had to be dropped because a file could not be retrieved. */
  readonly failures: readonly AssetFailure[];
}

/**
 * Resolve every `@font-face` file in a stylesheet, and drop any face whose file could not be had.
 *
 * A face that keeps a URL nobody can reach is worse than no face at all: the reader waits for a
 * request that fails and then sees the fallback anyway, and the file betrays where it was made. So a
 * failed fetch removes the whole rule — the text still renders, in the next family of the stack.
 *
 * @param css - The stylesheet text, with URLs already absolute or document-relative to the app.
 * @param fetchFont - How to retrieve one font file.
 * @param packaging - `single-file` embeds each file; `zip` writes it out and links relatively.
 * @returns The rewritten stylesheet, any files to place beside it, and the faces that were dropped.
 */
export async function resolveFontFaces(
  css: string,
  fetchFont: AssetFetcher,
  packaging: 'single-file' | 'zip',
): Promise<ResolvedFontFaces> {
  const blocks = parseFontFaces(css);
  const sources = [...new Set(blocks.flatMap((block) => block.urls).filter((url) => !isEmbedded(url)))];
  if (sources.length === 0) return { css, assets: [], failures: [] };

  // Concurrently: a family is several files, and a serial pass would add a round trip each.
  const fetched = await Promise.all(
    sources.map(async (source) => {
      try {
        return { source, result: await fetchFont(source) };
      } catch (error) {
        return { source, result: null, error };
      }
    }),
  );

  const replacements = new Map<string, string>();
  const assets: ExportAsset[] = [];
  const failures: AssetFailure[] = [];
  for (const [index, entry] of fetched.entries()) {
    if (entry.result === null) {
      failures.push({
        source: entry.source,
        reason: entry.error instanceof Error ? entry.error.message : 'could not be retrieved',
      });
      continue;
    }
    const { bytes, contentType } = entry.result;
    if (packaging === 'zip') {
      const path = fontFileName(entry.source, index, contentType);
      assets.push({ path, bytes, contentType });
      replacements.set(entry.source, path);
    } else {
      replacements.set(entry.source, toDataUri(bytes, contentType));
    }
  }

  let result = css;
  for (const block of blocks) {
    const unresolved = block.urls.some((url) => !isEmbedded(url) && !replacements.has(url));
    const rewritten = unresolved ? '' : rewriteFontFaceUrls(block, (url) => replacements.get(url) ?? null);
    // A replacer function, not a string: a `data:` payload is arbitrary text and `$&` in a replacement
    // string would be read as a back-reference.
    result = result.replace(block.text, () => rewritten);
  }
  return { css: result, assets, failures };
}

/**
 * The in-zip path for one font file.
 *
 * @param source - The URL it came from, used for its leaf name and extension hint.
 * @param index - The file's position, making the name unique.
 * @param contentType - The type the server declared, when it is a font type.
 * @returns A path relative to the document, inside the fonts folder.
 */
export function fontFileName(source: string, index: number, contentType: string): string {
  const fromSource = sourceLeaf(source).extension;
  const extension =
    FONT_EXTENSION_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] ??
    (/^(woff2|woff|ttf|otf)$/.test(fromSource) ? fromSource : 'woff2');
  return assetPath('fonts', source, index, extension, 'font');
}

/**
 * Remove any `@font-face` rule still pointing somewhere a saved file cannot reach.
 *
 * The last line of defence, applied to the whole stylesheet an export emits. Everything upstream is
 * supposed to have resolved or dropped these already; this makes "no absolute URL in the output" a
 * property of the document rather than a property of every path through the pipeline. `data:` and
 * plain relative paths (a file the zip carries) are kept; anything with a scheme or a leading `/` is
 * not, because in a saved file it resolves against the reader's filesystem or a host that is none of
 * their business.
 *
 * @param css - The stylesheet text about to be emitted.
 * @returns The stylesheet with unreachable faces removed.
 */
export function stripRemoteFontFaces(css: string): string {
  return filterFontFaces(css, (block) =>
    block.urls.every((url) => isEmbedded(url) || isDocumentRelative(url)),
  );
}

/** Whether a URL resolves against the exported document itself rather than a host or a root. */
function isDocumentRelative(url: string): boolean {
  return !/^([a-z][\w+.-]*:|\/)/i.test(url);
}
