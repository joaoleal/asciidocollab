import type { InputStream, Stack } from '@lezer/lr';
import { ExternalTokenizer } from '@lezer/lr';
import { Tree } from '@lezer/common';
import { blockTokenizer } from '@/lib/codemirror/asciidoc-block-tokens';
import { asciidocLanguage } from '@/lib/codemirror/asciidoc-language';
import { createBlockTokenLogic } from '@/lib/codemirror/asciidoc-block-token-logic';
import { BODY, HEADER_AFTER_TITLE, HEADER_AFTER_AUTHOR } from '@/lib/codemirror/asciidoc-block-context-logic';

/**
 * Wiring test for `asciidoc-block-tokens.ts`. The jest transform loads the generated
 * `asciidoc-parser.terms.js`, so the production `blockTokenizer` (the shared block-token
 * logic bound to the real term-id map) is imported directly. The production parser that
 * embeds it lives in `asciidoc-language.ts`; parsing a heading through it proves the
 * tokenizer is wired in and emits block tokens.
 *
 * The branch-coverage block below drives `createBlockTokenLogic` directly through a mock
 * `InputStream`/`Stack`, so every block-detection path in the shared logic is exercised
 * deterministically (the full parser would need carefully crafted documents and a live
 * scheduler to reach the same branches).
 */

describe('blockTokenizer', () => {
  test('is an ExternalTokenizer instance', () => {
    expect(blockTokenizer).toBeInstanceOf(ExternalTokenizer);
  });

  test('the production parser (which embeds it) tokenizes a heading', () => {
    const source = String.raw`= Document Title

Body text.
`;
    const tree = asciidocLanguage.parser.parse(source);
    expect(tree).toBeInstanceOf(Tree);

    const nodeNames = new Set<string>();
    tree.iterate({
      enter: (node) => {
        nodeNames.add(node.name);
      },
    });
    expect(nodeNames.size).toBeGreaterThan(1);
  });
});

// ── Direct, mock-driven coverage of createBlockTokenLogic ──────────────────────

// Every external token name from `asciidoc.grammar` mapped to a unique non-zero id.
// The accepted id is reverse-mapped back to a name so assertions read by token name.
const TOKEN_NAMES = [
  'docTitleToken',
  'heading1Token', 'heading2Token', 'heading3Token', 'heading4Token', 'heading5Token',
  'attrEntryToken',
  'commentBlockDelim', 'commentLineToken', 'admonitionLineToken', 'blockMacroToken', 'descListToken',
  'admonNoteLineToken', 'admonTipLineToken', 'admonWarningLineToken', 'admonImportantLineToken', 'admonCautionLineToken',
  'admonNoteAttrToken', 'admonTipAttrToken', 'admonWarningAttrToken', 'admonImportantAttrToken', 'admonCautionAttrToken',
  'listingDelim', 'literalDelim', 'exampleDelim', 'sidebarDelim', 'quoteDelim', 'passthroughDelim',
  'openDelim', 'tableDelim', 'csvTableDelim', 'dsvTableDelim',
  'stemAttrToken', 'admonAttrToken',
  'conditionalToken', 'blockAttrToken',
  'checkDoneMarker', 'checkTodoMarker', 'unorderedMarker', 'orderedMarker',
  'inlineMacroToken', 'footnoteToken',
  'blockTitleToken',
  'thematicBreakToken', 'pageBreakToken', 'hardBreakToken',
  'continuationLineToken', 'paragraphLineToken',
  'authorLineToken', 'revisionLineToken',
];

const TERMS: Record<string, number> = Object.fromEntries(
  TOKEN_NAMES.map((name, index) => [name, index + 1]),
);
const ID_TO_NAME = new Map<number, string>(
  TOKEN_NAMES.map((name, index) => [index + 1, name]),
);

interface MockResult {
  token: string | null;
  // Position of the read cursor when acceptToken was called (relative to doc start).
  acceptedAt: number;
}

