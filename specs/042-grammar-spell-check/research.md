# Phase 0 Research: On-Device Grammar & Spelling Checking

All decisions below feed the plan and data model. Format per decision: **Decision / Rationale / Alternatives**. Open unknowns are collected at the end and must be resolved during implementation (none block the plan).

## R1 — Grammar engine: harper.js `WorkerLinter`, pinned `2.4.0`

**Decision**: Use `harper.js` at an **exact** pin `2.4.0` (no `^`/`~`). Use `WorkerLinter`, not `LocalLinter`, constructed with the bundled binary: `new WorkerLinter({ binary })` where `binary` comes from `harper.js/binary`. Call `await linter.setup()` during editor initialization (fire-and-forget alongside other async init) so first-lint latency is hidden.

**Verified API surface** (from writewithharper.com docs, July 2026):
- `setup(): Promise<void>` — idempotent warm-up; completes lazily on first use if not called.
- `lint(text: string, options?): Promise<Lint[]>`.
- `Lint`: `span()` → `{ start, end }` (character offsets into the linted string), `message()`, `lint_kind()` / `lint_kind_pretty()` (category string), `suggestions()`, `suggestion_count()`, `get_problem_text()`.
- `applySuggestion(text: string, lint: Lint, suggestion: Suggestion): Promise<string>` — returns corrected text.
- `ignoreLint(source, lint)` / `ignoreLints(source, lints)` / `exportIgnoredLints(): Promise<string>` / `importIgnoredLints(json)` — ignore records use **privacy-respecting hashes** (no raw prose stored).
- `importWords(words: string[])` / `exportWords(): Promise<string[]>` — dictionary; `importWords` is heavy → **batch**.
- `getDialect()` / `setDialect(dialect)`.
- `getLintConfig()` / `setLintConfig({ RuleName: true | false | null })`.

**Rationale**: `WorkerLinter` runs the WASM off the main thread (Principle XIII). The package is explicitly **early-access with an unstable API**, so an exact pin protects against a breaking minor. All methods the plan brief named are confirmed to exist.

**Alternatives**: `LocalLinter` (rejected — runs WASM on the main thread, would block typing). A cloud grammar API (rejected — violates Principle X and the entire privacy premise).

## R2 — Worker + WASM bundling: reuse the PDF pipeline pattern (Next.js/webpack, **not Vite**)

**Decision**: `apps/web` is a **Next.js** app (webpack/Turbopack); there is no Vite. Follow the repo's proven pattern from the PDF export pipeline:
- Worker instantiated as a **classic worker** via `new Worker(new URL('../workers/harper.worker.ts', import.meta.url))` through a small factory `create-harper-worker.ts` (mirrors `create-pdf-worker.ts`) so tests can inject a fake worker.
- **Self-host the WASM** as a vendored `public/` asset (`/vendor/harper/…`) via a `build-harper-wasm.mjs` script wired into `predev`/`prebuild` (mirrors `build-asciidoctor-pdf-wasm.mjs`), fetched same-origin — guarantees offline + no-egress (Principle X). The vendoring script must **no-op gracefully** when the source blob is absent (like the PDF one) so CI/dev never breaks.
- Hand-rolled `postMessage` RPC with a discriminated-union protocol + type guards + monotonic `requestId` and a main-thread **staleness guard** (mirrors `packages/asciidoc-pdf/src/protocol.ts` + `use-pdf-export.ts`).
- Keep browser-free message-handling logic in a testable controller (mirrors `pdf-render-controller.ts`).

**Nuance to verify (U1)**: harper.js `WorkerLinter` **already spins up its own internal worker and loads its own WASM**. Two viable shapes:
  - **(a) Use `WorkerLinter` directly on the main thread** (it self-manages its worker) — simplest; the "worker" is Harper's own. Our `harper-worker-client.ts` then just wraps the `WorkerLinter` instance + debounce/staleness, no custom worker file.
  - **(b) Host `WorkerLinter` (or `LocalLinter`) inside our own worker** — full control over bundling/warm-up, matches the PDF template exactly.
  Prefer **(a)** if harper.js's own worker bundles cleanly under Next.js webpack; fall back to **(b)** (self-hosted) if Harper's internal worker/WASM URL resolution fights the bundler. Resolve in a spike before committing the worker file. Either way the WASM is self-hosted, not CDN.

