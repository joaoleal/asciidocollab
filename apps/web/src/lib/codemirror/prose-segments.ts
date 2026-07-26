import type { Tree, SyntaxNode } from '@lezer/common';
import { attributeEntryLineRanges, verbatimRanges } from '@asciidocollab/asciidoc-core';
import { isRevisionLineText } from './asciidoc-block-token-helpers';

/**
 * Prose extraction + offset mapping — the shared "what is prose" model reused by both the nspell
 * spell-checker (`asciidoc-spellcheck.ts`) and the Harper grammar linter. Pure (no CodeMirror/DOM/Yjs),
 * so it unit-tests against a raw Lezer tree.
 *
 * This module owns the single authority for the classification (verbatim blocks, macros, attributes,
 * URLs, role-span markup, header metadata) via the KEEP/DROP/BOUNDARY logic — by syntax-tree node
 * name, plus one construct the tree cannot answer for, which is excluded by POSITION instead (the
 * attribute entries a header paragraph absorbs when the byline is declined). The one addition grammar
 * needs over spelling is **segmentation at block boundaries** —
 * each contiguous prose block is its own segment, so grammar rules never see the end of one paragraph
 * glued to the start of the next across a skipped code block (which would manufacture false positives).
 */

/** Grammar node names whose text is NOT prose and must not be spell/grammar-checked. */
export const SPELLCHECK_SKIP_NODES = new Set([
  'ListingBlock', 'LiteralBlock', 'PassthroughBlock', 'CommentBlock', 'CommentLine',
  'StemBlock', 'Monospace', 'AttributeEntry', 'AttributeReference', 'BlockMacro',
  'InlineMacro', 'CrossReference', 'Footnote', 'Conditional', 'BlockAttributeLine',
  'DocumentTitle',
  // The document-header byline: names, emails, brand words, a version and a date are metadata, not
  // prose. The tokenizer emits these nodes only in header position — the `@context` tracker in
  // `asciidoc-block-context-logic.ts` states where Asciidoctor's header walk allows each of them — so
  // the same text lower in the document stays an ordinary, checked paragraph.
  'AuthorLine', 'RevisionLine',
  // Inline non-prose constructs: URLs, UI/math macros, inline passthrough,
  // anchors, callouts, and entities are verbatim/identifier content, not prose.
  'Link', 'InlineStem', 'UiMacro', 'Passthrough', 'InlineAnchor', 'BiblioAnchor',
  'Callout', 'Entity',
  // `{set:name:value}` — the attribute name and value are identifiers, not prose.
  'InlineSet',
  // Table structure. The `[cols="2,1",options="header"]` spec line is its own token (NOT a
  // BlockAttributeLine), and the `|===` fences and `|` cell separators are pure punctuation — all of
  // it is markup, so none of it may be checked. Cell CONTENT stays prose: only the marks are skipped.
  'TableCols', 'TableFence', 'TableCellMark',
  // CSV/DSV tables are delimited DATA, not prose, so the whole block is skipped (like a listing).
  'CsvTableBlock', 'DsvTableBlock',
  // `[graphviz, mygraph, svg]` — a diagram declaration line is markup (its body is a ListingBlock).
  'DiagramBlockDeclaration',
  // Standalone markup lines: `<<<` (page break) and `'''` (thematic break) are pure punctuation.
  'PageBreak', 'ThematicBreak',
  // Delimiter fences of blocks whose BODY is prose (example, sidebar, quote, open). The block itself
  // must stay checkable, so only the `====` / `****` / `____` / `--` lines are skipped. Verbatim
  // blocks (listing, literal, passthrough) are already skipped whole, fences included.
  'ExampleFence', 'SidebarFence', 'QuoteFence', 'OpenFence',
  // Admonition labels — the `[NOTE]` block annotation and the `NOTE:` paragraph prefix are markup;
  // the admonition's text after them is ordinary prose and stays checked.
  'AdmonAnnotation', 'AdmonNoteAnnotation', 'AdmonTipAnnotation', 'AdmonWarningAnnotation',
  'AdmonImportantAnnotation', 'AdmonCautionAnnotation',
  'AdmonNotePfx', 'AdmonTipPfx', 'AdmonWarningPfx', 'AdmonImportantPfx', 'AdmonCautionPfx',
  // List item markers (`* `, `. `, and the `[x]`/`[ ]` checkboxes) — markup; the item text is prose.
  'UnorderedMark', 'OrderedMark', 'CheckDoneMark', 'CheckTodoMark',
]);

