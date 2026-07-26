import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { Tree } from '@lezer/common';
import { extractProseSegments, spanToDocumentRange } from '@/lib/codemirror/prose-segments';
import { createTestBlockTokenizer } from '../../helpers/asciidoc-test-tokenizer';

// Build the parser from the grammar source (as the spellcheck/fold tests do): the generated
// `asciidoc-parser.js` is ESM the node-project Jest transform does not compile. extractProseSegments
// is a pure function over (tree, text), so no live editor/DOM is needed — this runs in the node project.
const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const parser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
});

function parse(text: string): Tree {
  return parser.parse(text);
}

/** Concatenated visible text of every segment (segments joined by ' | ' for readability). */
function segmentTexts(text: string): string[] {
  return extractProseSegments(parse(text), text).map((s) => s.text);
}

describe('extractProseSegments', () => {
  test('extracts a single prose paragraph as one segment with a correct offset map', () => {
    const text = 'hello world\n';
    const segments = extractProseSegments(parse(text), text);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('hello world');
    // map[i] points at the document char that text[i] came from.
    expect(segments[0].map).toHaveLength(segments[0].text.length);
    for (let index = 0; index < segments[0].text.length; index++) {
      expect(text[segments[0].map[index]]).toBe(segments[0].text[index]);
    }
  });

  test('splits two paragraphs separated by a blank line into two segments', () => {
    expect(segmentTexts('First paragraph here.\n\nSecond paragraph here.\n')).toEqual([
      'First paragraph here.',
      'Second paragraph here.',
    ]);
  });

  test('keeps a soft-wrapped (single-newline) paragraph as one segment', () => {
    expect(segmentTexts('First line\nsecond line\n')).toEqual(['First line\nsecond line']);
  });

  test('never yields prose from inside a verbatim listing block, and does not join the prose around it', () => {
    const text = 'Before code.\n\n----\nnotprose zzqx\n----\n\nAfter code.\n';
    const segments = segmentTexts(text);
    expect(segments).toEqual(['Before code.', 'After code.']);
    expect(segments.join(' ')).not.toContain('notprose');
    expect(segments.join(' ')).not.toContain('zzqx');
  });

  test('a document that is entirely a code block yields zero segments', () => {
    expect(segmentTexts('----\nonly code here\n----\n')).toEqual([]);
  });

  test('collapses an inline skip node to a separator without splitting the sentence', () => {
    // The bare URL (Link) is skipped; the surrounding prose stays ONE grammar segment so "Visit … now"
    // is linted together, but the URL text itself is never prose.
    const segments = segmentTexts('Visit https://exampledomain.test now\n');
    expect(segments).toHaveLength(1);
    expect(segments[0]).not.toContain('exampledomain');
    expect(segments[0]).toMatch(/^Visit\s+now$/);
  });

  test('reconstructs a role-span body so a word split by markup rejoins as one prose word', () => {
    // `[.underline]##O##nce` renders as "Once"; the role name + `##` delimiters are markup.
    const segments = segmentTexts('[.underline]##O##nce upon a loop.\n');
    expect(segments).toHaveLength(1);
    expect(segments[0]).not.toContain('underline');
    expect(segments[0]).not.toContain('#');
    expect(segments[0]).toMatch(/^Once upon a loop\.$/);
  });

  test('excludes the document-header author/revision byline', () => {
    const text = '= Guided Tour\nThe Zyxwv Team <hello@zyxwv.test>\nv1.0, 2026-07-18\n\nOrdinary prose.\n';
    const segments = segmentTexts(text);
    expect(segments.join(' | ')).not.toContain('Zyxwv');
    expect(segments).toContain('Ordinary prose.');
  });

  test('degenerate inputs (empty / whitespace-only) yield zero segments', () => {
    expect(segmentTexts('')).toEqual([]);
    expect(segmentTexts('   \n\n  \t\n')).toEqual([]);
  });

  // One case per non-prose category: the excluded token's identifier text must never surface as prose,
  // while any real prose in the same document still does (proving exclusion is scoped, not total).
  describe.each([
    ['verbatim listing block', '----\nzzqxblock\n----\n', 'zzqxblock'],
    ['inline monospace', 'Prose `zzqxmono` here.\n', 'zzqxmono'],
    ['attribute entry', ':zzqxattr: value\n\nProse.\n', 'zzqxattr'],
    ['attribute reference', 'Welcome to {zzqxref} today.\n', 'zzqxref'],
    ['inline set', 'Prose with {set:zzqxset:zzqxval} inside.\n', 'zzqxset'],
    ['bare URL link', 'Visit https://zzqxlink.test now\n', 'zzqxlink'],
    ['html entity', 'Tom &zzqxent; here\n', 'zzqxent'],
    ['block image macro', 'image::zzqximg.png[alt]\n\nProse.\n', 'zzqximg'],
    ['comment line', '// zzqxcomment note\n\nProse.\n', 'zzqxcomment'],
    ['table cols spec line', '[cols="2,1",options="zzqxhdr"]\n|===\n| A | B\n|===\n', 'zzqxhdr'],
    ['csv table data', '[format=csv]\n,===\nzzqxcsv,other\n,===\n', 'zzqxcsv'],
    ['dsv table data', '[format=dsv]\n:===\nzzqxdsv:other\n:===\n', 'zzqxdsv'],
    ['diagram declaration', '[graphviz, zzqxdiag, svg]\n----\ndigraph {}\n----\n', 'zzqxdiag'],
    ['single-character cross-reference', 'See <<x>> zzqxafter.\n', '>>'],
  ])('excludes %s', (_label, snippet, forbidden) => {
    test(`"${forbidden}" never appears as prose`, () => {
      expect(segmentTexts(snippet).join(' | ')).not.toContain(forbidden);
    });
  });

  describe('table markup', () => {
    const TABLE = '[cols="2,1",options="header"]\n|===\n| Name | Notes\n| a | b\n|===\n';

    test('keeps cell content but excludes the cols spec, fences, and every cell separator', () => {
      const joined = segmentTexts(TABLE).join(' | ');
      // Cell prose is still checked…
      expect(joined).toContain('Name');
      expect(joined).toContain('Notes');
      // …but none of the surrounding markup is. The grammar tokenizes only the ROW-LEADING pipe, so a
      // mid-row separator would otherwise leak into the prose handed to the checker.
      expect(joined).not.toContain('cols=');
      expect(joined).not.toContain('|===');
      expect(joined).not.toContain('|');
    });
  });

  describe('block markup never reaches the checker', () => {
    test.each([
      ['page break', 'Before.\n\n<<<\n\nAfter.\n', ['Before.', 'After.']],
      ['thematic break', "Before.\n\n'''\n\nAfter.\n", ['Before.', 'After.']],
      ['example fences', '====\nInside example.\n====\n', ['Inside example.']],
      ['sidebar fences', '****\nInside sidebar.\n****\n', ['Inside sidebar.']],
      ['quote fences', '____\nInside quote.\n____\n', ['Inside quote.']],
      ['open-block fences', '--\nInside open.\n--\n', ['Inside open.']],
      ['admonition block label', '[NOTE]\n====\nInside note.\n====\n', ['Inside note.']],
      ['admonition paragraph prefix', 'NOTE: inline admonition text.\n', ['inline admonition text.']],
      ['unordered list markers', '* item one\n* item two\n', ['item one\nitem two']],
      ['ordered list markers', '. first\n. second\n', ['first\nsecond']],
      ['checklist markers', '* [x] done thing\n* [ ] todo thing\n', ['done thing\ntodo thing']],
    ])('strips %s but keeps the prose', (_label, snippet, expected) => {
      expect(segmentTexts(snippet)).toEqual(expected);
    });
  });

  describe('no manufactured spacing (skipped markup must not invent lints)', () => {
    test('an inline skip does not leave a run of spaces behind', () => {
      // `In section <<install-guide>>.` used to extract as `In section  .` — the author's space plus
      // the separator space standing in for the cross-reference — which the checker reported as
      // "there are 2 spaces where there should be only one" against markup the author cannot fix.
      const [segment] = extractProseSegments(
        parse('In section <<install-guide>>.\n'),
        'In section <<install-guide>>.\n',
      );
      expect(segment.text).not.toMatch(/ {2}/);
      expect(segment.text).toBe('In section.');
    });

    test('a mid-sentence skip still separates the words around it', () => {
      const text = 'See <<install-guide>> for details.\n';
      const [segment] = extractProseSegments(parse(text), text);
      expect(segment.text).toBe('See for details.');
      expect(segment.text).not.toMatch(/ {2}/);
    });

    test('a skip never fuses the words on either side of it', () => {
      const text = 'Prose `zzqxmono` here.\n';
      const [segment] = extractProseSegments(parse(text), text);
      expect(segment.text).toBe('Prose here.');
    });

    test("does NOT silence the author's own spacing mistake", () => {
      // Only spacing left behind by REMOVED MARKUP is cleaned up. A genuine stray space before a
      // period is real prose the checker should still flag, so it must survive extraction.
      const text = 'Hello .\n';
      const [segment] = extractProseSegments(parse(text), text);
      expect(segment.text).toBe('Hello .');
    });
  });
});

