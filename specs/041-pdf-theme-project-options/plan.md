# Implementation Plan: PDF Theme Editing & Sectioned Project Options

**Branch**: `041-pdf-theme-project-options` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/041-pdf-theme-project-options/spec.md`

## Summary

Three capabilities over the existing in-browser PDF stack:

1. **Sectioned project options** — the settings page splits into URL-addressable sections, keeping one
   shared render-config draft so a section save cannot clobber another section's values.
2. **A YAML theme editor** — selecting a `*-theme.yml` file in the file tree opens a two-pane editor:
   YAML on the left with theme-key completion and inline colour/font previews, an auto-updating PDF
   preview of a built-in sample document on the right, with a with/without comparison toggle for
   enabled extensions. The theme is an ordinary project file, so it inherits co-editing, presence and
   permissions unchanged.
3. **Twelve first-party PDF converter extensions** — converter customisations in the shape the
   asciidoctor-pdf extension documentation describes, selectable per project, plus a deployment folder
   an administrator can drop further extensions into without rebuilding.

The technical spine is that the theme and the extensions are both *already-supported shapes* in the
existing stack: the collab layer is file-type agnostic, and `SOURCEMAP_SHIM` in the convert path is
already a converter extension. The genuinely new engineering is (a) a theme-key descriptor catalogue
derived from the gem's own theme files, (b) a manifest-driven extension loader serving both the
shipped set and the administrator's folder, and (c) turning the parity harness from a hand-written
suite into a manifest-driven one that actually runs in CI.

**All extension code originates in the deployment.** A project cannot contribute executable code —
see the security finding in §Constitution Check, which is why an earlier project-supplied design was
removed.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22, React 19, Ruby 3.3 (wasm32-wasip1)

**Primary Dependencies**: Next.js 16.2.6 (app router), CodeMirror 6 (`@codemirror/lang-yaml` to be
promoted to a direct dep — already present transitively), Yjs + Hocuspocus 4, `@ruby/wasm-wasi` +
`@bjorn3/browser_wasi_shim`, asciidoctor-pdf 2.3.24 (baked into wasm), Prisma + PostgreSQL, Fastify

**Storage**: Theme = an ordinary project file (file store + Yjs state, no schema change). Extension
selection = a new key inside the existing `project_render_configs.config` JSON blob — **no migration
required**. Administrator extensions live on the deployment's filesystem, not in the database.

**Testing**: Jest (unit, in-memory fakes per Principle III), Playwright (e2e), the pdf-parity Playwright
project (reference comparison per Principles XI/XV), Docker-generated reference PDFs

**Target Platform**: Modern browsers; all rendering client-side in a Web Worker (Principle X)

**Project Type**: pnpm monorepo — `apps/{web,api,collab}`, `packages/{shared,domain,db,asciidoc-pdf,asciidoc-core}`

**Performance Goals**: Sample preview updates within 3s of a theme edit (SC-003); editor stays
interactive during render (SC-004, Principle XIII)

**Constraints**: No egress of document content (Principle X); output must match the canonical CLI
toolchain (Principle XI); deterministic output (Principle XII); everything inside the browser sandbox
(Principle XIV)

**Scale/Scope**: 12 shipped extensions, ~200 theme keys in the descriptor catalogue, 1 settings page
split into ~5 sections, ~12 new parity fixtures

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design.*

### Passing without qualification

| Principle | How this feature satisfies it |
|---|---|
| **I. Clean Code** | Theme-key catalogue is generated, not hand-maintained; extension loading reuses the existing `SOURCEMAP_SHIM` shape rather than inventing a second mechanism. |
| **II. TDD** | Every implementation task runs via `/tdd`. Note the opt-in rule: the spec's SC-003 (3s) and SC-004 (responsiveness) are *not* requests for performance tests and MUST NOT generate them. |
| **III. Seam Testing** | No new repository interfaces — extension selection rides the existing `ProjectRenderConfig` repo, which already has in-memory fakes. |
| **IV. Reuse Before Rebuild** | **Strongly satisfied.** YAML mode reused (`@codemirror/lang-yaml`, already present); theme-key catalogue derived from the gem's own `base-theme.yml`/`default-theme.yml` via a repeatable build step; FR-010 seeding is a copy of `default-theme.yml`. See research R2/R3. |
| **V. Design Tokens** | Section navigation, catalogue UI and the comparison toggle are app chrome → tokens only, both modes. |
| **VI. Style Isolation** | The PDF preview renders to canvas via pdfjs; no document CSS enters app chrome. |
| **VII. Per-User Preferences** | Theme and extension selection are **project-scoped configuration**, explicitly permitted by VII's carve-out: stored on the project, permission-gated, and they do not silently rewrite document source. |
| **VIII. Editor Pipeline Integrity** | The theme editor adds a *new* editor profile; the AsciiDoc profile, its sanitizer and scroll-sync are untouched. |
| **IX. Untrusted Input Boundary** | **Non-waivable — satisfied, and this is why the design changed.** No externally-sourced content is executed. Extension code originates only in the deployment (FR-034); project content stays inert data (FR-035). |
| **X. Client-Side / No Egress** | **Non-waivable — satisfied.** All rendering stays in the worker. Extension code is shipped in the build or supplied by the deployment administrator; none comes from project content, and nothing is fetched from a third party at runtime (FR-031, FR-034). |
| **XII. Deterministic Output** | Extension ordering must be deterministic (FR-031c) rather than load-order dependent; reference builds already pin `SOURCE_DATE_EPOCH`. |
| **XIII. Non-Blocking** | Preview rendering already runs in a worker. The sync-`vm.eval` limitation (research R8) means a buggy extension could still stall a render, but extensions are now trusted deployment code, so this is an operational concern rather than a security control. |
| **XIV. Sandbox-Safe Dependencies** | Extensions are plain Ruby, gated by the build's native-extension check (`build-wasm.sh:99-110`). Administrator extensions are documented as carrying deployment trust (FR-037) rather than being presented as sandboxed from it. |

### Security finding that shaped the design

**The renderer's Ruby VM can reach JavaScript.** `packages/asciidoc-pdf/ruby/Gemfile:32` pins
`gem "js", "~> 2.7"` (vendored as `js-2.9.4`) — the ruby.wasm host bridge, which exposes `JS.global`,
the Web Worker's entire JavaScript global scope. Its own documentation demonstrates
`JS.global[:WebSocket].new(...)`. The gem also ships `JS::RequireRemote`, explicitly built to fetch and
evaluate Ruby from a URL.

Consequences for any *untrusted* Ruby in that VM:

- **Egress is reachable through JavaScript**, bypassing the inert socket shims and the WASI preopen
  list entirely — every control sits at the wrong layer. This breaks **Principle X, which is
  non-waivable**.
- The code runs in **another member's browser on our origin**, so a `fetch` with
  `credentials: 'include'` carries that member's session — privilege escalation from "can write a
  project file" to "can act as any member who previews the document".
- `JS::RequireRemote` defeats content-digest approval: an approved three-line file can pull arbitrary
  code at render time, so the content that matters was never the content approved.

Hardening was rejected as unsound: stripping the constant does not survive Ruby's reflectiveness
(`ObjectSpace`, and `$LOADED_FEATURES` making a re-`require` a silent no-op), so it would require
proving a negative in a language designed to make that false — and re-proving it on every ruby.wasm
bump. Removing `js` is not available either; it is the bridge that makes `vm.eval` work.

**Design consequence**: extension code may originate only in the deployment (FR-034). An earlier
project-supplied design was removed. An administrator who can write to the deployment's extension
folder already controls the served application, so the same Ruby carries **no new privilege** there —
which is exactly why the folder is acceptable where the project file tree was not.

This removes what were previously three separate violations: the Principle IX execution exception, the
absent bounded-execution mechanism, and the warm-VM state leak. Administrator extensions are trusted
deployment code on the same footing as the shipped set, so they keep the warm VM and need no watchdog.

### Extension catalogue ownership — assigned to the server

An architecture review found the catalogue had never been assigned to a layer, which produced four
compounding findings (a cross-package DTO outside `packages/shared`, assembly logic in a route
handler, filesystem access with no port, and two competing delivery paths). The decision:

**The catalogue is a server-side concern.** The administrator's folder is scanned by an
infrastructure adapter behind a domain port, assembled by a use case, and exposed by a thin Fastify
route. `packages/shared` owns the one manifest/entry shape that domain, api, web and asciidoc-pdf all
consume.

- **The folder is a bind-mounted volume at a configured path (default `/data/pdf-extensions`), not
  `apps/web/public/`.** A
  path inside the web image is baked at build time, so FR-033/FR-033b — "add an extension without
  rebuilding" — would have been unsatisfiable there. `docker-compose.prod.yml`'s `web` service
  declares no mount over `public/`.
- **Extension source is served through the authenticated API**, never as a public static asset
  (FR-033f). Files under Next.js `public/` are world-readable; extension source should not be.
- **`packages/asciidoc-pdf` receives the administrator listing injected**, never imported — it may not
  import from `apps/*` (P0 blocking rule 9), and it is consumed only by `apps/web`.

### Violations requiring justification

One item does not pass cleanly. It is tracked in Complexity Tracking.

---

**V-1 — Principles XI + XV: the parity suite does not run in CI**

Principle XV requires fidelity-critical behaviour to have comparison tests against reference output
before it is "done", and explicitly names **theme application** as fidelity-critical. The harness
exists and is good, but `playwright.config.ts` `testIgnore`s `pdf-parity-render.spec.ts` and no CI
script invokes `playwright.pdf-parity.config.ts` (research R10). **A comparison suite that never runs
does not satisfy XV.**

*Mitigation, in scope for this feature*: generalise the browser spec from hand-written blocks to a
manifest-driven loop, add fixtures for the twelve extensions plus theme editing, and wire the parity
config into CI. CI already installs poppler-utils and restores the wasm engine with comments
anticipating this.

*Consequence for design*: FR-032f (shipped extensions loadable by the canonical CLI) is not optional
polish — without it the Docker reference build cannot load the extension and no parity test is
possible. This constrains extensions to be plain `-r`-able Ruby files rather than code embedded in our
eval'd convert string.

## Project Structure

### Documentation (this feature)

```text
specs/041-pdf-theme-project-options/
├── plan.md              # This file
├── research.md          # Phase 0 output — R1..R12
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── render-config.md         # extension selection in the existing config blob
│   ├── theme-descriptor.md      # generated theme-key catalogue shape
│   └── pdf-extension.md         # the contract a converter extension implements
├── checklists/
│   └── requirements.md  # spec quality checklist (already present)
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
packages/shared/
├── src/render-config/
│   ├── config.ts                 # + extension selection keys on renderConfigSchema
│   ├── resolve.ts                # + resolve enabled extensions
│   └── theme-file.ts             # NEW: shared theme-recognition rule (FR-009b)
├── src/pdf-extensions/           # NEW: PdfExtensionManifest + CatalogueEntry — the single
│                                 #      definition, crossing domain/api/web/asciidoc-pdf
└── scripts/                      # NEW: theme-descriptor generator (mirrors apps/web/scripts/)

packages/asciidoc-pdf/
├── ruby/
│   ├── Gemfile                   # + path gem for first-party extensions
│   └── extensions/asciidocollab-pdf-extensions/
│       └── lib/                  # the 12 converter extensions (plain -r-able Ruby)
├── src/convert/invoke.ts         # + extension load seam in buildConvertCode
├── src/extensions/               # NEW: deterministic load ordering (consumes the shared DTO;
│                                 #      receives the admin listing injected, never imports apps/*)
├── src/protocol.ts               # + enabledExtensions on ProjectSnapshot
└── tests/

packages/domain/src/
├── ports/pdf-extensions/         # NEW: PdfExtensionSourcePort (folder scan + source read)
└── use-cases/project/            # NEW: GetPdfExtensionCatalogueUseCase

packages/infrastructure/src/persistence/pdf-extensions/   # NEW: filesystem adapter for the port
apps/api/src/routes/projects/pdf-extensions.ts            # thin route → use case
/data/pdf-extensions/                                     # administrator drop-folder (bind mount)

apps/web/src/
├── lib/codemirror/
│   ├── theme/                    # NEW: descriptor catalogue, completion, swatch/font widgets
│   └── editor-extensions.ts      # + YAML/theme editor profile seam
├── lib/pdf/
│   ├── build-project-snapshot.ts # + enabled extensions; theme content from aux cache
│   └── auxiliary-text-cache.ts   # NEW: theme/.bib content outside the include graph (R6)
├── components/
│   ├── theme-editor/             # NEW: two-pane editor + comparison toggle
│   └── settings/                 # sectioned project options
├── app/(dashboard)/dashboard/projects/[id]/
│   ├── settings/settings-client.tsx    # section navigation via useSearchParams
│   └── project-editor-layout.tsx       # ContentArea file-type dispatch
└── workers/asciidoc-pdf.worker.ts      # + extension loading

apps/web/e2e/
├── pdf-extensions.spec.ts        # NEW: US3 end-to-end
└── pdf-parity/
    ├── pdf-parity-render.spec.ts # generalised to manifest-driven
    └── fixtures/<extension>/     # ~12 new fixtures + committed reference PDFs

scripts/ci/                        # + parity gate wiring
```

**Structure Decision**: Existing pnpm monorepo, no new packages. The three stories touch largely
disjoint areas — settings page (`apps/web/.../settings/`), editor (`apps/web/src/lib/codemirror/` +
`components/theme-editor/`), and renderer (`packages/asciidoc-pdf/`) — which supports the spec's
independent-testability requirement and lets the tiers land incrementally per FR-032a2.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **V-1**: generalising the parity spec + wiring parity into CI (beyond the feature's nominal surface) | Principle XV names theme application fidelity-critical and requires comparison tests; the existing suite is `testIgnore`d and never runs, so the principle is currently unmet | Adding 12 hand-written test blocks would triple the spec file and still leave the suite unrun in CI — the coverage would be nominal, not real. |

**Resolved during planning, retained for the record**: an earlier design permitted projects to supply
their own Ruby extensions, which required a Principle IX execution exception, a bounded-execution
mechanism that does not exist, and a per-render VM teardown to stop state leaking between projects.
The `js`-bridge finding above showed the sandbox argument underpinning all three did not hold, and the
capability was removed in favour of the administrator folder. No compensating complexity remains.
