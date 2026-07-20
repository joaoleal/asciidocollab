# Phase 0 Research: PDF Theme Editing & Sectioned Project Options

**Feature**: 041-pdf-theme-project-options
**Date**: 2026-07-18

All Technical Context unknowns are resolved below. Each finding is anchored to the code that was read,
so the plan's decisions can be audited rather than taken on trust.

---

## R1. Editor dispatch by file type

**Decision**: Introduce a file-type dispatch in `ContentArea` plus a parallel "extension profile" seam
next to `buildEditorExtensions`. Theme files get a YAML profile; everything else keeps today's
AsciiDoc profile unchanged.

**Rationale**: There is no dispatch today. `ContentArea` in
`apps/web/src/app/(dashboard)/dashboard/projects/[id]/project-editor-layout.tsx` (~lines 196–262)
branches only on *content state* — null / loading / binary / error — and otherwise always renders
`<AsciiDocEditor>`. The only file-type input is a presentation flag, `isAsciiDoc={isAsciiDocFile(...)}`,
which merely hides the AsciiDoc toolbar. **The CodeMirror extension set is unconditionally AsciiDoc.**

Consequence worth stating plainly: a `.yml` file today opens with AsciiDoc syntax highlighting,
AsciiDoc completions and AsciiDoc linting applied to YAML. The theme editor is therefore also a bug
fix, not only a new capability.

**Alternatives considered**: A separate route for theme editing (rejected — the spec's FR-009 requires
selecting the file in the tree to open the editor, and a route would fork the collab wiring);
conditional extensions inline in `AsciiDocEditor` (rejected — pushes file-type knowledge into a
component whose name promises otherwise).

---

## R2. YAML language support and completion

**Decision**: Add `@codemirror/lang-yaml` as a direct dependency; build the theme-key completion source
as a new module under `apps/web/src/lib/codemirror/completions/`, modelled on `attribute.ts`.

**Rationale**: `@codemirror/lang-yaml@6.1.3` and `@lezer/yaml@1.0.4` are **already installed
transitively** via `@codemirror/language-data`, and `apps/web/src/lib/codemirror/source-languages.ts`
already resolves YAML lazily for `[source,yaml]` blocks — so YAML highlighting costs no new bundle
weight. Promoting it to a direct dependency is hygiene, not new surface.

Completion infrastructure is established: `autocompletion({ override: [...] })` in
`editor-extensions.ts` (lines ~271–282) with eight existing sources. `completions/attribute.ts` is the
closest template — a factory closing over a lazy accessor, returning
`{ from, options, filter: false }` from a `context.matchBefore(...)` match.

**Alternatives considered**: Writing a YAML mode (rejected outright under Principle IV — a maintained
compatible asset exists); a generic JSON-Schema-driven completion library (rejected — no schema exists
for this theme language, see R3).

---

## R3. Where theme-key descriptors come from — Principle IV

**Decision**: Generate the descriptor catalogue at build time from the asciidoctor-pdf gem's own
`base-theme.yml` and `default-theme.yml`, which are already vendored in-repo and baked into the wasm.
Layer a curated, hand-maintained description table on top for prose and value-kind refinement.

**Rationale**: This is the Principle IV question for this feature, and it has a good answer. The gem
ships its themes at
`packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems/asciidoctor-pdf-2.3.24/data/themes/`
— `base-theme.yml`, `default-theme.yml`, and eight variants (sans, for-print, font-fallback
combinations). These are the authoritative key set for the exact renderer version we ship, so deriving
from them means the catalogue can never drift from the renderer (the FR-009b discipline, applied to
descriptors).

**There is no official machine-readable schema.** The published reference at
`docs.asciidoctor.org/pdf-converter/latest/theme/keys/` is prose documentation, and no JSON Schema
exists upstream or on SchemaStore. So descriptions must be authored; only the *key set and value
shapes* can be derived. Deriving the mechanical part and hand-writing only the prose is the correct
split under Principle IV's "documented, repeatable build step rather than in-place edits".

