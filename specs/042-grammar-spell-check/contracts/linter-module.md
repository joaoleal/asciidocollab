# Module Contract: Prose Extraction & Offset Mapping (RISK MODULE)

The make-or-break unit (spec US1/FR-002, plan research R3). Pure, framework-free, unit-tested against the Lezer tree via the existing `tokenize` harness before any wiring. Refactored out of `asciidoc-spellcheck.ts` and shared with the nspell fallback.

## `lib/codemirror/prose-segments.ts`

```ts
export interface ProseSegment {
  /** Visible prose text of one contiguous prose block (markup/code/macros removed). */
  text: string;
  /** map[i] = document offset of text[i]. Strictly increasing. Length === text.length. */
  map: number[];
}

/** Extract prose-only segments from a parsed AsciiDoc document. */
export function extractProseSegments(tree: SyntaxNode | Tree, text: string): ProseSegment[];

/** Map a lint span (offsets into a segment's text) to an absolute document range. */
export function spanToDocumentRange(segment: ProseSegment, spanStart: number, spanEnd: number): { from: number; to: number };
//  → { from: segment.map[spanStart], to: segment.map[spanEnd - 1] + 1 }
```

### Exclusion set (reuse `SPELLCHECK_SKIP_NODES` verbatim)

Excluded from prose (never linted): `ListingBlock`, `LiteralBlock`, `PassthroughBlock`, `CommentBlock`, `CommentLine`, `StemBlock`, `Monospace`, `AttributeEntry`, `AttributeReference`, `BlockMacro`, `InlineMacro`, `CrossReference`, `Footnote`, `Conditional`, `BlockAttributeLine`, `DocumentTitle`, `Link`, `InlineStem`, `UiMacro`, `Passthrough`, `InlineAnchor`, `BiblioAnchor`, `Callout`, `Entity`, `InlineSet`. Plus: `RoleSpan` body is reconstructed (drop `[.role]##`/`##` markup, keep body); document header author/revision lines excluded by position (`headerMetadataRanges`).

### Segmentation rule (the addition grammar needs over spelling)

- Segment boundaries fall at excluded-node boundaries and blank-line block breaks: each **contiguous** run of prose is its own `ProseSegment`. Do **not** join prose across a skipped block into one string (avoids cross-block false grammar positives).
- Within a segment, dropped role-span markup is removed so a word split by markup rejoins (as the existing code already does).

### Contract tests (author first — Principle II)

- Every excluded node category produces **no** prose in its range (one test per category from the set above).
- Prose inside `Paragraph`, list/description continuations, admonition bodies, and heading text (non-title) IS extracted.
- `spanToDocumentRange` lands exactly on the intended characters for: single-segment, **multi-segment** documents, spans adjacent to skipped nodes, spans inside reconstructed role-span bodies.
- Round-trip: for every segment, `text[i]` equals `documentText[map[i]]` except at collapsed boundary spaces.
- Degenerate inputs: empty document, document that is entirely a code block (→ zero segments), whitespace-only prose.

## `lib/codemirror/harper/harper-linter-source.ts`

```ts
/** @codemirror/lint source: extract segments → lint via worker client → map spans → Diagnostic[]. */
export function harperLintSource(deps: {
  client: HarperWorkerClient;
  getDialect: () => 'en-GB' | 'en-US';
  getHydrationReady: () => boolean;         // ignored-lints blob + project dictionary imported into the worker
}): (view: EditorView) => Promise<Diagnostic[]>;
```

- Checks EVERY prose segment of the open file, in both check scopes. The editor can only underline text with a position in its own document, and that document is the open file either way; the scope widens what the panel LISTS, not what is underlined.
- Produces `[]` (no diagnostics, no throw) when the engine is unavailable — graceful degradation (FR-025/026).
- Ignored issues and dictionary terms are suppressed **inside Harper** (the worker `importIgnoredLints` the user's blob and `importWords` the project dictionary), so the source does not re-filter by hash — it renders whatever the worker returns. `getHydrationReady` is a readiness signal (re-lint once the blob + dictionary are imported), not a client-side filter.
- Each `Diagnostic` carries actions: **apply** (dispatch CM transaction — the only shared write), **add to project dictionary**, **ignore**.

## Guarantees

- Pure functions (`extractProseSegments`, `spanToDocumentRange`, `lintToDiagnostic`) have no CodeMirror/DOM/Yjs dependency beyond the read-only syntax tree + text, so they unit-test via `tokenize`.
- The source never dispatches a document change except on explicit user "apply" — the invariant that keeps diagnostics out of the Yjs doc (Principle VII / FR-011).

## `lib/codemirror/harper/included-file-lint.ts`

```ts
/** The "Whole document" half: check the OTHER files of the open document's include tree. */
export function createIncludedFileLinter(options: {
  parse: (text: string) => Tree;            // injected, so the module stays free of the generated parser
}): {
  lint(
    files: readonly { fileId: string; path: string; content: string }[],
    run: { client: HarperWorkerClient; isCancelled?: () => boolean; yieldToUi?: () => Promise<void> },
  ): Promise<{
    issues: { fileId: string; path: string; line: number; category: GrammarCategory; message: string }[];
    completed: boolean;
  }>;
};
```

- Each file is checked on its own, NOT as one assembled document: assembling fuses a parent's last paragraph with its child's first and manufactures issues across a boundary the author cannot see.
- Issues are reported as `{path, line}` LOCATIONS, never as document ranges — an offset into another file means nothing in this editor, and painting it would underline unrelated text. They therefore carry no one-click fix chips; selecting one opens its file at its line (reusing the cross-reference go-to-definition seam).
- `completed: false` means the shared worker client superseded the pass (the open file's own lint took its turn). The caller retries rather than publishing a list that silently omits the files never reached.
- The per-file parse is memoized against its exact content, so re-checking an unchanged tree costs a map lookup per file.
- The result reaches the Writing panel through `lib/codemirror/harper/document-scope-store.ts`, whose snapshot also distinguishes "this file includes no other files" and "this file is not part of the main document" from a genuinely clean result — "Whole document" must never be silently identical to "This file".

### Cost

The pass never runs on the local user's keystrokes: those change only the open file, whose issues come from the live editor lint. It runs on entering the scope, on the engine becoming ready, when the include tree's file list changes, and when a collaborator touches a project file.