// `[.role]##body##` is a single token, but only the role NAME is markup — the body is ordinary prose.
// The prefix/suffix delimiters are DROPped so a word split by the span rejoins (`[.u]##O##nce` → `Once`).
// Handled out-of-band rather than added to SPELLCHECK_SKIP_NODES, which would suppress the body too.
const ROLE_SPAN_NODE = 'RoleSpan';

/** The table block whose `|` cell separators are markup even where the grammar leaves them untokenized. */
const TABLE_BLOCK_NODE = 'TableBlock';

/**
 * Punctuation that must not be preceded by a space. Used to clean up after removed markup: an inline
 * skip can leave the author's space stranded before it (`In section <<install-guide>>.` → `In section .`).
 */
const CLOSING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);

/** A contiguous run of prose with a per-character map back to document offsets. */
export interface ProseSegment {
  /** Visible prose text of one contiguous prose block (markup/code/macros removed). */
  text: string;
  /** `map[i]` = document offset of `text[i]`. Strictly increasing; `length === text.length`. */
  map: number[];
}

const KEEP = 0;
const DROP = 1;
const BOUNDARY = 2;

/** Classify every document character as KEEP (prose), DROP (removed markup), or BOUNDARY (skipped). */
function classify(tree: Tree | SyntaxNode, text: string): Uint8Array {
  const cls = new Uint8Array(text.length); // 0 = KEEP by default
  tree.cursor().iterate((node) => {
    if (node.name === ROLE_SPAN_NODE) {
      const spanText = text.slice(node.from, node.to);
      const bracketEnd = spanText.indexOf(']'); // end of the `[.role]` name
      let delimiter = bracketEnd + 1;
      let hashes = 0;
      while (bracketEnd !== -1 && spanText[delimiter] === '#') {
        hashes++;
        delimiter++;
      }
      if (bracketEnd === -1 || hashes === 0) {
        // Malformed span — treat it all as a boundary rather than leaking markup as prose.
        for (let index = node.from; index < node.to; index++) cls[index] = BOUNDARY;
        return;
      }
      const bodyFrom = node.from + delimiter; // first body char (after `[.role]##`)
      const bodyTo = node.from + spanText.length - hashes; // first trailing `#`
      for (let index = node.from; index < bodyFrom; index++) cls[index] = DROP; // `[.role]##` prefix
      for (let index = bodyTo; index < node.to; index++) cls[index] = DROP; // `##` suffix
      return; // body chars stay KEEP so they join the surrounding prose
    }
    if (node.name === TABLE_BLOCK_NODE) {
      // The grammar models only the ROW-LEADING `|` as a TableCellMark; every further separator on the
      // line falls into inline content (a deliberate highlighting simplification). For prose they are
      // all markup, so skip every `|` inside the table rather than leaking separators into a segment.
      for (let index = node.from; index < node.to; index++) {
        if (text[index] === '|') cls[index] = BOUNDARY;
      }
      return; // keep descending: the fences and cell marks mark themselves below
    }
    if (SPELLCHECK_SKIP_NODES.has(node.name)) {
      for (let index = node.from; index < node.to; index++) cls[index] = BOUNDARY;
    }
  });

  // Verbatim regions (listing / literal / passthrough / comment blocks, fences included, plus `//`
  // line comments) are code samples, never prose. The node rules above already skip a TOP-LEVEL
  // `ListingBlock`, but the grammar models every delimited block's body as flat raw lines, so a
  // listing NESTED inside an example/sidebar/quote/admonition block produces no node at all and its
  // code would be spell- and grammar-checked as the outer block's prose — false positives on a very
  // common AsciiDoc shape, and ones the author cannot act on. `verbatimRanges` answers this from the
  // text, matching each fence to the delimiter that opened it, and is the SAME authority the preview
  // and reference-extraction layers use to decide what is a code sample.
  for (const { from, to } of verbatimRanges(text)) {
    for (let index = from; index < Math.min(to, text.length); index++) cls[index] = BOUNDARY;
  }

  // Attribute entries (`:toc: left`, `:product-name: AsciidoCollab`, `:sectnums!:`, a `\`-wrapped
  // value) are configuration, not writing: the name is an AsciiDoc syntax identifier and the value is
  // overwhelmingly a token, path, version, or brand word. At a block boundary they parse as
  // `AttributeEntry` and are already skipped by node.
  //
  // Restricted to the DOCUMENT HEADER, and only as a safety net for it. Elsewhere an attribute-shaped
  // line is NOT an attribute entry: Asciidoctor recognises entries only at a block boundary, so
  // `:note: the ratio was mesured wrong` sitting inside a paragraph is ordinary prose — and the
  // tokenizer agrees, parsing it as paragraph continuation. Masking it document-wide silently dropped
  // that line from checking, hiding real typos in real sentences, which is a worse failure than the
  // false positives this exists to prevent. In the header the risk is the other way round: the byline
  // predicates are deliberately conservative, and a declined author line reopens the paragraph
  // absorption that swallows every entry under it, so the net stays.
  const entryRanges = attributeEntryLineRanges(text);
  const headerEnd = documentHeaderEnd(text, entryRanges);
  for (const { from, to } of entryRanges) {
    if (from >= headerEnd) break; // ranges are ascending — past the header, nothing else qualifies
    for (let index = from; index < Math.min(to, text.length); index++) cls[index] = BOUNDARY;
  }
  return cls;
}

