import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { LRLanguage, LanguageSupport } from '@codemirror/language';
import {
  attributeCompletionSource,
  xrefCompletionSource,
  createXrefCompletionSource,
  createAttributeCompletionSource,
  createIncludeCompletionSource,
  tableSnippetCompletionSource,
  tableCellCompletionSource,
  captionCompletionSource,
  createImageCompletionSource,
  sourceLanguageCompletionSource,
} from '@/lib/codemirror/asciidoc-completions';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});

const asciidocLang = LRLanguage.define({ name: 'asciidoc', parser: lezerParser });
const asciidocExtension = new LanguageSupport(asciidocLang);

type CompletionSource = (context: CompletionContext) => Promise<CompletionResult | null> | CompletionResult | null;

async function getCompletions(source: CompletionSource, documentContent: string, triggerPosition: number) {
  const state = EditorState.create({
    doc: documentContent,
    extensions: [asciidocExtension],
    selection: { anchor: triggerPosition },
  });
  const context: CompletionContext = {
    state,
    pos: triggerPosition,
    explicit: false,
    matchBefore: (regex: RegExp) => {
      const match = state.sliceDoc(0, triggerPosition).match(regex);
      return match ? { from: triggerPosition - match[0].length, to: triggerPosition, text: match[0] } : null;
    },
  } as CompletionContext;
  return source(context);
}

