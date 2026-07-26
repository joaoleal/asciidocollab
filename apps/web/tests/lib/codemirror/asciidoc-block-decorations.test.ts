import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { LRParser } from '@lezer/lr';
import {
  computeBlockMarkerRanges,
  BLOCK_TITLE_MARKER_CLASS,
  TABLE_SEP_CLASS,
  TABLE_HEADER_CELL_CLASS,
  STEM_PREFIX_CLASS,
  STEM_BODY_CLASS,
} from '@/lib/codemirror/asciidoc-block-decorations';
import { asciidocHighlightTags } from '@/lib/codemirror/asciidoc-highlight-tags';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

/**
 * Block-marker decoration tests (feature 030). The leading `.` of a block title recedes,
 * table `|` separators recede, and header-row cells go bold — cues the grammar cannot carry by token
 * tag alone because only PART of the node changes while its body stays readable.
 */

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const parser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
}).configure({ props: [asciidocHighlightTags] }) as LRParser;

function markers(source: string) {
  return computeBlockMarkerRanges(parser.parse(source), source).map((r) => ({
    text: source.slice(r.from, r.to),
    cls: r.cls,
  }));
}

describe('block-title marker', () => {
  test('the leading `.` of a block title is marked, the title text is not', () => {
    const found = markers('.Pythagorean theorem\n');
    expect(found).toEqual([{ text: '.', cls: BLOCK_TITLE_MARKER_CLASS }]);
  });

  test('a block title above a delimited block is marked', () => {
    const found = markers('.Setup options\n====\nbody\n====\n');
    expect(found.some((m) => m.text === '.' && m.cls === BLOCK_TITLE_MARKER_CLASS)).toBe(true);
  });
});

describe('table separators and header cells', () => {
  const HEADER_TABLE =
    '[cols="2,1",options="header"]\n|===\n| Feature | Status\n| Live preview | Stable\n|===\n';

  test('every `|` cell separator is receded to markup', () => {
    const seps = markers(HEADER_TABLE).filter((m) => m.cls === TABLE_SEP_CLASS);
    // 2 pipes on the header row + 2 on the body row = 4.
    expect(seps).toHaveLength(4);
    expect(seps.every((m) => m.text === '|')).toBe(true);
  });

  test('header-row cells go bold; body-row cells do not', () => {
    const headerCells = markers(HEADER_TABLE).filter((m) => m.cls === TABLE_HEADER_CELL_CLASS);
    expect(headerCells.map((m) => m.text)).toEqual(['Feature', 'Status']);
  });

  test('implicit header (first row followed by a blank line) is bolded', () => {
    const found = markers('|===\n| A | B\n\n| 1 | 2\n|===\n');
    const headerCells = found.filter((m) => m.cls === TABLE_HEADER_CELL_CLASS);
    expect(headerCells.map((m) => m.text)).toEqual(['A', 'B']);
  });

  test('a table with no header option and no blank line bolds nothing', () => {
    const found = markers('|===\n| A | B\n| 1 | 2\n|===\n');
    expect(found.some((m) => m.cls === TABLE_HEADER_CELL_CLASS)).toBe(false);
    // …but separators still recede.
    expect(found.some((m) => m.cls === TABLE_SEP_CLASS)).toBe(true);
  });

  test('a `%header` shorthand marks the first row as a header', () => {
    const found = markers('[%header]\n|===\n| A | B\n| 1 | 2\n|===\n');
    expect(found.filter((m) => m.cls === TABLE_HEADER_CELL_CLASS).map((m) => m.text)).toEqual(['A', 'B']);
  });

  test('a header row split across physical lines (cols="2,1") bolds ALL its cells', () => {
    // The 2-column header occupies two physical lines (one cell each); both must be bold, and the
    // body cells below must not be.
    const source = '[cols="2,1",options="header"]\n|===\n| Feature\n| Status\n| Live preview | Stable\n| Math | Beta\n|===\n';
    const headerCells = markers(source).filter((m) => m.cls === TABLE_HEADER_CELL_CLASS);
    expect(headerCells.map((m) => m.text)).toEqual(['Feature', 'Status']);
  });

  test('a bare `cols=3` header spanning three physical lines bolds all three cells', () => {
    const source = '[cols=3,options="header"]\n|===\n| A\n| B\n| C\n| 1 | 2 | 3\n|===\n';
    const headerCells = markers(source).filter((m) => m.cls === TABLE_HEADER_CELL_CLASS);
    expect(headerCells.map((m) => m.text)).toEqual(['A', 'B', 'C']);
  });

  test('an implicit header that spans two physical lines before the blank line bolds both cells', () => {
    const source = '[cols="2,1"]\n|===\n| Feature\n| Status\n\n| Live preview | Stable\n|===\n';
    const headerCells = markers(source).filter((m) => m.cls === TABLE_HEADER_CELL_CLASS);
    expect(headerCells.map((m) => m.text)).toEqual(['Feature', 'Status']);
  });
});

describe('inline stem prefix and math body', () => {
  test('`stem:[…]` splits into a bold prefix and a chip-backed formula body', () => {
    const found = markers('Euler: stem:[sqrt(4) = 2] inline.\n');
    const prefix = found.find((m) => m.cls === STEM_PREFIX_CLASS);
    const body = found.find((m) => m.cls === STEM_BODY_CLASS);
    expect(prefix?.text).toBe('stem:');
    expect(body?.text).toBe('[sqrt(4) = 2]');
  });

  test('`latexmath:[…]` also splits prefix from body', () => {
    const found = markers('x latexmath:[a^2] y\n');
    expect(found.find((m) => m.cls === STEM_PREFIX_CLASS)?.text).toBe('latexmath:');
    expect(found.find((m) => m.cls === STEM_BODY_CLASS)?.text).toBe('[a^2]');
  });
});
