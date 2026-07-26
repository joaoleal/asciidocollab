/**
 * @file Turns a finished export into the bytes that get downloaded — one HTML file, or a zip holding
 * the document beside its assets.
 *
 * Kept apart from the document assembly so the choice between the two packagings is one small,
 * inspectable decision rather than a branch threaded through the whole export.
 */

import { zipSync, strToU8 } from 'fflate';
import type { HtmlExportPackaging } from '@asciidocollab/shared';
import { exportFileName } from '@/lib/export-file-name';
import type { ExportAsset } from './inline-assets';

/**
 * The stylesheet, as one more thing the zip carries beside the document.
 *
 * Modelled as an asset rather than a special case in the packager: the archive is then just "the
 * document plus its files", and the stylesheet is named, placed and written by exactly the code that
 * already handles images and fonts.
 *
 * @param css - The stylesheet text.
 * @returns The asset to include in a zip export.
 */
export function stylesheetAsset(css: string): ExportAsset {
  return { path: ZIP_STYLESHEET_NAME, bytes: strToU8(css), contentType: 'text/css;charset=utf-8' };
}

/** The document name inside a zip. Fixed, because a browser opens `index.html` without being asked. */
export const ZIP_DOCUMENT_NAME = 'index.html';

/**
 * The stylesheet name inside a zip.
 *
 * A zip export keeps its CSS in a file of its own and links to it, rather than inlining it as the
 * single-file export does. That is the difference between the two formats: one is a document you can
 * forward anywhere, the other is a document you can work with — open the stylesheet, change a colour,
 * reload. It sits next to `index.html` at the archive root so the `href` is a bare file name, which
 * resolves the same under `file://` as it does over HTTP.
 */
export const ZIP_STYLESHEET_NAME = 'styles.css';

/** Content types for the two shapes an export can take. */
const HTML_TYPE = 'text/html;charset=utf-8';
const ZIP_TYPE = 'application/zip';

/** A packaged export: the bytes, the name to save them under, and what they are. */
export interface PackagedExport {
  /** The file's contents, ready to hand to a download. */
  readonly blob: Blob;
  /**
   * The same contents as raw bytes.
   *
   * Carried alongside the blob because a `Blob` is opaque — reading it back is asynchronous and, in a
   * test environment, not always possible at all. Exposing what went in keeps the packaging decision
   * verifiable without depending on the host's Blob implementation.
   */
  readonly bytes: Uint8Array;
  /** The file name to offer, including its extension. */
  readonly fileName: string;
}

/**
 * Package a rendered document for download.
 *
 * A single-file export is the HTML itself; every asset is already embedded in it, so there is nothing
 * else to carry. A zip export writes the document as {@link ZIP_DOCUMENT_NAME} beside its assets at
 * the paths the document already links to, so the archive is self-consistent the moment it is opened.
 *
 * The zip is written UNCOMPRESSED (`level: 0`). Its payload is images that are already compressed
 * formats, so deflating them buys almost nothing and costs a pass over every byte on the main thread.
 * The HTML compresses well, but it is the small part.
 *
 * @param html - The complete standalone document.
 * @param assets - Assets to place beside it; ignored for a single-file export.
 * @param packaging - Which shape to produce.
 * @param projectName - The project's display name, which the download is named after.
 * @returns The packaged bytes and the file name to save them under.
 */
export function packageExport(
  html: string,
  assets: readonly ExportAsset[],
  packaging: HtmlExportPackaging,
  projectName: string,
): PackagedExport {
  if (packaging === 'single-file') {
    const bytes = strToU8(html);
    return {
      blob: new Blob([html], { type: HTML_TYPE }),
      bytes,
      fileName: exportFileName(projectName, 'html'),
    };
  }

  const entries: Record<string, Uint8Array> = { [ZIP_DOCUMENT_NAME]: strToU8(html) };
  for (const asset of assets) {
    entries[asset.path] = asset.bytes;
  }
  const zipped = zipSync(entries, { level: 0 });
  // Copied into a fresh buffer so the Blob part is an unambiguous, non-shared ArrayBuffer.
  const buffer = new ArrayBuffer(zipped.byteLength);
  new Uint8Array(buffer).set(zipped);
  return {
    blob: new Blob([buffer], { type: ZIP_TYPE }),
    bytes: zipped,
    fileName: exportFileName(projectName, 'zip'),
  };
}

/**
 * Hand a packaged export to the browser as a download.
 *
 * The object URL is revoked on the next task rather than immediately: revoking it in the same tick as
 * the synthetic click races the browser's own read of it, and the download silently produces nothing.
 *
 * @param packaged - The bytes and file name to save.
 */
export function downloadExport(packaged: PackagedExport): void {
  const url = URL.createObjectURL(packaged.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = packaged.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
