import type { Diagnostic } from '@codemirror/lint';
import { spanToDocumentRange, type ProseSegment } from '../prose-segments';
import { categoryForLintKind, GRAMMAR_CATEGORY_MARK_CLASS, type GrammarCategory } from './category-colors';
import { grammarSuggestionActions } from './apply-suggestion';
import { lintRuleLabel } from './lint-rule-label';
import type { EngineLint, EngineSuggestion } from './harper-engine';

/**
 * Maps one Harper lint (found in a prose segment) to a CodeMirror {@link Diagnostic}, translating the
 * segment-local span to an absolute document range and tagging it with a UI category so the theme
 * colours the underline, gutter, tooltip, and panel consistently.
 *
 * Pure: it takes the lint plus the segment that produced it and returns plain data, so it unit-tests
 * without an engine or editor. The apply/ignore/add-to-dictionary actions are attached by the lint
 * source that owns the worker client, not here.
 */

/** A CodeMirror diagnostic enriched with the writing-issue category and its suggested fixes. */
export interface GrammarDiagnostic extends Diagnostic {
  /** The writing-issue category driving this diagnostic's colour. */
  category: GrammarCategory;
  /**
   * The suggested fixes for this issue. Each targets the diagnostic's `[from, to]` span (or inserts
   * after it), so the popover and apply flow need only the diagnostic plus the chosen suggestion.
   */
  grammarSuggestions: EngineSuggestion[];
  /**
   * The engine's own lint object, carried by IDENTITY. Ignoring a lint is the one operation that
   * cannot be expressed in coordinates: the engine matches the lint against the exact object it
   * handed out, so a structurally identical copy is rejected.
   */
  grammarLint: EngineLint;
  /**
   * The prose segment's text, which is the coordinate system the lint's own span is in. `ignore`
   * re-lints this text to locate the lint, so it must be the segment, not the whole document.
   */
  grammarSegmentText: string;
}

/**
 * The label shown under a diagnostic when the lint names no rule.
 *
 * CodeMirror renders `Diagnostic.source` beneath the message in its lint tooltip, so this string is
 * READER-FACING, not an internal tag. Naming the engine there told the reader nothing they could act
 * on — every issue in the panel comes from the same engine — so the rule's own name goes there instead
 * (see {@link lintToDiagnostic}) and this remains only as the honest fallback for a lint that names no
 * rule: "it came from Harper, but not which check" beats an empty line or an invented name.
 */
export const GRAMMAR_DIAGNOSTIC_SOURCE = 'harper';

/**
 * Convert a Harper lint into a category-tagged CodeMirror diagnostic.
 *
 * @param lint - The lint found by the engine, with its span in the segment's own coordinates.
 * @param segment - The prose segment the lint was found in, providing the offset map back to the document.
 * @returns The diagnostic to render, positioned in absolute document coordinates.
 */
export function lintToDiagnostic(lint: EngineLint, segment: ProseSegment): GrammarDiagnostic {
  const { from, to } = spanToDocumentRange(segment, lint.span.start, lint.span.end);
  const category = categoryForLintKind(lint.kind);
  return {
    from,
    to,
    severity: 'info',
    // The rule that fired, which CodeMirror shows under the message in its tooltip — the same specific
    // name the Writing Issues panel puts on each card (`SentenceCapitalization`, not `Spelling`), so the
    // two surfaces name the same thing and a reader can find it in the Rules list.
    source: lintRuleLabel(lint.rule) ?? GRAMMAR_DIAGNOSTIC_SOURCE,
    message: lint.message,
    markClass: GRAMMAR_CATEGORY_MARK_CLASS[category],
    category,
    grammarSuggestions: lint.suggestions,
    grammarLint: lint,
    grammarSegmentText: segment.text,
    // One-click fixes in the inline lint tooltip (the "diagnostic/tooltip surface"). Each applies its
    // fix as an ordinary document change through the CRDT.
    actions: grammarSuggestionActions(lint.suggestions),
  };
}
