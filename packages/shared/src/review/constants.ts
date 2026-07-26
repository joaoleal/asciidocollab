/** @file Named constants for the review module's wire contract. */

/**
 * Maximum length, in characters, of a review comment/reply body.
 *
 * Declared here rather than re-exported from `@asciidocollab/domain`, which is how the sibling enums in
 * `./enums.ts` already mirror `domain/src/constants/review.ts`. The re-export pointed `shared` UP at the
 * domain, and because this is a runtime VALUE (not a type that compiles away) it also meant the browser
 * pulled `@asciidocollab/domain` in behind every `@asciidocollab/shared` import — the API boundary's
 * `maxLength` and the composer's `maxLength` do not need a server bundle to agree on 4000.
 *
 * The two declarations are held together by a parity test in `apps/api/tests/architecture`: the API is
 * a layer permitted to import both, so the check lives where it can actually read each side.
 */
export const REVIEW_BODY_MAX_LEN = 4000;
