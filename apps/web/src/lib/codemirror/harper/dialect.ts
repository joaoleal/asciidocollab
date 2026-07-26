/**
 * The English dialects grammar checking can enforce, expressed in the app's own vocabulary
 * (`en-GB` / `en-US`) rather than Harper's numeric `Dialect` enum. Keeping this module free of any
 * harper.js import lets settings/UI/validation code share one dialect type without pulling in the
 * Harper WASM engine; the enum translation happens only at the engine boundary
 * (`create-harper-worker.ts`).
 *
 * The set itself is NOT restated here. A dialect travels to the server in the project render config,
 * where `grammarDialectSchema` validates it, so that schema is the authority and this module projects
 * it into the plain array/type/guard the UI wants. Restating the literals would have let the value the
 * editor enforces drift from the value the API accepts.
 */

import { grammarDialectSchema } from '@asciidocollab/shared';

/** English dialects a project may configure for grammar checking. */
export const GRAMMAR_DIALECTS = grammarDialectSchema.options;

/** A project-configurable English dialect. */
export type GrammarDialect = (typeof GRAMMAR_DIALECTS)[number];

/** The default dialect when a project enables grammar checking without choosing one (spec FR-023). */
export const DEFAULT_GRAMMAR_DIALECT: GrammarDialect = 'en-GB';

const GRAMMAR_DIALECT_SET: ReadonlySet<string> = new Set(GRAMMAR_DIALECTS);

/** Type guard: whether an unknown value is one of the supported grammar dialects. */
export function isGrammarDialect(value: unknown): value is GrammarDialect {
  return typeof value === 'string' && GRAMMAR_DIALECT_SET.has(value);
}
