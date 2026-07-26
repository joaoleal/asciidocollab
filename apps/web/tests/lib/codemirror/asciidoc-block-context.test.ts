import type { InputStream, Stack } from '@lezer/lr';
import { blockContext } from '@/lib/codemirror/asciidoc-block-context';
import {
  createBlockContextLogic,
  HEADER_START, HEADER_AFTER_TITLE, HEADER_AFTER_AUTHOR, BODY,
} from '@/lib/codemirror/asciidoc-block-context-logic';

/**
 * The document-header state machine that decides where a byline may be recognised. Driven directly
 * here (a `ContextTracker` exposes its spec only through the parser, so `shift` is invoked through the
 * same interface lezer uses); the end-to-end transitions are asserted in `asciidoc-grammar.test.ts`.
 */

// Term ids are arbitrary but must be distinct, exactly as in the generated parser.
const TERMS: Record<string, number> = {
  docTitleToken: 1, attrEntryToken: 2, commentLineToken: 3, blankLineToken: 4,
  authorLineToken: 5, revisionLineToken: 6,
  heading1Token: 7, paragraphLineToken: 8, listingDelim: 9, blockAttrToken: 10, blockTitleToken: 11,
};

const tracker = createBlockContextLogic(TERMS) as unknown as {
  shift: (context: number, term: number, stack: Stack, input: InputStream) => number;
  hash: (context: number) => number;
};

/** Feed a run of terms through the tracker from the initial state and return where it lands. */
function walk(...terms: number[]): number {
  let context: number = HEADER_START;
  for (const term of terms) {
    context = tracker.shift(context, term, null as unknown as Stack, null as unknown as InputStream);
  }
  return context;
}

describe('blockContext (production binding)', () => {
  test('is the tracker the grammar names, bound to the generated term ids', () => {
    expect(blockContext).toBeDefined();
    expect(blockContext).toHaveProperty('start', HEADER_START);
  });
});

describe('createBlockContextLogic', () => {
  test('starts before the title', () => {
    expect(walk()).toBe(HEADER_START);
  });

  test('the document title opens the author position', () => {
    expect(walk(TERMS.docTitleToken)).toBe(HEADER_AFTER_TITLE);
  });

  test('entries, comments and blank lines above the title keep the header ahead', () => {
    expect(walk(TERMS.commentLineToken, TERMS.attrEntryToken, TERMS.blankLineToken)).toBe(HEADER_START);
    expect(walk(TERMS.commentLineToken, TERMS.attrEntryToken, TERMS.docTitleToken)).toBe(HEADER_AFTER_TITLE);
  });

  test('a block-attribute line above the title keeps the header ahead', () => {
    // Asciidoctor runs `parse_block_metadata_lines` BEFORE it looks for the doctitle and carries the
    // attributes onto the document, so `[#custom-id]` / `[.lead]` above `= Title` leaves a real header.
    expect(walk(TERMS.blockAttrToken)).toBe(HEADER_START);
    expect(walk(TERMS.blockAttrToken, TERMS.docTitleToken, TERMS.authorLineToken)).toBe(HEADER_AFTER_AUTHOR);
  });

  test('a block TITLE above the document title means there is no header', () => {
    // parser.rb: "block title is not allowed above document title" — Asciidoctor finalizes the header
    // and never parses header metadata, so no byline may follow.
    expect(walk(TERMS.blockTitleToken)).toBe(BODY);
    expect(walk(TERMS.blockTitleToken, TERMS.docTitleToken)).toBe(BODY);
  });

  test('a body block before the title means the document has no header', () => {
    expect(walk(TERMS.paragraphLineToken)).toBe(BODY);
    expect(walk(TERMS.paragraphLineToken, TERMS.docTitleToken)).toBe(BODY);
    expect(walk(TERMS.heading1Token, TERMS.docTitleToken)).toBe(BODY);
  });

  test('entries and comments between the title and the author line are transparent', () => {
    expect(walk(TERMS.docTitleToken, TERMS.attrEntryToken, TERMS.commentLineToken)).toBe(HEADER_AFTER_TITLE);
    expect(walk(TERMS.docTitleToken, TERMS.attrEntryToken, TERMS.authorLineToken)).toBe(HEADER_AFTER_AUTHOR);
  });

  test('a blank line after the title ends the header', () => {
    expect(walk(TERMS.docTitleToken, TERMS.blankLineToken)).toBe(BODY);
  });

  test('entries and comments between the author and revision lines are transparent', () => {
    expect(walk(TERMS.docTitleToken, TERMS.authorLineToken, TERMS.attrEntryToken)).toBe(HEADER_AFTER_AUTHOR);
    expect(walk(TERMS.docTitleToken, TERMS.authorLineToken, TERMS.commentLineToken, TERMS.revisionLineToken))
      .toBe(BODY);
  });

  test('anything else at the author position ends the header', () => {
    expect(walk(TERMS.docTitleToken, TERMS.listingDelim)).toBe(BODY);
    expect(walk(TERMS.docTitleToken, TERMS.authorLineToken, TERMS.paragraphLineToken)).toBe(BODY);
  });

  test('BODY is absorbing — a later title opens no second header', () => {
    expect(walk(TERMS.docTitleToken, TERMS.authorLineToken, TERMS.revisionLineToken, TERMS.docTitleToken))
      .toBe(BODY);
    expect(walk(TERMS.paragraphLineToken, TERMS.docTitleToken, TERMS.attrEntryToken)).toBe(BODY);
  });

  test('the context is its own hash, so states compare cheaply', () => {
    for (const context of [HEADER_START, HEADER_AFTER_TITLE, HEADER_AFTER_AUTHOR, BODY]) {
      expect(tracker.hash(context)).toBe(context);
    }
  });
});