**Fallback**: harper.js documents a **CDN** delivery option. This is the documented last resort **only if** self-host bundling proves fragile; it weakens the offline guarantee and must be an explicit, reviewed decision (it still carries no document text, but a first-load fetch would require connectivity, conflicting with FR-025). Default is self-host.

**Rationale**: Reuse (Principle IV) of a pattern already hardened for a 72 MB WASM engine; self-host keeps the no-egress/offline invariants.

**Alternatives**: Vite `?worker`/`?url` imports (N/A — no Vite). Bundling Harper's WASM into the module graph via webpack async WebAssembly (possible for a shim that imports it, but Harper ships its own loader — self-hosting the blob is cleaner and matches the repo).

### Spike resolution (T003) — U1 resolved: **R2(a), WorkerLinter-direct**

Verified against the installed `harper.js@2.4.0` type surface (`node_modules/harper.js/dist/index.d.ts`, `binary.js`):

- **`WorkerLinter` self-manages its own dedicated Web Worker** (`class WorkerLinter implements Linter`, private `worker`/`requestQueue`/`serializer` members). It is constructed with `LinterInit { binary: BinaryModule; dialect?: Dialect }`. So Harper's own worker IS the off-main-thread engine (Principle XIII) — **no hand-rolled `harper.worker.ts` + postMessage protocol is required** for the happy path, exactly as the worker-protocol contract anticipated ("the protocol collapses into a thin promise-wrapping client").
- **Self-hosted binary, no CDN**: `harper.js/binary` resolves its wasm via `new URL("harper_wasm_bg.wasm", import.meta.url)`. To keep offline/no-egress guarantees decoupled from webpack asset-URL resolution inside Harper's internal worker, we vendor the full binary to `public/vendor/harper/harper_wasm_bg.wasm` (T002) and construct it with `createBinaryModuleFromUrl('/vendor/harper/harper_wasm_bg.wasm', 'full')` — a same-origin fetch the internal worker performs. (The **full** flavor, not `slim`: slim drops rules we need for grammar/style.)
- **Chosen architecture**: `apps/web/src/lib/create-harper-worker.ts` constructs the binary + `WorkerLinter`; `harper-worker-client.ts` wraps that instance with warm-up (`setup()`), debounce, and a monotonic-`requestId` staleness guard. **T006 is therefore a thin async client wrapping `WorkerLinter`, not a custom worker file** — the client-facing method surface (`setup/lint/applySuggestion/import·exportWords/import·exportIgnoredLints/setDialect/get·setLintConfig`) is identical to the contract.
- **`Dialect` is an enum** (`American=0, British=1, Australian=2, Canadian=3, Indian=4`), so `en-GB`→`Dialect.British`, `en-US`→`Dialect.American` (mapping module in the client).
- **U4 resolved**: `organizedLints(text, options): Promise<Record<string, Lint[]>>` **exists** on both linters — the Issues/Rules panels can group by source rule directly (no client-side-only fallback needed), though panels still render whatever keys the engine returns (never a hardcoded rule list).
- **U2 resolved**: `Suggestion.get_replacement_text()` + `kind()` (`Replace|Remove|InsertAfter`) are exposed, enabling a minimal document diff for the apply path (R5) without re-diffing whole segments.
- **`lint` options**: pass `{ language: 'plaintext' }` — we feed Harper already-extracted prose segments, not markdown, so Harper must not re-parse markup.

**Fallback R2(b) retained**: if a real Next.js/Turbopack build later shows Harper's internal `new Worker(...)`/wasm-URL resolution fails to bundle, host `LocalLinter` inside our own classic worker (`harper.worker.ts`) per the worker-protocol contract — the `harper-worker-client.ts` surface is unchanged, so the fallback is isolated to `create-harper-worker.ts`. Full bundle verification runs in a real browser at the T041 gate (the repo verifies wasm engines in-browser, not under ts-jest).

## R3 — Prose extraction + offset mapping: refactor the EXISTING spell-check machinery (RISK MODULE)

