/**
 * Reusable scanning primitives for the AsciiDoc block-level external tokenizer — the pure
 * char-code constants and stateless helper predicates extracted from
 * `asciidoc-block-token-logic.ts`. These are the low-level building blocks the hot-path
 * tokenizer switch composes; isolating them here keeps the factory focused on token dispatch.
 *
 * Nothing here depends on the generated `asciidoc-parser` or on any term-id map, so it stays
 * trivially shared between the production tokenizer and the grammar test harness.
 */

export const NEWLINE = 10, SPACE = 32, TAB = 9, EQUALS = 61, DASH = 45, STAR = 42, UNDERSCORE = 95;
export const PLUS = 43, SLASH = 47, COLON = 58, PIPE = 124, DOT = 46, LBRACK = 91, RBRACK = 93, SEMICOLON = 59, COMMA = 44;
export const APOSTROPHE = 39, LANGLE = 60, BACKSLASH = 92, BACKTICK = 96;

/**
 * A look-ahead view over the input being tokenized, exposing the char code `offset`
 * positions from the current scan position.
 */
interface PeekInput {
  /**
   * Returns the char code `offset` positions ahead of the cursor, or `-1` past the end.
   *
   * @param offset - How many positions ahead of the cursor to read.
   * @returns The char code at that position, or `-1` when out of range.
   */
  peek: (offset: number) => number;
}

/**
 * A look-ahead view that also knows the absolute cursor position, used to detect line starts.
 */
interface PeekInputWithPos extends PeekInput {
  /**
   * The absolute cursor position within the input.
   */
  pos: number;
}

/**
 * A consuming view over the input, exposing the current char code and a cursor advance.
 */
interface ConsumingInput {
  /**
   * The char code at the cursor, or `-1` at the end of input.
   */
  next: number;
  /**
   * Advances the cursor one position forward.
   */
  advance: () => void;
}

/**
 * Reports whether the current line consists solely of `min`+ repetitions of `code`
 * (optionally trailed by whitespace) — for example `'''` thematic break, `<<<` page break.
 *
 * @param input - The look-ahead view over the input.
 * @param code - The char code the line must repeat.
 * @param min - The minimum number of repetitions required.
 * @returns `true` when the line is such a break line.
 */
export function isBreakLine(input: PeekInput, code: number, min: number): boolean {
  let count = 0;
  while (input.peek(count) === code) count++;
  if (count < min) return false;
  let offset = count;
  let next = input.peek(offset);
  while (next === SPACE || next === TAB) {
    offset++;
    next = input.peek(offset);
  }
  return next === NEWLINE || next === -1;
}

/**
 * Reports whether the current line is a generic block-attribute line `[..]` whose last
 * non-whitespace character is a closing bracket (for example `[source,ruby]`,
 * `[cols="1,1"]`, `[.lead]`). Excludes block anchors `[[id]]` (start `[[`).
 *
 * @param input - The look-ahead view over the input.
 * @returns `true` when the line is a generic block-attribute line.
 */
export function isBlockAttributeLine(input: PeekInput): boolean {
  if (input.peek(1) === LBRACK) return false; // `[[` block anchor, not an attribute line
  let offset = 1;
  let lastClose = -1;
  while (offset < 2000) {
    const code = input.peek(offset);
    if (code === NEWLINE || code === -1) break;
    if (code === RBRACK) lastClose = offset;
    offset++;
  }
  if (lastClose < 1) return false;
  for (let position = lastClose + 1; position < offset; position++) {
    const code = input.peek(position);
    if (code !== SPACE && code !== TAB) return false;
  }
  return true;
}

/**
 * Reports whether a list marker begins at `offset` (used to allow leading whitespace before a
 * marker, which Asciidoctor permits). Each pattern requires a trailing space, so it never matches
 * a bare block delimiter line (`****`, `----`, `....`) — those have no space and are column-0 only.
 *
 * @param input - The look-ahead view over the input.
 * @param offset - The position at which to test for a marker.
 * @returns `true` when a list marker starts at that position.
 */