/**
 * Run the shared logic over `documentContent` with the read cursor starting at `startPos`.
 *
 * `canShift` controls `Stack.canShift`, which every BLOCK-start branch now consults through
 * `acceptBlockToken` (not just the paragraph/continuation/blank-line branches): a block construct is
 * only tokenized where the parser could actually attach it, so a delimited block's verbatim body no
 * longer has its content read as constructs.
 *
 * The default models a parser at a BLOCK BOUNDARY — the position these line-recognition tests
 * describe — so every block token may start here, while `paragraphLineToken`/`continuationLineToken`
 * may NOT: those two shift only mid-paragraph / inside a list item, and admitting them would absorb
 * every line as continuation text before any block branch is reached. Pass an explicit `canShift` to
 * model a restricted position (mid-paragraph, inside a list item, or inside a delimited block body).
 *
 * `context` is the second gate, and the one that decides the byline: `Stack.context` carries the
 * document-header state (see `asciidoc-block-context-logic.ts`), and the author/revision branches
 * demand `HEADER_AFTER_TITLE` / `HEADER_AFTER_AUTHOR`. It defaults to `BODY`, the ordinary
 * everywhere-else position, so a name-shaped line at a generic block boundary stays prose.
 */
function runLogic(
  documentContent: string,
  options: { startPos?: number; canShift?: (term: number) => boolean; context?: number } = {},
): MockResult {
  const startPos = options.startPos ?? 0;
  const context = options.context ?? BODY;
  const canShift =
    options.canShift ??
    ((term) =>
      term !== TERMS['paragraphLineToken'] && term !== TERMS['continuationLineToken']);
  const codes = [...documentContent].map((char) => char.codePointAt(0) ?? 0);
  let pos = startPos;
  let accepted: number | null = null;
  let acceptedAt = -1;

  const peek = (offset: number): number => {
    const index = pos + offset;
    if (index < 0 || index >= codes.length) return -1;
    return codes[index];
  };

  const input: InputStream = {
    get next(): number {
      return pos >= codes.length ? -1 : codes[pos];
    },
    get pos(): number {
      return pos;
    },
    peek,
    advance(): number {
      pos++;
      return pos >= codes.length ? -1 : codes[pos];
    },
    acceptToken(term: number, endOffset = 0): void {
      accepted = term;
      acceptedAt = pos + endOffset;
    },
  } as unknown as InputStream;

  const stack: Stack = {
    canShift(term: number): boolean {
      return canShift(term);
    },
    get context(): number {
      return context;
    },
  } as unknown as Stack;

  const logic = createBlockTokenLogic(TERMS);
  logic(input, stack);

  return {
    token: accepted === null ? null : (ID_TO_NAME.get(accepted) ?? null),
    acceptedAt,
  };
}

