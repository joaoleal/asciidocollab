# Quickstart: PDF Theme Editing & Sectioned Project Options

**Feature**: 041-pdf-theme-project-options

Orientation for anyone picking up implementation. Read `plan.md` for the Constitution Check and
`research.md` for why each decision was made.

---

## Start here — three things that surprised the research

1. **A `.yml` file today opens in the AsciiDoc editor.** There is no file-type dispatch; `ContentArea`
   branches only on content state. So the theme editor is partly a bug fix (research R1).
2. **Exports may already render with no theme at all.** The PDF snapshot's content cache walks the
   `include::` graph from the main file, and a theme is never reachable that way — so on a fresh page
   load `discoverThemePath` cannot even see the theme's path (research R6). Fix this early; several
   acceptance scenarios silently depend on it.
3. **A hung Ruby extension freezes the whole worker.** The convert runs under synchronous `vm.eval`, so
   the worker cannot process its own cancel message. Only the main thread can intervene, via
   `worker.terminate()` (research R8).

---

## Suggested order

The three stories are largely disjoint, but there are two real dependencies.

```
US1 sectioned options ──┐
                        ├──▶ US3 extension catalogue UI
R6 auxiliary cache ─────┴──▶ US2 theme editor ──▶ US3 comparison toggle
```

1. **R6 auxiliary text cache** — unblocks everything theme-related and fixes a live defect.
2. **US1 sectioned options** — self-contained; gives US3's catalogue a home.
3. **US2 theme editor** — descriptor catalogue → YAML profile → completion → widgets → preview.
4. **US3 Tier 1** → Tier 2 → Tier 3. The administrator folder is best built early within US3, since the
   shipped set and the folder share one loader and one catalogue — building the folder path second
   means retrofitting it.

Before any extension work: **generalise the parity spec to a manifest-driven loop and wire it into CI**
(plan V-1). Doing this after twelve fixtures exist means rewriting twelve hand-written blocks.

---

## Key files

| Concern | File |
|---|---|
| Editor dispatch | `apps/web/.../projects/[id]/project-editor-layout.tsx` → `ContentArea` (~196-262) |
| Extension composition | `apps/web/src/lib/codemirror/editor-extensions.ts` |
| Completion template | `apps/web/src/lib/codemirror/completions/attribute.ts` |
| Widget template | `apps/web/src/lib/codemirror/asciidoc-attribute-fold.ts` |
| Collab binding (generic) | `apps/web/src/components/editor/editor-collab-extensions.ts` |
| Snapshot build | `apps/web/src/lib/pdf/build-project-snapshot.ts` |
| Convert invocation | `packages/asciidoc-pdf/src/convert/invoke.ts` → `buildConvertCode` (479-512) |
| Extension shape precedent | same file → `SOURCEMAP_SHIM` (~421) |
| First-party Ruby precedent | `packages/asciidoc-pdf/ruby/shims/asciidoctor-pdf-wasm-shims/` |
| VM lifecycle | `packages/asciidoc-pdf/src/vm/ruby-pdf-vm.ts` |
| Settings page | `apps/web/.../projects/[id]/settings/settings-client.tsx` |
| Render config schema | `packages/shared/src/render-config/config.ts` |
| Parity suite | `apps/web/e2e/pdf-parity/pdf-parity-render.spec.ts` |
| Vendored default theme | `packages/asciidoc-pdf/ruby/.wasm-build/vendor/.../data/themes/default-theme.yml` |

---

## Traps

- **Never load Ruby from `/project`.** That mount is member-writable, and the Ruby VM includes the
  JavaScript host bridge (`JS.global`) — so project-authored Ruby could reach the network through JS
  regardless of the renderer's sandboxing. This is why the project-supplied design was removed; see
  `plan.md`'s security finding before reintroducing anything that loads from there.
- **Extensions must be idempotent.** The VM is warm and never torn down between renders, so a
  non-idempotent `prepend` corrupts every later render in that worker.
- **`renderConfigSchema` is `.strict()`.** Add the `extensions` key there first, or every save 400s.
- **`PUT /render-config` is a full replace.** Sections must share one draft and PUT the merged whole,
  and the response must re-seed all drafts (FR-006).
- **`dispose()` the VM after untrusted renders.** Otherwise a project's monkey-patch survives into a
  different project's render (research R9).
- **Extensions must be `-r`-able by the CLI** (FR-032f), or the Docker reference build cannot load them
  and no parity test is possible — which under Principle XV means not shippable.
- **Don't write performance tests.** Principle II makes them opt-in; SC-003 and SC-004 are not requests
  for them.
- **`packages/asciidoc-pdf` tests don't run in CI.** Run
  `pnpm --filter @asciidocollab/asciidoc-pdf test` manually (see AGENTS.md).

---

## Verifying

Per Principle XV, theme application is fidelity-critical — a comparison test against reference output
is required, and a snapshot of our own output against itself does not count.

```bash
# unit
pnpm --filter @asciidocollab/web test
pnpm --filter @asciidocollab/asciidoc-pdf test    # not in CI — run manually

# parity (requires Docker for reference regeneration, poppler-utils for comparison)
cd apps/web && pnpm exec playwright test --config playwright.pdf-parity.config.ts

# regenerate a reference PDF
node apps/web/e2e/pdf-parity/generate-reference.mjs ext-paragraph-numbering

# full gate before the feature is done
pnpm gate
```

Then the `/code-review` loop until it returns zero findings — both steps are non-negotiable per the
constitution's End-of-Feature Verification.

---

## Open questions for implementation

Two edge cases in the spec remain deliberately unanswered, both narrow enough to settle in code:

- **Competing layout extensions** — a large table demanding an alternate page size *inside* a
  multi-column section. Needs a defined precedence (FR-031c requires the outcome be predictable).
- **Custom title page with no logo** — the fallback when the project supplies none.

One item to verify rather than assume:

- **Uploaded files and collab.** Research confirmed the `create-file` path mints a `Document` row for
  every file regardless of extension. The **upload** path was not verified — an uploaded theme without
  a `Document` row would fall back to read-only REST content and never co-edit.
