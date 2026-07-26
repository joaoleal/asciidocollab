import type { Tree, SyntaxNode } from '@lezer/common';

/**
 * Prose extraction + offset mapping — the shared "what is prose" model reused by both the nspell
 * spell-checker (`asciidoc-spellcheck.ts`) and the Harper grammar linter. Pure (no CodeMirror/DOM/Yjs),
 * so it unit-tests against a raw Lezer tree.
 *
 * This module owns the single authority for the classification (verbatim blocks, macros, attributes,
 * URLs, role-span markup, header metadata) via the KEEP/DROP/BOUNDARY logic; the one addition grammar
 * needs over spelling is **segmentation at block boundaries** — each contiguous prose block is its own
 * segment, so grammar rules never see the end of one paragraph glued to the start of the next across a
 * skipped code block (which would manufacture false positives).
 */

/** Grammar node names whose text is NOT prose and must not be spell/grammar-checked. */
export const SPELLCHECK_SKIP_NODES = new Set([
  'ListingBlock', 'LiteralBlock', 'PassthroughBlock', 'CommentBlock', 'CommentLine',
  'StemBlock', 'Monospace', 'AttributeEntry', 'AttributeReference', 'BlockMacro',
  'InlineMacro', 'CrossReference', 'Footnote', 'Conditional', 'BlockAttributeLine',
  'DocumentTitle',
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

/**
 * Byte ranges of the document-header author and revision lines, which AsciiDoc treats as metadata
 * (names, emails, brand words, version + date), not prose.
 *
 * These lines are only present when the document opens with a level-0 title: the author line
 * immediately follows it and the optional revision line follows that, with the header ending at the
 * first blank line, attribute entry (`:`), or comment (`//`). The block tokenizer never emits the
 * grammar's stub `AuthorLine`/`RevisionLine` nodes (they need header context it cannot enforce), so
 * these lines are excluded by position instead of by node name.
 *
 * @param text - The full document text.
 * @returns Up to two `[from, to)` ranges (author, then revision), or none.
 */
export function headerMetadataRanges(text: string): Array<[number, number]> {
  // A document header exists only when the first line is a level-0 title (`= `);
  // `==`+ are section headings, not a title, so require exactly one `=`.
  if (!/^=[ \t]/.test(text)) return [];
  const ranges: Array<[number, number]> = [];
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return [];
  let start = firstBreak + 1; // first char of the line after the title
  for (let line = 0; line < 2; line++) {
    const nextBreak = text.indexOf('\n', start);
    const end = nextBreak === -1 ? text.length : nextBreak;
    const content = text.slice(start, end);
    // The header ends at a blank line; an attribute entry or comment is not an
    // author/revision line (attributes are already skipped as their own nodes).
    if (content.trim() === '' || content.startsWith(':') || content.startsWith('//')) break;
    ranges.push([start, end]);
    if (nextBreak === -1) break;
    start = nextBreak + 1;
  }
  return ranges;
}

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

  // The author/revision byline parses as an ordinary paragraph (the grammar's AuthorLine/RevisionLine
  // tokens are never emitted), so exclude those header lines by position — names/brands/versions there
  // are metadata, not prose.
  for (const [from, to] of headerMetadataRanges(text)) {
    for (let index = from; index < to; index++) cls[index] = BOUNDARY;
  }
  return cls;
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
