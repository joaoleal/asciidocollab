// Tests for assembleOutline (feature 032)
import { assembleOutline } from '@/lib/outline/assemble-outline';

function makeReader(files: Record<string, string>) {
  return (path: string): string | null => files[path] ?? null;
}

function makeFileIdForPath(map: Record<string, string>) {
  return (path: string): string => map[path] ?? path;
}

describe('assembleOutline — scope=current (feature 032)', () => {
  test('returns current-file entries and scope=current when scopePreference is "current"', () => {
    const files = {
      'main.adoc': '= Doc\n\n== Section One\n\ninclude::ch.adoc[]\n',
      'ch.adoc': '== Section Two\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'ch.adoc': 'id-ch' }),
      scopePreference: 'current',
    });
    expect(result.scope).toBe('current');
    expect(result.entries.every((entry) => entry.sourceFileId === 'id-main')).toBe(true);
    // Should have titles from main.adoc only, not ch.adoc
    const titles = result.entries.map((entry) => entry.title);
    expect(titles).toContain('Doc');
    expect(titles).toContain('Section One');
    expect(titles).not.toContain('Section Two');
  });

  test('returns scope=current and no entries for an unreadable open file', () => {
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'open.adoc',
      openFileId: 'id-open',
      readFile: () => null,
      fileIdForPath: () => 'x',
      scopePreference: 'current',
    });
    expect(result.scope).toBe('current');
    expect(result.entries).toEqual([]);
  });
});

describe('assembleOutline — effective-scope fallbacks (feature 032)', () => {
  test('falls back to current when rootPath is null (no main document)', () => {
    const files = { 'open.adoc': '== Only This\n' };
    const result = assembleOutline({
      rootPath: null,
      openFilePath: 'open.adoc',
      openFileId: 'id-open',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'open.adoc': 'id-open' }),
      scopePreference: 'full',
    });
    expect(result.scope).toBe('current');
    expect(result.rootFileId).toBeNull();
    expect(result.entries.map((entry) => entry.title)).toContain('Only This');
  });

  test('falls back to current when open file is not reachable from root', () => {
    const files = {
      'main.adoc': '= Root\n\n== Root Section\n',
      'unrelated.adoc': '== Unrelated\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'unrelated.adoc',
      openFileId: 'id-unrelated',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'unrelated.adoc': 'id-unrelated' }),
      scopePreference: 'full',
    });
    expect(result.scope).toBe('current');
    expect(result.entries.map((entry) => entry.title)).toContain('Unrelated');
    expect(result.entries.map((entry) => entry.title)).not.toContain('Root Section');
  });
});

describe('assembleOutline — full scope with provenance (feature 032)', () => {
  test('full scope: entries contain provenance fields (sourceFileId, sourcePath, sourceLine)', () => {
    const files = {
      'main.adoc': '= Title\n\n== Main Section\n\ninclude::ch.adoc[]\n',
      'ch.adoc': '== Child Section\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'ch.adoc': 'id-ch' }),
      scopePreference: 'full',
    });
    expect(result.scope).toBe('full');
    const mainEntries = result.entries.filter((entry) => entry.sourceFileId === 'id-main');
    const childEntries = result.entries.filter((entry) => entry.sourceFileId === 'id-ch');
    expect(mainEntries.length).toBeGreaterThan(0);
    expect(childEntries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.sourcePath).toBeDefined();
      expect(entry.sourceLine).toBeDefined();
      expect(typeof entry.sourceLine).toBe('number');
      expect(entry.sourceLine).toBeGreaterThanOrEqual(1);
    }
  });

  test('full scope: entries in assembled document order (seamless, no per-file grouping)', () => {
    const files = {
      'main.adoc': '= Title\n\n== First\n\ninclude::ch.adoc[]\n\n== Third\n',
      'ch.adoc': '== Second\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'ch.adoc': 'id-ch' }),
      scopePreference: 'full',
    });
    const titles = result.entries.map((entry) => entry.title);
    expect(titles.indexOf('First')).toBeLessThan(titles.indexOf('Second'));
    expect(titles.indexOf('Second')).toBeLessThan(titles.indexOf('Third'));
  });

  test('isOpenFile is true for entries from the open file, false for others', () => {
    const files = {
      'main.adoc': '= Title\n\n== Main Section\n\ninclude::ch.adoc[]\n',
      'ch.adoc': '== Child Section\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'ch.adoc': 'id-ch' }),
      scopePreference: 'full',
    });
    for (const entry of result.entries) {
      expect(entry.isOpenFile).toBe(entry.sourceFileId === 'id-main');
    }
  });

  test('sourceLine in provenance is the 1-based line within the source file (not the assembled line)', () => {
    const files = {
      // blank line before heading so the paragraph-absorption rule does not swallow it
      'main.adoc': '= Title\n\ninclude::ch.adoc[]\n',
      'ch.adoc': 'First line\n\n== Child Heading\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main', 'ch.adoc': 'id-ch' }),
      scopePreference: 'full',
    });
    const childHeading = result.entries.find((entry) => entry.title === 'Child Heading');
    expect(childHeading).toBeDefined();
    // In ch.adoc, "== Child Heading" is on line 3 (after the blank line on line 2)
    expect(childHeading!.sourceLine).toBe(3);
    expect(childHeading!.sourceFileId).toBe('id-ch');
  });

  test('inactive-conditional headings are excluded from the assembled outline', () => {
    const files = {
      'main.adoc': 'ifdef::never[]\n== Hidden\nendif::[]\n\n== Visible\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    const titles = result.entries.map((entry) => entry.title);
    expect(titles).not.toContain('Hidden');
    expect(titles).toContain('Visible');
  });

  test('resolves a {attr} heading title against an earlier attribute definition', () => {
    const files = {
      'main.adoc': '= Book\n:productName: Acme\n\n== {productName} Guide\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    expect(result.entries.map((entry) => entry.title)).toContain('Acme Guide');
  });

  test('a :name: line inside a verbatim/listing block is NOT treated as an attribute definition', () => {
    const files = {
      // `:productName: Acme` sits inside a listing block, so per AsciiDoc it is literal text and must
      // not define `productName`; the later `{productName}` heading title stays unresolved.
      'main.adoc': '= Book\n\n----\n:productName: Acme\n----\n\n== {productName} Guide\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    const titles = result.entries.map((entry) => entry.title);
    expect(titles).toContain('{productName} Guide');
    expect(titles).not.toContain('Acme Guide');
  });

  test('unresolved includes are passed through in AssembledOutline.unresolved', () => {
    const files = {
      'main.adoc': '= Title\n\ninclude::missing.adoc[]\n\n== After\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(result.unresolved[0].target).toBe('missing.adoc');
    // The rest of the outline should still be present (graceful degradation)
    expect(result.entries.map((entry) => entry.title)).toContain('After');
  });

  test('cycle-safe: cyclic includes terminate without hanging', () => {
    const files = {
      'a.adoc': '== A\ninclude::b.adoc[]\n',
      'b.adoc': '== B\ninclude::a.adoc[]\n',
    };
    const result = assembleOutline({
      rootPath: 'a.adoc',
      openFilePath: 'a.adoc',
      openFileId: 'id-a',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'a.adoc': 'id-a', 'b.adoc': 'id-b' }),
      scopePreference: 'full',
    });
    expect(result.unresolved.some((u) => u.reason === 'cycle')).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
  });
});