Value kinds are inferable from the default theme's own values: `#RRGGBB` → colour, `0.67in` / `10.5` →
measurement, font family names → font, enumerated words → keyword. This directly serves FR-010b's
swatches and font samples and FR-010a's value completion.

**Alternatives considered**: Hand-authoring ~200 descriptors (rejected — drifts from the renderer on
every gem bump, and is exactly the re-derivation Principle IV forbids); scraping the docs site at
build time (rejected — network dependency in the build, brittle against docs restructuring);
extracting keys from the converter's Ruby source (rejected — the theme files are a cleaner, declared
interface).

**Bonus**: `default-theme.yml` also directly satisfies FR-010 — seeding a newly created theme file
with the effective default is a file copy, not a synthesis.

---

## R4. Inline colour swatches and font samples

**Decision**: Follow the `asciidoc-attribute-fold.ts` widget pattern —
`Decoration.replace({ widget })` with a `WidgetType`, built by a `ViewPlugin`, **skipping the range
when the cursor or selection overlaps it** so the raw text is revealed for editing.

**Rationale**: `apps/web/src/lib/codemirror/asciidoc-attribute-fold.ts` is a direct precedent with
exactly the behaviour a swatch wants: `AttributeValueWidget extends WidgetType` implementing `eq()`,
`ignoreEvent(): false` and `toDOM()`, plus a `StateEffect` (`refreshAttributeFoldEffect`) that forces
recompute without a document change. The reveal-on-cursor behaviour is what keeps a swatch from
fighting the editor.

Three further precedents exist if richer rendering is needed:
`rename-suggestion/rename-suggestion-widget.tsx` (React inside a widget),
`remote-cursor-avatars.ts` (widget-based carets), and `inline-style-registry.ts` (registry-driven
decorations recomputed from a lookup table rather than the syntax tree — the closest analogue to a
theme-key→renderer table).

Note the distinction from feature 030's T016 pattern (`asciidoc-block-decorations.ts`), which is a
*mark* decoration over `syntaxTree` — right for tokens, wrong for widgets.

---

## R5. Collaborative editing of a theme file

**Decision**: No collab work required. Theme files already co-edit today; only the *view* changes.

**Rationale**: The collaboration stack is generic over any text file and contains nothing
AsciiDoc-specific:

- `packages/domain/src/use-cases/file-tree/create-file.ts` (~line 84) creates a `Document` row with
  `contentId` + `yjsStateId` for **every** file, with no extension guard.
- `apps/web/src/hooks/use-file-selection.ts` calls `getCollabDocumentInfo` first and takes the Yjs path
  whenever a document exists.
- `apps/web/src/components/editor/editor-collab-extensions.ts` binds
  `yCollab(ydoc.getText('codemirror'), awareness, { undoManager })` — plain `Y.Text` on a fixed key.
- `apps/collab/src/extensions/persistence.ts` `onStoreDocument` writes
  `getText('codemirror').toString()` back to the file store, again type-agnostic.

This makes FR-026a and FR-026b essentially free, which is the strongest vindication of the
clarification decision to make the theme an ordinary project file.

**One gap to verify during implementation**: only the `create-file` path was confirmed to mint a
`Document` row. Files arriving via **upload** need checking — an uploaded theme without a `Document`
row would fall back to read-only REST content.

---

## R6. Making exports use the theme's current contents (FR-017a) — **defect found**

**Decision**: Add an auxiliary text-file cache for theme (and `.bib`) paths, seeded from the file tree
and subscribed to the unfiltered `content-changed` stream.

**Rationale — this is a live bug, not just a gap.** `buildSnapshot` in `project-editor-layout.tsx`
(~line 639) builds the `ProjectSnapshot` from `getProjectFiles()`, the content cache in
`apps/web/src/hooks/use-project-symbol-index.ts`. That cache is populated by `fetchReachableContent`
(`lib/codemirror/include-tree-fetcher.ts`), which walks **the `include::` graph from the main file
only**. A YAML theme is never reachable that way.