export function startsListMarker(input: PeekInput, offset: number): boolean {
  const code = input.peek(offset);
  if (code === STAR) {
    let n = 0;
    while (input.peek(offset + n) === STAR) n++;
    return input.peek(offset + n) === SPACE; // `* `, `** ` … (checklist is `* [x] `, also a space)
  }
  if (code === DASH) {
    return input.peek(offset + 1) === SPACE; // single `- ` only; `--`/`----` are delimiters
  }
  if (code === DOT) {
    let n = 0;
    while (input.peek(offset + n) === DOT) n++;
    return input.peek(offset + n) === SPACE; // `. `, `.. ` …
  }
  if (code >= 48 && code <= 57) {
    let n = 0;
    while (input.peek(offset + n) >= 48 && input.peek(offset + n) <= 57) n++;
    return input.peek(offset + n) === DOT && input.peek(offset + n + 1) === SPACE; // `1. `
  }
  return false;
}

/**
 * Reports whether the cursor sits at the start of a line (column 0 or just after a newline).
 *
 * @param input - The look-ahead view that also tracks the cursor position.
 * @returns `true` when the cursor is at a line start.
 */
export function isLineStart(input: PeekInputWithPos): boolean {
  return input.pos === 0 || input.peek(-1) === NEWLINE;
}

/**
 * Reports whether the current line (cursor at column 0) is a DELIMITED-BLOCK delimiter — a fenced
 * boundary that, per Asciidoctor's `block_terminates_paragraph` compliance, ends an open paragraph
 * even with no blank line before it (e.g. `prose` immediately followed by `****` opens a sidebar
 * block). It mirrors EXACTLY the delimiter forms {@link createBlockTokenLogic} accepts: a run of 4+
 * `= * _ + . / -` alone on the line (example / sidebar / quote / passthrough / literal / comment /
 * listing blocks), the two-dash open block `--`, and the table fences `|=== , === :===`. Section
 * titles (`== `) and list markers — which a paragraph instead ABSORBS — are deliberately excluded,
 * so this only stops the absorption for true block boundaries.
 *
 * @param input - The look-ahead view over the input (cursor on the first char of the line).
 * @param base - Offset of the first char of the line to test (0 = the cursor's own line). Lets a
 *   caller test the line that FOLLOWS the current one without moving the cursor.
 * @returns `true` when the line starts a delimited block.
 */
export function startsDelimitedBlock(input: PeekInput, base = 0): boolean {
  const ch = input.peek(base);
  // Fenced delimiters: a run of one repeated char alone on the line.
  if (ch === EQUALS || ch === STAR || ch === UNDERSCORE || ch === PLUS ||
      ch === SLASH || ch === DOT || ch === DASH) {
    let count = 0;
    while (input.peek(base + count) === ch) count++;
    const after = input.peek(base + count);
    if (after !== NEWLINE && after !== -1) return false; // text after the run ⇒ not a bare delimiter
    if (count >= 4) return true;                          // ==== ---- **** ____ ++++ .... ////
    return ch === DASH && count === 2;                    // -- open block
  }
  // Table fences `|=== , === :===` (the column-0 forms the tokenizer recognises).
  if (ch === PIPE || ch === COMMA || ch === COLON) {
    return input.peek(base + 1) === EQUALS && input.peek(base + 2) === EQUALS && input.peek(base + 3) === EQUALS;
  }
  return false;
}

/**
 * Advances the cursor to the end of the current line, consuming the trailing newline if present.
 *
 * @param input - The consuming view over the input.
 */
export function consumeToEOL(input: ConsumingInput): void {
  while (input.next !== NEWLINE && input.next !== -1) input.advance();
  if (input.next === NEWLINE) input.advance();
}

/**
 * Advances the cursor forward by exactly `count` characters, used to skip a fixed-length label prefix.
 *
 * @param input - The consuming view over the input.
 * @param count - The number of characters to advance.
 */
export function advanceBy(input: ConsumingInput, count: number): void {
  for (let index = 0; index < count; index++) input.advance();
}

/**
 * Advances the cursor over a description-list term and its `::`/`;;` separator run, stopping
 * immediately after the separator (before any definition text, trailing space, or newline). Leaving
 * the rest of the line unconsumed lets the grammar parse the definition as `inlineContent` so it
 * highlights as body text — keeping the first definition line the same colour as a continuation line.
 *
 * @param input - The consuming view over the input.
 * @param termLength - Number of characters in the term, up to the first separator char.
 * @param separator - The separator char code (`:` or `;`).
 */
