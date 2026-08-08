import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { Tree } from '@lezer/common';
import { extractProseSegments, spanToDocumentRange } from '@/lib/codemirror/prose-segments';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

// Build the parser from the grammar source (as the spellcheck/fold tests do): the generated
// `asciidoc-parser.js` is ESM the node-project Jest transform does not compile. extractProseSegments
// is a pure function over (tree, text), so no live editor/DOM is needed — this runs in the node project.
const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const parser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
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

  test('excludes the byline even when something precedes the title', () => {
    // The byline is excluded by NODE (the tokenizer emits AuthorLine/RevisionLine in header position),
    // not by counting lines from the top. A positional rule missed this shape entirely — a licence
    // comment above the title, and the author's name and email address were spell-checked.
    const text = '// Copyright 2026 Zyxwv\n= Guided Tour\nThe Zyxwv Team <hello@zyxwv.test>\n:p: v\n\nOrdinary prose.\n';
    const segments = segmentTexts(text);
    expect(segments.join(' | ')).not.toContain('Zyxwv');
    expect(segments.join(' | ')).not.toContain('hello@zyxwv.test');
    expect(segments).toEqual(['Ordinary prose.']);
  });

  test('a leading blank line does not expose the whole header to the checker', () => {
    // The checker-facing half of the tracker's leading-blank-line gap: with the header lost, the byline
    // and every entry it absorbed reached the spell/grammar checker as one prose segment.
    const text = '\n= Guided Tour\nThe Zyxwv Team <hello@zyxwv.test>\nv1.0\n:product-name: Zzqxbrand\n\nOrdinary prose.\n';
    const joined = segmentTexts(text).join(' | ');
    expect(joined).not.toContain('Zyxwv');
    expect(joined).not.toContain('Zzqxbrand');
    expect(segmentTexts(text)).toEqual(['Ordinary prose.']);
  });

  test.each([
    ['a leading blank line', '\n'],
    ['several leading blank lines', '\n\n'],
    ['a leading whitespace-only line', ' \n'],
    ['a leading block-attribute line', '[#custom-id]\n'],
  ])('excludes the byline and its entries with %s above the title', (_label, lead) => {
    // Asciidoctor skips blank lines and collects block metadata BEFORE it looks for the doctitle, so
    // all of these still have a real header. A leading EMPTY line used to lose it outright — the
    // grammar's `nl` has no exported term id, so it reached the context tracker as an unknown term and
    // ended the header before it began. The byline was then spell-checked and `:toclevels: 3` reached
    // the grammar checker as prose.
    const text = `${lead}= Guided Tour\nThe Zyxwv Team <hello@zyxwv.test>\nv1.0, 2026-07-18\n:toclevels: 3\n\nOrdinary prose.\n`;
    const segments = segmentTexts(text);
    expect(segments.join(' | ')).not.toContain('Zyxwv');
    expect(segments.join(' | ')).not.toContain('toclevels');
    expect(segments).toEqual(['Ordinary prose.']);
  });

  test('a leading blank line does not manufacture a header where there is none', () => {
    // The header rescue is keyed on reaching a level-0 title across only the lines that may precede
    // one; without such a title the answer must still be "no header", so body text stays checked.
    expect(segmentTexts('\nJane Doe writes here.\n:sub: teh value is wrong\n').join(' | '))
      .toContain('teh value is wrong');
  });

  test('a declined byline under a title reached across leading lines still shields its entries', () => {
    // The positional safety net has to survive the same leading lines the tokenizer does, or the two
    // disagree: here the byline is declined (too many words), so a paragraph absorbs the entry and no
    // AttributeEntry node is emitted for it.
    const text = '// Copyright 2026\n= T\nSome long prose that is not an author line.\n:a: Zzqxbrand\n\nBody.\n';
    const joined = segmentTexts(text).join(' | ');
    expect(joined).not.toContain('Zzqxbrand');
    expect(joined).toContain('Some long prose that is not an author line.');
  });

  test('a genuine first paragraph under the title IS checked', () => {
    // Nothing here is a byline: eight words fails the author-line predicate, so the tokenizer declines
    // it and the line stays an ordinary Paragraph. Blanking the two lines under a title by position
    // dropped this sentence from checking altogether.
    const text = '= T\nThis introductory sentence has a typoo in it.\n\nBody.\n';
    expect(segmentTexts(text).join(' | ')).toContain('typoo');
  });

  describe('attribute entries are configuration, never prose', () => {
    // Regression: a document header's entries reached the checker as prose and were spell-checked, so
    // `toclevels`, `sectnums`, `sectnumlevels` and the brand word `AsciidoCollab` were all underlined.
    // The AttributeEntry NODE was already skipped, but the block tokenizer emits it only where the line
    // OPENS a block — after the author byline the header is one paragraph, and a paragraph absorbs every
    // following line, so the entries parsed as ParagraphContinuation. They are excluded by position now.
    const HEADER = [
      '= Showcase Document',
      'Ada Zyxwv',
      'v1.0, 2026-07-26',
      ':toc: left',
      ':toclevels: 3',
      ':icons: font',
      ':experimental:',
      ':sectnums:',
      ':sectnumlevels: 3',
      ':stem:',
      ':product-name: AsciidoCollab',
      ':showcase-version: 1.0',
      '',
      'Ordinary prose.',
      '',
    ].join('\n');

    test('no entry of a full document header survives as prose', () => {
      expect(segmentTexts(HEADER)).toEqual(['Ordinary prose.']);
    });

    test.each([
      ['toc'], ['toclevels'], ['icons'], ['experimental'], ['sectnums'], ['sectnumlevels'],
      ['stem'], ['product-name'], ['AsciidoCollab'], ['showcase-version'],
    ])('"%s" never appears as prose', (token) => {
      expect(segmentTexts(HEADER).join(' | ')).not.toContain(token);
    });

    test('excludes an unset entry in either form', () => {
      expect(segmentTexts('Prose above.\n\n:sectnums!:\n:!zzqxunset:\n\nProse below.\n')).toEqual([
        'Prose above.',
        'Prose below.',
      ]);
    });

    test('excludes every line of a `\\`-wrapped value, not just the first', () => {
      const text = 'Prose above.\n\n:zzqxattr: firstpart \\\nzzqxcontinued\n\nProse below.\n';
      const joined = segmentTexts(text).join(' | ');
      expect(joined).not.toContain('zzqxattr');
      expect(joined).not.toContain('zzqxcontinued'); // the continuation line is value text too
      expect(segmentTexts(text)).toEqual(['Prose above.', 'Prose below.']);
    });

    test('an attribute-looking line inside a listing block is verbatim, not an entry', () => {
      // It must not be checked either way, but for the VERBATIM reason: the shared engine excludes
      // entries inside verbatim/comment blocks, so the masking never reaches into a code sample that
      // happens to document AsciiDoc syntax. (Prose AFTER such a block is separately lost to a
      // pre-existing tokenizer limitation — a block construct inside a listing body breaks the block —
      // so this case asserts only that the sample text never surfaces.)
      expect(segmentTexts('Prose above.\n\n----\n:zzqxsample: zzqxvalue\n----\n').join(' | '))
        .not.toContain('zzqx');
    });

    test('an INDENTED attribute-looking line is not treated as an entry', () => {
      // AsciiDoc has no indented attribute-entry form (the shared `ATTR_ENTRY_LINE_RE` is anchored at
      // column 0), so this line is not masked as one — masking it here would mean applying a rule the
      // preview and attribute-resolution layers do not.
      expect(segmentTexts('  :product-name: AsciidoCollab\n')).toEqual([':product-name: AsciidoCollab']);
    });

    test('a body line that merely contains a colon is still checked', () => {
      expect(segmentTexts('Note: this line has a colon but is ordinary prose.\n')).toEqual([
        'Note: this line has a colon but is ordinary prose.',
      ]);
    });
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

  // A delimited block's body is modelled as flat raw lines, so a listing NESTED inside a block whose
  // body IS prose (example / sidebar / quote / open / admonition) produces no node of its own. Without
  // a positional verbatim scan its code was checked as the outer block's prose.
  describe('verbatim content nested inside a prose-bodied block', () => {
    const NESTED = '====\nintro\n----\nzzqxnested teh notaword\n----\n====\n\nProse below.\n';

    test('the nested listing body never reaches the checker', () => {
      expect(segmentTexts(NESTED).join(' | ')).not.toContain('zzqxnested');
    });

    test('the surrounding prose still does', () => {
      expect(segmentTexts(NESTED)).toEqual(['intro', 'Prose below.']);
    });

    test.each([
      ['sidebar', '****'],
      ['quote', '____'],
      ['open', '--'],
    ])('a listing nested in a %s block is excluded too', (_label, fence) => {
      const text = `${fence}\nintro\n....\nzzqxnested\n....\n${fence}\n\nProse below.\n`;
      expect(segmentTexts(text).join(' | ')).not.toContain('zzqxnested');
    });

    test('a top-level listing is still excluded (unchanged)', () => {
      expect(segmentTexts('----\nzzqxtop\n----\n\nProse.\n').join(' | ')).not.toContain('zzqxtop');
    });
  });

  // An attribute entry is only an entry at a BLOCK BOUNDARY. The positional mask that rescues a
  // document header (where a declined byline reopens paragraph absorption) must not reach into the
  // body, where an attribute-shaped line inside a paragraph is ordinary prose the author can fix.
  describe('attribute-shaped lines in the body stay prose', () => {
    test('a `:name:` line inside a paragraph is still checked', () => {
      const text = 'Some prose here.\n:note: the ratio was mesured wrong\nMore prose.\n';
      expect(segmentTexts(text).join(' | ')).toContain('mesured');
    });

    test('a document with no header does not get header treatment', () => {
      // No level-0 title ⇒ no document header ⇒ nothing to rescue positionally.
      const text = 'Opening prose.\n:sub: teh value is wrong\n';
      expect(segmentTexts(text).join(' | ')).toContain('teh value is wrong');
    });

    test('the header itself is still excluded', () => {
      const text = '= T\nAda Zyxwv\nv1.0, 2026-07-26\n:product-name: Zzqxbrand\n\nReal prose.\n';
      expect(segmentTexts(text).join(' | ')).not.toContain('Zzqxbrand');
      expect(segmentTexts(text)).toEqual(['Real prose.']);
    });

    test('an entry at a body block boundary is excluded by its node, not by position', () => {
      const text = '= T\n\nProse.\n\n:zzqxbody: value\n\nMore prose.\n';
      expect(segmentTexts(text).join(' | ')).not.toContain('zzqxbody');
    });

    test('the header ends at the first BODY line, not at the first blank line', () => {
      // Asciidoctor's header is `title, entry*, author, entry*, [revision], entry*`, so `Body line.`
      // ends it — the `:note:` under it is paragraph continuation, ordinary prose. Running the mask on
      // to the first blank line swallowed that line and hid the typo, the very failure restricting the
      // mask to the header is meant to prevent.
      const text = '= T\nAda Zyxwv\nv1.0\nBody line.\n:note: the ratio was mesured wrong\n\nEnd.\n';
      const joined = segmentTexts(text).join(' | ');
      expect(joined).toContain('mesured');
      expect(joined).not.toContain('v1.0'); // the byline above it is still metadata
    });

    test('a byline followed by entries still shields every entry under it', () => {
      // The other direction: here the header really does run to the blank line, and the entries the
      // byline's paragraph absorbs must stay masked.
      const text = '= T\nAda Zyxwv\n:product-name: Zzqxbrand\n:toclevels: 3\n\nReal prose.\n';
      expect(segmentTexts(text)).toEqual(['Real prose.']);
    });

    test('a comment line inside the header does not end it', () => {
      const text = '= T\nAda Zyxwv\n// a note\n:product-name: Zzqxbrand\n\nReal prose.\n';
      expect(segmentTexts(text)).toEqual(['Real prose.']);
    });

    test('entries ABOVE the byline do not end the header, so the ones below stay masked', () => {
      // Asciidoctor consumes entries before reading the author line, and the tokenizer now agrees, so
      // this byline IS an AuthorLine and the entries below it are real `AttributeEntry` nodes. The
      // positional net still has to agree with that: ending the header at the byline is what once let
      // `:b:`/`:product-name:` reach the checker as prose, back when the byline was declined here.
      const text = '= T\n:a: 1\nAda Zyxwv\n:b: 2\n:product-name: Zzqxbrand\n\nBody.\n';
      const joined = segmentTexts(text).join(' | ');
      expect(joined).not.toContain('Zzqxbrand');
      expect(joined).not.toContain(':b: 2');
      expect(segmentTexts(text)).toContain('Body.');
    });

    test('a declined byline of ordinary words still shields the entries it absorbs', () => {
      // Five words fails the author-line predicate, so the tokenizer leaves this a Paragraph that
      // absorbs the entries below it. The line itself stays prose; the entries do not.
      const text = '= T\nJane Q Public Doe Smith\n:toclevels: 3\n:product-name: Zzqxbrand\n\nBody.\n';
      const joined = segmentTexts(text).join(' | ');
      expect(joined).toContain('Jane Q Public Doe Smith');
      expect(joined).not.toContain('toclevels');
      expect(joined).not.toContain('Zzqxbrand');
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
    if (!second) throw new Error('expected a second prose segment');
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
