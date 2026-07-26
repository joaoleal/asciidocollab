# Implementation Plan: On-Device Grammar & Spelling Checking

**Branch**: `042-grammar-spell-check` | **Date**: 2026-07-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/042-grammar-spell-check/spec.md`

## Summary

Add on-device grammar, spelling, and style checking to the collaborative CodeMirror 6 AsciiDoc editor using **harper.js** (pinned `2.4.0`, early-access API), running its WebAssembly engine inside a **Web Worker** so typing latency is never blocked. Checking runs over **prose only** by walking the existing AsciiDoc Lezer syntax tree; findings surface as view-local `@codemirror/lint` diagnostics (wavy underlines + gutter + panel + status bar) that **never** enter the Yjs document. Only an author's accepted fix is dispatched as an ordinary CodeMirror transaction, so it propagates as a normal collaborative edit through the CRDT. A single **project-scoped dictionary** and each author's **private ignored-issue list** persist server-side; the enforced English **dialect** and a per-project **enable flag** live on project settings, gated on the project language being English.

The riskiest components — **prose extraction** (correctly excluding markup/code/macros) and **span-to-position offset mapping** — are designed and tested first, as first-class pure modules. Critically, the existing `asciidoc-spellcheck.ts` already solves both for the nspell spell-checker; this plan **refactors that logic into a shared, per-segment module** reused by both the existing spell-checker and the new Harper linter (Principle IV — Reuse Before Rebuild).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20, React 19 / Next.js 16 (App Router). Browser target ES2022 + WebAssembly + Web Workers.

**Primary Dependencies**:
- Web: `harper.js@2.4.0` (exact pin — early-access, unstable API), `@codemirror/{view,state,language,lint}@^6`, `y-codemirror.next@^0.3.5`, `yjs@^13`, in-repo AsciiDoc Lezer grammar (`apps/web/src/lib/codemirror/asciidoc.grammar`).
- API/domain: Fastify (`apps/api`), Prisma (`packages/db`), zod (`packages/shared`).

**Storage**:
- PostgreSQL via Prisma — **new** `ProjectDictionary` (project-scoped term list) and `IgnoredLint` (per-user, per-document) tables.
- Project-scoped **enable flag** + **English dialect** stored on project settings (extend `Project.language` to carry the dialect, plus an enable key in the `ProjectRenderConfig.config` JSON — see research.md R7).
- Client: Harper's dictionary/ignore state is hydrated **from the server** into the in-worker linter (`importWords` / `importIgnoredLints`); `localStorage` used only as an optimistic mirror (no IndexedDB — matches the repo's existing convention).

**Testing**: Jest (apps/web multi-project: `node` unit, `jsdom` component, `integration`); the `tokenize` Lezer-tree harness (`apps/web/tests/lib/codemirror/helpers/tokenize.ts`) for the prose-extraction unit tests; domain in-memory fakes; infra testcontainers (`packages/testing`); Fastify route tests; Playwright e2e for the concurrent-edit / no-leak integration scenario.

**Target Platform**: Web (browser main thread + dedicated Web Worker + WASM) with a Fastify API + Postgres backend. Monorepo.

**Project Type**: Web application (monorepo: `apps/web`, `apps/api`, `packages/{domain,infrastructure,shared,db,testing}`).

**Performance Goals**: No perceptible typing-latency regression. Lint debounced ~300–500 ms on document changes; all checking off the main thread in the worker; **incremental** (changed/visible prose segments) rather than whole-document re-lint per keystroke; editor remains responsive at tens of thousands of words.

**Constraints**:
- **On-device only** — no network request may carry document text; feature must function fully offline (Principle X). Harper WASM is self-hosted same-origin (vendored `public/`), no CDN by default.
- **Non-blocking** — WASM/linting off the main thread (Principle XIII).
- **View-local** — diagnostics, counts, tooltips, gutter markers live entirely in each collaborator's view state; never written to the Yjs doc or synced via `y-codemirror.next` (Principle VII).
- **Graceful degradation** — if the WASM engine fails to load, the editor stays fully usable, no console-fatal; the feature is silently unavailable (nspell spell-check remains as fallback).

**Scale/Scope**: Per-document multi-collaborator editing sessions; project-scoped shared dictionary; documents up to tens of thousands of words.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing (no new violations introduced by the design).*

| Principle | Applies? | How this plan satisfies it |
|-----------|----------|----------------------------|
| **II. TDD (NON-NEGOTIABLE)** | Yes | Every implementation task runs via `/tdd`. The two riskiest units (prose extraction, offset mapping) get failing unit tests first via the `tokenize` harness. Domain use cases tested with in-memory repository fakes; infra repos with testcontainers; API routes with route tests. Integration test for concurrent-edit-while-applying-a-fix authored before the apply path. |
| **IV. Reuse Before Rebuild** | Yes | Prose extraction + offset map is **refactored out of** `asciidoc-spellcheck.ts` into a shared segment module, reused by both nspell and Harper — not re-derived. The Worker+WASM vendoring/warm-up/degradation pattern is copied from the PDF pipeline (`asciidoc-pdf.worker.ts`, `create-pdf-worker.ts`, `build-asciidoctor-pdf-wasm.mjs`). harper.js is vendored + version-pinned; the project-config, per-user-pref, and full-stack layering patterns mirror features 041/038/022. |
| **V. Theming via Design Tokens** | Yes | Category colors (spelling/grammar/style) added as `--syntax-*` design tokens in `globals.css` (light + dark), consumed via the `c(--…)` helper in `asciidoc-theme.ts` and reused across underline, gutter, tooltip, panel, and status bar. No color literals. |
| **VII. Per-User Preferences, Shared Content Immutability** | Yes — central | The **project dictionary**, **dialect**, and **enable flag** are project-scoped configuration (stored on the project, permission-gated to editors/owners, shared by design) — explicitly permitted by VII's project-config carve-out. The **ignored-issue list** and all diagnostics are per-user/view-local and never mutate shared content. The only shared mutation is an accepted fix, dispatched as a normal CM transaction through the CRDT. |
| **VIII. Editor Pipeline Integrity** | Yes | No change to preview sanitization or scroll-sync. Grammar is an additive lint/decoration layer. Applying a fix uses an ordinary `EditorView.dispatch` change that flows through `y-codemirror.next` — the same edit path users already use; no bypass. |
| **IX. Untrusted Input Boundary (NON-NEGOTIABLE)** | Yes | Harper reads the user's own document text as **inert data** inside the worker (never executed/evaluated). No new external-content or fetch path is introduced. Dictionary terms are user-supplied text persisted server-side — validated (length, charset) at the API boundary via a zod schema, mirroring `render-config/config.ts`. |
| **X. Client-Side by Default — No Source Egress (NON-NEGOTIABLE)** | Yes — strongly aligned | All checking happens on-device in the worker. The WASM binary is self-hosted same-origin (vendored `public/vendor/harper/`), no CDN by default, so no document text ever leaves the client and the feature works fully offline. (Dictionary/ignore sync carries accepted **terms** and privacy-hashed ignored-lint records — not document prose — over the app's own authenticated API, which is not third-party egress.) |
| **XI. Reference-Build Parity (NON-NEGOTIABLE)** | **N/A** | This feature does not render or export; there is no Asciidoctor reference-build oracle for grammar results. No parity obligation. |
| **XII. Deterministic Output** | Partial / N/A | No generated output artifact. Grammar results are deterministic for a given engine version + lint config; the exact `harper.js@2.4.0` pin makes results reproducible across machines. |
| **XIII. Non-Blocking Responsiveness** | Yes | Engine runs in a Web Worker (`WorkerLinter`); linting is debounced and incremental; the main thread never runs WASM. Typing, selection, navigation stay responsive during linting. |
| **XIV. Sandbox-Safe Dependencies Only** | Yes | harper.js WASM runs inside the browser/worker sandbox — no subprocess, socket, or native OS extension. Capabilities are browser-provided. |
| **XV. Fidelity Verified Before Done** | **N/A** | No fidelity-critical rendering output; there is no reference build to compare against. Replaced by the feature-specific verification below. |

**Feature-specific verification (in place of XI/XV parity):** the riskiest units get pure unit tests (prose extraction excludes all markup categories; offset mapping lands spans on the right characters across multi-segment documents), plus an integration/e2e test that applies a suggestion while a second collaborator edits the same region — asserting no lost edits and **no diagnostic leakage into shared Yjs state**.

**Result: PASS.** No violations. Complexity Tracking is empty.

**Deviations from the plan brief (called out per the brief's "call out unknowns rather than guessing"):**
1. **Persistence is server-side, not IndexedDB.** FR-018 requires the project dictionary to propagate across collaborators, which client-only IndexedDB cannot do; the repo also has no IndexedDB precedent. Server is the source of truth; the in-worker linter is hydrated via `importWords`/`importIgnoredLints`. (See research.md R6.)
2. **No per-author personal dictionary.** The clarified spec resolved the dictionary to a single **project-scoped** dictionary (the brief said "resolve the split from the clarified spec"). (See spec Clarifications.)
3. **Dialect lives on project settings, not a per-document attribute.** FR-023, Principle VII, and the codebase's existing decision ("the spellcheck language is a project-level setting, not a user preference") all favor project scope. This is the one place the plan intentionally departs from the brief's "per-document attribute so it travels with the file." If per-document travel is required, it is a small, isolated change — flagged for confirmation. (See research.md R7.)
4. **Bundler is Next.js/webpack, not Vite.** `apps/web` has no Vite; the worker+WASM approach follows the repo's Next.js pattern (`new Worker(new URL(...))` + vendored `public/` asset). CDN remains the documented fallback. (See research.md R2.)

## Project Structure

### Documentation (this feature)

```text
specs/042-grammar-spell-check/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions, reconciliations, unknowns
├── data-model.md        # Phase 1 — entities, tables, DTOs
├── quickstart.md        # Phase 1 — how to run/verify the feature
├── contracts/           # Phase 1 — API + worker-RPC + linter-module contracts
│   ├── api.md
│   ├── worker-protocol.md
│   └── linter-module.md
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/db/prisma/
└── schema.prisma                      # + model ProjectDictionary, model IgnoredLint (+ Project.language dialect widening)

