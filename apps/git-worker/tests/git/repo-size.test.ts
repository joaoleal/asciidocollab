import { repoSizeCeilingBytes, repoSizeExceedsLimit } from '../../src/git/repo-size.js';

describe('repoSizeCeilingBytes', () => {
  it('converts a megabyte ceiling to the exact byte count it represents', () => {
    expect(repoSizeCeilingBytes(1)).toBe(1024 * 1024);
    expect(repoSizeCeilingBytes(500)).toBe(500 * 1024 * 1024);
  });
});

describe('repoSizeExceedsLimit', () => {
  it('returns false when the measured size is under the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024 - 1, 1)).toBe(false);
  });

  it('returns false when the measured size exactly equals the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024, 1)).toBe(false);
  });

  it('returns true when the measured size is over the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024 + 1, 1)).toBe(true);
  });

  it('returns true for a size far beyond a small ceiling', () => {
    expect(repoSizeExceedsLimit(500 * 1024 * 1024, 1)).toBe(true);
  });

  it('returns false for zero measured size regardless of ceiling', () => {
    expect(repoSizeExceedsLimit(0, 1)).toBe(false);
  });
});