**Decision**: The "make-or-break" offset-mapping already exists inside `apps/web/src/lib/codemirror/asciidoc-spellcheck.ts` (`asciidocSpellcheckSource`): a `KEEP/DROP/BOUNDARY` per-char classification driven by `SPELLCHECK_SKIP_NODES` + `headerMetadataRanges` + `RoleSpan` handling, producing a `visible` string and an `offsetMap: number[]` back to document offsets. **Refactor this into a shared, pure, per-segment module** `lib/codemirror/prose-segments.ts`:
- `extractProseSegments(tree, text): ProseSegment[]` where `ProseSegment = { text: string; map: number[] }` (`map[i]` = document offset of `text[i]`).
- **Segment at block boundaries** rather than collapsing the whole document into one string. Rationale: for *grammar* (not just spelling), joining the end of one paragraph to the start of the next across a skipped code block with a single space can manufacture false grammar errors. Each contiguous prose block becomes its own segment; Harper lints each segment independently and maps spans back via that segment's `map`.
- Reuse the exact `SPELLCHECK_SKIP_NODES` set (source/listing/literal/passthrough/comment/stem blocks, attribute entries + references, block/inline macros, cross-references, footnotes, conditionals, block-attribute lines, document title, links, inline stem, UI macros, inline passthrough, anchors, biblio anchors, callouts, entities, inline set) plus `RoleSpan` body reconstruction and header-metadata exclusion — these already encode every exclusion the spec's US1/FR-002 requires.
- `asciidoc-spellcheck.ts` is refactored to consume `extractProseSegments` too, so nspell and Harper share one prose model (single source of truth for "what is prose").

**Span mapping rule**: for a Harper `Lint` with `span() = {start, end}` on segment `s`, the document range is `[s.map[start], s.map[end - 1] + 1]`. Unit-tested for: multi-segment documents, spans adjacent to skipped nodes, spans inside role-span bodies, and empty/whitespace-only segments.

**Rationale**: Principle IV — the exclusion logic and offset map are already written, reviewed, and unit-tested; re-deriving them would invite drift and the exact bugs the brief warns about. Segmenting is the one genuine addition grammar needs over spelling.

**Alternatives**: One document-wide joined string (rejected for grammar — cross-block false positives). Re-walking the tree independently for Harper (rejected — duplicates the skip-node authority; two lists would drift).

## R4 — Diagnostics rendering: `@codemirror/lint` source, view-local, category-colored

**Decision**: Surface Harper results as a `linter(harperLintSource)` `@codemirror/lint` source (merges with the existing gutter/underline pipeline; `lintGutter()` is already registered). Register it in `buildEditorExtensions` (`editor-extensions.ts`) inside a `Compartment` so enable/dialect/scope changes reconfigure live. Debounce ~300–500 ms (the `linter()` source is already async/debounced; tune `delay`). Color by category via new `--syntax-grammar-*` design tokens (spelling/grammar/style), reused across underline, gutter marker, tooltip, panel, and status bar (Principle V).

**View-local guarantee**: diagnostics are produced by a lint source and rendered as decorations — pure view/state layers that Yjs never observes. The single hard rule (already how the codebase stays safe): the checker MUST NOT `dispatch` a document `changes:` except when the user accepts a fix. Remote-vs-local transactions are distinguished via `y-codemirror.next`'s `ySyncFacet` / `isChangeOrigin` where needed. A unit/integration test asserts the Yjs `Y.Text` contains no diagnostic metadata after linting.

**Rationale**: matches the established `asciidocDiagnosticsSource` / `createSpellcheckLinter` pattern; the lint source is the natural, debounced, edit-tolerant home.

**Alternatives**: a bespoke `ViewPlugin` decoration layer (viable but re-implements gutter/tooltip plumbing `@codemirror/lint` already provides).

## R5 — Applying fixes through the CRDT

**Decision**: To apply a suggestion, call `worker.applySuggestion(segmentText, lint, suggestion)` to get the corrected **segment** text, compute the minimal changed range, and `view.dispatch({ changes })` as an ordinary CodeMirror transaction. `y-codemirror.next` observes the change and propagates it as a normal collaborative edit. Never mutate `Y.Text` directly or bypass the CM transaction path.

**Concurrency**: because the edit goes through the CRDT like any keystroke, a concurrent collaborator edit in the same region merges via Yjs — no lost edits. The integration test exercises exactly this (apply while a second doc edits the same region) and asserts both changes survive and no diagnostic leaks into shared state.

**Rationale**: Principle VIII/VII — the only shared mutation is a real text edit on the same path users already use.