packages/domain/src/
├── entities/
│   ├── project-dictionary.ts          # NEW — project-scoped term set
│   └── ignored-lint.ts                # NEW — per-user, per-document dismissal
├── value-objects/ids/
│   ├── project-dictionary-id.ts       # NEW
│   └── ignored-lint-id.ts             # NEW
├── ports/grammar/
│   ├── project-dictionary.repository.ts   # NEW
│   └── ignored-lint.repository.ts         # NEW
├── use-cases/grammar/                 # NEW — get/add/remove dictionary term; get/replace ignored lints (+ authorization + audit-log)
└── use-cases/settings/                # EXTEND (existing area) — get/set grammar settings (enable flag + dialect), alongside render-config

packages/shared/src/grammar/
├── grammar.dto.ts                     # NEW — dictionary + ignored-lint + settings DTOs
└── grammar-config.ts                  # NEW — zod schema (term validation, dialect enum, enable flag)

packages/infrastructure/src/persistence/grammar/
├── prisma-project-dictionary.repository.ts   # NEW
└── prisma-ignored-lint.repository.ts         # NEW

apps/api/src/routes/grammar/           # NEW — dictionary GET/POST/DELETE, ignored-lints GET/PUT, settings GET/PUT (wired in di/routes.ts, di/repositories.ts, index.ts AppContainer)

