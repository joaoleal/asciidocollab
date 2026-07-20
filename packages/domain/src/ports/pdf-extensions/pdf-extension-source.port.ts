import { Result } from '../../types/result';
import { DomainError } from '../../errors/domain-error';
import type { PdfExtensionManifest } from '@asciidocollab/asciidoc-core';

/**
 * @file The ONLY route to the administrator's PDF-extension drop folder.
 *
 * That folder is a filesystem location outside the application image, whose contents an
 * administrator controls and the application does not. Reading it from anywhere else — a route, a
 * use case, the renderer — would mean each caller re-deciding the bounds on how much work an
 * outside party can cause, and re-deciding what happens to a malformed file. So it is a port with
 * exactly one adapter, and the Data Access Rules make this the only door.
 *
 * The bounds are part of the CONTRACT, not the adapter's private business: an implementation MUST
 * enforce a cap on how many extensions it returns and how large a single source may be, and MUST
 * report — never silently drop — anything it excluded. That is what makes a scan bounded work
 * rather than work an administrator's folder contents can dictate.
 */

/** One extension found in the drop folder: its manifest, and where it was read from. */
export interface DiscoveredPdfExtension {
  /** The validated manifest the extension declares. */
  readonly manifest: PdfExtensionManifest;
  /**
   * An opaque handle the adapter uses to read this extension's source again.
   *
   * Opaque on purpose: callers must not construct or manipulate it, because a caller that could
   * build a handle could name a file the adapter never offered.
   */
  readonly handle: string;
}

/** Something in the folder that was excluded, and why — surfaced rather than hidden. */
export interface ExcludedPdfExtension {
  /** The file or directory it came from, for an administrator to act on. */
  readonly source: string;
  /** Why it was excluded: malformed manifest, oversized source, or a cap being reached. */
  readonly reason: string;
}

/** The result of scanning the drop folder. */
export interface PdfExtensionListing {
  /** Every extension the folder offers, within the configured caps. */
  readonly extensions: readonly DiscoveredPdfExtension[];
  /** Everything excluded, with a reason. Never empty silently. */
  readonly excluded: readonly ExcludedPdfExtension[];
}

/** Reads administrator-provided PDF converter extensions. The only route to that folder. */
export interface PdfExtensionSourcePort {
  /**
   * List the extensions the administrator has provided.
   *
   * Implementations MUST honour the configured scan-cache interval so repeated catalogue reads do
   * not rescan the filesystem, MUST stop at the configured maximum, and MUST report what they
   * excluded.
   *
   * @returns The listing, or a domain error when the folder cannot be read at all.
   */
  list(): Promise<Result<PdfExtensionListing, DomainError>>;

  /**
   * Read one extension's Ruby source.
   *
   * The handle comes from a prior {@link list}; an unknown handle is an error rather than a
   * filesystem lookup, so nothing a caller invents can name a file.
   *
   * @param handle - The opaque handle from {@link DiscoveredPdfExtension}.
   * @returns The source text, or a domain error when the handle is unknown or unreadable.
   */
  readSource(handle: string): Promise<Result<string, DomainError>>;
}