**Open detail (U2)**: map Harper's returned corrected-segment string to a **minimal** document change (diff the changed span rather than replacing the whole segment) so the transaction is a tight edit and merges cleanly. Prefer replacing just the lint's mapped `[from, to]` with the suggestion's replacement text where the harper.js API exposes it on the suggestion; otherwise diff old-vs-new segment.

## R6 — Persistence: server-side source of truth (reconciled vs. brief's IndexedDB)

**Decision**: The **project dictionary** and **ignored-lint** records are persisted **server-side** (Postgres via Prisma), delivered over the app's authenticated API separately from the Yjs document. On editor load, the client fetches them and hydrates the worker via `importWords(terms)` (batched — R1) and `importIgnoredLints(json)`. Adding a term = POST to the API + `importWords([term])` locally; ignoring an issue = `ignoreLint` locally + PUT the exported ignore JSON (or the single record) to the API. `localStorage` MAY mirror for optimistic/offline warm start (matches `use-editor-preferences.ts`); **no IndexedDB** (none exists in the repo).

**Rationale**: FR-018 requires the project dictionary to propagate to **all** collaborators and across devices — impossible with client-only IndexedDB. FR-022 requires ignored-lints to survive reloads/device changes and stay private per user. Server storage satisfies both; Harper's export/import JSON formats are the natural wire payloads. This **supersedes the brief's "persist to IndexedDB,"** which cannot meet FR-018.

**Alternatives**: IndexedDB-only (rejected — no cross-collaborator/cross-device sync; violates FR-018). Storing in the Yjs doc (rejected — Principle VII; would sync grammar-support data into shared content).

## R7 — Dialect + enable flag on project settings (reconciled vs. brief's per-document attribute)

**Decision**:
- **Dialect**: today `Project.language` is a `SpellcheckLanguage` from `['en','es','fr','pt','de','it','uk','pl','tr']` — plain `'en'`, no British/American distinction. Widen the English option to carry a **dialect** (`en-GB` default per the brief, `en-US`), either by extending the language enum or adding a sibling `dialect` field; the English value maps to Harper's `setDialect`. Feature activates only when the project language is English (FR-023).
- **Enable flag**: add a `grammarCheckEnabled` key to the existing `ProjectRenderConfig.config` JSON (extend `renderConfigSchema` in `packages/shared/src/render-config/config.ts`) — lowest-friction, reuses the existing GET/PUT + `use-project-render-config` plumbing. Only meaningful when the project language is English.
- Both are **project-scoped, permission-gated** (editor/owner to change), read by all members.

**Rationale**: FR-023 (dialect from project settings), Principle VII (project config on the project, not per-user), **and** the codebase's existing explicit decision — `EditorPreferences` documents "the spellcheck language is a project-level setting, not a user preference" — all converge on project scope. This is the deliberate departure from the brief's "per-document AsciiDoc attribute so it travels with the file."

**Flagged for confirmation (D1)**: if per-document travel is genuinely required, store dialect as an AsciiDoc `:lang:`-style document attribute instead. This is isolated (parse one attribute vs. read project config) and does not change the rest of the plan. Default remains project settings per the spec.

**Alternatives**: per-document attribute (the brief) — rejected for conflicting with FR-023 and the existing project-language model. Per-user dialect preference — rejected (Principle VII; collaborators would check the same doc differently).

## R8 — Coexistence with the existing nspell spell-checker

**Decision**: Harper does spelling **and** grammar/style; the existing nspell spell-check (`createSpellcheckLinter`) does spelling only. To avoid double-flagging misspellings:
- When the project has grammar checking enabled **and** Harper's WASM loads successfully, **Harper owns prose checking** and the nspell spell-check source is disabled (its compartment reconfigured to produce no diagnostics).
- If Harper fails to load (Principle-X/degradation path) **or** grammar checking is disabled, the nspell spell-check remains active exactly as today — this **is** the graceful-degradation fallback.
- The existing per-user spell-check ignore list and the new grammar ignored-lint list are unified conceptually but keep their storage; the `spellcheckEnabled` user preference continues to gate the fallback.

**Rationale**: one prose model (R3), no duplicate underlines, and the existing feature becomes the fallback for free.

**Open detail (U3)**: confirm whether the existing per-user spell-check "add to dictionary" list should be migrated/merged into the new project dictionary, or kept separate. Lean: keep the user spell-ignore for the nspell fallback; the project dictionary is the new shared authority for Harper. Decide during implementation.

