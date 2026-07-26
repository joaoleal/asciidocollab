---

description: "Task list for On-Device Grammar & Spelling Checking"
---

# Tasks: On-Device Grammar & Spelling Checking

**Input**: Design documents from `/specs/042-grammar-spell-check/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Implementation**: Every task MUST be executed via the `/tdd` skill (Constitution §Implementation Discipline) — the skill owns red-green-refactor. Tasks describe WHAT; do not split a deliverable into separate "write test" / "write implementation" tasks. Exceptions (config/build/spike only) are marked `[no-TDD]`.

**Organization**: Grouped by user story (spec priorities P1: US1–US3, P2: US4–US6, P3: US7) for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US7 (user-story phases only; Setup/Foundational/Polish carry none)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Engine dependency, offline WASM delivery, and the bundling spike that decides the worker architecture.

- [X] T001 [no-TDD] Add exact-pinned `harper.js` `2.4.0` (no `^`/`~`) to `apps/web/package.json` dependencies and install.
- [X] T002 [P] [no-TDD] Add `apps/web/scripts/build-harper-wasm.mjs` to vendor Harper's WASM + language data into `apps/web/public/vendor/harper/`, wired into `predev`/`prebuild` in `apps/web/package.json`; the script MUST no-op gracefully (warn, exit 0) when the source blob is absent (mirror `scripts/build-asciidoctor-pdf-wasm.mjs`).
- [X] T003 [no-TDD] Engine bundling spike (research U1): determine whether harper.js `WorkerLinter` bundles cleanly under Next.js/webpack (WorkerLinter-direct) or must be hosted in a self-hosted classic worker; add a minimal proof-of-load and record the chosen architecture in `specs/042-grammar-spell-check/research.md` §R2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The risk modules (prose extraction + offset map), the engine worker/client, and the read-side settings gate. **No user story can begin until this phase is complete.**

**⚠️ CRITICAL — includes the two make-or-break units (T004) tested first.**

- [X] T004 [P] Prose extraction + offset-map module `apps/web/src/lib/codemirror/prose-segments.ts` — `extractProseSegments(tree, text): ProseSegment[]` and `spanToDocRange(segment, start, end)`, refactored from the KEEP/DROP/BOUNDARY logic in `asciidoc-spellcheck.ts`, segmenting at block boundaries. RISK MODULE: unit-test every exclusion category and multi-segment span mapping via the `apps/web/tests/lib/codemirror/helpers/tokenize.ts` harness (contracts/linter-module.md).
- [X] T005 Refactor `apps/web/src/lib/codemirror/asciidoc-spellcheck.ts` to consume `prose-segments.ts` (nspell behavior unchanged; it becomes the Harper-off fallback — research R8).
- [X] T006 Harper engine factory — **T003 resolved this to R2(a): `WorkerLinter` self-manages its own worker, so NO hand-rolled `harper.worker.ts`/postMessage protocol is needed.** Done so far: `apps/web/src/lib/codemirror/harper/dialect.ts` (pure `GrammarDialect` type + `GRAMMAR_DIALECTS`/`DEFAULT_GRAMMAR_DIALECT`/`isGrammarDialect`, unit-tested — the enum translation stays at the engine boundary). Remaining: `apps/web/src/lib/create-harper-worker.ts` factory constructing the self-hosted binary (`createBinaryModuleFromUrl('/vendor/harper/harper_wasm_bg.wasm','full')`) + `new WorkerLinter({ binary, dialect })`, adapted to a domain-typed `HarperEngine` interface (the testable seam); emits structured `engine-init-failed` on WASM failure without memoizing it. Factory is browser-only (WorkerLinter cannot run in Node) → verified in-browser at T041.
- [X] T007 Harper worker client `apps/web/src/lib/codemirror/harper/harper-worker-client.ts` — warm-up ping on mount, ~300–500 ms debounce, monotonic `requestId` + staleness guard (discard superseded lint results), promise-wrapped RPC.
- [X] T008 [P] Extend `renderConfigSchema` in `packages/shared/src/render-config/config.ts` with `grammarCheckEnabled` (zod, default per spec) and validate in `packages/shared/tests/render-config/config.test.ts`.
- [X] T009 Web `use-grammar-settings` hook `apps/web/src/hooks/use-grammar-settings.ts` deriving `{ enabled, languageIsEnglish, dialect }` from the existing render-config (`use-project-render-config`) + project language, defaulting dialect to `en-GB`. Read-only (edit UI is US7).

**Checkpoint**: Engine loads in a worker, prose extracts with correct offsets, activation gate readable — user stories can begin.

---

## Phase 3: User Story 1 - See writing issues underlined as I type (Priority: P1) 🎯 MVP

**Goal**: Prose-only spelling/grammar/style issues underlined live in the author's view; markup/code/macros never flagged; editor stays usable if the engine fails.

**Independent Test**: Type a paragraph with a misspelling plus a `[source]` block and an inline `xref:`/`link:` — only the prose word is marked; code and macros are not; typing stays responsive; blocking `/vendor/harper/*` leaves the editor fully usable.

- [X] T010 [P] [US1] Category color design tokens `--syntax-grammar-spelling` / `-grammar` / `-style` (light + dark) in `apps/web/src/styles/globals.css`, consumed via `apps/web/src/lib/codemirror/harper/category-colors.ts` and `apps/web/src/lib/codemirror/asciidoc-theme.ts` (underline + gutter). No color literals (Principle V).
- [X] T011 [US1] Lint→Diagnostic mapping `apps/web/src/lib/codemirror/harper/lint-to-diagnostic.ts` — Harper `Lint` (`span()`, `lint_kind()`, `message()`, `suggestions()`) → CM `Diagnostic` with category + document range via `spanToDocRange` (depends on T004).
- [X] T012 [US1] Harper lint source `apps/web/src/lib/codemirror/harper/harper-linter-source.ts` — extract segments → `client.lint` → map/render `Diagnostic[]`; returns `[]` (no throw) when the engine is unavailable; lints incrementally over changed/visible segments (depends on T004, T007, T011).
- [X] T013 [US1] Register the Harper lint source in `apps/web/src/lib/codemirror/editor-extensions.ts` inside a `Compartment`, gated on `enabled && languageIsEnglish && engine-loaded`; disable the nspell spellcheck source while Harper is active (research R8); trigger `setup()` warm-up at editor init in `apps/web/src/hooks/use-editor-mount.ts` (depends on T012, T009).
- [X] T014 [US1] Graceful degradation: on WASM/worker init failure the editor stays fully usable (no console-fatal, no blocking error) and the nspell spellcheck fallback remains active (worker-client error path + compartment reconfigure) (depends on T013).

**Checkpoint**: MVP — live prose-only underlines with graceful degradation, independently demoable.

---

## Phase 4: User Story 2 - Apply a suggested correction in one action (Priority: P1)

**Goal**: Apply a suggested fix in one action; it becomes a normal collaborative edit through the CRDT.

**Independent Test**: With a marked issue, apply its suggestion once → text corrected → the change appears in a second collaborator's tab as an ordinary edit.

- [X] T015 [US2] Apply-suggestion flow `apps/web/src/lib/codemirror/harper/apply-suggestion.ts` — `client.applySuggestion(segmentText, lint, suggestion)` → minimal document change → `view.dispatch({ changes })` through y-codemirror.next; never mutate `Y.Text` directly (research R5/U2).
- [X] T016 [US2] Inline suggestion popover `apps/web/src/components/grammar/suggestion-popover.tsx` — suggested-fix chip(s) wired to the apply action via the diagnostic/tooltip surface (depends on T015).

**Checkpoint**: US1 + US2 — see and fix issues; fixes propagate collaboratively.

---

## Phase 5: User Story 3 - Keep grammar feedback private to each collaborator (Priority: P1)

**Goal**: Diagnostics/counts/tooltips are view-local and never enter the Yjs doc or sync; only accepted fixes are shared.

**Independent Test**: Two tabs edit the same doc, each with issues; neither sees the other's marks/counts; inspecting `ydoc.getText('codemirror')` shows no grammar metadata; applying a fix under concurrent same-region edits loses no changes.

- [X] T017 [US3] Guarantee + unit test that the Harper lint source and decorations never dispatch a `Y.Text`-affecting change except the explicit apply path — `apps/web/tests/lib/codemirror/harper/no-shared-mutation.test.ts`.
- [X] T018 [US3] Integration test: apply a suggestion while a second collaborator edits the same region — assert no lost edits and no diagnostic/count leakage into shared Yjs state; also assert marks stay anchored when a remote edit inserts/deletes text above an existing issue (spec Edge Cases) (`apps/web/tests/**/grammar-collab.integration.test.ts`; explicitly requested by plan) (depends on T015).

**Checkpoint**: Privacy/collaboration invariant proven — P1 set complete.

---

## Phase 6: User Story 4 - Review and resolve issues from a panel (Priority: P2)

**Goal**: A right-hand panel listing all current issues with navigation, grouping, per-rule fix-all, and resolve.

**Independent Test**: Open the Grammar panel → Issues tab lists every issue with location/category/suggestion; selecting navigates; resolving (fix/ignore) removes it and clears the mark.

- [~] US4 data bridge DONE (prerequisite for T019/T020/T021): `apps/web/src/lib/codemirror/harper/grammar-diagnostics.ts` — `collectGrammarDiagnostics(state)` (reads only the Harper-source lint diagnostics with live positions), `groupByCategory`, `categoryCounts`, and `grammarDiagnosticsListener(onChange)` (surfaces the issue set to React on doc/lint change). Unit-tested (4 tests). Remaining for T019/T020/T021: the `grammar-rail.tsx` panel + Issues tab UI, status-bar counts, and mounting/wiring the listener into the editor extensions + `project-editor-layout.tsx`.
- [X] T019 [US4] Right-hand Grammar panel scaffold `apps/web/src/components/grammar/grammar-rail.tsx` (mirror `apps/web/src/components/review/comment-rail.tsx`), mounted in `apps/web/src/app/(dashboard)/dashboard/projects/[id]/project-editor-layout.tsx`.
- [X] T020 [US4] Issues tab in the Grammar panel — list issues grouped by rule/category (research R9 fallback), navigate-to-location on select, per-rule fix-all, resolve removes from list + clears inline mark (depends on T019, T012).
- [X] T021 [P] [US4] Status bar per-category counts + on-device indicator in `apps/web/src/components/editor/editor-status-bar.tsx` (reuse T010 colors).

**Checkpoint**: Systematic review surface over US1's issues.

---

## Phase 7: User Story 5 - Add domain terms to the project dictionary (Priority: P2)

**Goal**: One server-persisted project dictionary; any editor can add a term; it stops being flagged for everyone across all project documents.

**Independent Test**: Add a flagged domain term → no longer flagged for you or a second collaborator, in this and other project documents; a look-alike misspelling is still flagged.

- [X] T022 [P] [US5] Prisma model `ProjectDictionaryTerm` in `packages/db/prisma/schema.prisma` (`projectId` FK, `@@unique([projectId, term])`, `@@index([projectId])`, `@@map("project_dictionary_terms")`). Edit schema only — **ASK before generating/applying any migration** (Architecture Constitution §Database Migration Policy).
- [X] T023 [P] [US5] Shared DTO + term validation in `packages/shared/src/grammar/grammar.dto.ts` + `packages/shared/src/grammar/grammar-config.ts` (zod: trim, non-empty, ≤128, no whitespace/control chars) with tests (contracts/api.md §Validation authority).
- [X] T024 [US5] Domain: `ProjectDictionary` entity + `ProjectDictionaryId` value object (`packages/domain/src/value-objects/ids/`) + repository port `packages/domain/src/ports/grammar/project-dictionary.repository.ts` + in-memory fake in `packages/domain/tests/ports/grammar/`.
- [X] T025 [US5] Domain use cases add/remove/list dictionary term in `packages/domain/src/use-cases/grammar/` with editor/owner authorization + audit-log write, tested with in-memory fakes; include a case-insensitive dedupe assertion and a **look-alike guard** test proving an accepted term does not suppress a genuinely different misspelling that resembles it (FR-019 / SC-005) (depends on T024).
- [X] T026 [US5] Infra repo `packages/infrastructure/src/persistence/grammar/prisma-project-dictionary.repository.ts` (+ testcontainer integration test in `packages/infrastructure/tests/persistence/grammar/`) (depends on T022, T024).
- [X] T027 [US5] API routes `apps/api/src/routes/grammar/dictionary.ts` (GET/POST/DELETE per contracts/api.md; record the "no dedicated rate limit" decision) + route tests in `apps/api/tests/routes/grammar/`; wire in `di/routes.ts`, `di/repositories.ts`, and `AppContainer['repos']` (`apps/api/src/index.ts`) (depends on T025, T026).
- [X] T028 [US5] Web transport `apps/web/src/lib/api/grammar.ts` + `apps/web/src/hooks/use-project-dictionary.ts`; hydrate the worker via batched `importWords` on load and refetch/import on change (depends on T027, T007).
- [X] T029 [US5] Web Dictionary tab (searchable list, import/export) in the Grammar panel + "add word" action in the suggestion popover (depends on T028, T016, T019).

**Checkpoint**: Shared project dictionary end-to-end.

---

## Phase 8: User Story 6 - Ignore an individual issue (Priority: P2)

**Goal**: Private per-author ignore that survives reload/devices and never affects others.

**Independent Test**: Ignore an issue → gone for you, still gone after reload/another device; a second collaborator still sees it.

- [X] T030 [P] [US6] Prisma model `IgnoredLint` in `packages/db/prisma/schema.prisma` (`@@unique([userId, documentId])`, `ignoredLintsJson` text, `@@map("ignored_lints")`). Edit schema only — **ASK before migration**.
- [X] T031 [US6] Domain: `IgnoredLint` entity + id + port `packages/domain/src/ports/grammar/ignored-lint.repository.ts` + in-memory fake; get/replace (upsert) use cases in `packages/domain/src/use-cases/grammar/` scoped to the caller, tested with fakes. Note: `documentId` maps to the existing `FileId` concept — reuse it, do not introduce a new document entity.
- [X] T032 [US6] Infra repo `packages/infrastructure/src/persistence/grammar/prisma-ignored-lint.repository.ts` (+ testcontainer test) (depends on T030, T031).
- [X] T033 [US6] API routes `apps/api/src/routes/grammar/ignored-lints.ts` (GET/PUT blob, caller-scoped, document→project membership verified in the use case) + tests + DI wiring (depends on T031, T032).
- [X] T034 [US6] Web `apps/web/src/hooks/use-ignored-lints.ts` + transport; `importIgnoredLints(blob)` into the worker on load; "ignore" action → `ignoreLint` → `exportIgnoredLints` → PUT (upsert) (depends on T033, T007, T016).

**Checkpoint**: Private ignores end-to-end.

---

## Phase 9: User Story 7 - Enforce the project's configured English dialect (Priority: P3)

**Goal**: Checking enforces the project's configured English dialect; inactive for non-English projects.

**Independent Test**: Project = British English → British spellings accepted, American flagged; switch to American → reverse; non-English → grammar checking inactive.

- [X] T035 [US7] Project dialect: widen `Project.language`/add a dialect field (`en-GB`/`en-US`) in `packages/db/prisma/schema.prisma` + `packages/domain/src/entities/project.ts` + shared DTO/validation. Edit schema only — **ASK before migration**. *(Assumes project-settings scope per plan; see open decision D1 in Notes.)*
- [X] T036 [US7] API grammar-settings: `PUT` enable + dialect (reject/ignore dialect when language is non-English) + tests; `GET` exposes `{ enabled, dialect, languageIsEnglish }` (fold into render-config or a `routes/grammar/settings.ts`) (depends on T035, T008).
- [X] T037 [US7] Web: project settings UI (enable toggle + dialect select) in `apps/web/src/app/(dashboard)/dashboard/projects/[id]/settings/settings-client.tsx`; wire `setDialect` into the worker and re-lint on change; activation only when language is English (depends on T036, T009, T007).

**Checkpoint**: Dialect enforcement + per-project enablement.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Brief-requested surfaces beyond the spec's user stories, performance hardening, and the end-of-feature gate.

- [X] T038 [P] Rules tab in the Grammar panel — implements view-local rule configuration (**FR-027**): data-driven from `getLintConfig()` keys (never a hardcoded rule list), with presets "spec prose" / "relaxed" / "spelling only" applied via `setLintConfig` (research R9; resolve U4 `organizedLints` here).
- [X] T039 [P] Toolbar lint-scope toggle "my prose only" vs "whole document" — implements the per-view scope filter (**FR-028**) in `apps/web/src/components/editor/editor-toolbar.tsx` (research R10 — viewport/authorship heuristic fallback).
- [X] T040 Performance hardening (functional): incremental re-lint of changed/visible segments + per-segment result cache keyed by text hash; **manually** confirm responsiveness on a tens-of-thousands-of-words document against SC-003's ~50 ms/keystroke target. Do NOT add an automated performance/load-test suite (Constitution Principle II — performance tests are opt-in and not requested here) (research R11; spec SC-003).
- [~] T041 [no-TDD] Gate status: **lint + typecheck + unit + integration all GREEN across every package** — web 4731 (+6 integration), domain 1025, api 735, shared 171; grammar testcontainer repos pass (dictionary, ignored-lints) under Docker. The two shared editor suites I touched (asciidoc-editor, settings-client) were re-mocked for the new code paths and pass. **Remaining (needs the running dev stack + a real browser):** quickstart steps 1–10 — the Harper WASM only loads in a real browser (create-harper-worker is excluded from unit coverage by design), so the on-device lint/underline/apply/offline/degradation flows are verified there; plus `pnpm gate`'s e2e + security scan and the `/code-review` loop.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → **Foundational (P2)** → **User Stories (P3–P9)** → **Polish (P10)**.
- T003 (spike) blocks T006 (worker architecture). T004 blocks T005/T011/T012. T006 → T007.
- **US1 (P1)** is the MVP and unblocks the P1 set. **US2** depends on US1 (T012). **US3** depends on US2 (T015). **US4** depends on US1 (T012). **US5/US6** depend on Foundational + the popover (T016). **US7** depends on Foundational settings (T008/T009).

### User-story independence

- US1 stands alone (MVP). US2/US3/US4 build on US1's lint source but are each independently testable. US5/US6 are full-stack and independently testable once the popover exists. US7 is independent of US4–US6.

### Parallel opportunities

- Setup: T002 ∥ T003.
- Foundational: T004 ∥ T008 (different packages); T006→T007 sequential.
- US1: T010 ∥ (T011→T012→T013→T014).
- US4: T021 ∥ T019/T020.
- US5/US6 schema + shared DTO tasks (T022, T023, T030) are [P] against each other; server layers within a story are sequential (port → use case → repo → route → web).
- US5 and US6 can be built in parallel by different developers after Foundational + T016.

---

## Implementation Strategy

### MVP first

1. Setup (T001–T003) → Foundational (T004–T009) → **US1 (T010–T014)**. Stop and validate: live prose-only underlines + graceful degradation.
2. Add **US3 (T017–T018)** early despite being after US2 in numbering — the privacy invariant is non-negotiable before any wider rollout; it needs US2's apply path (T015), so sequence US1 → US2 → US3.

### Incremental delivery

US1 (MVP) → US2 (apply) → US3 (privacy proof) → US4 (panel) → US5 (dictionary) → US6 (ignore) → US7 (dialect) → Polish. Each story is a demoable increment.

---

## Notes

- Each task = one `/tdd` invocation (red-green-refactor); `[no-TDD]` marks config/build/spike/verification-only tasks.
- **Prisma schema tasks (T022, T030, T035): DECISION 2026-07-25 — the app is pre-production/never-released, so edit `schema.prisma` only and DEFER all migrations this session (no committed migration scripts). The user updates dev/test DBs separately (e.g. `prisma db push`). Infra testcontainer suites that need the schema applied use `prisma db push` against the ephemeral container, not a committed migration.**
- Tests live under each package/app `tests/` root mirroring `src/` — never `__tests__/` or co-located.
- **D1 (dialect location) — resolved**: the clarified spec (FR-023) decides dialect comes from **project settings**; T035–T037 implement that and all three artifacts agree. The only reason to revisit is if the user prefers the original brief's per-document `:lang:`-style attribute — an isolated change to T035–T037 — otherwise proceed as written.
- Open unknowns carried by tasks: U1 (T003, engine bundling), U2 (T015, minimal-diff apply), U4 (T038, `organizedLints`), U5 (T039, authorship scope) — each has a documented fallback in research.md.
- After all tasks: full quality-gate sweep + `/code-review` loop to zero findings (T041).
