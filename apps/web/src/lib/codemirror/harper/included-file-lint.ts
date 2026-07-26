import type { Tree } from '@lezer/common';
import { extractProseSegments, spanToDocumentRange, type ProseSegment } from '../prose-segments';
import { categoryForLintKind, type GrammarCategory } from './category-colors';
import type { HarperWorkerClient } from './harper-worker-client';

/**
 * The cross-file half of the writing checker: the pass that checks the files an open document pulls in
 * with `include::`, which the editor's own lint source cannot see.
 *
 * The CodeMirror lint source runs over the `EditorView`'s document, and that document is only ever the
 * OPEN file — so on its own it can never make "Whole document" mean more than "this file". This module
 * closes that gap: given the other files of the include tree (content read from the project symbol
 * index), it extracts their prose the same way the open file's is extracted, lints it through the same
 * worker client, and reports each issue as a `{path, line}` LOCATION rather than a document range.
 * Positions are deliberately not produced: an offset into another file means nothing in this editor,
 * and painting it here would underline unrelated text.
 *
 * Each file is checked on its own rather than as one assembled document. Assembling would fuse the last
 * paragraph of a parent with the first of its child and manufacture issues across a boundary the author
 * cannot see, and it would leave every issue needing a reverse provenance lookup to be reportable.
 */

/** One file of the open document's include tree, with the content the checker reads. */
export interface IncludedFile {
  /** The file node id, so a click can navigate to it. */
  readonly fileId: string;
  /** The project-relative path, shown in the panel. */
  readonly path: string;
  /** The file's current text. */
  readonly content: string;
}

/** A writing issue found in a file OTHER than the one open in the editor. */
export interface IncludedFileIssue {
  /** The file node id the issue is in. */
  readonly fileId: string;
  /** The project-relative path of that file. */
  readonly path: string;
  /** The 1-based line of the issue within that file. */
  readonly line: number;
  /** The writing-issue category, driving the panel's colour dot. */
  readonly category: GrammarCategory;
  /** The engine's message for the issue. */
  readonly message: string;
  /**
   * The name of the rule that produced it, so a cross-file issue names its rule exactly like an issue
   * in the open file (see `EngineLint.rule`). Empty when the engine attributed none.
   */
  readonly rule: string;
}

/** The outcome of one cross-file pass. */
export interface IncludedFileLintResult {
  /** The issues found so far, in file order. */
  readonly issues: IncludedFileIssue[];
  /**
   * True when every file was checked. False when the pass was cancelled, or when the shared worker
   * client superseded it (the open file's own lint started while this pass was mid-flight) — the
   * issues collected so far are partial and the caller should retry rather than publish them.
   */
  readonly completed: boolean;
}

/** Per-pass inputs: the client to lint through, plus the cancellation and yielding hooks. */
export interface IncludedFileLintRun {
  /** The worker client that lints off the main thread (shared with the open file's lint source). */
  readonly client: HarperWorkerClient;
  /** Returns true once the pass should stop (the scope changed, or the editor unmounted). */
  readonly isCancelled?: () => boolean;
  /** Awaited between files so a large include tree never blocks the UI in one go. */
  readonly yieldToUi?: () => Promise<void>;
}

/** Construction inputs for {@link createIncludedFileLinter}. */
export interface IncludedFileLinterOptions {
  /**
   * Parses AsciiDoc text into a syntax tree. Injected rather than imported so this module stays free of
   * the generated parser, and so a test can drive it with a parser built from the grammar source.
   *
   * @param text - The file text to parse.
   * @returns The parsed syntax tree.
   */
  readonly parse: (text: string) => Tree;
}

/** Checks the non-open files of an include tree, reusing its parse cache across passes. */
export interface IncludedFileLinter {
  /**
   * Check every given file and collect its issues.
   *
   * @param files - The files to check (the open file must NOT be among them).
   * @param run - The client plus the cancellation and yielding hooks for this pass.
   * @returns The issues found and whether the pass ran to completion.
   */
  lint(files: readonly IncludedFile[], run: IncludedFileLintRun): Promise<IncludedFileLintResult>;
}

/** A file's parsed prose, cached against the exact content it was derived from. */
interface ParsedFile {
  /** The content the segments and line starts were computed from. */
  readonly content: string;
  /** The file's prose segments. */
  readonly segments: ProseSegment[];
  /** Offset of the first character of each line, ascending (index 0 is line 1). */
  readonly lineStarts: number[];
}

/** Never hold parses for more files than a large book's include tree, so the cache cannot grow unbounded. */
const PARSE_CACHE_MAX = 200;

/** Offsets of every line start in a text, so an offset resolves to a line by binary search. */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/**
 * The 1-based line containing an offset.
 *
 * @param lineStarts - Ascending line-start offsets from {@link computeLineStarts}.
 * @param offset - The character offset to locate.
 * @returns The 1-based line number.
 */
function lineOfOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Resolve a lint's segment-local span to the 1-based line it starts on within its file. */
function issueLine(segment: ProseSegment, spanStart: number, spanEnd: number, lineStarts: readonly number[]): number {
  return lineOfOffset(lineStarts, spanToDocumentRange(segment, spanStart, spanEnd).from);
}

/** Yield to the browser between files by default, so a long tree checks in slices rather than one block. */
function defaultYieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Create the cross-file checker. The returned linter memoizes each file's parse against its exact
 * content, so re-checking an unchanged include tree costs a map lookup per file instead of a full
 * re-parse — which is what makes it affordable to re-run the pass whenever the tree changes.
 *
 * @param options - The parse function to derive prose with.
 * @returns A linter that checks a set of included files.
 */
export function createIncludedFileLinter(options: IncludedFileLinterOptions): IncludedFileLinter {
  const parsed = new Map<string, ParsedFile>();

  /** Return a file's prose segments and line index, parsing (and caching) only when the content changed. */
  function parseFile(file: IncludedFile): ParsedFile {
    const cached = parsed.get(file.path);
    if (cached && cached.content === file.content) return cached;
    const entry: ParsedFile = {
      content: file.content,
      segments: extractProseSegments(options.parse(file.content), file.content),
      lineStarts: computeLineStarts(file.content),
    };
    parsed.set(file.path, entry);
    if (parsed.size > PARSE_CACHE_MAX) {
      const oldest = parsed.keys().next().value;
      if (oldest !== undefined) parsed.delete(oldest);
    }
    return entry;
  }

  return {
    async lint(files, run) {
      const issues: IncludedFileIssue[] = [];
      const yieldToUi = run.yieldToUi ?? defaultYieldToUi;
      for (const file of files) {
        if (run.isCancelled?.()) return { issues, completed: false };
        const { segments, lineStarts } = parseFile(file);
        if (segments.length === 0) continue;
        const results = await run.client.lint(
          segments.map((segment, index) => ({ id: String(index), text: segment.text })),
        );
        // `null` means the shared client superseded this request (or the engine is unavailable). The
        // remaining files were never checked, so report the pass as incomplete rather than publishing
        // a list that silently omits them.
        if (results === null) return { issues, completed: false };
        for (const result of results) {
          const segment = segments[Number(result.id)];
          if (!segment) continue; // a stale/unknown id — skip rather than mis-locate
          for (const lint of result.lints) {
            issues.push({
              fileId: file.fileId,
              path: file.path,
              line: issueLine(segment, lint.span.start, lint.span.end, lineStarts),
              category: categoryForLintKind(lint.kind),
              message: lint.message,
              rule: lint.rule,
            });
          }
        }
        await yieldToUi();
      }
      return { issues, completed: !run.isCancelled?.() };
    },
  };
}
