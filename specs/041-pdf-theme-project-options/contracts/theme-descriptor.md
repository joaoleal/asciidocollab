# Contract: Theme Setting Descriptor Catalogue

**Feature**: 041-pdf-theme-project-options

The catalogue that drives theme-key completion (FR-010a), inline colour swatches and font samples
(FR-010b), and validation (FR-010c). It is **generated**, not hand-maintained — this is the feature's
main Principle IV obligation.

---

## Generation

**Input** — the gem's own theme files, already vendored in-repo and baked into the wasm:

```
packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/
  gems/asciidoctor-pdf-2.3.24/data/themes/
    base-theme.yml          # structural floor
    default-theme.yml       # the effective default; also seeds FR-010
```

**Output** — a generated TypeScript module consumed by the completion source and the widget registry.

```
ThemeSettingDescriptor {
  key             string    // dotted, e.g. "heading.h2.font-color"
  category        string    // "heading"
  valueKind       'colour' | 'font' | 'measurement' | 'keyword' | 'number' | 'boolean' | 'string'
  permittedValues string[]? // keyword only
  description     string
  defaultValue    string?
  contributedBy   string?   // extension id; absent for renderer built-ins
}
```

**Split of responsibility** (research R3): no machine-readable schema exists upstream, so

- `key`, `category`, `valueKind`, `defaultValue` are **derived** from the theme YAML;
- `description` and `permittedValues` come from a **hand-maintained table keyed by `key`**;
- `contributedBy` comes from each extension's manifest (see `pdf-extension.md`).

`valueKind` inference from the default theme's own values:

| Pattern | Kind |
|---|---|
| `#RRGGBB`, `[C,M,Y,K]` | colour |
| `0.67in`, `10.5`, `1.2em`, `12pt` | measurement |
| Font family name matching a declared catalogue entry | font |
| Enumerated word from a known set | keyword |
| `true` / `false` | boolean |

---

## Invariants

| # | Invariant | Why |
|---|---|---|
| D1 | Every key resolves to exactly one descriptor; duplicates fail the build | Completion must be unambiguous |
| D2 | A hand-written description whose key vanishes after a gem bump **fails the build** | Stops silent drift — the FR-009b discipline applied to descriptors |
| D3 | No descriptor may be offered that the renderer does not recognise | SC-011 |
| D4 | Regeneration is a documented, repeatable build step — never hand-editing generated output | Principle IV |
| D5 | Extension-contributed descriptors appear only while that extension is enabled | FR-031b |

**D2 is the load-bearing one.** A generated catalogue that silently tolerates stale hand-written
descriptions decays into exactly the hand-maintained list Principle IV forbids — the build failure is
what keeps the generation honest.

---

## Consumers

1. **Completion source** — `apps/web/src/lib/codemirror/completions/`, modelled on `attribute.ts`
   (factory closing over a lazy accessor, `context.matchBefore(...)` →
   `{ from, options, filter: false }`). Offers keys valid at the cursor, with `description` as detail
   and `permittedValues` as value completions (FR-010a).

2. **Inline widgets** — `Decoration.replace({ widget })` per the `asciidoc-attribute-fold.ts` pattern,
   which **skips the range when the cursor or selection overlaps it** so raw text is revealed for
   editing. `valueKind: 'colour'` → swatch; `valueKind: 'font'` → rendered sample (FR-010b). The
   registry-driven approach in `inline-style-registry.ts` is the closest structural analogue.

3. **Validation** — a lint source alongside `asciidoc-diagnostics.ts` and
   `editor-spellcheck-linter.ts`, reporting unknown keys and malformed values against the line they
   occur on (FR-010c, FR-015). Must never discard the last valid preview.

---

## Seeding a new theme (FR-010)

Creating a `*-theme.yml` offers to seed it from `default-theme.yml` — a copy of the vendored file, not
a synthesis. This makes "the effective default theme as the editable starting point" exact by
construction rather than approximate.
