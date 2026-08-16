# Contract: font sources for the Print preview

The resolver *declares* `FontRequirement`s (data-model §3); it does not load fonts. This contract
fixes how each source is obtained, because one of them — the project's own font files — is untrusted
project content being handed to the browser as a font resource.

## The three sources

| Source | Origin | Obtained via |
|--------|--------|--------------|
| `project` | the project's own `.woff2` files | the **existing** project-asset mechanism (`apps/web/src/hooks/use-project-asset-cache.ts`, `use-referenced-assets.ts`) — the same path the PDF preview already uses for images and fonts |
| `catalogue` | the gem's subsetted faces, converted to WOFF2 — **every family the gem's default theme references**, `Noto Serif` included | `packages/asciidoc-pdf`'s committed, manifested asset directory, served from the app's own origin (research R3) |
| `fallback` | a same-classification local stack | no fetch of any kind |

## Rules

| # | Rule | Requirement |
|---|------|-------------|
| F1 | Project fonts MUST be fetched through the existing project-asset mechanism. The Print style MUST NOT introduce a new route, a new storage reader, or a direct path join | Arch. Constitution — Module Boundaries; Principle IV |
| F2 | Only paths named by the resolved theme's font catalogue are requested. A path is never taken from anywhere else, and never assembled from user text at the call site | Principle IX |
| F3 | A requested asset that is absent, unreadable, or not a decodable font MUST resolve to `fallback` with a `theme-font-unavailable` diagnostic — never a broken page and never a silent blank | FR-028, FR-032 |
| F4 | A font is obtained from the project or from the application's own origin, and from nowhere else. There is no code path that can fetch a font from an external location | FR-029, Principle X |
| F7 | A `catalogue` face is the gem's own converted subset. Another build of the same family — notably the `next/font/google` `Noto Serif` the app already loads for the `asciidoctor` style — MUST NOT stand in for it: same name, different sfnt, different metrics, and it is the default theme's body face, so it would be the one font path never compared against the gem's (research R3) | FR-027 |
| F5 | Catalogue fonts are served from the published, manifested package directory — never from `packages/asciidoc-pdf/ruby/.wasm-build/`, which is gitignored build output | Principle XII; Arch. Constitution — Module Boundaries |
| F6 | Font bytes are never interpreted, parsed or rewritten by application code — they are handed to the browser's font loader as opaque bytes | Principle IX |

## Why F1 matters

Without it, "served to the preview from project storage" is an unnamed trust edge: an implementation
could reasonably build its own reader and re-derive path handling that the existing asset mechanism
already gets right. Naming the mechanism means the validated path is the only path, and any deviation
is visible in review rather than plausible.

## Test obligations

- A project supplying its own font renders in that font (SC-002 anchor fixture, per
  [fidelity-oracle.md](./fidelity-oracle.md)).
- A theme naming a font the project does not supply and the catalogue does not contain renders in a
  fallback and produces exactly one diagnostic naming the font (FR-028).
- Every family the gem's default theme references resolves to `catalogue`, not `fallback` — asserted
  against the family list read from `default-theme.generated.ts`, so a family missing from the
  converted assets fails a test rather than degrading the default appearance quietly (F7).
- A project font path that is absent, is a non-font file, or is corrupt yields F3's behaviour in all
  three cases.
- No test double is needed to prove F4: an assertion that the feature's modules contain no external
  URL and no fetch to a non-origin host is a static check, and belongs in the same suite that already
  guards the no-egress rule.
