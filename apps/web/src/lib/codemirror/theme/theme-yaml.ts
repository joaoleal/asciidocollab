/**
 * @file Reading an Asciidoctor-PDF theme document's structure by line.
 *
 * The theme editor's three capabilities — key completion, inline colour/font previews, and
 * validation — all need the same two answers: *what dotted key does this line assign?* and *what
 * path is the cursor nested under?* Deriving those separately in three places is how a swatch comes
 * to appear on a line the validator calls unknown, so all three read this module.
 *
 * This is a deliberately small, indentation-driven reader rather than a YAML parser. A theme is a
 * plain nested mapping of scalars: no anchors, no flow mappings, no multi-document streams. Parsing
 * it structurally would mean re-deriving line offsets from a syntax tree to place decorations and
 * diagnostics, which is more work for a shape that never occurs here. Anything this reader cannot
 * make sense of is reported as "no key on this line", and the caller simply does nothing to it —
 * offering no swatch is always safe, whereas guessing at a key is not.
 */

/** A single `key: value` assignment on one line of a theme document. */
export interface ThemeAssignment {
  /** The full dotted path, e.g. `heading.h2.font-color`. */
  readonly key: string;
  /** The final segment only, as written on this line. */
  readonly leaf: string;
  /** 1-based line number. */
  readonly line: number;
  /** Document offset where the key's text begins. */
  readonly keyFrom: number;
  /** Document offset just past the key's text. */
  readonly keyTo: number;
  /** The raw value text, trimmed and with any trailing comment removed. Empty for a container. */
  readonly value: string;
  /** Document offset where the raw value begins; equal to `valueTo` when there is no value. */
  readonly valueFrom: number;
  /** Document offset just past the raw value. */
  readonly valueTo: number;
}

/** A line's indentation depth in spaces, or null when the line carries no mapping key. */
interface LineShape {
  readonly indent: number;
  readonly leaf: string;
  readonly keyOffset: number;
  readonly rest: string;
  readonly restOffset: number;
}

/**
 * A mapping key at the start of a line: optional indent, an unquoted key, a colon, then the rest.
 *
 * Theme keys are bare words with hyphens and underscores. Quoted keys and list items (`- `) are
 * deliberately not matched — a theme has neither, and matching them would mean guessing at a
 * structure this reader does not model.
 */
const MAPPING_LINE = /^(\s*)([A-Za-z\d][\w-]*)\s*:(.*)$/;

/**
 * A `#` immediately followed by 3, 4, 6 or 8 hex digits and nothing word-like after — the CSS-style
 * colour literal Asciidoctor-PDF accepts alongside the bare `RRGGBB` form.
 */
const HASH_COLOUR = /^#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/i;

/**
 * Strip a trailing `#` comment from a value.
 *
 * The awkward case is `font-color: #333333  # body text`, where BOTH hashes sit after whitespace.
 * Position alone cannot separate them, so a hash opens a comment unless what follows it is a hex
 * colour literal — which is the only thing a `#` legitimately begins inside a theme value.
 *
 * @param raw - Everything after the colon on a theme line.
 * @returns The value text with any comment removed; surrounding whitespace is left intact so the
 *   caller can still compute offsets against the original line.
 */
export function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && !HASH_COLOUR.test(raw.slice(index))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

/** Decompose one line into its mapping key and the text after the colon, or null when it has none. */
function shapeOf(line: string, lineStart: number): LineShape | null {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return null;
  const match = MAPPING_LINE.exec(line);
  if (match === null) return null;
  const [, indent, leaf, rest] = match;
  return {
    indent: indent.length,
    leaf,
    keyOffset: lineStart + indent.length,
    rest,
    restOffset: lineStart + indent.length + leaf.length + line.slice(indent.length + leaf.length).indexOf(':') + 1,
  };
}

/**
 * Every key assignment in a theme document, with its full dotted path and value range.
 *
 * Container lines (`heading:` with nothing after the colon) are NOT returned as assignments — they
 * carry no value to preview or validate — but they do establish the path their children nest under.
 *
 * @param text - The whole theme document.
 * @returns One entry per line that assigns a value, in document order.
 */