## R9 — Rules configuration & the Issues panel grouping

**Decision**: Rule toggles via `setLintConfig({ Rule: true|false|null })`, current state via `getLintConfig()`. Presets ("spec prose" / "relaxed" / "spelling only") are named bundles of rule on/off values applied through `setLintConfig`. Because the docs **warn not to rely on any specific rule name existing**, the Rules tab must be **data-driven from `getLintConfig()`'s returned keys** (render whatever rules the engine reports), never a hardcoded rule list; presets reference rules defensively (unknown keys ignored).

**Panel grouping (U4)**: the brief references `organizedLints` to group issues by source rule. `organizedLints` is **not present in the public harper.js docs** — treat as unverified. Fallback: group diagnostics in our own panel by `lint_kind()` (category) and/or the rule name Harper exposes on the lint, computed client-side. Verify whether `organizedLints` exists on `WorkerLinter@2.4.0` during the engine spike; if absent, use the client-side grouping (no functional loss).

**Rationale**: forward-compatible with Harper's frequently-changing rule set; the panel degrades to category grouping if rule metadata is thin.

## R10 — Lint scope toggle ("my prose only" vs "whole document")

**Decision**: A per-view toolbar toggle filters which prose segments are linted/shown. "Whole document" (default, per spec Assumptions) lints all prose segments. "My prose only" filters to ranges the local user authored, derived from Yjs authorship if available (awareness/attribution) or falls back to the current selection/viewport if per-character authorship is not tracked. It is a **view filter only** — never changes what is checked for other collaborators (each lints locally).

**Open detail (U5)**: confirm whether per-character authorship attribution is available from the Yjs setup (`use-collab-document.ts` / awareness). If not cheaply available, "my prose only" scopes to the current viewport/edited-region heuristic and is documented as such. Default scope is whole-document, so this does not block the MVP.

## R11 — Performance strategy

**Decision**: Keep all linting on the worker; debounce 300–500 ms; lint **incrementally** — re-lint only prose segments overlapping changed ranges (and eagerly the visible viewport), not the whole document per keystroke. Reuse the PDF pipeline's monotonic `requestId` + staleness guard so superseded lint results are discarded (prevents flicker/stale suggestions — spec edge cases). Cache per-segment lint results keyed by segment text hash so unchanged segments are not re-linted.

**Rationale**: FR-004/005 and the large-document edge case; mirrors the PDF controller's staleness handling.

## Unknowns to resolve during implementation (none block planning)

| ID | Unknown | Resolution path | Risk |
|----|---------|-----------------|------|
| U1 | ~~Does harper.js `WorkerLinter`'s internal worker/WASM bundle cleanly under Next.js webpack…~~ **RESOLVED (T003): R2(a)** — `WorkerLinter` self-manages its worker; self-host the binary via `createBinaryModuleFromUrl('/vendor/harper/…')`; thin client wraps it; R2(b) fallback isolated to `create-harper-worker.ts`. Bundle verified in-browser at T041. | Engine spike (done). | ~~Med~~ closed |
| U2 | ~~Minimal-diff mapping of Harper's corrected segment back to a tight document change.~~ **RESOLVED (T003)**: `Suggestion.get_replacement_text()` + `kind()` exposed → diff the lint's mapped span only. | Inspected 2.4.0 API. | ~~Low~~ closed |
| U3 | Merge vs. keep the existing per-user spell-ignore list alongside the new project dictionary. | Decide during R8 implementation. | Low |
| U4 | ~~Does `organizedLints` exist on `WorkerLinter@2.4.0`?~~ **RESOLVED (T003)**: yes — `organizedLints(text, opts): Promise<Record<string, Lint[]>>` on both linters. Group by rule directly; panels still render engine-reported keys, never a hardcoded list. | Verified in spike. | ~~Low~~ closed |
| U5 | Per-character authorship for "my prose only" scope. | Check Yjs/awareness; viewport heuristic fallback. | Low |
| D1 | **Decision to confirm with user**: dialect on project settings (plan default) vs. per-document attribute (brief). | Surfaced in final report; default = project settings per FR-023. | Med (scoping) |

All unknowns have a documented fallback that keeps the feature shippable; none require guessing a requirement.
