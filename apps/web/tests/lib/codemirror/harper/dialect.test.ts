import { GRAMMAR_DIALECTS, DEFAULT_GRAMMAR_DIALECT, isGrammarDialect } from '@/lib/codemirror/harper/dialect';

describe('grammar dialects', () => {
  test('lists the project-configurable English dialects, defaulting to British', () => {
    expect([...GRAMMAR_DIALECTS]).toEqual(['en-GB', 'en-US']);
    expect(DEFAULT_GRAMMAR_DIALECT).toBe('en-GB');
    expect(GRAMMAR_DIALECTS).toContain(DEFAULT_GRAMMAR_DIALECT);
  });

  test('isGrammarDialect narrows valid dialect strings and rejects others', () => {
    expect(isGrammarDialect('en-GB')).toBe(true);
    expect(isGrammarDialect('en-US')).toBe(true);
    expect(isGrammarDialect('en')).toBe(false);
    expect(isGrammarDialect('fr-FR')).toBe(false);
    expect(isGrammarDialect(undefined)).toBe(false);
    expect(isGrammarDialect(null)).toBe(false);
  });
});