describe('createBlockTokenLogic block detection', () => {
  // ── Hard line break ──────────────────────────────────────────────────────────
  test('hard break: space + `+` at end of line', () => {
    expect(runLogic('a +\n', { startPos: 2 }).token).toBe('hardBreakToken');
  });

  test('hard break: tab + `+` at end of document', () => {
    expect(runLogic('a\t+', { startPos: 2 }).token).toBe('hardBreakToken');
  });

  test('`+` not preceded by whitespace is not a hard break', () => {
    expect(runLogic('a+\n', { startPos: 1 }).token).toBeNull();
  });

  test('`+` preceded by space but not at line end is not a hard break', () => {
    expect(runLogic('a + b\n', { startPos: 2 }).token).toBeNull();
  });

  // ── Line-start / paragraph gates ───────────────────────────────────────────────
  test('not at line start: returns without a token', () => {
    expect(runLogic('xy\n', { startPos: 1 }).token).toBeNull();
  });

  test('at EOF immediately: returns without a token', () => {
    expect(runLogic('', { startPos: 0 }).token).toBeNull();
  });

  test('mid-paragraph line (canShift paragraphLineToken) consumes line as paragraph', () => {
    const result = runLogic('= Heading\n', {
      canShift: (term) => term === TERMS.paragraphLineToken,
    });
    expect(result.token).toBe('paragraphLineToken');
  });

  // A delimited-block delimiter ends an open paragraph even when a continuation is shiftable
  // (Asciidoctor `block_terminates_paragraph`): it must NOT be absorbed but emit its delim token.
  describe('delimited-block delimiter terminates an open paragraph (not absorbed)', () => {
    // Mid-paragraph, but modelled the way the REAL `Stack.canShift` behaves: it simulates reductions,
    // so with a paragraph open the parser can both continue it (`paragraphLineToken`) AND reduce it to
    // start a new block — every block-start term is shiftable here. Only `continuationLineToken` is
    // not (that shifts inside a list item / description entry, which this position is not). Asserted
    // against the real parser: `prose\n****\nbody\n****` yields `Paragraph` + `SidebarBlock`, and
    // `prose\nendif::[]` yields `Paragraph` + `Conditional`.
    const inParagraph = { canShift: (term: number) => term !== TERMS['continuationLineToken'] };
    const expectDelim = (line: string, token: string) =>
      expect(runLogic(line, inParagraph).token).toBe(token);

    test('**** → sidebarDelim', () => expectDelim('****\n', 'sidebarDelim'));
    test('==== → exampleDelim', () => expectDelim('====\n', 'exampleDelim'));
    test('---- → listingDelim', () => expectDelim('----\n', 'listingDelim'));
    test('.... → literalDelim', () => expectDelim('....\n', 'literalDelim'));
    test('____ → quoteDelim', () => expectDelim('____\n', 'quoteDelim'));
    test('++++ → passthroughDelim', () => expectDelim('++++\n', 'passthroughDelim'));
    test('//// → commentBlockDelim', () => expectDelim('////\n', 'commentBlockDelim'));
    test('-- (open block) → openDelim', () => expectDelim('--\n', 'openDelim'));
    test('|=== → tableDelim', () => expectDelim('|===\n', 'tableDelim'));
    test(',=== → csvTableDelim', () => expectDelim(',===\n', 'csvTableDelim'));
    test(':=== → dsvTableDelim', () => expectDelim(':===\n', 'dsvTableDelim'));

    // A delimiter at EOF (no trailing newline) still terminates the paragraph.
    test('**** at end of input → sidebarDelim', () => expectDelim('****', 'sidebarDelim'));

    // Conditional preprocessor directives are resolved before block parsing, so a directive line
    // under paragraph content (with no blank line) is NOT absorbed — it terminates the paragraph and
    // tokenizes as a conditional. This is the fix for `endif::[]` (which closes a region directly
    // under its content) rendering unhighlighted while the opening `ifdef::` highlighted.
    test('endif::[] under a paragraph → conditionalToken', () => expectDelim('endif::[]\n', 'conditionalToken'));
    test('endif::[] at end of input → conditionalToken', () => expectDelim('endif::[]', 'conditionalToken'));
    test('ifdef::env[] under a paragraph → conditionalToken', () => expectDelim('ifdef::env[]\n', 'conditionalToken'));
    test('ifndef::env[] under a paragraph → conditionalToken', () => expectDelim('ifndef::env[]\n', 'conditionalToken'));
    test('ifeval::[...] under a paragraph → conditionalToken', () => expectDelim('ifeval::["{v}"=="1"]\n', 'conditionalToken'));

    // Look-alikes a paragraph DOES still absorb: a heading (`== `), a too-short run (`===`),
    // a single dash bullet context, and a `|` that is not a table fence — startsDelimitedBlock
    // returns false for these, so they stay paragraph continuation text.
    test('== heading is absorbed (heading does not terminate a paragraph)', () =>
      expect(runLogic('== Title\n', inParagraph).token).toBe('paragraphLineToken'));
    test('=== (run < 4, no space) is absorbed', () =>
      expect(runLogic('===\n', inParagraph).token).toBe('paragraphLineToken'));
    test('| not followed by === is absorbed', () =>
      expect(runLogic('| cell only\n', inParagraph).token).toBe('paragraphLineToken'));
  });

  test('blank line at line start with paragraph shiftable is not consumed as paragraph', () => {
    // input.next === NEWLINE so the paragraph branch is skipped.
    expect(
      runLogic('\n', { canShift: (term) => term === TERMS.paragraphLineToken }).token,
    ).toBeNull();
  });

  // ── Leading whitespace before a list marker ───────────────────────────────────
  test('indented list marker: leading whitespace skipped, marker accepted from line start', () => {
    const result = runLogic('   * item\n');
    expect(result.token).toBe('unorderedMarker');
  });

  test('indented dash list marker `   - ` skips whitespace', () => {
    expect(runLogic('   - item\n').token).toBe('unorderedMarker');
  });

  test('indented dot ordered marker `   . ` skips whitespace', () => {
    expect(runLogic('   . item\n').token).toBe('orderedMarker');
  });

  test('indented nested dot marker `   .. ` skips whitespace', () => {
    expect(runLogic('   .. item\n').token).toBe('orderedMarker');
  });

  test('indented numeric ordered marker `   1. ` skips whitespace', () => {
    expect(runLogic('   1. item\n').token).toBe('orderedMarker');
  });

  test('indented `   - ` with no following space stays put (dash not a marker)', () => {
    // exercises startsListMarker DASH branch returning false
    expect(runLogic('   -x\n').token).toBeNull();
  });

  test('indented `   .x` (dot not followed by space) is not a marker', () => {
    expect(runLogic('   .x\n').token).toBeNull();
  });

  test('indented `   1x` (digit not followed by dot+space) is not a marker', () => {
    expect(runLogic('   1x\n').token).toBeNull();
  });

  test('leading whitespace with no list marker: not a marker', () => {
    expect(runLogic('   plain text\n').token).toBeNull();
  });

  test('leading whitespace consuming to EOF after skip yields no marker char', () => {
    // All whitespace then EOF — startsListMarker false, ch becomes -1 path.
    expect(runLogic('   ').token).toBeNull();
  });

  // ── '=' headings & example delimiter ──────────────────────────────────────────
  test('document title `= `', () => {
    expect(runLogic('= Title\n').token).toBe('docTitleToken');
  });

  test('heading1 `== `', () => {
    expect(runLogic('== Section\n').token).toBe('heading1Token');
  });

  test('heading2 `=== `', () => {
    expect(runLogic('=== Sub\n').token).toBe('heading2Token');
  });

  test('heading3 `==== `', () => {
    expect(runLogic('==== A\n').token).toBe('heading3Token');
  });

  test('heading4 `===== `', () => {
    expect(runLogic('===== B\n').token).toBe('heading4Token');
  });

  test('heading5 `====== `', () => {
    expect(runLogic('====== C\n').token).toBe('heading5Token');
  });

  test('example delimiter `====` alone on a line', () => {
    expect(runLogic('====\n').token).toBe('exampleDelim');
  });

  test('example delimiter `====` at EOF', () => {
    expect(runLogic('====').token).toBe('exampleDelim');
  });

  test('`= =` (afterSpace is EQUALS for count 1) is not a doc title', () => {
    expect(runLogic('= =x\n').token).toBeNull();
  });

  test('lone `=` with no space and fewer than 4 is not a token', () => {
    expect(runLogic('=x\n').token).toBeNull();
  });

  test('`===` (3 equals, no space, not >=4) is not a token', () => {
    expect(runLogic('===\n').token).toBeNull();
  });

  // ── '-' listing / open / unordered / dash checklist ───────────────────────────
  test('listing delimiter `----`', () => {
    expect(runLogic('----\n').token).toBe('listingDelim');
  });

  test('open block delimiter `--`', () => {
    expect(runLogic('--\n').token).toBe('openDelim');
  });

  test('open block delimiter `--` at EOF', () => {
    expect(runLogic('--').token).toBe('openDelim');
  });

  test('dash unordered marker `- `', () => {
    expect(runLogic('- item\n').token).toBe('unorderedMarker');
  });

  test('dash checklist unchecked `- [ ] `', () => {
    expect(runLogic('- [ ] task\n').token).toBe('checkTodoMarker');
  });

  test('dash checklist checked `- [x] `', () => {
    expect(runLogic('- [x] task\n').token).toBe('checkDoneMarker');
  });

  test('dash checklist checked `- [X] `', () => {
    expect(runLogic('- [X] task\n').token).toBe('checkDoneMarker');
  });

  test('dash checklist checked `- [*] `', () => {
    expect(runLogic('- [*] task\n').token).toBe('checkDoneMarker');
  });

  test('dash `- [y] ` invalid box char falls back to plain unordered marker', () => {
    expect(runLogic('- [y] task\n').token).toBe('unorderedMarker');
  });

  test('dash `- [x]` missing trailing space falls back to unordered marker', () => {
    expect(runLogic('- [x]task\n').token).toBe('unorderedMarker');
  });

  test('single `-` with no following space is not a token', () => {
    expect(runLogic('-x\n').token).toBeNull();
  });

  test('three dashes `---` (not 1/2/>=4) is not a token', () => {
    expect(runLogic('---\n').token).toBeNull();
  });

  // ── '*' sidebar / checklist / unordered ───────────────────────────────────────
  test('sidebar delimiter `****`', () => {
    expect(runLogic('****\n').token).toBe('sidebarDelim');
  });

  test('star checklist `* [ ] `', () => {
    expect(runLogic('* [ ] task\n').token).toBe('checkTodoMarker');
  });

  test('star checklist `* [x] `', () => {
    expect(runLogic('* [x] task\n').token).toBe('checkDoneMarker');
  });

  test('star checklist invalid box `* [y] ` falls back to unordered', () => {
    expect(runLogic('* [y] task\n').token).toBe('unorderedMarker');
  });

  test('star unordered marker `* `', () => {
    expect(runLogic('* item\n').token).toBe('unorderedMarker');
  });

  test('nested star unordered marker `** `', () => {
    expect(runLogic('** item\n').token).toBe('unorderedMarker');
  });

  test('star with no following space and not 4+ is not a token', () => {
    expect(runLogic('*x\n').token).toBeNull();
  });

  test('`* [x]` without trailing space after bracket is unordered (bracket path declines)', () => {
    expect(runLogic('* [x]y\n').token).toBe('unorderedMarker');
  });

  // ── '_' quote delimiter ────────────────────────────────────────────────────────
  test('quote delimiter `____`', () => {
    expect(runLogic('____\n').token).toBe('quoteDelim');
  });

  test('three underscores `___` is not a token', () => {
    expect(runLogic('___\n').token).toBeNull();
  });

  // ── '+' passthrough delimiter ──────────────────────────────────────────────────
  test('passthrough delimiter `++++`', () => {
    expect(runLogic('++++\n').token).toBe('passthroughDelim');
  });

  test('three plus `+++` is not a token', () => {
    expect(runLogic('+++\n').token).toBeNull();
  });

  // ── "'" thematic break ─────────────────────────────────────────────────────────
  test("thematic break `'''`", () => {
    expect(runLogic("'''\n").token).toBe('thematicBreakToken');
  });

  test("thematic break `'''` with trailing whitespace then EOF", () => {
    expect(runLogic("'''  ").token).toBe('thematicBreakToken');
  });

  test("two apostrophes `''` is not a thematic break", () => {
    expect(runLogic("''\n").token).toBeNull();
  });

  test("`'''x` (non-whitespace trailer) is not a thematic break", () => {
    expect(runLogic("'''x\n").token).toBeNull();
  });

  // ── '<' page break ─────────────────────────────────────────────────────────────
  test('page break `<<<`', () => {
    expect(runLogic('<<<\n').token).toBe('pageBreakToken');
  });

  test('two angles `<<` is not a page break', () => {
    expect(runLogic('<<\n').token).toBeNull();
  });

  // ── '/' comment block / comment line ────────────────────────────────────────────
  test('comment block delimiter `////`', () => {
    expect(runLogic('////\n').token).toBe('commentBlockDelim');
  });

  test('comment block delimiter `////` at EOF', () => {
    expect(runLogic('////').token).toBe('commentBlockDelim');
  });

  test('comment line `// note`', () => {
    expect(runLogic('// a comment\n').token).toBe('commentLineToken');
  });

  test('three slashes `///` is a comment line (not 4+)', () => {
    expect(runLogic('///\n').token).toBe('commentLineToken');
  });

  test('single slash `/x` is not a comment', () => {
    expect(runLogic('/x\n').token).toBeNull();
  });

  // ── ',' csv table ─────────────────────────────────────────────────────────────
  test('csv table delimiter `,===`', () => {
    expect(runLogic(',===\n').token).toBe('csvTableDelim');
  });

  test('comma not followed by `===` is not a token', () => {
    expect(runLogic(',foo\n').token).toBeNull();
  });

  // ── ':' dsv table / attribute entry ─────────────────────────────────────────────
  test('dsv table delimiter `:===`', () => {
    expect(runLogic(':===\n').token).toBe('dsvTableDelim');
  });

  test('attribute entry `:name:`', () => {
    expect(runLogic(':author: Joe\n').token).toBe('attrEntryToken');
  });

  test('attribute entry with dashes `:my-attr:`', () => {
    expect(runLogic(':my-attr: x\n').token).toBe('attrEntryToken');
  });

  test('`:` followed by non-alnum is not an attribute entry', () => {
    expect(runLogic(': text\n').token).toBeNull();
  });

  test('`:name` with no closing colon is not an attribute entry', () => {
    expect(runLogic(':name only\n').token).toBeNull();
  });

  // ── '|' table delimiter ──────────────────────────────────────────────────────
  test('table delimiter `|===`', () => {
    expect(runLogic('|===\n').token).toBe('tableDelim');
  });

  test('pipe not followed by `===` is not a token', () => {
    expect(runLogic('| cell\n').token).toBeNull();
  });

  // ── '.' literal / ordered / block title ─────────────────────────────────────────
  test('literal block delimiter `....`', () => {
    expect(runLogic('....\n').token).toBe('literalDelim');
  });

  test('ordered marker `. `', () => {
    expect(runLogic('. item\n').token).toBe('orderedMarker');
  });

  test('nested ordered marker `.. `', () => {
    expect(runLogic('.. item\n').token).toBe('orderedMarker');
  });

  test('four dots with a space `.... ` is an ordered depth-4 marker', () => {
    expect(runLogic('.... item\n').token).toBe('orderedMarker');
  });

  test('block title `.Title`', () => {
    expect(runLogic('.My Title\n').token).toBe('blockTitleToken');
  });

  test('`.[x]` (dot then bracket) is not a block title', () => {
    expect(runLogic('.[id]\n').token).toBeNull();
  });

  test('lone `.` at EOL is not a block title', () => {
    expect(runLogic('.\n').token).toBeNull();
  });

  test('`..text` (two dots, no space) is not a token', () => {
    expect(runLogic('..text\n').token).toBeNull();
  });

  // ── '[' stem / admonition attr / block attr ──────────────────────────────────
  test('stem attribute `[stem]`', () => {
    expect(runLogic('[stem]\n').token).toBe('stemAttrToken');
  });

  test('admonition attribute `[NOTE]`', () => {
    expect(runLogic('[NOTE]\n').token).toBe('admonNoteAttrToken');
  });

  test('admonition attribute `[WARNING]`', () => {
    expect(runLogic('[WARNING]\n').token).toBe('admonWarningAttrToken');
  });

  test('generic block attribute `[source,ruby]`', () => {
    expect(runLogic('[source,ruby]\n').token).toBe('blockAttrToken');
  });

  test('block anchor `[[id]]` is not a block-attribute line', () => {
    expect(runLogic('[[anchor]]\n').token).toBeNull();
  });

  test('unterminated `[` (no closing bracket) is not a block-attribute line', () => {
    expect(runLogic('[unclosed\n').token).toBeNull();
  });

  test('`[attr] x` with trailing non-whitespace after `]` is not a block-attribute line', () => {
    expect(runLogic('[attr] x\n').token).toBeNull();
  });

  test('`[attr]  ` with trailing whitespace after `]` IS a block-attribute line', () => {
    expect(runLogic('[attr]  \n').token).toBe('blockAttrToken');
  });

  // ── Letters: conditionals, footnote, admonition paragraph, macros, desc list ──
  test('conditional directive `ifdef::`', () => {
    expect(runLogic('ifdef::env[]\n').token).toBe('conditionalToken');
  });

  test('conditional directive `endif::`', () => {
    expect(runLogic('endif::[]\n').token).toBe('conditionalToken');
  });

  test('footnote `footnote:[text]`', () => {
    expect(runLogic('footnote:[a note]\n').token).toBe('footnoteToken');
  });

  test('footnote with no closing bracket is not a footnote token', () => {
    expect(runLogic('footnote:[unterminated\n').token).toBeNull();
  });

  test('admonition paragraph `NOTE: `', () => {
    expect(runLogic('NOTE: heads up\n').token).toBe('admonNoteLineToken');
  });

  test('admonition paragraph `WARNING: `', () => {
    expect(runLogic('WARNING: careful\n').token).toBe('admonWarningLineToken');
  });

  test('inline macro at line start `link:url[text]`', () => {
    expect(runLogic('link:http://x[label]\n').token).toBe('inlineMacroToken');
  });

  test('inline macro with no closing bracket is not accepted as inline macro', () => {
    expect(runLogic('link:http://x[label\n').token).toBeNull();
  });

  test('inline macro with no bracket at all is not accepted', () => {
    expect(runLogic('link:http://x\n').token).toBeNull();
  });

  test('`name: value` (single colon then space) is not an inline macro', () => {
    expect(runLogic('name: value\n').token).toBeNull();
  });

  test('block macro `image::pic.png[]`', () => {
    expect(runLogic('image::pic.png[]\n').token).toBe('blockMacroToken');
  });

  test('description list `term:: def` (double colon, text after close)', () => {
    expect(runLogic('term:: definition\n').token).toBe('descListToken');
  });

  test('double-colon line ending exactly at `]` is a block macro', () => {
    expect(runLogic('video::id[opts]\n').token).toBe('blockMacroToken');
  });

  test('semicolon description-list separator `term;;`', () => {
    expect(runLogic('term;; def\n').token).toBe('descListToken');
  });

  test('plain word line with no marker is not a token', () => {
    expect(runLogic('justaword\n').token).toBeNull();
  });

  test('letter line that is only an identifier followed by EOL is not a token', () => {
    expect(runLogic('word\n').token).toBeNull();
  });

  test('`name:: ` with double colon but no closing bracket is a description list', () => {
    expect(runLogic('term:: plain text\n').token).toBe('descListToken');
  });

  test('inline macro rejected when char after colon is `[`', () => {
    expect(runLogic('name:[x]\n').token).toBeNull();
  });

  // ── Digit-starting: explicit ordered list, desc lists ──────────────────────────
  test('explicit ordered marker `1. `', () => {
    expect(runLogic('1. item\n').token).toBe('orderedMarker');
  });

  test('multi-digit ordered marker `42. `', () => {
    expect(runLogic('42. item\n').token).toBe('orderedMarker');
  });

  test('digit description list `1:: def`', () => {
    expect(runLogic('1:: definition\n').token).toBe('descListToken');
  });

  test('digit description list `1;; def`', () => {
    expect(runLogic('1;; definition\n').token).toBe('descListToken');
  });

  test('digit line with a space before any separator stops scanning (no token)', () => {
    expect(runLogic('1 plus 1\n').token).toBeNull();
  });

  test('digit line ending without separator is not a token', () => {
    expect(runLogic('123abc\n').token).toBeNull();
  });

  test('`1.x` (dot not followed by space) is not an ordered marker', () => {
    expect(runLogic('1.x\n').token).toBeNull();
  });

  // ── Continuation line ───────────────────────────────────────────────────────────
  test('continuation line consumed when canShift continuationLineToken', () => {
    const result = runLogic('continued text\n', {
      canShift: (term) => term === TERMS.continuationLineToken,
    });
    expect(result.token).toBe('continuationLineToken');
  });

  test('continuation branch skipped on blank line even when shiftable', () => {
    expect(
      runLogic('\n', { canShift: (term) => term === TERMS.continuationLineToken }).token,
    ).toBeNull();
  });

  test('continuation branch skipped at EOF even when shiftable', () => {
    expect(
      runLogic('', { canShift: (term) => term === TERMS.continuationLineToken }).token,
    ).toBeNull();
  });

  test('non-matching letter line with continuation shiftable becomes continuation', () => {
    // `justtext` reaches the bottom continuation branch (no block construct matched).
    expect(
      runLogic('justtext\n', {
        canShift: (term) => term === TERMS.continuationLineToken,
      }).token,
    ).toBe('continuationLineToken');
  });

  // ── Document-header byline (author / revision lines) ──────────────────────────
  // These two tokens are emitted only where the parse CONTEXT says the document header is at the
  // author / revision position — Asciidoctor allows attribute entries and comment lines between those
  // lines, which no grammar sequence can express (see `asciidoc-block-context-logic.ts`). The
  // positions are modelled here by that context; the real transitions are asserted end-to-end in
  // `asciidoc-grammar.test.ts`.
  describe('author / revision lines', () => {
    /** The header position where an author line may be recognised. */
    const underTitle = { context: HEADER_AFTER_TITLE };
    /** The header position where a revision line may be recognised. */
    const underAuthor = { context: HEADER_AFTER_AUTHOR };

    const expectAuthor = (line: string, expected: string | null) =>
      expect(runLogic(line, underTitle).token).toBe(expected);
    const expectRevision = (line: string, expected: string | null) =>
      expect(runLogic(line, underAuthor).token).toBe(expected);

    test('name + email', () =>
      expectAuthor('The AsciidoCollab Team <hello@asciidocollab.example>\n', 'authorLineToken'));
    test('single name', () => expectAuthor('Jane\n', 'authorLineToken'));
    test('two names', () => expectAuthor('Jane Doe\n', 'authorLineToken'));
    test('three names', () => expectAuthor('Jane Q. Doe\n', 'authorLineToken'));
    test('name with hyphen and apostrophe', () => expectAuthor("Anne-Marie O'Neill\n", 'authorLineToken'));
    test('`;`-separated authors', () =>
      expectAuthor('Jane Doe <j@x.io>; John Roe <r@x.io>\n', 'authorLineToken'));
    test('author line at end of input (no trailing newline)', () =>
      expectAuthor('Jane Doe', 'authorLineToken'));
    test('trailing whitespace is tolerated', () => expectAuthor('Jane Doe   \n', 'authorLineToken'));
    test('the whole line (newline included) is consumed', () =>
      expect(runLogic('Jane Doe\nnext\n', underTitle).acceptedAt).toBe(9));

    test('four name words is prose, not an author line', () =>
      expectAuthor('This document explains things\n', null));
    test('a sentence with punctuation is prose', () =>
      expectAuthor('This explains, briefly.\n', null));
    test('an angle-bracket segment without an `@` is not an email', () =>
      expectAuthor('Jane Doe <not-an-email>\n', null));
    test('an email containing a space is not an email', () =>
      expectAuthor('Jane Doe <a b@x.io>\n', null));
    test('a leading space disqualifies the line', () => expectAuthor(' Jane Doe\n', null));
    // Not a byline ⇒ the line falls through to the branch that really owns it. In the header those
    // two ARE an attribute entry and a comment line, which is exactly what Asciidoctor consumes
    // between the title and the byline.
    test('an attribute entry is an entry, not an author line', () =>
      expectAuthor(':toc: left\n', 'attrEntryToken'));
    test('a comment line is a comment, not an author line', () =>
      expectAuthor('// a note\n', 'commentLineToken'));
    test('an empty `;` segment disqualifies the line', () =>
      expectAuthor('Jane;;Doe\n', 'descListToken')); // `;;` is a description-list separator
    test('a blank line is not an author line', () => expectAuthor('\n', null));
    test('an over-long line is not an author line', () =>
      expectAuthor(`${'w'.repeat(600)}\n`, null));

    test('a quote fence under the title opens the block, not an author line', () =>
      expect(runLogic('____\n', { ...underTitle, canShift: () => true }).token).toBe('quoteDelim'));
    test('a conditional directive under the title is not an author line', () =>
      expect(runLogic('endif::[]\n', { ...underTitle, canShift: () => true }).token).toBe('conditionalToken'));

    test('version only', () => expectRevision('v1.0\n', 'revisionLineToken'));
    test('version without the `v`', () => expectRevision('1.0\n', 'revisionLineToken'));
    test('version + date', () => expectRevision('v1.0, 2026-07-18\n', 'revisionLineToken'));
    test('bare date', () => expectRevision('2026-07-18\n', 'revisionLineToken'));
    test('version + date + remark', () =>
      expectRevision('1.0, Jan 01, 2013: Ring in the new year\n', 'revisionLineToken'));
    test('version + remark', () => expectRevision('v1.0: first cut\n', 'revisionLineToken'));
    test('revision line at end of input', () => expectRevision('v1.0', 'revisionLineToken'));

    test('a version not starting with a digit is prose', () => expectRevision('Version two\n', null));
    test('a digit followed by prose is not a revision line', () =>
      expectRevision('2 apples a day\n', null));
    test('an ordered list item is a list item, not a revision line', () =>
      expectRevision('1. Step one\n', 'orderedMarker'));
    test('a numeric description-list term is a description list, not a revision line', () =>
      expectRevision('1:: definition\n', 'descListToken'));
    test('an attribute entry is an entry, not a revision line', () =>
      expectRevision(':toclevels: 3\n', 'attrEntryToken'));
    test('an over-long line is not a revision line', () =>
      expectRevision(`v1.0, ${'x'.repeat(600)}\n`, null));

    // The gates are independent: neither token is emitted outside its own header position.
    test('an author-shaped line is not emitted at the revision position', () =>
      expectRevision('Jane Doe <j@x.io>\n', null));
    test('a revision-shaped line is not emitted at the author position', () =>
      expectAuthor('v1.0, 2026-07-18\n', null));
    test('neither is emitted at a generic block boundary', () =>
      expect(runLogic('Jane Doe\n').token).toBeNull());
  });
});
