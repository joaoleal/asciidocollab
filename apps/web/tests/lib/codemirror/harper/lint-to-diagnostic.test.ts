import { lintToDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';
import { GRAMMAR_CATEGORY_MARK_CLASS } from '@/lib/codemirror/harper/category-colors';
import type { EngineLint } from '@/lib/codemirror/harper/harper-engine';
import type { ProseSegment } from '@/lib/codemirror/prose-segments';

/** A segment whose text starts at document offset 100 (identity map shifted by 100). */
function segmentAt(text: string, base: number): ProseSegment {
  return { text, map: [...text].map((_char, index) => base + index) };
}

function lint(overrides: Partial<EngineLint> & Pick<EngineLint, 'span'>): EngineLint {
  return {
    kind: 'Grammar',
    // Every lint the engine hands out names the rule that produced it (it comes from `organizedLints`),
    // so a fixture without one is not a lint the engine could have produced.
    rule: 'SomeRule',
    message: 'Something is off.',
    suggestions: [],
    ...overrides,
  };
}

describe('lintToDiagnostic', () => {
  test('maps a segment-local span to an absolute document range', () => {
    const segment = segmentAt('a bad line', 100);
    const diagnostic = lintToDiagnostic(lint({ span: { start: 2, end: 5 }, kind: 'Spelling' }), segment);
    // "bad" is at segment offsets 2..5, so document offsets 102..105.
    expect(diagnostic.from).toBe(102);
    expect(diagnostic.to).toBe(105);
  });

  test('carries the lint message and an info severity', () => {
    const segment = segmentAt('a bad line', 0);
    const diagnostic = lintToDiagnostic(lint({ span: { start: 2, end: 5 }, message: '“bad” is a typo.' }), segment);
    expect(diagnostic.message).toBe('“bad” is a typo.');
    expect(diagnostic.severity).toBe('info');
  });

  test('tags the diagnostic with its category and the matching mark class', () => {
    const segment = segmentAt('a bad line', 0);
    const spelling = lintToDiagnostic(lint({ span: { start: 2, end: 5 }, kind: 'Typo' }), segment);
    expect(spelling.category).toBe('spelling');
    expect(spelling.markClass).toBe(GRAMMAR_CATEGORY_MARK_CLASS.spelling);

    const style = lintToDiagnostic(lint({ span: { start: 0, end: 1 }, kind: 'Redundancy' }), segment);
    expect(style.category).toBe('style');
    expect(style.markClass).toBe(GRAMMAR_CATEGORY_MARK_CLASS.style);
  });

  // CodeMirror renders `source` beneath the message in its lint tooltip, so it is what the reader sees
  // when hovering an underline. It used to read "harper", which names the engine every issue comes from
  // and so tells the reader nothing; it now names the rule that fired, matching the chip the Writing
  // Issues panel shows and the key the Rules tab lists.
  test('names the rule that fired, so the tooltip and the panel agree', () => {
    const segment = segmentAt('a bad line', 0);
    const diagnostic = lintToDiagnostic(
      lint({ span: { start: 2, end: 5 }, rule: 'SentenceCapitalization' }),
      segment,
    );
    expect(diagnostic.source).toBe('SentenceCapitalization');
  });

  test('falls back to naming the engine when the lint names no rule', () => {
    // Honest rather than blank: "it came from Harper, but not which check".
    const segment = segmentAt('a bad line', 0);
    const diagnostic = lintToDiagnostic(lint({ span: { start: 2, end: 5 }, rule: '' }), segment);
    expect(diagnostic.source).toBe('harper');
  });
});
