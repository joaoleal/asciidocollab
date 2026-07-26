/**
 * @file Wire DTOs for the grammar feature (feature 042). None carries document prose — only accepted
 * terms and privacy-hashed ignored-lint blobs (contracts/api.md). The project's grammar settings are
 * not here: they are stored on, and travel with, the project render configuration.
 */

/** A single stored project-dictionary term as returned by the API. */
export interface DictionaryTermDto {
  /** The term's id. */
  id: string;
  /** The accepted word or acronym. */
  term: string;
  /** The user who added the term. */
  createdByUserId: string;
  /** When it was added (ISO 8601). */
  createdAt: string;
}

/**
 * Response of `GET …/dictionary`: every accepted term record for the project. The client maps these to
 * plain strings for the linter's `importWords` hydration, and uses the ids for management (removal).
 */
export interface DictionaryListDto {
  /** All accepted term records for the project. */
  terms: DictionaryTermDto[];
}

/** Response of `GET …/ignored-lints`: the caller's privacy-hashed blob (empty string when none). */
export interface IgnoredLintsDto {
  /** Harper's `exportIgnoredLints()` output, or an empty string. */
  ignoredLintsJson: string;
}
