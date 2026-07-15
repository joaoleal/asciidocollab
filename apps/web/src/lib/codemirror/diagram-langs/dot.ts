import {
  StreamLanguage,
  LanguageSupport,
  type StreamParser,
  type StringStream,
} from '@codemirror/language';

/**
 * A faithful — but deliberately pragmatic — highlighter for the Graphviz DOT
 * language, implemented as a CodeMirror {@link StreamParser}.
 *
 * It is a *highlighter, not a validator*: any input tokenises without ever
 * throwing, and constructs it does not understand degrade to a neutral token
 * rather than derailing the surrounding document. It exists so that DOT source
 * inside `[graphviz]` / `[dot]` AsciiDoc diagram blocks reads like code in the
 * editor; the block-body routing that mounts it lives in a separate task.
 *
 * The `token` method returns `@lezer/highlight` tag *names* (e.g. `"keyword"`,
 * `"variableName"`, `"squareBracket"`). CodeMirror's stream-language runner
 * resolves those names against the highlight-tag table, so the parser composes
 * with the editor theme without needing an explicit `tokenTable`.
 */

/** Reserved DOT keywords (case-insensitive per the language spec). */
const KEYWORDS = new Set(['graph', 'digraph', 'subgraph', 'strict', 'node', 'edge']);

/**
 * Identifier characters. DOT ids are `[a-zA-Z_\200-\377][a-zA-Z0-9_\200-\377]*`;
 * we widen the high range to all non-ASCII code points, which is harmless for a
 * highlighter and covers Unicode graph labels.
 */
const ID_START = /[A-Za-z_-￿]/;
const ID_CHAR = /[A-Za-z0-9_-￿]/;

/**
 * Per-line mutable state threaded through the DOT stream tokenizer.
 */
export interface DotState {
  /** True while inside a block comment (which spans lines). */
  inBlockComment: boolean;
  /** Nesting depth of the current attribute list `[ … ]`. */
  attrDepth: number;
  /**
   * Within an attribute list we alternate key → value. `expectValue` is true
   * after an `=` (so an identifier is a value, not a key) and resets on `,`,
   * `;`, `[` or `]`.
   */
  expectValue: boolean;
}

function startState(): DotState {
  return { inBlockComment: false, attrDepth: 0, expectValue: false };
}

/** Consume the remainder of an open block comment; clears the flag once it closes. */
function consumeBlockComment(stream: StringStream, state: DotState): void {
  while (!stream.eol()) {
    if (stream.next() === '*' && stream.peek() === '/') {
      stream.next();
      state.inBlockComment = false;
      return;
    }
  }
}

/** Consume a double-quoted string, honouring backslash escapes. */
function consumeString(stream: StringStream): void {
  let escaped = false;
  let ch: string | void;
  while ((ch = stream.next()) != null) {
    if (ch === '"' && !escaped) break;
    escaped = !escaped && ch === '\\';
  }
}

function token(stream: StringStream, state: DotState): string | null {
  if (state.inBlockComment) {
    consumeBlockComment(stream, state);
    return 'comment';
  }

  if (stream.eatSpace()) return null;

  const ch = stream.peek();
  if (ch == null) return null;

  // ── Comments ──────────────────────────────────────────────────────────────
  if (stream.match('//')) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.match('/*')) {
    state.inBlockComment = true;
    consumeBlockComment(stream, state);
    return 'comment';
  }
  // A `#` line is a C-preprocessor-style comment in DOT.
  if (ch === '#') {
    stream.skipToEnd();
    return 'comment';
  }

  // ── Strings ───────────────────────────────────────────────────────────────
  if (ch === '"') {
    stream.next();
    consumeString(stream);
    return 'string';
  }

  // ── Numbers (optionally signed, with a fractional part) ────────────────────
  if (/[0-9]/.test(ch) || ((ch === '-' || ch === '.') && /[0-9]/.test(stream.string.charAt(stream.pos + 1)))) {
    stream.match(/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)/);
    return 'number';
  }

  // ── Edge operators ────────────────────────────────────────────────────────
  if (stream.match('->') || stream.match('--')) {
    return 'operator';
  }

  // ── Braces / brackets / punctuation ────────────────────────────────────────
  if (ch === '{' || ch === '}') {
    stream.next();
    return 'brace';
  }
  if (ch === '[') {
    stream.next();
    state.attrDepth++;
    state.expectValue = false;
    return 'squareBracket';
  }
  if (ch === ']') {
    stream.next();
    if (state.attrDepth > 0) state.attrDepth--;
    state.expectValue = false;
    return 'squareBracket';
  }
  if (ch === '=') {
    stream.next();
    if (state.attrDepth > 0) state.expectValue = true;
    return 'operator';
  }
  if (ch === ',' || ch === ';') {
    stream.next();
    state.expectValue = false;
    return 'punctuation';
  }
  if (ch === ':') {
    // Port separator (`node:port`); keeps the current key/value expectation.
    stream.next();
    return 'punctuation';
  }

  // ── Identifiers / keywords / attribute keys ────────────────────────────────
  if (ID_START.test(ch)) {
    stream.next();
    while (!stream.eol() && ID_CHAR.test(stream.peek() ?? '')) stream.next();
    const word = stream.current();
    if (KEYWORDS.has(word.toLowerCase())) return 'keyword';
    if (state.attrDepth > 0 && !state.expectValue) return 'attributeName';
    return 'variableName';
  }

  // Unknown character: advance one unit and stay neutral rather than stalling.
  stream.next();
  return null;
}

/** The raw stream parser — consumed by the diagram block-body highlight routing. */
export const dotStreamParser: StreamParser<DotState> = {
  name: 'dot',
  startState,
  token,
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['{', '[', '"'] },
  },
};

/** A CodeMirror {@link StreamLanguage} wrapping {@link dotStreamParser}. */
export const dotLanguage: StreamLanguage<DotState> = StreamLanguage.define(dotStreamParser);

/** {@link LanguageSupport} bundle for standalone use of the DOT language. */
export function dot(): LanguageSupport {
  return new LanguageSupport(dotLanguage);
}
