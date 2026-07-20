/**
 * PDF converter-extension catalogue API client. The catalogue is ASSEMBLED SERVER-SIDE — shipped
 * entries merged with the administrator's folder, stale selections resolved, malformed entries
 * excluded — so this client fetches a finished answer rather than composing one.
 */
import { apiRequest, API_BASE_URL, ApiError } from '@/lib/api/transport';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/shared';

/** Something in the administrator's folder that was excluded, and why. */
export interface PdfExtensionExclusion {
  /** The file or directory it came from. */
  readonly source: string;
  /** Why it was excluded, in terms an administrator can act on. */
  readonly reason: string;
}

/** A duplicate id between the shipped set and the administrator's folder. */
export interface PdfExtensionConflict {
  /** The contested id. */
  readonly id: string;
  /** What the conflict means for the catalogue. */
  readonly reason: string;
}

/** The catalogue as offered to one project. */
export interface PdfExtensionCatalogue {
  /** Every entry on offer, ordered by id. */
  readonly entries: readonly PdfExtensionCatalogueEntry[];
  /** Ids the project has enabled that nothing offers any more. */
  readonly staleSelections: readonly string[];
  /** Administrator entries excluded as malformed or oversized. */
  readonly excluded: readonly PdfExtensionExclusion[];
  /** Duplicate ids between the two sources. */
  readonly conflicts: readonly PdfExtensionConflict[];
}

export const pdfExtensionsApi = {
  /** Fetch the extension catalogue this project may choose from. */
  async get(projectId: string): Promise<{ /** The assembled catalogue. */ data: PdfExtensionCatalogue }> {
    return apiRequest(`/api/projects/${projectId}/pdf-extensions`);
  },

  /**
   * Fetch one extension's Ruby source, for the renderer to load in the browser.
   *
   * Not routed through `apiRequest`, which parses every response as JSON: the endpoint serves the
   * source as `text/plain`, and wrapping it in JSON purely to satisfy the shared helper would double
   * the payload and give the source a second escaping to get wrong.
   *
   * The server decides what this can name. `extensionId` is matched against the catalogue the server
   * assembled for this project and is never turned into a path, so an id nothing offers is a 404
   * rather than a file read.
   *
   * @param projectId - The project whose catalogue the id is resolved against.
   * @param extensionId - The extension whose source to fetch.
   * @returns The Ruby source text.
   */
  async getSource(projectId: string, extensionId: string): Promise<string> {
    const response = await fetch(
      `${API_BASE_URL}/api/projects/${projectId}/pdf-extensions/${encodeURIComponent(extensionId)}/source`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      throw new ApiError(
        response.status,
        'EXTENSION_SOURCE_UNAVAILABLE',
        `The source for extension "${extensionId}" could not be read.`,
      );
    }
    return response.text();
  },
};
