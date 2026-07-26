import { ExternalTokenizer, type ContextTracker } from '@lezer/lr';
import { createBlockTokenLogic } from '@/lib/codemirror/asciidoc-block-token-logic';
import { createBlockContextLogic } from '@/lib/codemirror/asciidoc-block-context-logic';

/**
 * Builds the AsciiDoc block-level ExternalTokenizer for the grammar test harness. It binds the
 * SHARED production tokenizing logic (`asciidoc-block-token-logic.ts`) to the term-id map that
 * `buildParser` provides — so tests exercise the exact code the editor ships (no hand-maintained
 * mirror to drift). The logic file takes the term ids as a parameter and imports nothing from the
 * generated parser, so it loads cleanly under the jest transform.
 *
 * @param terms - The term table from buildParser (external token name → id).
 */
export function createTestBlockTokenizer(terms: Record<string, number>): ExternalTokenizer {
  return new ExternalTokenizer(createBlockTokenLogic(terms), { contextual: true });
}

/**
 * Builds the document-header context tracker the grammar's `@context` declares, for the same reason
 * and on the same terms as {@link createTestBlockTokenizer}. `buildParser` REQUIRES it once the
 * grammar declares a context, and the byline tokens are gated on it, so a harness that omitted it
 * would fail to build rather than quietly parse bylines differently from the editor.
 *
 * @param terms - The term table from buildParser (external token name → id).
 */
export function createTestBlockContext(terms: Record<string, number>): ContextTracker<number> {
  return createBlockContextLogic(terms);
}
