/**
 * @file Turns the preview's image references into something an exported file can actually show.
 *
 * In the app, `<img src>` points at the project's authenticated asset endpoint — which is exactly
 * right on screen and useless in a file: a recipient without a session gets a 401, and even the author
 * gets nothing offline. So every referenced image is fetched once and then either embedded as a
 * `data:` URI (single-file export) or written beside the document (zip export).
 *
 * The scanning and rewriting are pure string operations kept separate from the fetching, so the
 * fiddly parts — which URLs count, how a rewrite avoids corrupting neighbouring markup — are testable
 * without a network or a DOM.
 */

/** A binary asset pulled in for an export. */
export interface ExportAsset {
  /** The path the asset is written to inside a zip, relative to the document. */
  readonly path: string;
  /** The raw bytes. */
  readonly bytes: Uint8Array;
  /** The MIME type, used for the `data:` URI and for the file's own identity. */
  readonly contentType: string;
}

/** A source that could not be fetched, kept so the export can tell the user rather than fail silently. */
export interface AssetFailure {
  /** The `src` value as it appeared in the document. */
  readonly source: string;
  /** Why it could not be retrieved. */
  readonly reason: string;
}

/** Fetches one image by its `src`, or returns null when it cannot be retrieved. */
export type AssetFetcher = (source: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

/**
 * `src` values that are already self-contained or point somewhere deliberate.
 *
 * `data:` is already embedded. `http(s)://` and protocol-relative URLs are the author's explicit
 * choice to reference something on the web, and rewriting them would change what the document means —
 * an export is not the place to decide a remote image should become a local copy.
 */
const SELF_CONTAINED = /^(data:|https?:\/\/|\/\/)/i;

/**
 * Matches a whole `<img>` tag. One greedy character class, no nested quantifier, and `<` excluded as
 * well as `>` — so a scan can never run past the start of the next tag and re-examine it. A lazy
 * `[^>]*?` before an inner match backtracks polynomially on long attribute lists instead, which is the
 * shape a ReDoS check rejects.
 */
const IMG_TAG = /<img\b[^<>]*>/gi;

/** Matches the `src` attribute inside one tag, capturing the quote style so it can be preserved. */
const SRC_ATTRIBUTE = /(\bsrc=)(["'])([^"']*)\2/i;

/**
 * Marks an `<img>` the export wrote itself, pointing at a file it is already carrying.
 *
 * Such a `src` is a path inside the archive, not something the project's asset endpoint has ever heard
 * of. Fetching it would fail and be reported as a missing image the author never referenced, so the
 * scan below skips it. Set by the diagram extraction (see `diagram-assets`), which is the only pass
 * that adds images of its own.
 */
export const EXPORT_ASSET_ATTRIBUTE = 'data-export-asset';

/** Matches the marker attribute in a tag, whatever else the tag carries. */
const EXPORT_ASSET_PRESENT = new RegExp(String.raw`\b${EXPORT_ASSET_ATTRIBUTE}\b`, 'i');

/** File extension → MIME type, for naming assets written into a zip. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

/**
 * Every distinct image source in the document that an export has to resolve itself, in document order.
 *
 * Already-embedded and remote sources are skipped — see {@link SELF_CONTAINED}. Duplicates are
 * collapsed so an image used five times is fetched once.
 *
 * @param html - The rendered document body.
 * @returns The distinct sources needing resolution.
 */
export function collectImageSources(html: string): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const [tag] of html.matchAll(IMG_TAG)) {
    if (EXPORT_ASSET_PRESENT.test(tag)) continue;
    const source = SRC_ATTRIBUTE.exec(tag)?.[3];
    if (source === undefined || source.length === 0) continue;
    if (SELF_CONTAINED.test(source) || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

/**
 * Replace image sources using `replacements`, leaving any source without an entry untouched.
 *
 * Sources that could not be fetched are deliberately left pointing where they pointed: a broken image
 * the reader can investigate beats a silently removed one they never learn was there.
 *
 * @param html - The rendered document body.
 * @param replacements - Original `src` → replacement value.
 * @returns The document with the replaced sources.
 */
export function rewriteImageSources(html: string, replacements: ReadonlyMap<string, string>): string {
  return html.replaceAll(IMG_TAG, (tag) =>
    tag.replace(SRC_ATTRIBUTE, (attribute, prefix: string, quote: string, source: string) => {
      const replacement = replacements.get(source);
      return replacement === undefined ? attribute : `${prefix}${quote}${replacement}${quote}`;
    }),
  );
}

/** Encode bytes as a base64 `data:` URI. */
export function toDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  // Chunked so a large image cannot blow the argument limit of a spread call.
  const CHUNK = 8192;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + CHUNK));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

/**
 * A stable, collision-free file name for an asset inside a zip.
 *
 * The document's own path structure is deliberately NOT reproduced: sources can be absolute, contain
 * `..`, or repeat a leaf name across folders, and a zip that mirrored them could write outside its own
 * directory. An index prefix keeps names unique without having to reason about any of that.
 *
 * @param source - The original source value, used only for its extension hint.
 * @param index - The asset's position, making the name unique.
 * @param contentType - The resolved MIME type, the authority on the extension.
 * @returns A path relative to the document, inside the assets folder.
 */
export function assetFileName(source: string, index: number, contentType: string): string {
  const fromSource = sourceLeaf(source).extension;
  const extension =
    EXTENSION_BY_TYPE[splitBefore(contentType, ';').trim().toLowerCase()] ??
    (isPlainExtension(fromSource) ? fromSource : 'bin');

  return assetPath('assets', source, index, extension, 'image');
}

/**
 * The leaf name of a URL or path, split into its stem and its extension.
 *
 * Plain string scanning rather than a pattern: the inputs are arbitrary URLs, and the lazy,
 * alternation-terminated patterns this used to need are exactly the shape a ReDoS check rejects.
 *
 * @param source - The URL or path to read.
 * @returns The leaf's stem and its lower-cased extension (empty when it has none).
 */
export function sourceLeaf(source: string): { stem: string; extension: string } {
  const withoutQuery = splitBefore(splitBefore(source, '?'), '#');
  const leaf = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\')) + 1);
  const dot = leaf.lastIndexOf('.');
  return {
    stem: dot > 0 ? leaf.slice(0, dot) : leaf,
    extension: dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '',
  };
}

/**
 * Build the in-zip path for one asset: `<folder>/<index>-<safe stem>.<extension>`.
 *
 * Shared by every kind of asset an export carries (images, fonts) so they all get the same
 * collision-free naming, and so the reasoning above about not mirroring source paths is stated once.
 *
 * @param folder - The zip folder to place it in, without a trailing slash.
 * @param source - The original URL or path, used only for its leaf name.
 * @param index - The asset's position within its folder, making the name unique.
 * @param extension - The extension to give it, without a dot.
 * @param fallbackStem - The stem to use when nothing usable survives sanitisation.
 * @returns A path relative to the document.
 */
export function assetPath(
  folder: string,
  source: string,
  index: number,
  extension: string,
  fallbackStem: string,
): string {
  const safeStem =
    trimDashes(sourceLeaf(source).stem.replaceAll(/[^\w.-]+/g, '-')).slice(0, 40) || fallbackStem;
  return `${folder}/${String(index + 1).padStart(3, '0')}-${safeStem}.${extension}`;
}

/** The part of `value` before the first `separator`, or all of it when absent. */
function splitBefore(value: string, separator: string): string {
  const at = value.indexOf(separator);
  return at === -1 ? value : value.slice(0, at);
}

/** Whether a source-derived extension is a plausible one (short and alphanumeric). */
function isPlainExtension(value: string): boolean {
  return value.length > 0 && value.length <= 5 && /^[a-z0-9]+$/.test(value);
}

/** Strip leading and trailing dashes without an alternation of unbounded quantifiers. */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

/** The outcome of resolving a document's images. */
export interface ResolvedAssets {
  /** The document with its image sources rewritten. */
  readonly html: string;
  /** The fetched assets, empty for a single-file export (they are embedded in `html` instead). */
  readonly assets: readonly ExportAsset[];
  /** Sources that could not be retrieved; their references are left as they were. */
  readonly failures: readonly AssetFailure[];
}

/**
 * Fetch every resolvable image and either embed it or collect it beside the document.
 *
 * Fetches run concurrently — an image-heavy document would otherwise take as long as the sum of its
 * requests — and one failure never aborts the export: it is recorded and the reference left alone.
 *
 * @param html - The rendered document body.
 * @param fetchAsset - How to retrieve one source's bytes.
 * @param packaging - `single-file` embeds each asset; `zip` writes them out and links relatively.
 * @returns The rewritten document, any collected assets, and the sources that failed.
 */
export async function resolveImageAssets(
  html: string,
  fetchAsset: AssetFetcher,
  packaging: 'single-file' | 'zip',
): Promise<ResolvedAssets> {
  const sources = collectImageSources(html);
  const fetched = await Promise.all(
    sources.map(async (source) => {
      try {
        return { source, result: await fetchAsset(source) };
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
      const path = assetFileName(entry.source, index, contentType);
      assets.push({ path, bytes, contentType });
      replacements.set(entry.source, path);
    } else {
      replacements.set(entry.source, toDataUri(bytes, contentType));
    }
  }

  return { html: rewriteImageSources(html, replacements), assets, failures };
}
