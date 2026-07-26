import * as terms from './asciidoc-parser.terms.js';
import { createBlockContextLogic } from './asciidoc-block-context-logic';

// The generated terms module exports one numeric id per external token; spread it into a
// plain record so the shared logic can look ids up by the grammar's external token names.
const termIds: Record<string, number> = { ...terms };

/**
 * The production document-header context tracker, bound to the generated term ids. The state machine
 * lives in `asciidoc-block-context-logic.ts` (shared with the grammar test harness so the two can
 * never diverge); the grammar's `@context` declaration names this binding.
 */
export const blockContext = createBlockContextLogic(termIds);
