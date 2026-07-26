/**
 * Grammar API client (feature 042): the project dictionary, per-user ignored lints, and project grammar
 * settings. No request or response carries document prose — only accepted terms, privacy-hashed
 * ignored-lint blobs, and settings.
 */
import { apiRequest } from '@/lib/api/transport';
import type {
  DictionaryListDto,
  DictionaryTermDto,
  IgnoredLintsDto,
} from '@asciidocollab/shared';

export const grammarApi = {
  /** Fetch every accepted term for a project (for `importWords` on editor load). */
  async listDictionary(projectId: string): Promise<{ /** The project's dictionary. */ data: DictionaryListDto }> {
    return apiRequest(`/api/projects/${projectId}/dictionary`);
  },

  /** Add a term to the project dictionary (editor/owner only; idempotent on a case-insensitive dup). */
  async addDictionaryTerm(
    projectId: string,
    term: string,
  ): Promise<{ /** The stored term. */ data: DictionaryTermDto }> {
    return apiRequest(`/api/projects/${projectId}/dictionary`, {
      method: 'POST',
      body: JSON.stringify({ term }),
    });
  },

  /** Remove a term from the project dictionary by id (editor/owner only). */
  async removeDictionaryTerm(projectId: string, termId: string): Promise<void> {
    await apiRequest(`/api/projects/${projectId}/dictionary/${termId}`, { method: 'DELETE' });
  },

  /** Fetch the caller's privacy-hashed ignored-lints blob for a document (empty string when none). */
  async getIgnoredLints(documentId: string): Promise<{ /** The caller's ignored-lints blob. */ data: IgnoredLintsDto }> {
    return apiRequest(`/api/documents/${documentId}/ignored-lints`);
  },

  /** Replace the caller's ignored-lints blob for a document (full upsert). */
  async putIgnoredLints(documentId: string, ignoredLintsJson: string): Promise<void> {
    await apiRequest(`/api/documents/${documentId}/ignored-lints`, {
      method: 'PUT',
      body: JSON.stringify({ ignoredLintsJson }),
    });
  },
};