Two consequences today:

1. On a fresh page load the theme's content is absent from the cache, so `discoverThemePath` — which
   filters `textPaths` derived from the same map — **cannot even see the theme's path**, and the export
   silently renders unthemed.
2. A collaborator's live theme edits never invalidate the cache, because `handleContentChanged` filters
   `content-changed` frames by reachability.

The precedent for the fix already exists in the same file: `renameRefreshNonce`
(`project-editor-layout.tsx` lines 325–338) shows the unfiltered-refresh pattern.

**Alternatives considered**: Widening the include-graph walk to include theme paths (rejected —
conflates two unrelated notions of reachability); fetching the theme on demand at export time
(rejected — a network round-trip inside the export path, and it would still miss the preview).

---

## R7. Loading PDF converter extensions into the wasm VM

**Decision**: Extend `buildConvertCode` in `packages/asciidoc-pdf/src/convert/invoke.ts` to emit
extension loading between the shim block and the convert call. Ship first-party extensions as a local
path gem under `packages/asciidoc-pdf/ruby/extensions/`.

> **Amended 2026-07-18.** This section originally also proposed loading project-supplied files with
> `load` from the mounted VFS. **Extension code now loads only from the deployment** — the shipped gem
> and the administrator's folder — and **never from `/project`**, which is member-writable. See
> plan.md §Security finding.

**Rationale**: Every piece of this already has a working precedent.

- **The invocation is an eval'd Ruby string.** `buildConvertCode` (invoke.ts:479–512) emits `require`s,
  then `READABLE_SHIM` (line 393), then `SOURCEMAP_SHIM` (line 421), then the `convert_file` call.
  Inserting into that array is a one-line seam.
- **The converter-customisation shape is already in use.** `SOURCEMAP_SHIM` *is* a converter extension:
  a Ruby module `prepend`ed onto `::Asciidoctor::PDF::Converter`, injected as a string, guarded by an
  `ancestors.include?` idempotency check. The twelve shipped extensions take exactly this shape.
- **First-party Ruby into the wasm has a precedent**: `ruby/shims/asciidoctor-pdf-wasm-shims/`, wired
  via `Gemfile:40` with `path:`, vendored by Bundler, passing the native-extension gate, baked by
  rbwasm. A sibling `ruby/extensions/` gem follows the same path.
- **Project `.rb` files are already mounted.** `populateProject` (`src/vfs/populate.ts:143`) writes every
  key of `snapshot.files` to `/project/<key>` with no extension allowlist.
- **`load` over `require`** because `require` caches in `$LOADED_FEATURES`; on the warm VM a modified
  extension would not take effect, defeating FR-035's re-approval-on-change requirement.

The native-extension gate is concrete and enforced (`build-wasm.sh:99–110`: `find` for
`*.so`/`*.bundle`/`*.dylib`/`extconf.rb`, exit 2 on any hit, `js` gem excepted), so a pure-Ruby
first-party gem passes it by construction — satisfying FR-032c mechanically rather than by review.

---

## R8. Bounded execution for project-supplied extensions — **SUPERSEDED**

> **⚠ SUPERSEDED 2026-07-18. Do not implement the watchdog described below.**
> This section analysed bounded execution for *project-supplied* extensions, which were removed after
> the `js`-bridge security finding (plan.md §Security finding). **FR-038 no longer exists.** The
> section is retained because this analysis is what motivated the removal.
>
> The sync-`vm.eval` limitation it documents remains accurate — but with extensions now being trusted
> deployment code, a stall is an operational concern for an administrator debugging their own
> extension, not a security control. See contracts/pdf-extension.md §Administrator folder.

**Original decision (no longer applicable)**: Main-thread watchdog + `worker.terminate()` + worker
rebuild + automatic re-render with the offending extension disabled.

**Rationale**: This is the largest architectural gap in the feature, and the constraint driving the
design is subtle:

- **No timeout, no fuel, no instruction limit exists** anywhere in the render path. The browser's
  WebAssembly engine exposes no fuel metering, and `WasiBridgeConfig` carries no memory ceiling.
- **The convert runs synchronously** — `vm.eval(...)`, not `evalAsync` (invoke.ts:281, with a comment at
  270–278 explaining that `evalAsync`'s Fiber has a small fixed C stack that overflows on deep
  prawn-svg recursion, producing an uncatchable wasm trap). **A hung Ruby extension therefore blocks
  the worker's event loop entirely** — the worker cannot process a `cancel` message, because
  `onmessage` never gets a turn.
- **Cancellation is cooperative and stage-boundary-only** (`orchestrator.ts:265`), never inside the
  convert.

So in-worker bounding is impossible; only the main thread can intervene, and `worker.terminate()` is
the sole hard kill. The "document still renders without it" half of FR-038 is then satisfiable by
re-rendering in a fresh worker with the extension excluded.

**Alternatives considered**: In-Ruby cooperative bounding via `TracePoint`/`set_trace_func` deadline
checks (rejected — cannot interrupt a tight loop inside C-level gem code, so it fails exactly the case
it exists for); a dedicated sacrificial worker per extension-bearing render (viable, and worth
revisiting if terminate-and-rebuild proves too slow — but it doubles warm-VM memory); `evalAsync` with
a Fiber timeout (rejected — the documented stack-overflow trap makes it strictly worse).

---

## R9. Warm-VM isolation — **leak found; mitigation SUPERSEDED**

> **⚠ SUPERSEDED 2026-07-18. Do not implement dispose-per-render.**
> The `vm.dispose()` mitigation existed to contain *project-supplied* extensions, which were removed
> (plan.md §Security finding). Shipped and administrator-provided extensions are trusted deployment
> code and keep the warm VM.
>
> **The underlying finding still binds**: because the VM is warm and never torn down, every extension
> MUST be idempotent (contract C3) — a non-idempotent `prepend` corrupts every later render in that
> worker. Idempotency replaced teardown as the mechanism, so it is a hard requirement rather than a
> nicety.

**Original decision (no longer applicable)**: Call `vm.dispose()` after any render that loaded a
project-supplied extension, forcing a cold start for the next render in that worker.

**Rationale**: `RubyPdfVmImpl` (`src/vm/ruby-pdf-vm.ts:140`) holds one `WasiBridge` for the worker's
life; `warmup()` returns `{coldStart:false}` after the first call, and **nothing calls `dispose()`
per-conversion** (it exists at line 203, used only via `worker.terminate()` on React unmount).

Therefore any constant, monkey-patch or `prepend` installed by a project extension **persists for the
life of the worker and applies to every later conversion** — including, potentially, conversions of a
*different project*, since the worker is per-hook-instance rather than per-project.

The existing first-party shims sidestep this by being idempotent and stateless; the one piece of
per-run state (`$__asciidocollab_source_map`) is explicitly reset before and after each convert
(invoke.ts:422, 493, 508) with a comment noting entries "never leak between runs". That discipline does
not generalise to arbitrary project code.

**Scope note**: first-party shipped extensions are trusted, idempotent and version-locked, so they do
**not** require the dispose-per-render penalty. The cost is confined to project-supplied extensions.

---

## R10. Reference-parity harness and the cost of twelve extensions

**Decision**: Generalise `pdf-parity-render.spec.ts` to a manifest-driven loop before adding extension
fixtures, and wire the parity config into CI.

**Rationale**: The harness is real and good, but its browser suite is **not fixture-driven** —
`apps/web/e2e/pdf-parity/pdf-parity-render.spec.ts` hand-writes each case (`code`, a loop over a
hardcoded `CITATION_VARIANTS`, and `['math','diagrams']`), 7 test cases over 8 fixture dirs. Adding
twelve hand-written blocks would triple the file for no benefit; the citations `variants[]` field is
the existing precedent for a variant matrix under one fixture.

