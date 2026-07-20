# Contract: PDF Converter Extension

**Feature**: 041-pdf-theme-project-options

Defines what a PDF extension is. One contract serves both origins — extensions shipped with the
application and extensions an administrator drops into the deployment's folder — because they are the
same artefact loaded from two places. This is the unit of work `/speckit-tasks` should use for each of
the twelve.

**All extension code originates in the deployment.** A project cannot contribute executable code; a
Ruby file in a project's file tree has no effect on rendering (FR-034, FR-035). See `plan.md`'s
security finding for why an earlier project-supplied design was removed.

---

## Shape

An extension is a Ruby file that customises the PDF converter, in the form the asciidoctor-pdf
extension documentation describes: a module `prepend`ed onto the converter, or a subclass registered
for the `pdf` backend.

The precedent already exists in-repo — `SOURCEMAP_SHIM` in
`packages/asciidoc-pdf/src/convert/invoke.ts` (~line 421) is exactly this shape:

```ruby
module AsciidocollabExtensions
  module ParagraphNumbering
    def init_pdf doc
      super
      doc.find_by(context: :paragraph).each_with_index do |para, idx|
        para.set_attr 'number', idx + 1
      end
    end

    def convert_paragraph node
      # ink the stored number in the margin, styled from theme keys
      super
    end
  end
end

unless ::Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabExtensions::ParagraphNumbering
  ::Asciidoctor::PDF::Converter.prepend AsciidocollabExtensions::ParagraphNumbering
end
```

**Requirements on every extension**

| # | Requirement | Source |
|---|---|---|
| C1 | Plain Ruby — no native code, no subprocess, no socket | FR-032c, Principle XIV |
| C2 | Loadable by the canonical CLI via `-r`, not only by our eval'd convert string | **FR-032f** |
| C3 | Idempotent — guarded so re-application on a warm VM is inert | Principle XII, research R9. **Load-bearing**: the VM is reused across renders and is never torn down, so a non-idempotent extension corrupts later renders |
| C4 | Appearance read from theme keys; never from a private config channel | FR-031a |
| C5 | Targets read from document block attributes / roles; never from the theme | FR-031a1 |
| C6 | Inert when disabled — targeting markup left in a document must render as if absent | FR-031a2 |
| C7 | Deterministic under composition — no reliance on load order | FR-031c |
| C8 | Declares its theme keys and targeting markup in a manifest | FR-031a3, FR-031b |

**C2 is the one most likely to be violated by accident.** It is what makes the Principle XI reference
build possible; an extension that only works inside our convert string cannot be parity-tested, and
under Principle XV is therefore not shippable.

---

## Manifest

**Defined once, in `packages/shared/src/pdf-extensions/`** — see data-model.md §4 for the field list.
The shape crosses domain, api, web and asciidoc-pdf, so `packages/shared` owns it and no other package
may redeclare it (Architecture Constitution §Contracts & Validation; P0 blocking rule 4).

`PdfExtensionManifest` is what the extension declares; `PdfExtensionCatalogueEntry` adds the
server-resolved `origin` and `available`. They are one shape and its resolved form, not two.

`themeKeys` feeds the descriptor catalogue with `contributedBy = id` (FR-031b), so enabling an
extension makes its settings completable in the theme editor. `sampleContent` is what FR-011a requires
the sample document to absorb.

---

## Load protocol

Emitted by `buildConvertCode` (`invoke.ts:479–512`), between the existing shim block and the
`convert_file` call.

1. **Shipped** — `require` by name from the baked path gem
   (`packages/asciidoc-pdf/ruby/extensions/`, wired via `Gemfile` with `path:`, following the
   `asciidoctor-pdf-wasm-shims` precedent).
2. **Administrator-provided** — fetched from the authenticated API (never a public static asset),
   written into the VFS at a dedicated mount, and `load`ed from there.

`packages/asciidoc-pdf` receives the administrator listing and source **injected by `apps/web` at the
worker composition root**. It MUST NOT import from `apps/*` (P0 blocking rule 9) and MUST NOT reach
the deployment folder itself.

Both keep the warm VM. Both are deployment code, so neither needs a teardown between renders — but
C3's idempotency guard is what makes that safe on a reused VM, which is why it is a hard requirement
rather than a nicety.

**Never load from `/project`.** Project files are mounted there and are member-writable; loading Ruby
from that mount is exactly the removed design.

**Ordering MUST be deterministic** — sort by catalogue id, not by selection order or object iteration
(FR-031c, Principle XII).

---

## Administrator folder

- **A bind-mounted directory at a configured path (default `/data/pdf-extensions`), outside the
  application image.** A path under
  `apps/web/public/` was rejected: it is baked into the web image at build time, so adding an
  extension would require a rebuild — which FR-033/FR-033b explicitly forbid. Files there are also
  world-readable, which FR-033f forbids.
- Read only through `PdfExtensionSourcePort` (data-model §5a); scanned by an infrastructure adapter,
  assembled by `GetPdfExtensionCatalogueUseCase`, exposed by a thin route — see
  `contracts/extension-catalogue.md`.
- Each extension supplies its manifest; entries appear in the catalogue indistinguishably from shipped
  ones (FR-033a, FR-033c).
- A file that fails to load, or whose manifest is missing, malformed, or duplicates another
  identifier, is **reported and excluded** — never fatal to the catalogue or the application
  (FR-033d, FR-033e).
- New extensions arrive **disabled for every project** (FR-036), so adding one cannot change existing
  output.

**Trust**: an administrator who can write to this folder already controls the served application, so
this grants no new privilege. The documentation must say so plainly rather than implying the renderer
sandboxes deployment code from the deployment (FR-037).

**Note on `vm.eval`**: the convert runs synchronously, so a buggy extension can stall a render and the
worker cannot interrupt itself (research R8). With extensions being trusted deployment code this is an
operational concern — an administrator debugging their own extension — not a security control. Worth a
troubleshooting note in the administrator documentation.

---

## Parity contract

Per Principle XV, each shipped extension is not done without a comparison test against reference
output.

- Fixture at `apps/web/e2e/pdf-parity/fixtures/ext-<id>/` with `source/`, `manifest.json`, and a
  committed `reference.pdf` generated by the Docker reference build with the extension `-r`'d.
- **Generalise `pdf-parity-render.spec.ts` to a manifest-driven loop first** — it currently hand-writes
  each case, and twelve more blocks would triple the file (research R10).
- Assertion level: page count + text layer for most; ink-map comparison for the visual ones
  (`custom-title-page`, `multi-column-sections`, `image-float-wrapping`).
- Each fixture asserts **both** states: enabled produces the expected change, disabled produces output
  identical to the unextended document (SC-015a).
- The parity config must run in CI (plan V-1) — coverage that never executes does not satisfy XV.

Administrator-provided extensions are outside our parity corpus: we ship no fixture for code we did
not write. Principle XI still holds structurally, because the administrator can run the same file
through the canonical CLI with `-r` and get the same output — which is precisely what C2 guarantees.