export function consumeDescTerm(input: ConsumingInput, termLength: number, separator: number): void {
  advanceBy(input, termLength);
  while (input.next === separator) input.advance();
}

/**
 * Advances the cursor over a complete attribute entry, following `\`-continued value lines. A
 * trailing `\` (after optional whitespace) at the end of a physical line continues the value onto
 * the next line, so every continued line is consumed into the same attribute-entry token — the whole
 * wrapped entry highlights as one definition. Stops at the first line that does not
 * end with a continuation marker (consuming its trailing newline, like {@link consumeToEOL}).
 *
 * @param input - The consuming view over the input.
 */
export function consumeAttributeEntry(input: ConsumingInput): void {
  for (;;) {
    // Track the last two non-newline chars of the line so a trailing `\` (optionally followed by
    // whitespace) can be detected without buffering the whole line.
    let lastNonSpace = -1;
    while (input.next !== NEWLINE && input.next !== -1) {
      if (input.next !== SPACE && input.next !== TAB) lastNonSpace = input.next;
      input.advance();
    }
    const continues = lastNonSpace === BACKSLASH;
    if (input.next === NEWLINE) input.advance();
    if (!continues || input.next === -1) return;
  }
}

/**
 * Reports whether `string_` appears in the input starting `offset` positions ahead of the cursor.
 *
 * @param input - The look-ahead view over the input.
 * @param string_ - The literal text to match.
 * @param offset - The position at which matching begins.
 * @returns `true` when the literal matches at that position.
 */
export function peekString(input: PeekInput, string_: string, offset = 0): boolean {
  for (let index = 0; index < string_.length; index++) {
    if (input.peek(offset + index) !== string_.codePointAt(index)) return false;
  }
  return true;
}

/**
 * Reports whether `code` is an ASCII letter or digit.
 *
 * @param code - The char code to classify.
 * @returns `true` for `A`-`Z`, `a`-`z`, and `0`-`9`.
 */