/**
 * Offset at which the AsciiDoc document header ends. Everything from there on is body, where a
 * construct is only a construct at a block boundary and the syntax tree is the authority.
 *
 * A header exists only when the document reaches a level-0 title (`= `) across nothing but the lines
 * Asciidoctor lets precede one — blank lines, comment lines, attribute entries and block-attribute
 * lines, the same set `blockContext`'s HEADER_START admits. It is the only shape in which the byline
 * can absorb the entries beneath it. Without such a title, there is no header and the answer is 0: a
 * document that opens with prose or a list has none, so an attribute-shaped line anywhere in it is
 * body text. Requiring the title on line ONE was the earlier bug: a licence comment or a stray leading
 * newline turned the safety net off for exactly the documents that carry a full header.
 *
 * The walk mirrors Asciidoctor's `parse_header_metadata` (parser.rb), which is what decides whether a
 * line renders as configuration or as writing: attribute entries (comment lines discarded with them)
 * are consumed BEFORE the author line, again BETWEEN the author and revision lines, and again after —
 * and the author line itself is read UNCONDITIONALLY, whatever its shape, while the revision line is
 * taken only if it matches. So the header is
 * `title, entry*, [any one line], entry*, [revision], entry*`, and it ends at the first line that
 * sequence does not reach.
 *
 * Mirroring it (rather than requiring the byline to sit directly under the title, as the GRAMMAR does)
 * is what keeps the mask a working safety net: with `= T\n:a: 1\nJoao Leal\n:b: 2\n\nBody.` the
 * tokenizer declines the byline — an entry precedes it — so `Joao Leal` opens a paragraph that absorbs
 * `:b: 2`, no `AttributeEntry` node is emitted for it, and stopping the header at the declined byline
 * left that entry to be spell-checked as prose. Stopping at the first BLANK line is the other failure:
 * a header that ends at a body line (`= T\nAda Zyxwv\nv1.0\nBody line.\n:note: a real sentence`) would
 * mask the `:note:` paragraph continuation under it, hiding a genuine typo.
 *
 * @param text - The full document text.
 * @param entryRanges - The document's attribute-entry spans, ascending (each starts at a line start
 *   and covers any `\`-continuation lines), so the walk agrees with the mask that uses them.
 * @returns The exclusive end offset of the header region (0 when the document has no header).
 */
