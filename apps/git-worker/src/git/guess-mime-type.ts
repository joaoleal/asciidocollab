import path from 'node:path';

/**
 * Best-effort MIME type by file extension, for a cloned file's `mimeType` field. Deliberately
 * small — only the kinds this platform's own content types (AsciiDoc, theme files, common
 * image/document formats) actually need distinguished. Anything else falls back to a generic
 * binary type, which is always a safe (if uninformative) answer.
 */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  '.adoc': 'text/asciidoc',
  '.asciidoc': 'text/asciidoc',
  '.asc': 'text/asciidoc',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** The MIME type reported for an extension this lookup does not recognize. */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Guesses a file's MIME type from its extension alone (no content sniffing — a clone materializes
 * many files, and this is a best-effort label, not a security boundary).
 *
 * @param filePath - The file's path (only its extension is used).
 * @returns The matched MIME type, or {@link DEFAULT_MIME_TYPE} when the extension is unrecognized.
 */
export function guessMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_TYPES[extension] ?? DEFAULT_MIME_TYPE;
}