apps/web/src/
├── lib/codemirror/
│   ├── prose-segments.ts              # NEW — shared prose extraction + offset map (refactored from asciidoc-spellcheck.ts) — RISK MODULE 1 & 2
│   ├── harper/
│   │   ├── harper-linter-source.ts    # NEW — @codemirror/lint source backed by the worker client
│   │   ├── harper-worker-client.ts    # NEW — main-thread RPC client (warm-up, debounce, staleness guard)
│   │   ├── lint-to-diagnostic.ts      # NEW — Harper Lint → CM Diagnostic (+ category, actions)
│   │   └── category-colors.ts         # NEW — spelling/grammar/style token mapping
│   ├── asciidoc-spellcheck.ts         # REFACTOR — consume prose-segments.ts; nspell becomes Harper-off fallback
│   └── editor-extensions.ts           # EDIT — register Harper lint source + compartment
├── workers/
│   └── harper.worker.ts               # NEW — WorkerLinter host (setup, lint, applySuggestion, import/export)
├── lib/create-harper-worker.ts        # NEW — worker factory (mirrors create-pdf-worker.ts)
├── scripts/build-harper-wasm.mjs      # NEW — vendor harper wasm → public/vendor/harper (predev/prebuild)
├── components/grammar/                # NEW — right-hand panel (Issues/Dictionary/Rules tabs), inline popover, status-bar counts, toolbar scope toggle
├── hooks/
│   ├── use-grammar-settings.ts        # NEW — project enable + dialect
│   ├── use-project-dictionary.ts      # NEW
│   └── use-ignored-lints.ts           # NEW
└── lib/api/grammar.ts                 # NEW — transport

apps/web/tests/…                        # unit (prose-segments, lint-to-diagnostic, worker client), component, integration (apply-under-concurrent-edit, no-leak)
packages/{domain,infrastructure,shared}/tests/…   # entity/use-case (in-memory fakes), repo (testcontainers), schema tests
apps/api/tests/routes/grammar/…         # route tests
```

**Structure Decision**: Web-application monorepo. The feature spans all five layers because the project dictionary, ignored-lint records, and grammar settings are server-persisted (per the clarified spec), while the checking engine, prose extraction, diagnostics, and UI live in `apps/web`. New concepts mirror the exemplar layer conventions from features 041 (project config), 038 (review comments), and 022 (per-user preference) as mapped in research.md.

## Complexity Tracking

*No constitution violations — this section is intentionally empty.*
