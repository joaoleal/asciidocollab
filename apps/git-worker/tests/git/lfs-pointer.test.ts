import { declaresLfsFilter, isUnsmudgedLfsPointer, shouldTrackWithLfs } from '../../src/git/lfs-pointer.js';

describe('declaresLfsFilter', () => {
  it('recognizes a filter=lfs attribute line', () => {
    expect(declaresLfsFilter('*.bin filter=lfs diff=lfs merge=lfs -text\n')).toBe(true);
  });

  it('recognizes filter=lfs among several attributes on one line', () => {
    expect(declaresLfsFilter('*.psd diff=lfs merge=lfs filter=lfs -text\n')).toBe(true);
  });

  it('returns false for a .gitattributes with no LFS declaration', () => {
    expect(declaresLfsFilter('*.adoc text eol=lf\n*.png binary\n')).toBe(false);
  });

  it('returns false for empty content (no .gitattributes at all)', () => {
    expect(declaresLfsFilter('')).toBe(false);
  });

  it('does not match "filter=lfs" as a substring of an unrelated token', () => {
    expect(declaresLfsFilter('*.bin filter=lfs-ish-but-not-quite\n')).toBe(false);
  });
});

describe('isUnsmudgedLfsPointer', () => {
  it('recognizes a real LFS pointer file\'s signature', () => {
    const pointer = Buffer.from(
      'version https://git-lfs.github.com/spec/v1\noid sha256:aaaa\nsize 1234\n',
      'utf8',
    );
    expect(isUnsmudgedLfsPointer(pointer)).toBe(true);
  });

  it('returns false for ordinary text content', () => {
    expect(isUnsmudgedLfsPointer(Buffer.from('= Chapter One\n\nHello.\n', 'utf8'))).toBe(false);
  });

  it('returns false for binary content shorter than the signature', () => {
    expect(isUnsmudgedLfsPointer(Buffer.from([0x89, 0x50, 0x4E, 0x47]))).toBe(false);
  });
});

describe('shouldTrackWithLfs', () => {
  it('returns false for a size below the threshold', () => {
    expect(shouldTrackWithLfs(1023, 1024, false)).toBe(false);
  });

  it('returns true for a size exactly at the threshold', () => {
    expect(shouldTrackWithLfs(1024, 1024, false)).toBe(true);
  });

  it('returns true for a size over the threshold', () => {
    expect(shouldTrackWithLfs(2048, 1024, false)).toBe(true);
  });

  it('returns false when already tracked, even far over the threshold', () => {
    expect(shouldTrackWithLfs(10_000_000, 1024, true)).toBe(false);
  });

  it('returns false for a size below the threshold whether or not already tracked', () => {
    expect(shouldTrackWithLfs(100, 1024, true)).toBe(false);
    expect(shouldTrackWithLfs(100, 1024, false)).toBe(false);
  });
});