function documentHeaderEnd(text: string, entryRanges: ReadonlyArray<{ from: number; to: number }>): number {
  const entryEnds = new Map(entryRanges.map(({ from, to }) => [from, to]));
  const lineEndAt = (start: number): number => {
    const nextBreak = text.indexOf('\n', start);
    return nextBreak === -1 ? text.length : nextBreak;
  };
  const nextLineAt = (start: number): number => Math.min(lineEndAt(start) + 1, text.length);
  /** Advance over the run of attribute entries and comment lines Asciidoctor consumes at this point. */
  const skipEntriesAndComments = (start: number): number => {
    let position = start;
    while (position < text.length) {
      const entryEnd = entryEnds.get(position);
      if (entryEnd !== undefined) {
        position = Math.min(entryEnd, text.length); // an entry owns its `\`-continuation lines
        continue;
      }
      if (!text.startsWith('//', position)) return position;
      position = nextLineAt(position);
    }
    return position;
  };
  /** True at the end of the document or on a blank line, both of which close the header. */
  const isBlankAt = (position: number): boolean =>
    position >= text.length || text.slice(position, lineEndAt(position)).trim() === '';

  // Find the document title across the lines that may precede it. `==`+ is a section heading, not a
  // level-0 title, so require exactly one `=`; anything that is not blank, a comment, an entry or a
  // block-attribute line is body, and a body line before the title means the document has no header.
  // A block TITLE (`.Caption`) is body here for the same reason it is in the context tracker:
  // Asciidoctor abandons header parsing when one sits above the doctitle.
  let titleStart = 0;
  for (;;) {
    titleStart = skipEntriesAndComments(titleStart);
    if (titleStart >= text.length) return 0;
    const line = text.slice(titleStart, lineEndAt(titleStart));
    if (/^=[ \t]/.test(line)) break;
    // Blank and block-attribute lines are transparent above the title; anything else ends the search.
    if (line.trim() !== '' && !/^\[.*\][ \t]*$/.test(line)) return 0;
    titleStart = nextLineAt(titleStart);
  }
  const firstBreak = text.indexOf('\n', titleStart);
  if (firstBreak === -1) return text.length; // a title and nothing else

  let position = skipEntriesAndComments(firstBreak + 1);
  if (isBlankAt(position)) return position;
  position = skipEntriesAndComments(nextLineAt(position)); // the author line, whatever it says
  if (!isBlankAt(position) && isRevisionLineText(text.slice(position, lineEndAt(position)))) {
    position = skipEntriesAndComments(nextLineAt(position));
  }
  return position;
}

/** True when a document character is horizontal/vertical whitespace. */
function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * Extract prose-only segments from a parsed AsciiDoc document. Markup/code/macros are removed; each
 * contiguous prose block (separated by a skipped block or a blank line) becomes its own segment.
 */
