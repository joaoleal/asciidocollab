import { ContextTracker } from '@lezer/lr';

/**
 * Document-header position tracking for the block tokenizer — the parse context that decides where an
 * implicit author line and a revision line may be recognised.
 *
 * WHY A CONTEXT TRACKER AND NOT THE GRAMMAR. The byline is positional, and the obvious way to say so
 * is a sequence: `DocumentTitle (AuthorLine RevisionLine?)?`. That works only while the byline sits
 * DIRECTLY under the title, which is not AsciiDoc: Asciidoctor's `parse_header_metadata` consumes
 * attribute entries (discarding comment lines with them) before the author line, again between the
 * author and revision lines, and again after. Writing those runs into the sequence
 * (`DocumentTitle headerMeta* AuthorLine …`) makes the grammar ambiguous — after a title, an
 * `AttributeEntry` may equally be header metadata or the next block, and lezer rejects the shift/reduce
 * conflict. The same conflict blocks hoisting the header into its own top-level rule. A context
 * tracker states the position directly instead, and leaves the grammar's block alternatives flat.
 *
 * It also fixes what the grammar could never see: a sequence keyed on `DocumentTitle` admits a byline
 * under ANY level-0 title, so `= Another Title` in the middle of a document turned the short sentence
 * below it into header metadata — mis-highlighted, and silently excluded from spell/grammar checking.
 * The context knows a title is THE document title only when nothing but blank lines, comment lines and
 * attribute entries precede it.
 *
 * The states mirror Asciidoctor's header walk. Everything that is not part of the header moves the
 * context to {@link BODY}, which is absorbing — a document has one header, and it is over.
 */

/** Before the document title: only blank lines, comment lines and attribute entries may precede it. */
export const HEADER_START = 0;
/** In the header, title seen, no author line yet — an author line may be recognised here. */
export const HEADER_AFTER_TITLE = 1;
/** In the header, author line seen — a revision line may be recognised here. */
export const HEADER_AFTER_AUTHOR = 2;
/** Past the header (or never in one): no byline may be recognised. Absorbing. */
export const BODY = 3;

/**
 * Build the block-context tracker bound to a term-id map, mirroring the tokenizer's own
 * `createBlockTokenLogic` split: the ids come from the generated parser, so the logic that reads them
 * stays free of the generated ESM and is shared verbatim with the grammar test harness.
 *
 * @param T - The term table (external token name → id).
 * @returns The tracker the grammar's `@context` declaration binds.
 */
export function createBlockContextLogic(T: Record<string, number>): ContextTracker<number> {
  const {
    docTitleToken, attrEntryToken, commentLineToken, blankLineToken, blockAttrToken,
    authorLineToken, revisionLineToken,
  } = T;

  return new ContextTracker<number>({
    start: HEADER_START,
    shift(context, term) {
      // Attribute entries and comment lines are transparent wherever the header allows them, exactly
      // as `process_attribute_entries` (which discards comment lines) is called at each step.
      const isHeaderMetadata = term === attrEntryToken || term === commentLineToken;
      switch (context) {
        case HEADER_START: {
          if (term === docTitleToken) return HEADER_AFTER_TITLE;
          // A blank line before the title is not content, so the header is still ahead —
          // `parse_document_header` opens with `reader.skip_blank_lines`. Both spellings of "blank"
          // arrive as `blankLineToken`: the tokenizer claims a truly empty line for it while the
          // context is HEADER_START precisely because the grammar's `nl` has no exported term id here.
          //
          // A block-attribute line (`[#custom-id]`, `[.lead]`) is likewise not content: Asciidoctor
          // runs `parse_block_metadata_lines` BEFORE it looks for the doctitle and carries the
          // attributes onto the document, so a byline still follows the title under one. A block TITLE
          // is deliberately NOT in this set — `.Caption` above a doctitle makes Asciidoctor abandon
          // header parsing outright (parser.rb, "block title is not allowed above document title"),
          // which is exactly the BODY answer below.
          //
          // Anything else is body: a document whose first block is a paragraph or a section heading
          // has no header.
          const isPreTitleMetadata = isHeaderMetadata || term === blankLineToken || term === blockAttrToken;
          return isPreTitleMetadata ? HEADER_START : BODY;
        }
        case HEADER_AFTER_TITLE: {
          if (term === authorLineToken) return HEADER_AFTER_AUTHOR;
          // A blank line ENDS the header here (unlike above it): the title stands alone.
          return isHeaderMetadata ? HEADER_AFTER_TITLE : BODY;
        }
        case HEADER_AFTER_AUTHOR: {
          // The revision line is the last thing the header can offer, so it closes the byline window
          // rather than opening another; the entries that may follow it are already ordinary entries.
          if (term === revisionLineToken) return BODY;
          return isHeaderMetadata ? HEADER_AFTER_AUTHOR : BODY;
        }
        default: {
          return BODY;
        }
      }
    },
    // The context IS a small number, so it is its own hash. Kept strict (the default) so a cached tree
    // node from a different header position is never reused during an incremental reparse.
    hash: (context) => context,
  });
}
