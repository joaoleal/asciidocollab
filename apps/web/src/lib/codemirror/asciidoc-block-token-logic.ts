import type { InputStream, Stack } from '@lezer/lr';

import {
  NEWLINE, SPACE, TAB, EQUALS, DASH, STAR, UNDERSCORE, BACKTICK,
  PLUS, SLASH, COLON, PIPE, DOT, LBRACK, RBRACK, SEMICOLON, COMMA,
  APOSTROPHE, LANGLE,
  isBreakLine,
  isBlockAttributeLine,
  startsListMarker,
  startsDelimitedBlock,
  isLineStart,
  consumeToEOL,
  consumeDescTerm,
  advanceBy,
  consumeAttributeEntry,
  peekString,
  isAlphaNumber,
  isAlphaNumberOrDash,
  scanInlineMark,
} from './asciidoc-block-token-helpers';
import { normalizeDiagramNotation, type DiagramNotation } from './diagram-notations';

/**
 * When the cursor sits on the opening `[` of a line, reports the diagram notation it declares — but
 * ONLY when the line is a well-formed block-attribute line whose first attribute is a recognised
 * notation (`[mermaid]`, `[graphviz]`, `[vega]`, `[vegalite]`, `vega-lite` folded) AND the
 * IMMEDIATELY following physical line is a delimited-block delimiter (`----` / `....` / …). This is
 * what distinguishes a diagram-block declaration from a generic `[source,ruby]` listing. Returns
 * `null` when any of those conditions fails, so the line falls through to the generic block-attribute
 * branch unchanged.
 */
function diagramDeclNotation(input: InputStream): DiagramNotation | null {
  if (input.peek(1) === LBRACK) return null; // `[[` block anchor
  let offset = 1;
  let name = '';
  while (offset < 200) {
    const code = input.peek(offset);
    if (code === RBRACK || code === COMMA || code === SPACE || code === TAB) break;
    if (code === NEWLINE || code === -1) return null;
    name += String.fromCodePoint(code);
    offset++;
  }
  const notation = normalizeDiagramNotation(name);
  if (notation === null) return null;
  if (!isBlockAttributeLine(input)) return null;
  // Locate the start of the NEXT physical line (just past this line's newline); a diagram
  // declaration REQUIRES a delimiter line immediately after it.
  let lineEnd = 0;
  for (;;) {
    const code = input.peek(lineEnd);
    if (code === -1) return null;
    if (code === NEWLINE) break;
    lineEnd++;
  }
  return startsDelimitedBlock(input, lineEnd + 1) ? notation : null;
}

/**
 * AsciiDoc block-level external-tokenizer logic — the SINGLE source of truth shared by the
 * production tokenizer (`asciidoc-block-tokens.ts`, which injects the generated term ids) and
 * the grammar test harness (`tests/helpers/asciidoc-test-tokenizer.ts`, which injects the term
 * ids from `buildParser`). It deliberately imports NOTHING from the generated `asciidoc-parser`
 * (which is ESM the jest transform can't load), taking the term-id map `T` as a parameter
 * instead — so the same code runs (and is covered) in both contexts and can never diverge.
 *
 * The reusable char-code constants and stateless scanning predicates live in the sibling
 * `asciidoc-block-token-helpers` module; this file keeps the per-position tokenizer dispatch.
 *
 * `T` is keyed by the external token names declared in `asciidoc.grammar` (`docTitleToken`,
 * `heading1Token`, …). `createBlockTokenLogic` destructures them ONCE (mirroring the original
 * `import { … as … }` aliases) so the hot-path tokenizer body reads free local bindings.
 */

// Conditional preprocessor directives — highlighted distinctly from generic block macros.
const CONDITIONAL_DIRECTIVES = ['ifdef::', 'ifndef::', 'ifeval::', 'endif::'];