describe('assembleOutline — attribute definitions in document order', () => {
  test('resolves a title against the value in effect at that point', () => {
    const files = {
      'main.adoc': '= Doc\n:product: Acme\n\n== {product} Guide\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'current',
    });
    expect(result.entries.map((entry) => entry.title)).toContain('Acme Guide');
  });

  test('stops resolving a title once the attribute is unset', () => {
    const files = {
      'main.adoc': '= Doc\n:product: Acme\n\n== {product} One\n\n:product!:\n\n== {product} Two\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'current',
    });
    const titles = result.entries.map((entry) => entry.title);
    expect(titles).toContain('Acme One');
    expect(titles).toContain('{product} Two');
  });

  test('treats a valueless attribute definition as an empty value', () => {
    const files = {
      'main.adoc': '= Doc\n:draft:\n\n== {draft}Notes\n',
    };
    const result = assembleOutline({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'current',
    });
    expect(result.entries.map((entry) => entry.title)).toContain('Notes');
  });
});

/** Loads assembleOutline against a stubbed assembler returning exactly `result`. */
function loadOutlineWith(result: unknown) {
  jest.resetModules();
  jest.doMock('@/workers/assemble-includes', () => ({ assembleIncludes: () => result }));
  return require('@/lib/outline/assemble-outline').assembleOutline;
}

describe('assembleOutline — degraded assembly results', () => {
  afterEach(() => {
    jest.dontMock('@/workers/assemble-includes');
    jest.resetModules();
  });

  test('falls back to the current file when the assembler returns no source map', () => {
    const assemble = loadOutlineWith({ content: '= Doc\n\n== Section\n', unresolved: [] });
    const files = { 'main.adoc': '= Doc\n\n== Section\n' };
    const result = assemble({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    expect(result.scope).toBe('current');
    expect(result.rootFileId).toBeNull();
  });

  test('attributes a heading past the end of the source map to the open file', () => {
    const assemble = loadOutlineWith({
      content: '= Doc\n\n== Beyond The Map\n',
      unresolved: [],
      // Deliberately shorter than the assembled content: assembled line 3 has no provenance.
      sourceMap: { lineToSource: [{ path: 'main.adoc', sourceLine: 1 }] },
    });
    const files = { 'main.adoc': '= Doc\n\n== Beyond The Map\n' };
    const result = assemble({
      rootPath: 'main.adoc',
      openFilePath: 'main.adoc',
      openFileId: 'id-main',
      readFile: makeReader(files),
      fileIdForPath: makeFileIdForPath({ 'main.adoc': 'id-main' }),
      scopePreference: 'full',
    });
    expect(result.scope).toBe('full');
    const beyond = result.entries.find((entry: { title: string }) => entry.title === 'Beyond The Map');
    expect(beyond).toMatchObject({
      sourceFileId: 'id-main',
      sourcePath: 'main.adoc',
      sourceLine: 3,
      isOpenFile: true,
    });
  });
});
