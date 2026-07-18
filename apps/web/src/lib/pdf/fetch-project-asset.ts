import { API_BASE_URL } from '@/lib/api/base-url';
/**
 * Fetch a project binary asset's bytes for the in-browser PDF pipeline. The HTML preview loads images
 * over HTTP from the API's per-path image endpoint; the offline PDF engine cannot, so its bytes are
 * fetched here (same origin, same session credentials) and mounted into the render VFS instead.
 *
 * Only assets the document already references (project-relative paths produced by the sandbox guard)
 * are ever passed in, so this never reaches an arbitrary remote URL — the no-egress invariant holds.
 */

/** Base URL of the Fastify backend, configurable via NEXT_PUBLIC_API_URL. */

/**
 * Raster image formats that are re-encoded to a clean, embeddable image before mounting. Limited to the
 * raster formats the PDF engine can embed at all (its image-guard accepts only `png`/`jpg`/`jpeg`/`svg`),
 * so normalising a `webp` would be wasted work — the guard drops it regardless. SVG (vector) is
 * excluded — prawn-svg embeds it as-is — as are fonts and bibliographies, which flow through the same
 * fetch and must never be run through an image decoder.
 */
const RASTER_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);

/** The `jpg`/`jpeg` extensions, re-encoded to baseline JPEG (never PNG — see {@link normalizeRasterImage}). */
const JPEG_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg']);

/** The lowercase file extension of a project-relative path, or `''` when it has none. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Re-encode a fetched raster image to a clean, baseline variant the offline PDF engine can always embed.
 *
 * Asciidoctor-PDF/prawn only embeds a narrow set of PNG/JPEG variants: interlaced, 16-bit, and some
 * palette/transparency PNGs — exactly what OS screenshot tools often produce — make it fail with
 * "could not embed image", rendering the alt-text placeholder instead. The browser can decode all of
 * those, so we round-trip the bytes through `createImageBitmap` + a canvas to normalise them.
 *
 * A JPEG is re-encoded back to a baseline JPEG (NOT PNG): a photographic image balloons several-fold as
 * PNG, which both bloats the PDF and can push a large photo past the pipeline's image-size guard so it
 * is dropped entirely — a regression the format-preserving round-trip avoids. PNG (and the other
 * lossless raster inputs) re-encode to a plain 8-bit PNG. `imageOrientation: 'none'` keeps the decoded
 * pixels in file order, matching prawn (which ignores EXIF orientation), so a photo never rotates.
 *
 * Only raster images are touched; SVG and non-image assets are returned unchanged. Any failure (an
 * undecodable image, or an environment without canvas — e.g. SSR/tests) falls back to the original
 * bytes, so this can never make an asset worse than not normalising it.
 */
async function normalizeRasterImage(bytes: Uint8Array, path: string): Promise<Uint8Array> {
  const extension = extensionOf(path);
  if (!RASTER_IMAGE_EXTENSIONS.has(extension)) return bytes;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return bytes;
  const isJpeg = JPEG_EXTENSIONS.has(extension);
  try {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]), { imageOrientation: 'none' });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (context === null) return bytes;
      context.drawImage(bitmap, 0, 0);
      const encoded = await canvas.convertToBlob(
        isJpeg ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' },
      );
      return new Uint8Array(await encoded.arrayBuffer());
    } finally {
      bitmap.close();
    }
  } catch {
    return bytes;
  }
}

/**
 * Build the API URL that serves a project asset by its project-relative path. Each path segment is
 * percent-encoded independently (preserving the `/` separators) so a path with spaces or other reserved
 * characters — e.g. `New Folder/Screenshot.png` — round-trips through the endpoint's per-segment decode.
 *
 * @param projectId - The project the asset belongs to.
 * @param path - The project-relative asset path (as the render engine resolves it).
 * @returns The absolute image-endpoint URL for the asset.
 */
export function projectAssetUrl(projectId: string, path: string): string {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${API_BASE_URL}/projects/${projectId}/images/${encoded}`;
}

/**
 * Fetch an asset's raw bytes. A missing/forbidden asset (any non-OK response) or a network failure is
 * WARNED and resolved as `null` rather than thrown, so one unavailable image can never break the whole
 * export/preview — the render pipeline then falls back to its not-found placeholder for just that image.
 *
 * @param projectId - The project the asset belongs to.
 * @param path - The project-relative asset path to fetch.
 * @returns The asset bytes, or `null` when it could not be fetched.
 */
export async function fetchProjectAsset(projectId: string, path: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(projectAssetUrl(projectId, path), { credentials: 'include' });
    if (!response.ok) {
      // eslint-disable-next-line no-console -- a skipped asset must surface, never abort the render.
      console.warn(`PDF asset "${path}" could not be fetched (${response.status}); skipping.`);
      return null;
    }
    const buffer = await response.arrayBuffer();
    return await normalizeRasterImage(new Uint8Array(buffer), path);
  } catch (error) {
    // eslint-disable-next-line no-console -- a skipped asset must surface, never abort the render.
    console.warn(`PDF asset "${path}" fetch failed; skipping.`, error);
    return null;
  }
}
