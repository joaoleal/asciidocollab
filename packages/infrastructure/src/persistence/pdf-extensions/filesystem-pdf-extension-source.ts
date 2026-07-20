import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ValidationError,
  type DiscoveredPdfExtension,
  type DomainError,
  type ExcludedPdfExtension,
  type PdfExtensionListing,
  type PdfExtensionSourcePort,
  type Result,
} from '@asciidocollab/domain';
import { parsePdfExtensionManifest } from '@asciidocollab/shared';

/**
 * @file Reads the administrator's PDF-extension drop folder.
 *
 * The folder's contents are not under the application's control, so everything here treats them as
 * untrusted input:
 *
 *  - **The scan is bounded.** It stops at `maxExtensions` and skips any source over
 *    `maxSourceBytes`, so the work a catalogue read costs cannot be dictated by what someone drops
 *    into the folder.
 *  - **Handles are opaque and never reconstructed.** `readSource` looks a handle up in the listing it
 *    produced; it never joins a caller-supplied string onto a path. A caller that could build a
 *    handle could name any file on the disk.
 *  - **One bad entry is excluded, not fatal.** A malformed manifest or an oversized source is
 *    reported and skipped, because a single broken file must not deny every project its catalogue.
 *
 * Layout expected in the folder — one directory per extension:
 *
 *     <path>/<extension-id>/manifest.json
 *     <path>/<extension-id>/extension.rb.
 */

/** The bounds and location this adapter operates under, injected from configuration. */
export interface FilesystemPdfExtensionSourceOptions {
  /** Absolute path of the drop folder. */
  readonly path: string;
  /** Maximum extensions to return; the scan stops there and reports the cap was reached. */
  readonly maxExtensions: number;
  /** Maximum bytes of a single source file; a larger one is excluded and reported. */
  readonly maxSourceBytes: number;
  /** How long a scan is reused, in milliseconds. */
  readonly scanCacheTtl: number;
  /** Clock source, injectable so the cache is testable without waiting. */
  readonly now?: () => number;
}

/** The manifest file each extension directory must contain. */
const MANIFEST_FILE = 'manifest.json';
/** The Ruby source file each extension directory must contain. */
const SOURCE_FILE = 'extension.rb';

/** A cached scan and the moment it was taken. */
interface CachedScan {
  readonly listing: PdfExtensionListing;
  readonly sourcePaths: ReadonlyMap<string, string>;
  readonly takenAt: number;
}

/** Filesystem-backed {@link PdfExtensionSourcePort} over the administrator drop folder. */
export class FilesystemPdfExtensionSource implements PdfExtensionSourcePort {
  private cache: CachedScan | null = null;
  private readonly now: () => number;

  /** Creates the adapter over a configured folder and its bounds. */
  constructor(private readonly options: FilesystemPdfExtensionSourceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** List the extensions the folder offers, reusing a recent scan when one is still valid. */
  async list(): Promise<Result<PdfExtensionListing, DomainError>> {
    const cached = this.cache;
    if (cached !== null && this.now() - cached.takenAt < this.options.scanCacheTtl) {
      return { success: true, value: cached.listing };
    }
    const scan = await this.scan();
    if (!scan.success) return scan;
    this.cache = { ...scan.value, takenAt: this.now() };
    return { success: true, value: scan.value.listing };
  }

  /** Read one extension's Ruby source, by a handle this adapter previously issued. */
  async readSource(handle: string): Promise<Result<string, DomainError>> {
    // Ensure a scan has happened, so a first call for a source resolves rather than 404ing.
    if (this.cache === null) {
      const listed = await this.list();
      if (!listed.success) return listed;
    }
    // The handle is LOOKED UP, never joined onto a path. This is what stops a caller-supplied string
    // naming a file the adapter never offered.
    const sourcePath = this.cache?.sourcePaths.get(handle);
    if (sourcePath === undefined) {
      return { success: false, error: new ValidationError(`Unknown extension handle: ${handle}`) };
    }
    try {
      return { success: true, value: await readFile(sourcePath, 'utf8') };
    } catch {
      return { success: false, error: new ValidationError(`Extension source could not be read: ${handle}`) };
    }
  }

  /** Walk the folder once, applying every bound and collecting exclusions. */
  private async scan(): Promise<
    Result<{ listing: PdfExtensionListing; sourcePaths: Map<string, string> }, DomainError>
  > {
    let entries: string[];
    try {
      const found = await readdir(this.options.path, { withFileTypes: true });
      entries = found.filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
    } catch {
      // A missing folder is the normal case for a deployment that provides no extensions — an empty
      // catalogue, not an error. Only the shipped set is offered.
      return { success: true, value: { listing: { extensions: [], excluded: [] }, sourcePaths: new Map() } };
    }

    const extensions: DiscoveredPdfExtension[] = [];
    const excluded: ExcludedPdfExtension[] = [];
    const sourcePaths = new Map<string, string>();

    for (const directory of entries) {
      if (extensions.length >= this.options.maxExtensions) {
        excluded.push({
          source: directory,
          reason: `Not read: the configured maximum of ${this.options.maxExtensions} extensions was reached.`,
        });
        continue;
      }

      const base = path.join(this.options.path, directory);
      const manifestPath = path.join(base, MANIFEST_FILE);
      const sourcePath = path.join(base, SOURCE_FILE);

      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        excluded.push({ source: directory, reason: `${MANIFEST_FILE} is missing or is not valid JSON.` });
        continue;
      }

      const parsed = parsePdfExtensionManifest(raw);
      if (!parsed.ok) {
        excluded.push({ source: directory, reason: parsed.reason });
        continue;
      }

      let sourceBytes: number;
      try {
        const sourceStat = await stat(sourcePath);
        sourceBytes = sourceStat.size;
      } catch {
        excluded.push({ source: directory, reason: `${SOURCE_FILE} is missing.` });
        continue;
      }
      if (sourceBytes > this.options.maxSourceBytes) {
        excluded.push({
          source: directory,
          reason: `${SOURCE_FILE} is ${sourceBytes} bytes, over the ${this.options.maxSourceBytes}-byte limit.`,
        });
        continue;
      }

      const handle = `${directory}:${parsed.manifest.id}`;
      extensions.push({ manifest: parsed.manifest, handle });
      sourcePaths.set(handle, sourcePath);
    }

    return { success: true, value: { listing: { extensions, excluded }, sourcePaths } };
  }
}
