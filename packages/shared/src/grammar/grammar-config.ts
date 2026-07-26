/**
 * @file The single validation authority for grammar-feature inputs (feature 042): dictionary terms and
 * the enforced English dialect. Both the API boundary and the web layer import these zod schemas, so
 * there is no parallel validation path (contracts/api.md §Validation authority).
 */

import { z } from 'zod';

/** Maximum length of a project-dictionary term. */
export const DICTIONARY_TERM_MAX_LEN = 128;

/**
 * Maximum length of the persisted per-user ignored-lints blob. It is an opaque JSON array of
 * privacy-hashes produced by `exportIgnoredLints()`; 256 KiB is far above any realistic number of
 * dismissed lints for one document, while still bounding per-user storage against a hostile client.
 */
export const IGNORED_LINTS_BLOB_MAX_LEN = 256 * 1024;

/** True when a term contains whitespace or a C0/DEL/C1 control character (checked by code point). */
function hasWhitespaceOrControl(term: string): boolean {
  for (const char of term) {
    const code = char.codePointAt(0) ?? 0;
    // `code <= 0x20` covers space and all C0 control characters (tab, newline, …); 0x7F–0x9F is DEL + C1.
    if (code <= 0x20 || (code >= 0x7F && code <= 0x9F)) return true;
  }
  return false;
}

/**
 * A project-dictionary term (Principle IX — validated at the boundary as inert text): trimmed,
 * non-empty, at most {@link DICTIONARY_TERM_MAX_LEN} characters, and free of whitespace and control
 * characters (a term is a single word/acronym, never a phrase or a line).
 */
export const dictionaryTermSchema = z
  .string()
  .trim()
  .min(1, { message: 'A dictionary term must not be empty.' })
  .max(DICTIONARY_TERM_MAX_LEN, { message: `A dictionary term must be at most ${DICTIONARY_TERM_MAX_LEN} characters.` })
  .refine((term) => !hasWhitespaceOrControl(term), {
    message: 'A dictionary term must not contain whitespace or control characters.',
  });

/** The English dialects grammar checking can enforce (mirrors the web `GrammarDialect`). */
export const grammarDialectSchema = z.enum(['en-GB', 'en-US']);

/** A validated English dialect. */
export type GrammarDialect = z.infer<typeof grammarDialectSchema>;

/** Body of a request to add a term to the project dictionary. */
export const addDictionaryTermSchema = z.object({ term: dictionaryTermSchema }).strict();

/** The privacy-hashed ignored-lints blob a client persists (opaque; harper.js `exportIgnoredLints()`). */
export const ignoredLintsBlobSchema = z
  .object({
    ignoredLintsJson: z
      .string()
      .max(IGNORED_LINTS_BLOB_MAX_LEN, { message: 'The ignored-lints blob is too large.' }),
  })
  .strict();
