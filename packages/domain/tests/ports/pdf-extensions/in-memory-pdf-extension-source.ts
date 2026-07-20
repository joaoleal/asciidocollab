import type {
  DiscoveredPdfExtension,
  ExcludedPdfExtension,
  PdfExtensionListing,
  PdfExtensionSourcePort,
} from '../../../src/ports/pdf-extensions/pdf-extension-source.port';
import type { PdfExtensionManifest } from '@asciidocollab/asciidoc-core';
import { Result } from '../../../src/types/result';
import { DomainError } from '../../../src/errors/domain-error';
import { ValidationError } from '../../../src/errors/common/validation-error';

/**
 * An in-memory {@link PdfExtensionSourcePort} for testing the use cases above it.
 *
 * It models the two behaviours a real adapter must have and a naive fake would not: an unknown
 * handle is refused rather than looked up, and the listing carries exclusions alongside the
 * extensions so a caller that ignores them fails a test rather than shipping.
 */
export class InMemoryPdfExtensionSource implements PdfExtensionSourcePort {
  private readonly sources = new Map<string, string>();
  private extensions: DiscoveredPdfExtension[] = [];
  private excluded: ExcludedPdfExtension[] = [];
  /** When set, `list` fails with it — for exercising an unreadable folder. */
  private listFailure: DomainError | null = null;

  /** Add an extension the folder offers. */
  add(manifest: PdfExtensionManifest, source = '# ruby'): this {
    const handle = `handle:${manifest.id}`;
    this.extensions.push({ manifest, handle });
    this.sources.set(handle, source);
    return this;
  }

  /** Record something the scan excluded. */
  exclude(source: string, reason: string): this {
    this.excluded.push({ source, reason });
    return this;
  }

  /** Make the next `list` fail, as an unreadable or missing folder would. */
  failList(error: DomainError): this {
    this.listFailure = error;
    return this;
  }

  /** Remove an extension, as an administrator deleting a file would. */
  remove(id: string): this {
    this.extensions = this.extensions.filter((entry) => entry.manifest.id !== id);
    this.sources.delete(`handle:${id}`);
    return this;
  }

  async list(): Promise<Result<PdfExtensionListing, DomainError>> {
    if (this.listFailure !== null) return { success: false, error: this.listFailure };
    return {
      success: true,
      value: { extensions: [...this.extensions], excluded: [...this.excluded] },
    };
  }

  async readSource(handle: string): Promise<Result<string, DomainError>> {
    const source = this.sources.get(handle);
    if (source === undefined) {
      // Refused rather than resolved: a handle a caller invented must never reach a lookup.
      return { success: false, error: new ValidationError(`Unknown extension handle: ${handle}`) };
    }
    return { success: true, value: source };
  }
}