export function isAlphaNumber(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/**
 * Reports whether `code` is whitespace, a line end, or out-of-range (`-1`). Used by the
 * constrained inline-mark boundary rules: a constrained mark must abut such a boundary on the
 * "outer" side (start/end of line or whitespace).
 *
 * @param code - The char code to classify.
 * @returns `true` for space, tab, newline, or end-of-input.
 */
export function isSpaceOrEdge(code: number): boolean {
  return code === SPACE || code === TAB || code === NEWLINE || code === -1;
}

/**
 * Reports whether the char `before` an opening constrained inline mark satisfies AsciiDoc's
 * "constrained" pre-boundary rule: the mark must sit at the start of a line, after whitespace, or
 * after one of a small set of non-word punctuation characters (`,;:"'`-([` and friends). It must
 * NOT directly follow a word character (a letter, digit, or `_`), so an in-word mark like the `*`
 * in `a*b*c` is rejected. Erring toward NO false highlights, only this conservative pre-set opens a
 * constrained mark.
 *
 * @param before - The char code immediately before the opening mark (`-1` at line start).
 * @returns `true` when the position may open a constrained mark.
 */
export function isConstrainedOpenBoundary(before: number): boolean {
  if (before === -1 || before === NEWLINE) return true;
  if (isSpaceOrEdge(before)) return true;
  // Asciidoctor's constrained pre-set: `, ; : " ' ` - ( [ { < ` and the like — any non-word,
  // non-mark punctuation. A word char (letter/digit/`_`) or another mark char never opens.
  if (isAlphaNumber(before) || before === UNDERSCORE || before === STAR || before === BACKTICK) return false;
  return (
    before === COMMA || before === SEMICOLON || before === COLON || before === 34 /* " */ ||
    before === APOSTROPHE || before === DASH || before === 40 /* ( */ || before === LBRACK ||
    before === 123 /* { */ || before === LANGLE || before === 96 /* ` handled above */
  );
}

/**
 * Reports whether `code` is alphanumeric, a dash, or an underscore (the identifier char set).
 *
 * @param code - The char code to classify.
 * @returns `true` for alphanumerics plus `-` and `_`.
 */
export function isAlphaNumberOrDash(code: number): boolean {
  return isAlphaNumber(code) || code === 45 || code === 95;
}

/** The outcome of scanning an inline mark: how many chars the span spans, and which form it is. */
export interface InlineMarkSpan {
  /** Total characters to consume for the span (open mark + body + close mark). */
  length: number;
  /** True for the unconstrained `**`/`__`/double-backtick form (matches anywhere). */
  unconstrained: boolean;
}

/**
 * Scan an inline emphasis span (`*bold*`/`_italic_`/`` `mono` ``) starting at the current cursor,
 * applying AsciiDoc's constrained/unconstrained boundary rules so an in-word mark (`a*b*c`,
 * `2*3*4`) never forms a span. `mark` is the delimiter char code (`*`, `_`, or backtick). The
 * cursor is assumed to sit ON the first mark char; `before` is the char immediately preceding it.
 *
 * Unconstrained form: a doubled mark (`**…**`) — matches even mid-word; the body is any non-empty
 * run that does not contain a newline and ends at the next doubled mark.
 *
 * Constrained form: a single mark — only forms when (a) the opener abuts a pre-boundary
 * (start/whitespace/punctuation, see {@link isConstrainedOpenBoundary}), (b) the char after the
 * opener is not whitespace/newline, (c) a closing single mark exists on the same line whose
 * preceding char is not whitespace, and (d) the char after the closer is a boundary
 * (whitespace/line-end or non-word punctuation). Erring toward NO false highlights, anything that
 * does not satisfy every clause returns `null` so the lone mark falls through to plain text.
 *
 * @param input - The look-ahead view over the input (cursor on the first mark char).
 * @param mark - The delimiter char code.
 * @param before - The char code immediately before the cursor (`-1` at line start).
 * @returns The {@link InlineMarkSpan} to consume, or `null` when no valid span forms here.
 */
export function scanInlineMark(input: PeekInput, mark: number, before: number): InlineMarkSpan | null {
  // ── Unconstrained `XX…XX` (doubled mark) — matches anywhere, including mid-word. ──
  if (input.peek(1) === mark) {
    let offset = 2;
    let bodyChars = 0;
    while (true) {
      const code = input.peek(offset);
      if (code === NEWLINE || code === -1) return null; // no closing pair on this line
      if (code === mark && input.peek(offset + 1) === mark) {
        return bodyChars > 0 ? { length: offset + 2, unconstrained: true } : null;
      }
      bodyChars += 1;
      offset += 1;
    }
  }

  // ── Constrained single mark — strict boundary rules. ──
  if (!isConstrainedOpenBoundary(before)) return null;
  const afterOpen = input.peek(1);
  if (isSpaceOrEdge(afterOpen) || afterOpen === mark) return null; // no space/empty after opener

  let offset = 1;
  while (true) {
    const code = input.peek(offset);
    if (code === NEWLINE || code === -1) return null; // unterminated ⇒ not a span
    if (code === mark) {
      const beforeClose = input.peek(offset - 1);
      const afterClose = input.peek(offset + 1);
      // The closer must not abut whitespace on its inner side and must be followed by a boundary
      // (whitespace, line-end, or non-word punctuation — never a word char, which would make it
      // an in-word mark). A doubled mark here is not a constrained closer.
      if (input.peek(offset + 1) === mark) { offset += 1; continue; }
      if (beforeClose !== SPACE && beforeClose !== TAB &&
          (isSpaceOrEdge(afterClose) || isConstrainedCloseBoundary(afterClose))) {
        return { length: offset + 1, unconstrained: false };
      }
    }
    offset += 1;
  }
}

/**
 * Reports whether the char AFTER a constrained closing mark is a valid post-boundary — a non-word
 * character that is allowed to follow emphasis (`. , ; : ! ? " ' ) ] } < >` and the like). A word
 * char (letter/digit/`_`) is rejected so a mark embedded in a word (`a*b*c`) never closes a span.
 */
function isConstrainedCloseBoundary(after: number): boolean {
  if (isAlphaNumber(after) || after === UNDERSCORE) return false;
  return true;
}
