import {
  categoryForLintKind,
  GRAMMAR_CATEGORIES,
  GRAMMAR_CATEGORY_MARK_CLASS,
  GRAMMAR_CATEGORY_DOT_CLASS,
} from '@/lib/codemirror/harper/category-colors';
import type { GrammarCategory } from '@/lib/codemirror/harper/category-colors';

describe('categoryForLintKind', () => {
  test('maps spelling-family kinds to "spelling"', () => {
    expect(categoryForLintKind('Spelling')).toBe('spelling');
    expect(categoryForLintKind('Typo')).toBe('spelling');
  });

  test('maps style/readability-family kinds to "style"', () => {
    expect(categoryForLintKind('Style')).toBe('style');
    expect(categoryForLintKind('Readability')).toBe('style');
    expect(categoryForLintKind('Redundancy')).toBe('style');
    expect(categoryForLintKind('WordChoice')).toBe('style');
  });

  test('maps grammar-family kinds to "grammar"', () => {
    expect(categoryForLintKind('Grammar')).toBe('grammar');
    expect(categoryForLintKind('Agreement')).toBe('grammar');
    expect(categoryForLintKind('Capitalization')).toBe('grammar');
    expect(categoryForLintKind('Punctuation')).toBe('grammar');
  });

  test('defaults an unknown kind to "grammar" (never hardcode the engine rule set)', () => {
    expect(categoryForLintKind('SomeNewKindHarperAdds')).toBe('grammar');
    expect(categoryForLintKind('')).toBe('grammar');
  });
});

describe('grammar category tokens', () => {
  test('every category has a distinct, stable mark class', () => {
    const classes = GRAMMAR_CATEGORIES.map((category) => GRAMMAR_CATEGORY_MARK_CLASS[category]);
    expect(new Set(classes).size).toBe(GRAMMAR_CATEGORIES.length);
    for (const category of GRAMMAR_CATEGORIES) {
      expect(GRAMMAR_CATEGORY_MARK_CLASS[category]).toMatch(/^cm-grammar-/);
    }
  });

  test('the categories are exactly spelling, grammar, and style', () => {
    const categories: GrammarCategory[] = [...GRAMMAR_CATEGORIES];
    expect(new Set(categories)).toEqual(new Set(['spelling', 'grammar', 'style']));
  });

  test('a category swatch is a real background class, not the editor mark class', () => {
    // The mark classes are matched by the CodeMirror theme only as `.cm-lintRange.cm-grammar-*`, and
    // only to set `text-decoration`. Used as a background class in ordinary markup they match nothing,
    // so every panel and status-bar dot painted with them was an invisible circle.
    for (const category of GRAMMAR_CATEGORIES) {
      expect(GRAMMAR_CATEGORY_DOT_CLASS[category]).not.toBe(GRAMMAR_CATEGORY_MARK_CLASS[category]);
      expect(GRAMMAR_CATEGORY_DOT_CLASS[category]).toMatch(/^bg-\[hsl\(var\(--syntax-grammar-/);
    }
  });

  test('each category has its own swatch colour', () => {
    const classes = GRAMMAR_CATEGORIES.map((category) => GRAMMAR_CATEGORY_DOT_CLASS[category]);
    expect(new Set(classes).size).toBe(GRAMMAR_CATEGORIES.length);
  });

});
