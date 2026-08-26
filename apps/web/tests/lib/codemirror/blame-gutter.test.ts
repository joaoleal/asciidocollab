import { blameAuthorStyle, formatBlameDate } from '@/lib/codemirror/blame-gutter';

describe('formatBlameDate', () => {
  test('reduces an ISO 8601 timestamp to its calendar-date portion', () => {
    expect(formatBlameDate('2026-08-24T10:15:00.000Z')).toBe('2026-08-24');
  });

  test('handles a bare date with no time component', () => {
    expect(formatBlameDate('2026-01-02')).toBe('2026-01-02');
  });

  test('returns an empty string for an unparseable value', () => {
    expect(formatBlameDate('not-a-date')).toBe('');
  });
});

describe('blameAuthorStyle', () => {
  test('returns a distinct style for a known vs. unknown author', () => {
    expect(blameAuthorStyle(true).className).not.toBe(blameAuthorStyle(false).className);
  });

  test('never returns a hardcoded hex or rgb color', () => {
    for (const hasAuthor of [true, false]) {
      const { className } = blameAuthorStyle(hasAuthor);
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});