export function themeAssignments(text: string): ThemeAssignment[] {
  const assignments: ThemeAssignment[] = [];
  /** The open path, as (indent, segment) pairs — anything indented further nests beneath it. */
  const stack: { indent: number; segment: string }[] = [];
  let offset = 0;

  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;

    const shape = shapeOf(line, lineStart);
    if (shape === null) continue;

    // Close every path segment at this indentation or deeper before opening a new one.
    while ((stack.at(-1)?.indent ?? -1) >= shape.indent) stack.pop();

    const path = [...stack.map((entry) => entry.segment), shape.leaf].join('.');
    const rawValue = stripComment(shape.rest);
    const trimmed = rawValue.trim();

    if (trimmed === '') {
      // A container: it opens a path for the lines below it rather than assigning anything.
      stack.push({ indent: shape.indent, segment: shape.leaf });
      continue;
    }

    const leadingSpace = rawValue.length - rawValue.trimStart().length;
    assignments.push({
      key: path,
      leaf: shape.leaf,
      line: index + 1,
      keyFrom: shape.keyOffset,
      keyTo: shape.keyOffset + shape.leaf.length,
      value: trimmed,
      valueFrom: shape.restOffset + leadingSpace,
      valueTo: shape.restOffset + leadingSpace + trimmed.length,
    });
  }

  return assignments;
}

/** Where the cursor sits in a theme document, for deciding what to complete. */
export interface ThemeCursorContext {
  /**
   * The dotted path the cursor's line nests under — the prefix a completed key belongs to. Empty at
   * the top level.
   */
  readonly parentPath: string;
  /** The partial key text already typed on this line, which the completion filters against. */
  readonly typed: string;
  /** Document offset where the typed key begins, so a completion replaces it rather than appending. */
  readonly from: number;
  /** True when the cursor is past the colon — the author is writing a VALUE, not a key. */
  readonly inValue: boolean;
  /** When `inValue`, the full dotted key whose value is being written. */
  readonly key: string;
}

/**
 * Work out what the cursor is in the middle of writing.
 *
 * @param text - The whole theme document.
 * @param position - The cursor's document offset.
 * @returns The context, or null when the line is a comment or otherwise not a place to complete.
 */
export function themeCursorContext(text: string, position: number): ThemeCursorContext | null {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  if (line.trimStart().startsWith('#')) return null;

  const beforeCursor = line.slice(0, position - lineStart);
  const indent = line.length - line.trimStart().length;

  // Rebuild the enclosing path from the lines above, closing any at this indent or deeper.
  const stack: { indent: number; segment: string }[] = [];
  let offset = 0;
  for (const previous of text.slice(0, lineStart).split('\n')) {
    const shape = shapeOf(previous, offset);
    offset += previous.length + 1;
    if (shape === null) continue;
    while ((stack.at(-1)?.indent ?? -1) >= shape.indent) stack.pop();
    if (stripComment(shape.rest).trim() === '') stack.push({ indent: shape.indent, segment: shape.leaf });
  }
  while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
  const parentPath = stack.map((entry) => entry.segment).join('.');

  const colon = beforeCursor.indexOf(':');
  if (colon !== -1) {
    const leaf = beforeCursor.slice(0, colon).trim();
    if (leaf === '') return null;
    const key = parentPath === '' ? leaf : `${parentPath}.${leaf}`;
    const afterColon = beforeCursor.slice(colon + 1);
    return {
      parentPath,
      typed: afterColon.trimStart(),
      from: lineStart + colon + 1 + (afterColon.length - afterColon.trimStart().length),
      inValue: true,
      key,
    };
  }

  const typed = beforeCursor.trimStart();
  // Only a bare key-shaped token is a completion point; anything else is not a key being written.
  if (!/^[A-Za-z\d]?[\w-]*$/.test(typed)) return null;
  return { parentPath, typed, from: lineStart + indent, inValue: false, key: '' };
}