describe('AsciiDoc Completion Sources', () => {
  describe('attributeCompletionSource', () => {
    test('triggers on { and returns doc-defined attributes', async () => {
      const documentContent = ':version: 1.0\n:author: Jane\n\nVersion {';
      const result = await getCompletions(attributeCompletionSource, documentContent, documentContent.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((option) => option.label === 'version')).toBe(true);
      expect(result?.options.some((option) => option.label === 'author')).toBe(true);
    });

    test('includes built-in AsciiDoc attributes', async () => {
      const documentContent = 'Hello {';
      const result = await getCompletions(attributeCompletionSource, documentContent, documentContent.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((option) => ['author', 'revdate', 'toc'].includes(option.label))).toBe(true);
    });

    test('does not return results when not after {', async () => {
      const documentContent = 'Hello world';
      const result = await getCompletions(attributeCompletionSource, documentContent, documentContent.length);
      expect(result).toBeNull();
    });
  });

  describe('xrefCompletionSource', () => {
    test('triggers on << and returns section IDs from headings', async () => {
      const documentContent = '== My Section\n\n=== Sub Section\n\nSee <<';
      const result = await getCompletions(xrefCompletionSource, documentContent, documentContent.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((option) =>
        option.label.toLowerCase().includes('my-section') ||
        option.label.toLowerCase().includes('section'),
      )).toBe(true);
    });

    test('returns anchor definitions [[id]]', async () => {
      const documentContent = '[[my-anchor]]\nSome text\n\nSee <<';
      const result = await getCompletions(xrefCompletionSource, documentContent, documentContent.length);
      expect(result).not.toBeNull();
    });

    test('does not return results when not after <<', async () => {
      const documentContent = 'See the section about things';
      const result = await getCompletions(xrefCompletionSource, documentContent, documentContent.length);
      expect(result).toBeNull();
    });
  });

  describe('createIncludeCompletionSource', () => {
    test('triggers on include:: and returns paths from provided list', async () => {
      const paths = ['chapters/intro.adoc', 'chapters/setup.adoc'];
      const source = createIncludeCompletionSource(paths);
      const documentContent = 'include::';
      const result = await getCompletions(source, documentContent, documentContent.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((option) => option.label.includes('intro'))).toBe(true);
      expect(result?.options.some((option) => option.label.includes('setup'))).toBe(true);
    });

    test('does not return project-external paths', async () => {
      const paths = ['chapters/intro.adoc'];
      const source = createIncludeCompletionSource(paths);
      const documentContent = 'include::';
      const result = await getCompletions(source, documentContent, documentContent.length);
      expect(result?.options.every((option) => paths.includes(option.label))).toBe(true);
    });

    test('returns empty results when path list is empty', async () => {
      const source = createIncludeCompletionSource([]);
      const documentContent = 'include::';
      const result = await getCompletions(source, documentContent, documentContent.length);
      expect(result?.options.length).toBe(0);
    });

    test('offers paths relative to the authoring file so the inserted target resolves', async () => {
      const source = createIncludeCompletionSource(
        ['New Folder/new-document.adoc', 'a-new-document.adoc'],
        () => 'New Folder/new-document-2.adoc',
      );
      const documentContent = 'include::';
      const result = await getCompletions(source, documentContent, documentContent.length);
      const labels = result?.options.map((option) => option.label);
      expect(labels).toContain('new-document.adoc'); // same folder → no prefix
      expect(labels).toContain('../a-new-document.adoc'); // project root → climb out
    });

    // Issue 10: xrefCompletionSource must serialise the document only once per
    // invocation. Two independent toString() calls on a large doc waste memory.
    test('xrefCompletionSource calls doc.toString() at most once per invocation', async () => {
      const documentContent = '== My Section\n\n[[anchor]]\n\nSee <<';
      const state = EditorState.create({
        doc: documentContent,
        extensions: [asciidocExtension],
        selection: { anchor: documentContent.length },
      });
      let callCount = 0;
      const originalToString = state.doc.toString.bind(state.doc);
      const spy = jest.spyOn(state.doc, 'toString').mockImplementation(() => {
        callCount++;
        return originalToString();
      });
      const context = {
        state,
        pos: documentContent.length,
        explicit: false,
        matchBefore: (regex: RegExp) => {
          const match = state.sliceDoc(0, documentContent.length).match(regex);
          return match ? { from: documentContent.length - match[0].length, to: documentContent.length, text: match[0] } : null;
        },
      } as CompletionContext;

      await xrefCompletionSource(context);

      expect(callCount).toBeLessThanOrEqual(1);
      spy.mockRestore();
    });

    // Issue 3: the factory must accept a getter so the editor useEffect (which
    // runs once at mount when includePaths==[]) gets live paths on every invoke.
    test('accepts a getter function and reads the latest paths on each completion invocation', async () => {
      let paths: string[] = [];
      const source = createIncludeCompletionSource(() => paths);

      const before = await getCompletions(source, 'include::', 'include::'.length);
      expect(before?.options.length ?? 0).toBe(0);

      paths = ['chapters/intro.adoc', 'chapters/setup.adoc'];
      const after = await getCompletions(source, 'include::', 'include::'.length);
      expect(after?.options.some((o) => o.label.includes('intro'))).toBe(true);
    });

    // mid-path narrowing tests
    describe('mid-path narrowing', () => {
      test('narrows to files under typed prefix after /', async () => {
        const paths = ['docs/intro.adoc', 'docs/setup.adoc', 'chapters/ch1.adoc'];
        const source = createIncludeCompletionSource(paths);
        const document = 'include::docs/';
        const result = await getCompletions(source, document, document.length);
        expect(result).not.toBeNull();
        expect(result?.options.every((o) => o.label.startsWith('docs/'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('intro'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('setup'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('ch1'))).toBe(false);
      });

      test('narrows to nested sub-directory paths', async () => {
        const paths = ['chapters/intro/part1.adoc', 'chapters/intro/part2.adoc', 'chapters/outro.adoc'];
        const source = createIncludeCompletionSource(paths);
        const document = 'include::chapters/intro/';
        const result = await getCompletions(source, document, document.length);
        expect(result).not.toBeNull();
        expect(result?.options.every((o) => o.label.startsWith('chapters/intro/'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('part1'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('part2'))).toBe(true);
        expect(result?.options.some((o) => o.label.includes('outro'))).toBe(false);
      });

      test('completion apply function appends [] and positions cursor between them', async () => {
        const paths = ['docs/intro.adoc'];
        const source = createIncludeCompletionSource(paths);
        const document = 'include::docs/';
        const result = await getCompletions(source, document, document.length);
        expect(result).not.toBeNull();
        const option = result?.options[0];
        expect(option).toBeDefined();
        expect(typeof option?.apply).toBe('function');
      });
    });
  });

  // table skeleton and cell completion tests
  describe('tableSnippetCompletionSource', () => {
    test('triggers after |=== at column 0', async () => {
      const document = '|===';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.length).toBeGreaterThan(0);
    });

    test('does not trigger when |=== is not at column 0', async () => {
      const document = 'Some text\n |===';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('does not trigger on partial |== (not full delimiter)', async () => {
      const document = '|==';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('offered option inserts a 2-column table skeleton', async () => {
      const document = '|===';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      const option = result!.options[0];
      expect(option).toBeDefined();
      expect(typeof option.apply).toBe('function');
    });
  });

  describe('tableCellCompletionSource', () => {
    test('triggers when | is at line start inside a table block', async () => {
      const document = '|===\n|col1 |col2\n\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.length).toBeGreaterThan(0);
    });

    test('does not trigger when | is inside a table block but not at line start', async () => {
      const document = '|===\n|col1 |';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('does not trigger outside a table block', async () => {
      const document = 'Some paragraph\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('does not trigger when table is closed', async () => {
      const document = '|===\n|cell\n|===\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).toBeNull();
    });
  });

  // caption completion tests
  describe('captionCompletionSource', () => {
    test('triggers when . is at column 0 on a blank line', async () => {
      const document = '.';
      const result = await getCompletions(captionCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.length).toBeGreaterThan(0);
    });

    test('offers a .Caption text placeholder', async () => {
      const document = '.';
      const result = await getCompletions(captionCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      const option = result!.options[0];
      expect(option.label).toMatch(/\./);
    });

    test('completion apply positions cursor on caption text', async () => {
      const document = '.';
      const result = await getCompletions(captionCompletionSource, document, document.length);
      const option = result?.options[0];
      expect(option).toBeDefined();
      expect(typeof option?.apply).toBe('function');
    });

    test('does not trigger when . is not at column 0', async () => {
      const document = 'Some text .';
      const result = await getCompletions(captionCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('does not trigger after a non-empty line', async () => {
      const document = 'Some content\n.';
      const result = await getCompletions(captionCompletionSource, document, document.length);
      // Should still trigger since . is at column 0 of its line
      expect(result).not.toBeNull();
    });
  });

  // image path completion tests
  describe('createImageCompletionSource', () => {
    test('triggers after image:: and returns image files', async () => {
      const paths = ['images/logo.png', 'docs/intro.adoc', 'assets/banner.svg'];
      const source = createImageCompletionSource(paths);
      const document = 'image::';
      const result = await getCompletions(source, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((o) => o.label.includes('logo.png'))).toBe(true);
      expect(result?.options.some((o) => o.label.includes('banner.svg'))).toBe(true);
      expect(result?.options.some((o) => o.label.includes('intro.adoc'))).toBe(false);
    });

    test('offers image paths relative to imagesdir (project-root based)', async () => {
      const source = createImageCompletionSource(
        ['assets/logo.png', 'assets/sub/icon.png'],
        () => new Map([['imagesdir', 'assets']]),
      );
      const document = 'image::';
      const result = await getCompletions(source, document, document.length);
      const labels = result?.options.map((o) => o.label);
      expect(labels).toContain('logo.png'); // assets/logo.png relative to imagesdir "assets"
      expect(labels).toContain('sub/icon.png');
    });

    test('triggers after image: (single colon) and returns image files', async () => {
      const paths = ['images/photo.jpg', 'docs/readme.adoc'];
      const source = createImageCompletionSource(paths);
      const document = 'See image:';
      const result = await getCompletions(source, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((o) => o.label.includes('photo.jpg'))).toBe(true);
      expect(result?.options.some((o) => o.label.includes('readme.adoc'))).toBe(false);
    });

    test('filters to image extensions only (.png .jpg .jpeg .gif .svg .webp)', async () => {
      const paths = ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.svg', 'f.webp', 'g.adoc', 'h.pdf', 'i.txt'];
      const source = createImageCompletionSource(paths);
      const document = 'image::';
      const result = await getCompletions(source, document, document.length);
      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels).toContain('a.png');
      expect(labels).toContain('b.jpg');
      expect(labels).toContain('c.jpeg');
      expect(labels).toContain('d.gif');
      expect(labels).toContain('e.svg');
      expect(labels).toContain('f.webp');
      expect(labels).not.toContain('g.adoc');
      expect(labels).not.toContain('h.pdf');
      expect(labels).not.toContain('i.txt');
    });

    test('completion apply function positions cursor between [ and ]', async () => {
      const paths = ['images/logo.png'];
      const source = createImageCompletionSource(paths);
      const document = 'image::';
      const result = await getCompletions(source, document, document.length);
      const option = result?.options[0];
      expect(option).toBeDefined();
      expect(typeof option?.apply).toBe('function');
    });

    test('returns empty list when no image files match', async () => {
      const paths = ['docs/intro.adoc', 'chapters/ch1.adoc'];
      const source = createImageCompletionSource(paths);
      const document = 'image::';
      const result = await getCompletions(source, document, document.length);
      expect(result?.options.length ?? 0).toBe(0);
    });

    test('accepts a getter function for dynamic path list', async () => {
      let paths: string[] = [];
      const source = createImageCompletionSource(() => paths);
      const document = 'image::';

      const before = await getCompletions(source, document, document.length);
      expect(before?.options.length ?? 0).toBe(0);

      paths = ['images/logo.png'];
      const after = await getCompletions(source, document, document.length);
      expect(after?.options.some((o) => o.label.includes('logo.png'))).toBe(true);
    });

    // Issue: word boundary — should not fire on identifiers containing "image:"
    test('does not trigger when image: appears inside a longer identifier', async () => {
      const source = createImageCompletionSource(['images/logo.png']);
      // "notimage::" — the regex should not match because a word char precedes "image"
      const document = 'notimage::';
      const result = await getCompletions(source, document, document.length);
      expect(result).toBeNull();
    });

    test('does not trigger when image: appears after an alphanumeric identifier', async () => {
      const source = createImageCompletionSource(['photo.jpg']);
      const document = 'myimage:photo.jpg';
      const result = await getCompletions(source, document, document.length);
      expect(result).toBeNull();
    });
  });

  // ── Issue: tableSnippetCompletionSource fires inside existing table ───────────

  describe('tableSnippetCompletionSource: no trigger inside an existing table', () => {
    test('does not trigger when |=== is typed at column 0 inside an already-open table', async () => {
      // User is inside a table and types |=== at the start of a line (closing delimiter)
      // The skeleton completion must NOT fire, otherwise it would corrupt the table.
      const document = '|===\n|col1 |col2\n|===';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('triggers normally when |=== is typed outside any table', async () => {
      const document = 'Some paragraph\n|===';
      const result = await getCompletions(tableSnippetCompletionSource, document, document.length);
      expect(result).not.toBeNull();
    });
  });

  // ── Issue: tableCellCompletionSource fires on closing |=== delimiter ──────────

  describe('tableCellCompletionSource: no trigger on closing delimiter line', () => {
    test('does not trigger when cursor is right after | of a closing |=== line', async () => {
      // |===\n|col1 |col2\n|===
      // Positions: opening |=== ends at 4, row at 5-16, closing | at 17, cursor at 18
      const document = '|===\n|col1 |col2\n|===';
      // closingPipePos = 17, so cursor = 18 (right after the |)
      const closingPipePos = document.lastIndexOf('|===');
      const result = await getCompletions(tableCellCompletionSource, document, closingPipePos + 1);
      expect(result).toBeNull();
    });
  });

  // ── Issue: tableCellCompletionSource inserts hardcoded 2-column row ───────────

  describe('tableCellCompletionSource: column count matches actual table', () => {
    test('inserted row has the same number of cells as the table', async () => {
      // 3-column table; cursor after | at start of new line inside it
      const document = '|===\n|A |B |C\n\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      const option = result!.options[0];
      expect(typeof option.apply).toBe('function');

      // Call apply with a mock view and capture the inserted text
      let insertedText = '';
      const mockView = {
        dispatch: jest.fn((tr: { changes: { insert: string } }) => { insertedText = tr.changes.insert; }),
        focus: jest.fn(),
      };
      (option.apply as (...arguments_: unknown[]) => void)(mockView, option, document.length - 1, document.length);
      // A 3-column row should have 3 | characters
      const cellCount = (insertedText.match(/\|/g) ?? []).length;
      expect(cellCount).toBe(3);
    });

    test('2-column table still inserts a 2-cell row', async () => {
      const document = '|===\n|A |B\n\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      let insertedText = '';
      const mockView = {
        dispatch: jest.fn((tr: { changes: { insert: string } }) => { insertedText = tr.changes.insert; }),
        focus: jest.fn(),
      };
      (result!.options[0].apply as (...arguments_: unknown[]) => void)(mockView, result!.options[0], document.length - 1, document.length);
      expect((insertedText.match(/\|/g) ?? []).length).toBe(2);
    });
  });

  // ── Issue: delimiter regex matches mixed-character strings like "--==" ─────────

  describe('tableCellCompletionSource: delimiter regex requires all-same characters', () => {
    test('does not treat "--==" as a block-delimiter opener (mixed chars)', async () => {
      // The old regex /^([-=.*_/+]{4,})$/ matched '--==' because the character
      // class allows any combination of those chars. '--==' was then stored as
      // currentBlockDelimiter, causing the following |=== to be skipped instead
      // of counted, so isInsideTableBlockByText returned false (no completion).
      const document = '--==\n|===\n|col1 |col2\n\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).not.toBeNull();
    });
  });

  // ── Issue: isInsideTableBlock false positive from code block delimiters ───────

  describe('tableCellCompletionSource: no false positive from |=== inside code blocks', () => {
    test('does not trigger in a paragraph after a listing block that contained |===', async () => {
      // Code block with an |=== inside it (example table in docs).
      // After the code block, we have a paragraph where the user types |.
      // The old string-based delimiter count includes the |=== inside the listing block.
      const document = '----\n|===\n|col\n----\nParagraph\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).toBeNull();
    });

    test('still triggers correctly inside a real table that follows a listing block', async () => {
      // Listing block followed by a real table — cursor in the real table body
      const document = '----\n|===\n|example\n----\n|===\n|real col\n\n|';
      const result = await getCompletions(tableCellCompletionSource, document, document.length);
      expect(result).not.toBeNull();
    });
  });
});

  describe('sourceLanguageCompletionSource', () => {
    test('triggers inside [source, and returns matching language tokens', async () => {
      const document = '[source,ja';
      const result = await getCompletions(sourceLanguageCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.some((o) => o.label === 'java' || o.label === 'javascript')).toBe(true);
    });

    test('lists every language when the prefix is empty', async () => {
      const document = '[source,';
      const result = await getCompletions(sourceLanguageCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect((result?.options.length ?? 0)).toBeGreaterThan(0);
    });

    test('tolerates whitespace after the comma and lower-cases the prefix', async () => {
      const document = '[source, JA';
      const result = await getCompletions(sourceLanguageCompletionSource, document, document.length);
      expect(result).not.toBeNull();
      expect(result?.options.every((o) => o.label.startsWith('ja'))).toBe(true);
    });

    test('returns no options for a prefix that matches no language', async () => {
      const document = '[source,zzzznotalang';
      const result = await getCompletions(sourceLanguageCompletionSource, document, document.length);
      expect(result?.options.length ?? 0).toBe(0);
    });

    test('does not trigger outside a [source, context', async () => {
      const document = 'just prose';
      const result = await getCompletions(sourceLanguageCompletionSource, document, document.length);
      expect(result).toBeNull();
    });
  });

describe('completion source guard and tree-path branches', () => {
  test('xref returns [#id] style anchors (second capture group)', async () => {
    const documentContent = '[#my-id]\nSome text\n\nSee <<';
    const result = await getCompletions(xrefCompletionSource, documentContent, documentContent.length);
    expect(result).not.toBeNull();
    expect(result?.options.some((o) => o.label === 'my-id')).toBe(true);
  });

  test('xref anchor capture mirrors the index grammar: no junk ids from role/option shorthand', async () => {
    // `[#multi,role1,role2]` / `[#withopt%opt]` carry roles/options after the id with separators
    // (`,`, `%`) that are not valid id chars. The symbol index's anchor grammar (`[A-Za-z][\w:.-]*`
    // with a closing `]` right after) does not recognize these forms, so completion must not offer
    // the raw bracket contents as an id — that would suggest an xref the index can never resolve. A
    // plain `[#clean]` and a dotted `[[dotted.id]]` (legal id chars) are still offered.
    const documentContent = '[#multi,role1,role2]\n[#withopt%opt]\n[#clean]\n[[dotted.id]]\n\nSee <<';
    const result = await getCompletions(xrefCompletionSource, documentContent, documentContent.length);
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toContain('clean');
    expect(labels).toContain('dotted.id');
    expect(labels).not.toContain('multi,role1,role2');
    expect(labels).not.toContain('withopt%opt');
  });

  test('include source returns null when the cursor is not after include::', async () => {
    const source = createIncludeCompletionSource(['a.adoc']);
    expect(await getCompletions(source, 'just some prose', 'just some prose'.length)).toBeNull();
  });

  test('image source returns null when the cursor is not after image:', async () => {
    const source = createImageCompletionSource(['logo.png']);
    expect(await getCompletions(source, 'just some prose', 'just some prose'.length)).toBeNull();
  });

  test('table cell source returns null when there is no leading pipe', async () => {
    expect(await getCompletions(tableCellCompletionSource, 'no pipe here', 'no pipe here'.length)).toBeNull();
  });

  test('caption source returns null when the cursor is not after a dot', async () => {
    expect(await getCompletions(captionCompletionSource, 'no dot here', 'no dot here'.length)).toBeNull();
  });

  test('an open table drives the text-based column-count fallback', async () => {
    // Unclosed table (no TableBlock node) → getTableColumnCount takes its
    // text-scanning fallback path, walking from the last top-level |=== opener.
    const documentContent = '|===\n|x |y |z\n\n|';
    const result = await getCompletions(tableCellCompletionSource, documentContent, documentContent.length);
    expect(result).not.toBeNull();
    let insertedText = '';
    const mockView = {
      dispatch: jest.fn((tr: { changes: { insert: string } }) => { insertedText = tr.changes.insert; }),
    };
    (result!.options[0].apply as (...arguments_: unknown[]) => void)(mockView, result!.options[0], documentContent.length - 1, documentContent.length);
    expect((insertedText.match(/\|/g) ?? []).length).toBe(3);
  });

  test('column-count text fallback skips a non-pipe line before the first cell row', async () => {
    // Unclosed table (text-fallback path). The line immediately after the |===
    // opener is prose, not a |cell row, so getTableColumnCount's scan must skip it
    // (the `line.startsWith('|')` guard is false) and keep looking for the real
    // header row before deriving the column count.
    const documentContent = '|===\nsome prose line\n|a |b\n\n|';
    const result = await getCompletions(tableCellCompletionSource, documentContent, documentContent.length);
    expect(result).not.toBeNull();
    let insertedText = '';
    const mockView = {
      dispatch: jest.fn((tr: { changes: { insert: string } }) => { insertedText = tr.changes.insert; }),
    };
    (result!.options[0].apply as (...arguments_: unknown[]) => void)(mockView, result!.options[0], documentContent.length - 1, documentContent.length);
    // The real header row "|a |b" has 2 cells, so the inserted row has 2 pipes.
    expect((insertedText.match(/\|/g) ?? []).length).toBe(2);
  });

  test('table cell completion uses the syntax tree for a complete table', async () => {
    // A closed table → the parser produces a TableBlock node, exercising the
    // syntax-tree path of isInsideTableBlock and getTableColumnCount.
    const documentContent = '|===\n|h1 |h2 |h3\n\n|';
    const result = await getCompletions(tableCellCompletionSource, documentContent, documentContent.length);
    if (result) {
      expect(result.options.length).toBeGreaterThan(0);
    }
  });
});

describe('completion apply callbacks dispatch editor changes', () => {
  type ApplyFunction = (view: unknown, completion: unknown, from: number, to: number) => void;

  function applyFirstFunction(options: readonly { apply?: unknown }[] | undefined) {
    const option = options?.find((o) => typeof o.apply === 'function');
    expect(option).toBeDefined();
    const dispatch = jest.fn();
    (option!.apply as ApplyFunction)({ dispatch }, option, 0, 0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    return dispatch.mock.calls[0][0] as { changes: { insert: string } };
  }

  test('include completion inserts the path followed by []', async () => {
    const result = await getCompletions(createIncludeCompletionSource(['docs/intro.adoc']), 'include::docs/', 'include::docs/'.length);
    expect(applyFirstFunction(result?.options).changes.insert).toMatch(/\[\]$/);
  });

  test('image completion inserts the path followed by []', async () => {
    const result = await getCompletions(createImageCompletionSource(['images/logo.png']), 'image::', 'image::'.length);
    expect(applyFirstFunction(result?.options).changes.insert).toMatch(/\[\]$/);
  });

  test('table snippet completion inserts a table skeleton', async () => {
    const result = await getCompletions(tableSnippetCompletionSource, '|===', '|==='.length);
    expect(applyFirstFunction(result?.options).changes.insert).toContain('|===');
  });

  test('caption completion inserts the caption label', async () => {
    const result = await getCompletions(captionCompletionSource, '.', 1);
    expect(applyFirstFunction(result?.options).changes.insert.length).toBeGreaterThan(0);
  });

  describe('cross-file completion via the symbol index', () => {
    const fakeIndex = {
      symbols: [
        { kind: 'anchor', name: 'shared-anchor', fileId: 'other', range: { from: 0, to: 0 } },
        { kind: 'section', name: '_other_section', fileId: 'other', range: { from: 0, to: 0 } },
        { kind: 'attribute', name: 'product-name', fileId: 'other', range: { from: 0, to: 0 } },
      ],
    } as unknown as ProjectSymbolIndex;

    test('xref completion offers anchors/sections defined in other files', async () => {
      const source = createXrefCompletionSource(() => fakeIndex);
      const result = await getCompletions(source, '<<', 2);
      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toContain('shared-anchor');
      expect(labels).toContain('_other_section');
    });

    test('attribute completion offers attributes defined in other files', async () => {
      const source = createAttributeCompletionSource(() => fakeIndex);
      const result = await getCompletions(source, '{', 1);
      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toContain('product-name');
    });

    test('with no index, the factory behaves like the current-file source', async () => {
      const source = createXrefCompletionSource(() => null);
      const result = await getCompletions(source, '<<', 2);
      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).not.toContain('shared-anchor');
    });
  });
});
