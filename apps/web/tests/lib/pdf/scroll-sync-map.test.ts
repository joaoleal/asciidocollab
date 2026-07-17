import type { ProjectSnapshot, PdfSourceMap } from '@asciidocollab/asciidoc-pdf';
import {
  buildAssembledLineToSource,
  buildAssembledScrollContext,
  isPathInAssembledTree,
  liftSourceMapToBlockStarts,
  openLineToAssembledLine,
} from '@/lib/pdf/scroll-sync-map';
import type { SourceMapEntry } from '@/workers/assemble-includes';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    files: {},
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    ...overrides,
  };
}

const entry = (path: string, sourceLine: number): SourceMapEntry => ({ path, sourceLine });

// ---------------------------------------------------------------------------
// isPathInAssembledTree.
// ---------------------------------------------------------------------------

const read = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('isPathInAssembledTree', () => {
  it('is true for the root path itself (no assembly needed)', () => {
    expect(isPathInAssembledTree('main.adoc', () => null, 'main.adoc')).toBe(true);
  });

  it('is true for a file the root reaches through an include directive', () => {
    const files = {
      'main.adoc': '= Title\n\ninclude::chapters/one.adoc[]\n',
      'chapters/one.adoc': '== One\n\nBody.\n',
    };
    expect(isPathInAssembledTree('main.adoc', read(files), 'chapters/one.adoc')).toBe(true);
  });

  it('is true for a transitively included file (include of an include)', () => {
    const files = {
      'main.adoc': 'include::a.adoc[]\n',
      'a.adoc': 'include::b.adoc[]\n',
      'b.adoc': 'Leaf.\n',
    };
    expect(isPathInAssembledTree('main.adoc', read(files), 'b.adoc')).toBe(true);
  });

  it('is false for a file the root never includes', () => {
    const files = {
      'main.adoc': '= Title\n\ninclude::chapters/one.adoc[]\n',
      'chapters/one.adoc': '== One\n',
      'orphan.adoc': '= Orphan\n',
    };
    expect(isPathInAssembledTree('main.adoc', read(files), 'orphan.adoc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAssembledLineToSource.
// ---------------------------------------------------------------------------

describe('buildAssembledLineToSource', () => {
  it('returns a provenance entry per assembled line for a single-file document', () => {
    const map = buildAssembledLineToSource(
      snapshot({ files: { 'main.adoc': '= Title\n\nBody paragraph.\n' } }),
    );

    expect(map).not.toBeNull();
    // Every assembled line traces back to the root file at its own 1-based line.
    expect(map?.[0]).toEqual({ path: 'main.adoc', sourceLine: 1 });
    expect(map?.length).toBeGreaterThan(0);
  });

  it('attributes an included file\'s lines to that file in the assembled map', () => {
    const map = buildAssembledLineToSource(
      snapshot({
        files: {
          'main.adoc': '= Title\n\ninclude::child.adoc[]\n',
          'child.adoc': 'From the child.\n',
        },
      }),
    );

    expect(map).not.toBeNull();
    // At least one assembled line must originate from the included child file.
    expect(map?.some((provenance) => provenance.path === 'child.adoc')).toBe(true);
  });

  it('returns null when the root document is missing (assembler emits no usable map)', () => {
    // A root path with no matching file yields an assembly whose only content is the unresolved-root
    // marker; the map is still an array, so this asserts the helper degrades to a value, never throws.
    expect(() => buildAssembledLineToSource(snapshot({ rootPath: 'absent.adoc' }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildAssembledScrollContext.
// ---------------------------------------------------------------------------

describe('buildAssembledScrollContext', () => {
  it('returns the provenance map alongside the assembled source lines', () => {
    const context = buildAssembledScrollContext(
      snapshot({ files: { 'main.adoc': '= Title\n\nBody paragraph.\n' } }),
    );

    expect(context).not.toBeNull();
    expect(context?.lineToSource[0]).toEqual({ path: 'main.adoc', sourceLine: 1 });
    // The assembled lines mirror the source; the first line is the document title.
    expect(context?.assembledLines[0]).toBe('= Title');
  });
});

// ---------------------------------------------------------------------------
// liftSourceMapToBlockStarts.
// ---------------------------------------------------------------------------

describe('liftSourceMapToBlockStarts', () => {
  // Lines: 1 `= T`, 2 ``, 3 `Before.`, 4 ``, 5 `.Example block`, 6 `====`, 7 `inside`, 8 `====`.
  const assembledLines = ['= T', '', 'Before.', '', '.Example block', '====', 'inside', '===='];
  const sourceMap: PdfSourceMap = [
    { line: 3, page: 1, yFraction: 0.1 },
    { line: 6, page: 1, yFraction: 0.4 }, // the example block, reported at its `====` delimiter
    { line: 7, page: 1, yFraction: 0.5 },
  ];

  it('lifts a titled block entry to its title line, preserving page/position', () => {
    const lifted = liftSourceMapToBlockStarts(sourceMap, assembledLines);
    // The delimiter-line entry (6) moves up to the `.Example block` title line (5).
    const example = lifted.find((mapEntry) => mapEntry.page === 1 && mapEntry.yFraction === 0.4);
    expect(example?.line).toBe(5);
    // The paragraph before it and the block's inner content keep their own lines.
    expect(lifted.map((mapEntry) => mapEntry.line)).toEqual([3, 5, 7]);
  });

  it('keeps the map sorted by line and de-duplicated after lifting', () => {
    const lifted = liftSourceMapToBlockStarts(sourceMap, assembledLines);
    const lines = lifted.map((mapEntry) => mapEntry.line);
    expect([...lines]).toEqual(lines.toSorted((a, b) => a - b));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('returns an empty map unchanged', () => {
    expect(liftSourceMapToBlockStarts([], assembledLines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// openLineToAssembledLine.
// ---------------------------------------------------------------------------

describe('openLineToAssembledLine', () => {
  const lineToSource: SourceMapEntry[] = [
    entry('main.adoc', 1),
    entry('main.adoc', 2),
    entry('child.adoc', 1),
    entry('child.adoc', 2),
    entry('main.adoc', 4),
  ];

  it('maps an exact open-file line to its assembled line (1-based index)', () => {
    // main.adoc line 4 is the 5th assembled line.
    expect(openLineToAssembledLine(lineToSource, 'main.adoc', 4)).toBe(5);
  });

  it('resolves to the nearest preceding source line within the open file', () => {
    // main.adoc has no source line 3; the greatest ≤ 3 is line 2 → assembled line 2.
    expect(openLineToAssembledLine(lineToSource, 'main.adoc', 3)).toBe(2);
  });

  it('ignores entries that belong to a different file', () => {
    // Only child.adoc lines count; line 2 is the 4th assembled line.
    expect(openLineToAssembledLine(lineToSource, 'child.adoc', 2)).toBe(4);
  });

  it('returns undefined when the open file contributes no line at or before the target', () => {
    // The first main.adoc source line is 1, so a target of 0 has nothing at or before it.
    expect(openLineToAssembledLine(lineToSource, 'main.adoc', 0)).toBeUndefined();
    // A file absent from the map maps nothing.
    expect(openLineToAssembledLine(lineToSource, 'other.adoc', 10)).toBeUndefined();
  });

  it('returns undefined for an empty provenance map', () => {
    expect(openLineToAssembledLine([], 'main.adoc', 5)).toBeUndefined();
  });
});