export function extractProseSegments(tree: Tree | SyntaxNode, text: string): ProseSegment[] {
  const cls = classify(tree, text);

  // Materialise the visible prose + a per-char document-offset map. DROP chars vanish (so a role-span
  // body rejoins the prose around it); a BOUNDARY run collapses to a single space (a word separator
  // whose map points at the boundary start), so an inline skip never fuses two words.
  //
  // Consecutive horizontal spaces are collapsed to one. Without this, extraction MANUFACTURES runs of
  // spaces the author never typed — `In section <<install-guide>>.` becomes `In section  .` because the
  // skipped cross-reference contributes a separator space right after the real one, and `| a | b`
  // becomes `  a   b` once the cell marks are skipped. Harper then reports "there are 2 spaces where
  // there should be only one" against markup the author cannot fix. Newlines are never collapsed: the
  // segment splitter below relies on them to find blank lines (block boundaries).
  const chars: string[] = [];
  const map: number[] = [];
  const lastIsHorizontalSpace = (): boolean => {
    const last = chars.at(-1);
    return last === ' ' || last === '\t';
  };
  /** True when nothing more is needed to separate words here — a newline already does it. */
  const lastSeparatesWords = (): boolean => {
    const last = chars.at(-1);
    return last === undefined || last === ' ' || last === '\t' || last === '\n' || last === '\r';
  };
  // True when the trailing space sits where markup was removed, so it is ours to clean up rather than
  // the author's spacing. A real `Hello .` typo keeps its space (and its lint); `See <<x>>.` does not.
  let trailingSpaceFollowsRemovedMarkup = false;
  for (let index = 0; index < text.length; ) {
    const kind = cls[index];
    if (kind === KEEP) {
      const char = text[index];
      const isHorizontalSpace = char === ' ' || char === '\t';
      // A real space is dropped only when it would merely extend an existing run of spaces.
      if (isHorizontalSpace && lastIsHorizontalSpace()) {
        index++;
        continue;
      }
      // Drop a space stranded before closing punctuation by the markup that used to sit between them.
      if (trailingSpaceFollowsRemovedMarkup && CLOSING_PUNCTUATION.has(char) && lastIsHorizontalSpace()) {
        chars.pop();
        map.pop();
      }
      chars.push(char);
      map.push(index);
      if (!isHorizontalSpace) trailingSpaceFollowsRemovedMarkup = false;
      index++;
    } else if (kind === DROP) {
      index++;
    } else {
      if (lastSeparatesWords()) {
        // Nothing separates to add (a space or newline already does, or we are at the start); just
        // remember that markup was removed here so a stranded space can be cleaned up below.
        trailingSpaceFollowsRemovedMarkup = true;
      } else {
        chars.push(' ');
        map.push(index);
        trailingSpaceFollowsRemovedMarkup = true;
      }
      index++;
      while (index < text.length && cls[index] === BOUNDARY) index++;
    }
  }

  // Split into block-level segments at blank lines (a run of whitespace containing ≥2 newlines), then
  // trim surrounding whitespace from each so a segment starts/ends on real prose. Whitespace-only runs
  // (e.g. a collapsed code block sitting alone between blank lines) yield no segment.
  const segments: ProseSegment[] = [];
  const n = chars.length;
  let index = 0;
  while (index < n) {
    // Skip whitespace between segments.
    while (index < n && isSpace(chars[index])) index++;
    if (index >= n) break;
    const start = index;
    let lastProse = index; // index of the last non-whitespace char seen in this segment
    let index_ = index;
    while (index_ < n) {
      if (chars[index_] === '\n') {
        // Peek across the whitespace run following this newline; ≥2 newlines ⇒ blank line ⇒ block break.
        let k = index_;
        let newlines = 0;
        while (k < n && isSpace(chars[k])) {
          if (chars[k] === '\n') newlines++;
          k++;
        }
        if (newlines >= 2) break; // segment ends at lastProse; resume scanning at k
        index_++;
      } else {
        if (!isSpace(chars[index_])) lastProse = index_;
        index_++;
      }
    }
    segments.push({
      text: chars.slice(start, lastProse + 1).join(''),
      map: map.slice(start, lastProse + 1),
    });
    index = index_;
  }
  return segments;
}

/** Map a lint span (offsets into a segment's `text`) to an absolute document range. */
export function spanToDocumentRange(
  segment: ProseSegment,
  spanStart: number,
  spanEnd: number,
): { from: number; to: number } {
  // A zero-width span (spanEnd === spanStart) marks an insertion point, not a range — Harper emits
  // these for boundary/insert-after lints. Mapping `to` via `map[spanEnd - 1] + 1` would land it at
  // `map[spanStart - 1] + 1`, *before* `from`, inverting the range and misplacing the fix. Collapse
  // it to a true zero-width range at the insertion point instead.
  if (spanEnd <= spanStart) {
    const at =
      spanStart < segment.map.length
        ? segment.map[spanStart]
        : (segment.map.at(-1) ?? 0) + 1; // insertion at the very end of the segment
    return { from: at, to: at };
  }
  return { from: segment.map[spanStart], to: segment.map[spanEnd - 1] + 1 };
}