describe('spanToDocumentRange', () => {
  test('maps a lint span in segment coords to an absolute document range', () => {
    const text = 'hello world\n';
    const [segment] = extractProseSegments(parse(text), text);
    // The span covering "world" (segment offsets 6..11) → document offsets 6..11.
    expect(spanToDocumentRange(segment, 6, 11)).toEqual({ from: 6, to: 11 });
    expect(text.slice(6, 11)).toBe('world');
  });

  test('lands on the intended characters in the SECOND segment of a multi-segment document', () => {
    const text = 'Before code.\n\n----\ncode\n----\n\nThe wolrd here.\n';
    const segments = extractProseSegments(parse(text), text);
    const second = segments.at(-1);
    const at = second.text.indexOf('wolrd');
    const { from, to } = spanToDocumentRange(second, at, at + 'wolrd'.length);
    expect(text.slice(from, to)).toBe('wolrd');
  });

  test('a span across a reconstructed role-span body maps to a range that includes the dropped markup', () => {
    const text = '[.underline]##O##nceword\n'; // renders "Onceword"
    const [segment] = extractProseSegments(parse(text), text);
    const at = segment.text.indexOf('Onceword');
    const { from, to } = spanToDocumentRange(segment, at, at + 'Onceword'.length);
    // The document slice spans the dropped `##…##` delimiters, so it is not literally "Onceword",
    // but it starts at the O and ends at the last body char.
    expect(text[from]).toBe('O');
    expect(text.slice(from, to)).toContain('nceword');
  });

  test('a zero-width span (an insertion point) maps to a non-inverted, zero-width range', () => {
    const text = 'hello world\n';
    const [segment] = extractProseSegments(parse(text), text);
    // Harper can report a zero-width span at a mid-segment insertion point (spanEnd === spanStart).
    const { from, to } = spanToDocumentRange(segment, 6, 6);
    expect(to).toBeGreaterThanOrEqual(from); // never inverted…
    expect(from).toBe(6); // …and anchored exactly at the insertion point
    expect(to).toBe(6);
  });

  test('a zero-width span at the very end of the segment maps just past the last prose char', () => {
    const text = 'hello world\n';
    const [segment] = extractProseSegments(parse(text), text);
    const end = segment.text.length; // one past the last mapped char
    const { from, to } = spanToDocumentRange(segment, end, end);
    expect(from).toBe(to);
    expect(from).toBe((segment.map.at(-1) ?? 0) + 1);
  });
});
