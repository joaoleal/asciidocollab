# Quickstart: On-Device Grammar & Spelling Checking

How to build, run, and verify the feature. Assumes the monorepo dev stack (`apps/web` Next.js + `apps/api` Fastify + Postgres).

## Prerequisites

- Node 20, pnpm.
- `harper.js@2.4.0` added to `apps/web` (exact pin).
- Harper WASM vendored into `apps/web/public/vendor/harper/` by `scripts/build-harper-wasm.mjs` (wired into `predev`/`prebuild`; no-ops gracefully if the source blob is absent).
- A project whose **language is English** with **grammar checking enabled** (project settings).

## Run

```bash
pnpm install
pnpm --filter @asciidocollab/web dev      # or the repo dev script (scripts/dev.sh)
```

Open a document in an English-language project with grammar checking enabled.

## Verify (maps to spec success criteria)

1. **Inline marking, prose only (US1 / SC-006)** — Type a paragraph with a misspelling plus a `[source]` code block containing a "misspelled" identifier and an inline `link:`/`xref:`. Only the prose word is underlined; the code, macro, and cross-reference are not.
2. **One-action fix propagates (US2 / SC-004)** — Hover the underline → apply the suggestion. The text is corrected. In a second browser tab (second collaborator) the correction appears as a normal edit.
3. **Privacy isolation (US3 / SC-002)** — Two tabs edit the same doc, each with issues in their own text. Neither tab's underlines/counts appear in the other. In devtools, inspect the Yjs `Y.Text` (`ydoc.getText('codemirror')`) — it contains no grammar metadata.
4. **Issues panel (US4)** — Open the right-hand Grammar panel → Issues tab: all current issues listed, grouped, with per-rule fix-all; selecting one navigates to it; resolving removes it.
5. **Project dictionary (US5 / SC-005)** — Add a flagged domain term via "add word". It stops being flagged for you and, after refetch, for the second collaborator — and in other documents in the project. A look-alike misspelling is still flagged.
6. **Ignore (US6)** — Ignore an issue → it disappears for you, reload → still gone; the second collaborator still sees it.
7. **Dialect (US7)** — Set the project language/dialect to British English → British spellings accepted, American equivalents flagged. Switch to American → reverse. Set a non-English project language → grammar checking is inactive.
8. **Offline (FR-025 / SC-008)** — With devtools **offline** from first load: linting still works (WASM is self-hosted, same-origin).
9. **Graceful degradation (FR-026 / SC-007)** — Simulate a WASM load failure (block `/vendor/harper/…`): the editor stays fully usable, no console-fatal, no blocking error; the nspell spell-check fallback remains.
10. **Responsiveness (SC-003)** — In a tens-of-thousands-of-words document, typing stays smooth while checking runs (worker + debounce + incremental).

## Test commands

```bash
# Riskiest units first (Principle II — author failing tests before impl)
pnpm --filter @asciidocollab/web test -- prose-segments        # extraction + offset map
pnpm --filter @asciidocollab/web test -- harper                # lint→diagnostic, worker client

# Server layers
pnpm --filter @asciidocollab/domain test                       # use cases w/ in-memory fakes
pnpm --filter @asciidocollab/infrastructure test               # repos w/ testcontainers
pnpm --filter @asciidocollab/shared test                       # grammar-config zod schema
pnpm --filter @asciidocollab/api test -- grammar               # routes

# Integration / e2e — apply under concurrent edit + no leak
pnpm --filter @asciidocollab/web test -- integration
pnpm --filter @asciidocollab/web e2e -- grammar

# End-of-feature gate (constitution)
pnpm gate                                                      # lint, typecheck, unit+integration, security
```

## Key files (see plan.md Project Structure)

- Prose extraction + offset map: `apps/web/src/lib/codemirror/prose-segments.ts` (refactored from `asciidoc-spellcheck.ts`).
- Worker + client: `apps/web/src/workers/harper.worker.ts`, `apps/web/src/lib/create-harper-worker.ts`, `apps/web/src/lib/codemirror/harper/harper-worker-client.ts`.
- Lint source + extension wiring: `apps/web/src/lib/codemirror/harper/harper-linter-source.ts`, registered in `editor-extensions.ts`.
- UI: `apps/web/src/components/grammar/` (panel, popover), status bar + toolbar toggle edits.
- Server: `packages/{domain,infrastructure,shared,db}` + `apps/api/src/routes/grammar/` (see contracts/api.md).