Comparison is not pixel-diff: page count via `pdfinfo`, text layer via `pdftotext -layout`, and for
math/diagrams a rasterised "ink map" (`pdftoppm -gray`, `INK_THRESHOLD = 250`) comparing dark-fraction
ratio and bbox edges. The `tolerance.pixelThreshold` fields in the manifests are vestigial for the
browser suite. Most extension fixtures need only text-layer + page-count assertions; the visual ones
(custom title page, multi-column, image float) need ink maps.

**CI is the real finding: the parity suite does not run.** `playwright.config.ts` explicitly
`testIgnore`s `pdf-parity-render.spec.ts`, and nothing in `.github/workflows/ci.yml` or `scripts/ci/`
invokes `playwright.pdf-parity.config.ts` — though CI already installs poppler-utils and restores the
wasm engine, with comments saying "once reference fixtures land". **Principle XV requires comparison
tests against reference output for fidelity-critical behaviour; a suite that never runs does not
satisfy it.** Wiring it in is therefore in scope for this feature, not optional hygiene.

Reference PDFs are Docker-generated from the real gem (`ruby:3.3`, pinned `asciidoctor-pdf:2.3.24`,
`-a reproducible`) and committed. Runtime is dominated by a one-time ~70 MiB wasm compile in
`beforeAll`; twelve added variants are likely single-digit added minutes, serialized.

**FR-032f consequence**: shipped extensions must be loadable by the Docker reference build, so they
must be plain `-r`-able Ruby files, not code that only exists inside our eval'd convert string.

---

## R11. Sectioned project options — routing and save semantics

**Decision**: Sections via `useSearchParams` on the existing `settings/` route (not nested routes), with
one shared `RenderConfig` draft across all sections that always PUTs the merged whole.

**Rationale**: Next 16.2.6, app router. **There is no Tabs primitive** —
`apps/web/src/components/ui/` has badge, button, card, dropdown-menu, input, label, progress,
resize-handle, skeleton, and no `@radix-ui/react-tabs` among the installed Radix packages. Existing
in-repo patterns for sectioned UI are `components/editor/left-panel-rail.tsx` (icon rail switching
panels) and the review panels; for URL-addressable selection the precedent is
`app/(dashboard)/dashboard/page.tsx` using `useSearchParams`. Nested routes in this codebase are
reserved for genuinely different pages (`settings/`, `members/`), which sections are not.

**FR-006 is a live hazard.** `PUT /api/projects/:id/render-config`
(`apps/api/src/routes/projects/render-config.ts`) is an explicit **full replace** — no merge or patch
path. `RenderConfig` is one flat object spanning document, page, font, images and custom attributes.
If sections each PUT only their own keys, the others are wiped. Keeping a single shared draft and
PUTting the whole is the cheaper of the two fixes and needs no API change. The returned config must
re-seed **all** sections' drafts, or a stale draft clobbers on the next save.

**Alternatives considered**: PATCH/merge semantics server-side (rejected for now — a wider change to
route, use case and audit-log entry for no user-visible benefit; revisit if sections ever need
independent saves); nested routes per section (rejected — forks the page's auth and data loading five
ways).

**Test churn to expect**: `apps/web/e2e/project-settings.spec.ts` assumes the name field and archive
banner are visible on load; `tests/.../settings-client.test.tsx` (212 lines) assumes a single flat
page; `tests/components/render-config-settings.test.tsx` asserts exact whole-config save payloads.

---

## R12. Access-control note

`settings/page.tsx` passes `"owner"` as `minRole` to `getProjectAccess`, so only owners reach the page
at all — making the internal `isOwner` check for the Danger Zone redundant today. FR-007's "uniformly
to every section" is therefore satisfied by the existing page-level gate, and sections must not
introduce their own weaker checks.

This also confirms the clarification-session decision: because the theme editor lives in the *editing
surface* rather than in project options, it correctly follows file permissions (FR-026) rather than
owner-only access — the two surfaces have genuinely different gates, and that is now intentional
rather than accidental.