/**
 * Whether the line at the current position begins a conditional preprocessor directive
 * (`ifdef::`/`ifndef::`/`ifeval::`/`endif::`).
 *
 * Asciidoctor resolves these line-by-line in the PRE-processor, before any block is parsed, so a
 * directive is always a directive regardless of what surrounds it — in particular a closing
 * `endif::[]` sits directly under the block content it wraps, with no blank line between. Without
 * this, that `endif::[]` line trips the mid-paragraph absorption rule and is swallowed as paragraph
 * text (while the opening `ifdef::`, which usually follows a blank line, highlights) — the exact
 * asymmetry a reader sees as "endif isn't highlighted like ifdef". Treating a directive line like a
 * delimited-block delimiter (it terminates an open paragraph) makes both ends highlight identically.
 */
function startsConditionalDirective(input: InputStream): boolean {
  return CONDITIONAL_DIRECTIVES.some((directive) => peekString(input, directive));
}

/**
 * Build the block-tokenizer read function bound to a term-id map. Term ids are destructured
 * once here; the returned closure (called per token position) reads only free locals.
 */
export function createBlockTokenLogic(T: Record<string, number>): (input: InputStream, stack: Stack) => void {
  const {
    docTitleToken: documentTitleToken,
    heading1Token, heading2Token, heading3Token, heading4Token, heading5Token,
    attrEntryToken: attributeEntryToken,
    commentBlockDelim, commentLineToken, blockMacroToken, descListToken,
    listingDelim, literalDelim, exampleDelim, sidebarDelim, quoteDelim, passthroughDelim,
    openDelim, tableDelim, csvTableDelim, dsvTableDelim,
    stemAttrToken: stemAttributeToken,
    diagramDeclToken,
    admonNoteAttrToken, admonTipAttrToken, admonWarningAttrToken, admonImportantAttrToken, admonCautionAttrToken,
    admonNoteLineToken, admonTipLineToken, admonWarningLineToken, admonImportantLineToken, admonCautionLineToken,
    conditionalToken,
    blockAttrToken: blockAttributeToken,
    checkDoneMarker, checkTodoMarker, unorderedMarker, orderedMarker,
    inlineMacroToken, footnoteToken,
    blockTitleToken,
    thematicBreakToken, pageBreakToken, hardBreakToken,
    continuationLineToken, paragraphLineToken,
    boldMarkToken, italicMarkToken, monoMarkToken,
    blockColsToken,
    blankLineToken,
  } = T;

  return (input, stack) => {
    // Hard line break: a `+` preceded by whitespace and immediately followed by a line end.
    // Checked before the line-start gate so it is recognised mid-document; consumes only the
    // `+` (the newline stays a separate token). `peek(-1)` sees the already-consumed space.
    if (input.next === PLUS && (input.peek(-1) === SPACE || input.peek(-1) === TAB) &&
        (input.peek(1) === NEWLINE || input.peek(1) === -1)) {
      input.advance();
      input.acceptToken(hardBreakToken);
      return;
    }

    // Inline emphasis marks (`*bold*` / `_italic_` / `` `mono` ``) — emitted as a SINGLE
    // boundary-checked span token so AsciiDoc's constrained/unconstrained word-boundary rule is
    // enforced with the lookbehind the `@tokens` DFA cannot express. Checked before
    // the line-start gate so it is recognised mid-line; `scanInlineMark` (which sees the preceding
    // char via `peek(-1)`) returns null for an in-word mark (`a*b*c`, `2*3*4`), leaving the lone mark
    // to fall through to the grammar's plain-text `markFallback`.
    if (input.next === STAR || input.next === UNDERSCORE || input.next === BACKTICK) {
      const span = scanInlineMark(input, input.next, input.peek(-1));
      if (span !== null) {
        const token = input.next === STAR ? boldMarkToken : (input.next === UNDERSCORE ? italicMarkToken : monoMarkToken);
        for (let index = 0; index < span.length; index++) input.advance();
        input.acceptToken(token);
        return;
      }
    }

    if (!isLineStart(input)) return;
    if (input.next === -1) return;

    // A WHITESPACE-ONLY line (spaces/tabs then a newline or EOF) is a BLANK line in AsciiDoc — it
    // ends the current paragraph/list and separates blocks, exactly like a truly empty line. Detected
    // before the paragraph-absorption branch below so the trailing whitespace is NOT swallowed as
    // paragraph text; otherwise a following admonition / stem / list / delimited block would not start
    // a new block (it would be absorbed). A truly empty line keeps its existing `nl`→blankLine path.
    if (input.next === SPACE || input.next === TAB) {
      let ws = 1;
      while (input.peek(ws) === SPACE || input.peek(ws) === TAB) ws++;
      const after = input.peek(ws);
      if ((after === NEWLINE || after === -1) && stack.canShift(blankLineToken)) {
        for (let index = 0; index < ws; index++) input.advance();
        // `after` is the char that followed the whitespace run; consume it too when it is the newline
        // (using the captured value, not `input.next`, which the narrowing above no longer tracks).
        if (after === NEWLINE) input.advance();
        input.acceptToken(blankLineToken);
        return;
      }
    }

    // Mid-paragraph: Asciidoctor consumes every non-blank line into the paragraph until a blank
    // line, so a line that looks like a heading or list marker here is plain text, not a new block.
    // Checked first so it wins over the block branches; `canShift` is true only inside a paragraph.
    // EXCEPTION (Asciidoctor `block_terminates_paragraph`): a delimited-block delimiter still ends the
    // paragraph with no blank line between them, so `startsDelimitedBlock` lines fall through to the
    // block branches below instead of being absorbed (e.g. `prose` directly above `****`). A
    // conditional preprocessor directive (`endif::[]` closing a region under its content, and the
    // opening forms) is likewise resolved before block parsing, so it too must not be absorbed —
    // otherwise `endif::[]` right under a paragraph goes unhighlighted (see startsConditionalDirective).
    if (input.next !== NEWLINE && stack.canShift(paragraphLineToken) &&
        !startsDelimitedBlock(input) && !startsConditionalDirective(input)) {
      consumeToEOL(input);
      input.acceptToken(paragraphLineToken);
      return;
    }

    // Asciidoctor allows list markers to be indented. Skip leading whitespace only when a real
    // list marker follows, so the accepted marker token still spans from the line start.
    let leadingWs = 0;
    while (input.peek(leadingWs) === SPACE || input.peek(leadingWs) === TAB) leadingWs++;
    if (leadingWs > 0 && startsListMarker(input, leadingWs)) {
      for (let index = 0; index < leadingWs; index++) input.advance();
    }

    const ch = input.next;
    if (ch === -1) return;

    // ── '=' : docTitle, headings, exampleDelim ────────────────────────────────
    if (ch === EQUALS) {
      let count = 0;
      while (input.peek(count) === EQUALS) count++;
      const afterEquals = input.peek(count);

      if (afterEquals === SPACE || afterEquals === TAB) {
        const afterSpace = input.peek(count + 1);
        // The marker is separated from the title by a space OR a tab (Asciidoctor `[ \t]+`). A section
        // title must have actual title text: skip the run of spaces/tabs after the marker and require a
        // non-whitespace char before the line ends. `== ` (empty) / `==   ` (whitespace only) is a
        // paragraph, matching Asciidoctor and the outline's `HEADING_RE` (`^(={1,6})\s+\S`), so the
        // editor highlight and the Outline panel can never disagree on what is a heading.
        let titlePos = count + 1;
        while (input.peek(titlePos) === SPACE || input.peek(titlePos) === TAB) titlePos++;
        const titleChar = input.peek(titlePos);
        const hasTitle = titleChar !== NEWLINE && titleChar !== -1;
        if (hasTitle && count === 1 && afterSpace !== EQUALS) { consumeToEOL(input); input.acceptToken(documentTitleToken); return; }
        if (hasTitle && count === 2 && afterSpace !== EQUALS) { consumeToEOL(input); input.acceptToken(heading1Token); return; }
        if (hasTitle && count === 3 && afterSpace !== EQUALS) { consumeToEOL(input); input.acceptToken(heading2Token); return; }
        if (hasTitle && count === 4 && afterSpace !== EQUALS) { consumeToEOL(input); input.acceptToken(heading3Token); return; }
        if (hasTitle && count === 5 && afterSpace !== EQUALS) { consumeToEOL(input); input.acceptToken(heading4Token); return; }
        // Exactly 6 `=` is level 5 — the deepest heading. A run of 7+ `=` is NOT a heading (it falls
        // through to a paragraph), matching Asciidoctor: `=======  Not a Section` is plain text.
        if (hasTitle && count === 6) { consumeToEOL(input); input.acceptToken(heading5Token); return; }
      }
      if (count >= 4 && (afterEquals === NEWLINE || afterEquals === -1)) {
        consumeToEOL(input); input.acceptToken(exampleDelim); return;
      }
      return;
    }

    // ── '-' : listingDelim, openDelim, unorderedMarker "- " ───────────────────
    if (ch === DASH) {
      let count = 0;
      while (input.peek(count) === DASH) count++;
      const afterDash = input.peek(count);
      if (count >= 4 && (afterDash === NEWLINE || afterDash === -1)) { consumeToEOL(input); input.acceptToken(listingDelim); return; }
      if (count === 2 && (afterDash === NEWLINE || afterDash === -1)) { consumeToEOL(input); input.acceptToken(openDelim); return; }
      if (count === 1 && afterDash === SPACE) {
        // Dash checklist `- [ ] ` — checked before the plain dash bullet (Asciidoctor allows
        // checkboxes on `-` as well as `*`); produces the existing ChecklistItem node.
        if (input.peek(count + 1) === LBRACK) {
          const boxChar = input.peek(count + 2);
          // Checked box: `x`, `X`, or `*`; unchecked: a space. (Asciidoctor accepts all three.)
          if ((boxChar === SPACE || boxChar === 120 || boxChar === 88 || boxChar === STAR) &&
              input.peek(count + 3) === 93 && input.peek(count + 4) === SPACE) {
            for (let index = 0; index < count + 5; index++) input.advance();
            const isDone = boxChar === 120 || boxChar === 88 || boxChar === STAR;
            input.acceptToken(isDone ? checkDoneMarker : checkTodoMarker); return;
          }
        }
        input.advance(); input.advance(); input.acceptToken(unorderedMarker); return;
      }
      return;
    }

    // ── '*' : sidebarDelim, checkDoneMarker/checkTodoMarker, unorderedMarker ──
    if (ch === STAR) {
      let count = 0;
      while (input.peek(count) === STAR) count++;
      const afterStar = input.peek(count);
      if (count >= 4 && (afterStar === NEWLINE || afterStar === -1)) { consumeToEOL(input); input.acceptToken(sidebarDelim); return; }
      if (afterStar === SPACE && input.peek(count + 1) === LBRACK) {
        const boxChar = input.peek(count + 2);
        if ((boxChar === SPACE || boxChar === 120 || boxChar === 88 || boxChar === STAR) &&
            input.peek(count + 3) === 93 && input.peek(count + 4) === SPACE) {
          for (let index = 0; index < count + 5; index++) input.advance();
          const isDone = boxChar === 120 || boxChar === 88 || boxChar === STAR;
          input.acceptToken(isDone ? checkDoneMarker : checkTodoMarker); return;
        }
      }
      if (afterStar === SPACE) {
        for (let index = 0; index <= count; index++) input.advance();
        input.acceptToken(unorderedMarker); return;
      }
      return;
    }

    // ── '_' : quoteDelim ───────────────────────────────────────────────────────
    if (ch === UNDERSCORE) {
      let count = 0;
      while (input.peek(count) === UNDERSCORE) count++;
      const afterU = input.peek(count);
      if (count >= 4 && (afterU === NEWLINE || afterU === -1)) { consumeToEOL(input); input.acceptToken(quoteDelim); return; }
      return;
    }

    // ── '+' : passthroughDelim ────────────────────────────────────────────────
    if (ch === PLUS) {
      let count = 0;
      while (input.peek(count) === PLUS) count++;
      const afterPlus = input.peek(count);
      if (count >= 4 && (afterPlus === NEWLINE || afterPlus === -1)) { consumeToEOL(input); input.acceptToken(passthroughDelim); return; }
      return;
    }

    // ── "'" : thematicBreak (`'''`) ───────────────────────────────────────────
    if (ch === APOSTROPHE) {
      if (isBreakLine(input, APOSTROPHE, 3)) { consumeToEOL(input); input.acceptToken(thematicBreakToken); return; }
      return;
    }

    // ── '<' : pageBreak (`<<<`) ────────────────────────────────────────────────
    if (ch === LANGLE) {
      if (isBreakLine(input, LANGLE, 3)) { consumeToEOL(input); input.acceptToken(pageBreakToken); return; }
      return;
    }

    // ── '/' : commentBlockDelim, commentLineToken ─────────────────────────────
    if (ch === SLASH) {
      if (input.peek(1) !== SLASH) return;
      let count = 0;
      while (input.peek(count) === SLASH) count++;
      const afterSlash = input.peek(count);
      if (count >= 4 && (afterSlash === NEWLINE || afterSlash === -1)) { consumeToEOL(input); input.acceptToken(commentBlockDelim); return; }
      consumeToEOL(input); input.acceptToken(commentLineToken); return;
    }

    // ── ',' : csvTableDelim (`,===`) ──────────────────────────────────────────
    if (ch === COMMA) {
      if (input.peek(1) === EQUALS && input.peek(2) === EQUALS && input.peek(3) === EQUALS) {
        consumeToEOL(input); input.acceptToken(csvTableDelim); return;
      }
      return;
    }

    // ── ':' : dsvTableDelim (`:===`), attrEntryToken ──────────────────────────
    if (ch === COLON) {
      if (input.peek(1) === EQUALS && input.peek(2) === EQUALS && input.peek(3) === EQUALS) {
        consumeToEOL(input); input.acceptToken(dsvTableDelim); return;
      }
      let offset = 1;
      const firstChar = input.peek(offset);
      if (!isAlphaNumber(firstChar)) return;
      offset++;
      while (offset < 200 && isAlphaNumberOrDash(input.peek(offset))) offset++;
      if (input.peek(offset) === COLON) { consumeAttributeEntry(input); input.acceptToken(attributeEntryToken); return; }
      return;
    }

    // ── '|' : tableDelim ──────────────────────────────────────────────────────
    if (ch === PIPE) {
      if (input.peek(1) === EQUALS && input.peek(2) === EQUALS && input.peek(3) === EQUALS) {
        consumeToEOL(input); input.acceptToken(tableDelim); return;
      }
      return;
    }

    // ── '.' : blockTitleToken, orderedMarker ─────────────────────────────────
    if (ch === DOT) {
      let count = 0;
      while (input.peek(count) === DOT) count++;
      const afterDots = input.peek(count);
      // Literal block delimiter: 4+ dots alone on a line (`....`). Checked before the ordered
      // marker so `.... ` (4 dots + space) still tokenizes as an ordered depth-4 item.
      if (count >= 4 && (afterDots === NEWLINE || afterDots === -1)) {
        consumeToEOL(input); input.acceptToken(literalDelim); return;
      }
      if (afterDots === SPACE) {
        for (let index = 0; index <= count; index++) input.advance();
        input.acceptToken(orderedMarker); return;
      }
      // Block title: single '.' followed by non-whitespace, non-'.', non-'['
      if (count === 1) {
        const afterDot = input.peek(1);
        if (afterDot !== SPACE && afterDot !== 9 /* TAB */ && afterDot !== DOT &&
            afterDot !== LBRACK && afterDot !== NEWLINE && afterDot !== -1) {
          consumeToEOL(input); input.acceptToken(blockTitleToken); return;
        }
      }
      return;
    }

    // ── '[' : stemAttributeToken, admonitionAttributeToken, generic block-attr ─
    if (ch === LBRACK) {
      if (peekString(input, '[stem]')) { consumeToEOL(input); input.acceptToken(stemAttributeToken); return; }
      if (peekString(input, '[NOTE]'))      { consumeToEOL(input); input.acceptToken(admonNoteAttrToken); return; }
      if (peekString(input, '[TIP]'))       { consumeToEOL(input); input.acceptToken(admonTipAttrToken); return; }
      if (peekString(input, '[WARNING]'))   { consumeToEOL(input); input.acceptToken(admonWarningAttrToken); return; }
      if (peekString(input, '[IMPORTANT]')) { consumeToEOL(input); input.acceptToken(admonImportantAttrToken); return; }
      if (peekString(input, '[CAUTION]'))   { consumeToEOL(input); input.acceptToken(admonCautionAttrToken); return; }
      // Table column-format specifier line `[cols="1,>2"]` / `[cols=2*]` — emitted as a
      // distinct token (before the generic block-attribute branch) so the cols spec highlights
      // distinctly. Matched only when it is a well-formed block-attribute line beginning `[cols`.
      if ((peekString(input, '[cols=') || peekString(input, '[cols ')) && isBlockAttributeLine(input)) {
        consumeToEOL(input); input.acceptToken(blockColsToken); return;
      }
      // Diagram block declaration `[mermaid]` / `[graphviz]` / `[vega]` / `[vegalite]` sitting
      // immediately above a delimited-block delimiter — emitted as its own token (before the generic
      // block-attribute branch) so a diagram declaration highlights distinctly from `[source,ruby]`.
      if (diagramDeclNotation(input) !== null) { consumeToEOL(input); input.acceptToken(diagramDeclToken); return; }
      // Generic block-attribute line `[source,ruby]`, `[.lead]`, and similar.
      if (isBlockAttributeLine(input)) { consumeToEOL(input); input.acceptToken(blockAttributeToken); return; }
      return;
    }

    // ── Letters ───────────────────────────────────────────────────────────────
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
      // Conditional preprocessor directives — distinct from generic block macros.
      for (const directive of CONDITIONAL_DIRECTIVES) {
        if (peekString(input, directive)) { consumeToEOL(input); input.acceptToken(conditionalToken); return; }
      }

      // footnoteToken (works at non-line-start too but checked here as well)
      if (peekString(input, 'footnote:[')) {
        let offset = 'footnote:['.length;
        while (input.peek(offset) !== 93 && input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) offset++;
        if (input.peek(offset) === 93) {
          for (let index = 0; index < offset + 1; index++) input.advance();
          input.acceptToken(footnoteToken); return;
        }
      }

      // Per-severity admonition paragraph tokens (NOTE: , TIP: , etc.). The trailing space is REQUIRED
      // to recognise the label (so `NOTE:foo` is not an admonition) but is NOT consumed into the token:
      // the prefix spans only `NOTE:` so the label chip hugs the label and the separating space reads as
      // plain body — `inlineContent? nl` then parses ` <body>`. Lengths are the label without the space.
      if (peekString(input, 'NOTE: '))      { advanceBy(input, 5);  input.acceptToken(admonNoteLineToken);      return; }
      if (peekString(input, 'TIP: '))       { advanceBy(input, 4);  input.acceptToken(admonTipLineToken);       return; }
      if (peekString(input, 'WARNING: '))   { advanceBy(input, 8);  input.acceptToken(admonWarningLineToken);   return; }
      if (peekString(input, 'IMPORTANT: ')) { advanceBy(input, 10); input.acceptToken(admonImportantLineToken); return; }
      if (peekString(input, 'CAUTION: '))   { advanceBy(input, 8);  input.acceptToken(admonCautionLineToken);   return; }

      // Author/revision line detection is not implemented in the tokenizer: the grammar
      // includes AuthorLine/RevisionLine as grammar-level stubs (for tag mapping purposes),
      // but they require document-header context that cannot be enforced via canShift alone.
      // The tokens remain in the grammar and highlight-tags but are never emitted.

      // Read identifier name
      let nameLength = 0;
      while (nameLength < 200 && isAlphaNumberOrDash(input.peek(nameLength))) nameLength++;

      // inlineMacroToken (only at line-start for this path; non-start is handled elsewhere)
      if (nameLength > 0 && input.peek(nameLength) === COLON && input.peek(nameLength + 1) !== COLON) {
        const afterColon = input.peek(nameLength + 1);
        if (afterColon !== SPACE && afterColon !== COLON && afterColon !== LBRACK && afterColon !== NEWLINE && afterColon !== -1) {
          let offset = nameLength + 1;
          while (input.peek(offset) !== LBRACK && input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) offset++;
          if (input.peek(offset) === LBRACK) {
            offset++;
            while (input.peek(offset) !== 93 && input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) offset++;
            if (input.peek(offset) === 93) {
              for (let index = 0; index < offset + 1; index++) input.advance();
              input.acceptToken(inlineMacroToken); return;
            }
          }
        }
      }

      // blockMacroToken or descListToken
      if (nameLength > 0 && input.peek(nameLength) === COLON && input.peek(nameLength + 1) === COLON) {
        let offset = nameLength + 2;
        let lastClosePosition = -1;
        while (true) {
          const code = input.peek(offset);
          if (code === NEWLINE || code === -1) break;
          if (code === 93) lastClosePosition = offset;
          offset++;
        }
        if (lastClosePosition === offset - 1) {
          consumeToEOL(input); input.acceptToken(blockMacroToken); return;
        }
        consumeDescTerm(input, nameLength, COLON); input.acceptToken(descListToken); return;
      }

      // `;;` description-list term separator (research D3).
      if (nameLength > 0 && input.peek(nameLength) === SEMICOLON && input.peek(nameLength + 1) === SEMICOLON) {
        consumeDescTerm(input, nameLength, SEMICOLON); input.acceptToken(descListToken); return;
      }
    }

    // ── Digit-starting: explicit-number ordered list, then description lists ────
    if (ch >= 48 && ch <= 57) {
      // Explicit-number ordered marker `\d+. ` (digits + dot + space) — emits the existing
      // OrderedListItem node so `1.` is highlighted like implicit `.` (research D3).
      let digits = 0;
      while (digits < 200 && input.peek(digits) >= 48 && input.peek(digits) <= 57) digits++;
      if (input.peek(digits) === DOT && input.peek(digits + 1) === SPACE) {
        for (let index = 0; index <= digits + 1; index++) input.advance();
        input.acceptToken(orderedMarker); return;
      }
      let offset = 1;
      while (offset < 200) {
        const code = input.peek(offset);
        if (code === COLON && input.peek(offset + 1) === COLON) {
          consumeDescTerm(input, offset, COLON); input.acceptToken(descListToken); return;
        }
        if (code === SEMICOLON && input.peek(offset + 1) === SEMICOLON) {
          consumeDescTerm(input, offset, SEMICOLON); input.acceptToken(descListToken); return;
        }
        if (code === NEWLINE || code === -1 || code === SPACE) break;
        offset++;
      }
    }

    // ── List / description continuation ─────────────────────────────────────────
    // The line began no block construct above. If it is non-blank and the parser is currently
    // inside a list item or description entry (i.e. it can shift a continuation line), consume
    // the whole line as the principal-text continuation. `Stack.canShift` keeps ordinary
    // paragraphs — where no continuation is expected — untouched.
    if (input.next !== NEWLINE && input.next !== -1 && stack.canShift(continuationLineToken)) {
      consumeToEOL(input);
      input.acceptToken(continuationLineToken);
    }
  };
}
