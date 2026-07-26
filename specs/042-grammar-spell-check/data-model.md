# Phase 1 Data Model: On-Device Grammar & Spelling Checking

Two kinds of data: **server-persisted** (project dictionary, ignored-lint records, project grammar settings) and **client/view-local, ephemeral** (prose segments, issues, diagnostics — never persisted, never shared). Persisted concepts mirror the layering of features 041 (project config) and 038 (review comments); ids follow the `value-objects/ids/` convention.

## Server-persisted entities

### 1. ProjectDictionary term

The single project-scoped set of accepted terms (spec FR-016–018; one logical dictionary per project). Modeled as one row per (project, term) for cheap add/remove and propagation.

| Field | Type | Notes |
|-------|------|-------|
| `id` | ProjectDictionaryId (uuid) | PK |
| `projectId` | ProjectId | FK → Project; indexed |
| `term` | string | The accepted word/acronym. Validated at API boundary (see constraints). |
| `createdByUserId` | UserId | Who added it (audit/attribution). |
| `createdAt` | DateTime | |

- **Uniqueness**: `@@unique([projectId, term])` (case-sensitivity decision below). Prevents duplicates.
- **Index**: `@@index([projectId])` for the load-all-terms query.
- **Prisma model** `ProjectDictionaryTerm`, `@@map("project_dictionary_terms")`.
- **Validation (zod, at API boundary — Principle IX)**: term is non-empty, trimmed, `length ≤ 128`, no whitespace/newlines, no control chars. Reject otherwise. Case: store as-entered; treat `@@unique` case-**insensitively** at the app layer to avoid `API`/`api` duplicates (normalize a `termLower` for the unique key, or enforce in the use case). **Decide in use case** — lean toward case-insensitive dedupe, case-preserving display.
- **Lifecycle**: created when any collaborator with edit access adds a term; deleted when removed. No update.
- **Authorization**: read = any project member; add/remove = editor/owner (mirrors render-config PUT). Mutations write an audit-log entry (repo convention).

### 2. IgnoredLint record

A single author's private set of dismissed issues for one document (spec FR-020–022; per-user, per-document). **Pinned shape**: one row per (user, document) holding the opaque, privacy-hashed blob that harper.js `exportIgnoredLints()` produces and `importIgnoredLints()` consumes — the internal structure is not parsed (early-access/unstable), so we store and round-trip the whole blob rather than per-hash rows.

| Field | Type | Notes |
|-------|------|-------|
| `id` | IgnoredLintId (uuid) | PK |
| `userId` | UserId | Owner; never exposed to other users. |
| `documentId` | FileId/DocumentId | The document the ignores apply to. |
| `ignoredLintsJson` | string (text) | Harper's `exportIgnoredLints()` output — privacy-hashed, **NOT raw prose**. |
| `updatedAt` | DateTime | |

- **Uniqueness**: `@@unique([userId, documentId])` (precedent: `UserKeyBinding`'s composite unique) — one blob per user per document; writes upsert.
- **Index**: covered by the unique constraint for the per-open load.
- **Prisma model** `IgnoredLint`, `@@map("ignored_lints")`.
- **Privacy**: contains only privacy-hashed data + ids; no document text. Never returned to any user but the owner; never enters the Yjs doc.
- **Lifecycle**: upserted on every ignore/un-ignore (full replace of the caller's blob); last-write-wins on the caller's own record.
- **Authorization**: a user may only read/write their **own** record (scoped by authenticated `userId` server-side).

### 3. Project grammar settings (extends existing project config)

Not a new table — extends what already exists (research R7):

| Setting | Storage | Type / values | Notes |
|---------|---------|---------------|-------|
| English dialect | `Project.language` (widened) or sibling `dialect` field | `en-GB` (default) \| `en-US` (extensible to `en-AU`/`en-CA` if Harper supports) | Maps to Harper `setDialect`. Feature active only when language is English. |
| Grammar checking enabled | key `grammarCheckEnabled` in `ProjectRenderConfig.config` JSON | boolean, default per spec | Only meaningful when language is English. Validated by extending `renderConfigSchema`. |

- **Authorization**: read = any member; change = editor/owner (existing render-config + project-language auth).
- **Migration**: widening the language enum touches the existing project language selector — coordinate with the existing spellcheck language UI.

## Client / view-local, ephemeral models (never persisted, never shared)

These exist only in each collaborator's browser tab. Yjs never observes them (Principle VII / FR-011).

### 4. ProseSegment (RISK MODULE — research R3)

Output of `extractProseSegments(tree, text)`; the offset-mapping unit under test.

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | Visible prose of one contiguous prose block (markup/code/macros excluded). |
| `map` | number[] | `map[i]` = document offset of `text[i]`. Length = `text.length`. |

- Invariant: `map` is strictly increasing; `map[i]` always points at a real document char (boundary runs collapse to a single space whose `map` entry is the boundary start).
- Span mapping: a Harper lint span `{start, end}` on this segment → document range `[map[start], map[end - 1] + 1]`.

### 5. Issue (view-local)

A Harper `Lint` adapted for rendering.

| Field | Type | Notes |
|-------|------|-------|
| `from` / `to` | number | Document offsets (mapped from the segment span). |
| `category` | `'spelling' \| 'grammar' \| 'style'` | Derived from `lint_kind()`; drives color (Principle V). |
| `rule` | string | Source rule (for panel grouping; may be thin — research R9). |
| `message` | string | From `lint()`. |
| `suggestions` | Suggestion[] | From the lint; each applies via `applySuggestion`. |
| `lintHash` | string | Harper's hash for this lint; used by the "ignore" action and for view-side de-dupe. |

- Rendered as a `@codemirror/lint` `Diagnostic` with actions: apply-suggestion, add-to-project-dictionary, ignore. Ignored issues are suppressed by Harper itself (the worker `importIgnoredLints` the caller's blob, so ignored lints are never emitted); dictionary terms are suppressed via `importWords`. No separate client-side hash filtering is required.

### 6. GrammarViewState (view-local)

Per-tab UI state: current check scope (`this-file` | `whole-document`, where `whole-document` follows `include::` into the rest of the document), category counts (for status bar), active rule config/preset, panel tab. Not persisted server-side (panel/tab prefs may use `localStorage` like other editor prefs). Never shared.

## Relationships

```text
Project 1───* ProjectDictionaryTerm         (project-scoped shared dictionary)
Project 1───1 ProjectRenderConfig            (+ grammarCheckEnabled key)          [existing]
Project.language (+dialect)                                                        [existing, widened]
User    1───* IgnoredLint *───1 Document     (per-user, per-document, private)
```

## State & flow notes

- **Add term**: validate → persist `ProjectDictionaryTerm` (audit-logged) → broadcast/refetch → each collaborator `importWords([term])` into their worker → term stops being flagged everywhere (FR-017/018, SC-005).
- **Ignore issue**: `ignoreLint` in worker → `exportIgnoredLints()` → PUT the blob to `IgnoredLint(userId, documentId, ignoredLintsJson)` (upsert) → Harper stops emitting that lint for that user; survives reload via `importIgnoredLints` on load (FR-020–022).
- **Apply fix**: `applySuggestion` → `view.dispatch({changes})` → CRDT propagates as normal edit (FR-007/008; the ONLY shared write).
- **Diagnostics/counts/tooltips**: computed from Issues in the view; asserted absent from `Y.Text` by test (FR-011, SC-002).
