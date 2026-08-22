import { Re2RegexEngine } from '../../src/services/re2-regex-engine';
import type { MatchBudget } from '@asciidocollab/domain';

const budget = (over: Partial<MatchBudget> = {}): MatchBudget => ({
  maxMatches: 10_000,
  deadline: Number.POSITIVE_INFINITY,
  ...over,
});

/**
 * Compiles through a freshly required engine whose RE2 constructor throws `thrown`. Real RE2 always
 * throws a native SyntaxError, so the two arms of the message fallback can only be separated by
 * substituting the compiler.
 */
function compileWithThrowingRe2(thrown: unknown): { success: boolean; error?: { message: string } } {
  let outcome!: { success: boolean; error?: { message: string } };
  jest.isolateModules(() => {
    jest.doMock('re2', () => class ThrowingRe2 {
      constructor() {
        throw thrown;
      }
    });
    const module_ = require('../../src/services/re2-regex-engine') as typeof import('../../src/services/re2-regex-engine');
    outcome = new module_.Re2RegexEngine().compile('whatever', { caseSensitive: true, multiline: false });
  });
  return outcome;
}

describe('Re2RegexEngine', () => {
  const engine = new Re2RegexEngine();

  it('rejects an invalid pattern with a ValidationError instead of throwing', () => {
    const result = engine.compile('(unclosed', { caseSensitive: true, multiline: false });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
  });

  it('rejects backtracking-only constructs (lookahead) that RE2 cannot compile', () => {
    // RE2 has no backreferences/lookaround — such a pattern must be rejected up
    // front (an accepted trade-off of the linear-time guarantee), never run.
    const result = engine.compile('(?=foo)', { caseSensitive: true, multiline: false });
    expect(result.success).toBe(false);
  });

  it('returns spans with numbered and named capture groups', () => {
    const result = engine.compile(String.raw`(?<y>\d{4})-(\d{2})`, { caseSensitive: true, multiline: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const spans = result.value.matches('2026-07 and 1999-12', budget());
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ from: 0, to: 7, groups: ['2026-07', '2026', '07'] });
    expect(spans[0]?.named).toEqual({ y: '2026' });
  });

  it('stays bounded on a catastrophic-backtracking pattern (linear time, no hang)', () => {
    // (a+)+$ against a long run of 'a' with a trailing non-match is the classic
    // ReDoS: exponential on a backtracking engine, linear on RE2.
    const result = engine.compile('(a+)+$', { caseSensitive: true, multiline: false });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const evil = `${'a'.repeat(50_000)}!`;
    const start = Date.now();
    const spans = result.value.matches(evil, budget());
    const elapsed = Date.now() - start;
    expect(spans).toEqual([]); // no match (trailing '!')
    expect(elapsed).toBeLessThan(1000); // would be effectively infinite under backtracking
  });

  it('honours the maxMatches budget bound', () => {
    const result = engine.compile('a', { caseSensitive: true, multiline: false });
    if (!result.success) return;
    expect(result.value.matches('aaaaaa', budget({ maxMatches: 3 }))).toHaveLength(3);
  });

  it('is case-insensitive when requested', () => {
    const result = engine.compile('foo', { caseSensitive: false, multiline: false });
    if (!result.success) return;
    expect(result.value.matches('FOO Foo foo', budget())).toHaveLength(3);
  });

  it('is case-sensitive when requested', () => {
    // The mirror of the case above: without it, dropping the `caseSensitive` arm of the flag
    // string would still read green.
    const result = engine.compile('foo', { caseSensitive: true, multiline: false });
    if (!result.success) return;
    const spans = result.value.matches('FOO Foo foo', budget());
    expect(spans).toEqual([{ from: 8, to: 11, groups: ['foo'] }]);
  });

  it('anchors ^ per line only when multiline is set', () => {
    const multiline = engine.compile('^b', { caseSensitive: true, multiline: true });
    if (!multiline.success) return;
    expect(multiline.value.matches('a\nb\nb', budget()).map((s) => s.from)).toEqual([2, 4]);

    const single = engine.compile('^b', { caseSensitive: true, multiline: false });
    if (!single.success) return;
    expect(single.value.matches('a\nb\nb', budget())).toEqual([]);
  });

  it('omits `named` entirely when the pattern has no named groups', () => {
    const result = engine.compile(String.raw`(\d+)`, { caseSensitive: true, multiline: false });
    if (!result.success) return;
    const spans = result.value.matches('n=42', budget());
    expect(spans).toEqual([{ from: 2, to: 4, groups: ['42', '42'] }]);
    expect('named' in spans[0]!).toBe(false);
  });

  it('stops at the deadline using the injected clock, keeping the matches found so far', () => {
    const result = engine.compile('a', { caseSensitive: true, multiline: false });
    if (!result.success) return;
    // The clock crosses the deadline on its third reading, so exactly two spans survive.
    const readings = [0, 50, 100, 100, 100];
    let call = 0;
    const spans = result.value.matches('aaaaa', budget({ deadline: 100, now: () => readings[call++] ?? 100 }));
    expect(spans.map((s) => s.from)).toEqual([0, 1]);
    expect(call).toBe(3);
  });

  it('resets lastIndex between passes so a reused matcher rescans from the start', () => {
    const result = engine.compile('a', { caseSensitive: true, multiline: false });
    if (!result.success) return;
    expect(result.value.matches('aaa', budget({ maxMatches: 1 })).map((s) => s.from)).toEqual([0]);
    // Without the lastIndex reset the second pass would resume after the first match.
    expect(result.value.matches('aaa', budget()).map((s) => s.from)).toEqual([0, 1, 2]);
  });

  describe('zero-width matches', () => {
    it('advances one unit past a zero-width match instead of spinning', () => {
      const result = engine.compile('x*', { caseSensitive: true, multiline: false });
      if (!result.success) return;
      const spans = result.value.matches('ab', budget());
      expect(spans).toEqual([
        { from: 0, to: 0, groups: [''] },
        { from: 1, to: 1, groups: [''] },
        { from: 2, to: 2, groups: [''] },
      ]);
    });

    it('steps over a whole astral code point, never landing mid-surrogate', () => {
      const result = engine.compile('x*', { caseSensitive: true, multiline: false });
      if (!result.success) return;
      // '\u{1F600}' occupies UTF-16 units 0 and 1; offset 1 is the low surrogate and must be skipped.
      const spans = result.value.matches('\u{1F600}b', budget());
      expect(spans.map((s) => s.from)).toEqual([0, 2, 3]);
    });
  });

  describe('compile errors', () => {
    afterEach(() => {
      jest.resetModules();
      jest.dontMock('re2');
    });

    it('surfaces the compiler\'s own message when it throws an Error', () => {
      const result = compileWithThrowingRe2(new SyntaxError('missing ): (unclosed'));
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('missing ): (unclosed');
    });

    it('falls back to a generic message when a non-Error is thrown', () => {
      const result = compileWithThrowingRe2('boom');
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Invalid regular expression');
    });
  });
});
