# Worker RPC Contract: Harper Linter

Main thread ↔ Web Worker protocol for the Harper engine. Mirrors the PDF pipeline's hand-rolled `postMessage` discriminated-union protocol (`packages/asciidoc-pdf/src/protocol.ts`) with type guards, a monotonic `requestId`, and a main-thread staleness guard. Classic worker via `new Worker(new URL('../workers/harper.worker.ts', import.meta.url))`.

> Note (research R2, U1): if harper.js `WorkerLinter`'s own internal worker bundles cleanly under Next.js, the "worker" IS Harper's own and this protocol collapses into a thin promise-wrapping client (`harper-worker-client.ts`) with no custom worker file. This contract describes the self-hosted-worker shape (fallback R2(b)); the client-facing method surface is identical either way.

## Main → Worker (`ToHarperWorker`)

```ts
type ToHarperWorker =
  | { type: 'setup' }                                             // warm-up: construct WorkerLinter + setup()
  | { type: 'lint'; requestId: number; segments: { id: string; text: string }[] }  // lint prose segments
  | { type: 'applySuggestion'; requestId: number; segmentText: string; lintRef: LintRef; suggestionIndex: number }
  | { type: 'importWords'; words: string[] }                      // batch dictionary hydrate
  | { type: 'exportWords'; requestId: number }
  | { type: 'importIgnoredLints'; json: string }
  | { type: 'exportIgnoredLints'; requestId: number }
  | { type: 'ignoreLint'; lintRef: LintRef; segmentText: string }
  | { type: 'setDialect'; dialect: 'en-GB' | 'en-US' }
  | { type: 'setLintConfig'; config: Record<string, boolean | null> }
  | { type: 'getLintConfig'; requestId: number }
  | { type: 'cancel'; requestId: number };
```

`LintRef` = a stable reference to a specific lint within a segment (e.g. `{ segmentId, spanStart, spanEnd }`) so `applySuggestion`/`ignoreLint` re-resolve the lint worker-side without shipping the opaque `Lint` object across the boundary.

## Worker → Main (`FromHarperWorker`)

```ts
type FromHarperWorker =
  | { type: 'ready' }                                             // setup complete
  | { type: 'lintResult'; requestId: number; issues: WireIssue[] }
  | { type: 'applied'; requestId: number; correctedText: string }
  | { type: 'words'; requestId: number; words: string[] }
  | { type: 'ignoredLints'; requestId: number; json: string }
  | { type: 'lintConfig'; requestId: number; config: Record<string, boolean | null> }
  | { type: 'error'; requestId?: number; error: { code: 'engine-init-failed' | 'lint-failed' | 'apply-failed'; message: string } };

interface WireIssue {
  segmentId: string;
  spanStart: number; spanEnd: number;   // offsets into that segment's text
  category: string;                     // lint_kind()
  rule?: string;
  message: string;
  suggestions: string[];                // suggestion display texts, index-aligned with applySuggestion
  lintHash: string;                     // for ignore + de-dupe
}
```

Type guards `isLintResult` / `isApplied` / `isHarperError` etc. Correlation by `requestId`; the main thread keeps `latestLintRequestId` and **discards** any `lintResult` whose `requestId` is stale (prevents flicker/stale suggestions — spec edge cases).

## Semantics

- **setup**: posted on worker mount (warm-up) so first-lint latency is hidden. Idempotent. On WASM init failure emits `error{code:'engine-init-failed'}`; the client sets "engine unavailable" and the editor stays usable (Principle X degradation) — nspell fallback remains. A failed init is **not** memoized (next lint retries a clean init).
- **lint**: worker lints each segment via `WorkerLinter.lint(segment.text)`, maps each `Lint` to a `WireIssue` (span in segment coords — the main thread maps to document offsets via the segment's `map`). Only changed/visible segments are sent (incremental — research R11).
- **applySuggestion**: worker calls `applySuggestion(segmentText, lint, suggestion)` and returns corrected segment text; the main thread computes the minimal document change and dispatches it (research R5/U2).
- **cancel**: drops in-flight work for a superseded `requestId`; silently ignored if already done.

## Invariants

- The worker holds **all** Harper WASM state; the main thread never loads WASM (Principle XIII).
- No message carries Yjs state or writes shared content. The worker never sees the collaboration document — only extracted prose-segment strings.
- No message crosses the network. The worker is same-origin; the WASM is a same-origin vendored asset (Principle X).
