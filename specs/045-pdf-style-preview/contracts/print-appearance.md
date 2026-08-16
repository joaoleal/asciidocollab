# Contract: `@asciidocollab/shared` — `print-appearance`

The public surface of the pure theme resolver. Consumed by `apps/web`; carries no browser, DOM, wasm
or filesystem dependency, so it is unit-testable as plain data in/data out (Principle III).

## Exports

```ts
/** Resolve a project's theme text into the appearance the Print preview presents. */
export function resolveAppearance(input: ResolveAppearanceInput): ResolveAppearanceResult;

/** The gem's default appearance, with no project theme overlaid (FR-022). */
export function defaultAppearance(): AppearanceModel;

export interface ResolveAppearanceInput {
  /** Raw theme document text, or undefined when the project has no theme (FR-022). */
  readonly themeText?: string;
  /** Path of the theme document, used only to attribute diagnostics to a resource. */
  readonly themePath?: string;
}

export interface ResolveAppearanceResult {
  /** Always present — never null, even when the theme could not be parsed (FR-023). */
  readonly appearance: AppearanceModel;
  /** Empty when nothing is wrong (FR-033). */
  readonly diagnostics: readonly AppearanceDiagnostic[];
  /** False when `appearance` is the default because the theme could not be parsed at all. */
  readonly themeApplied: boolean;
}
```

`AppearanceModel`, `AppearanceDiagnostic` and `FontRequirement` are as specified in
[data-model.md](../data-model.md) §2–§4.

## Behavioural contract

| # | Rule | Requirement |
|---|------|-------------|
| C1 | `resolveAppearance` is total — it never throws and never returns a null appearance, whatever the input text | FR-022, FR-023 |
| C2 | Given no `themeText`, the result equals `defaultAppearance()` with no diagnostics | FR-022 |
| C3 | Given text that parses, every key listed in FR-020 is resolved after the `extends` chain and `$variable` interpolation | FR-018, FR-019 |
| C4 | Given text that parses but holds a value that does not match its descriptor's `valueKind`, that key alone falls back to its default and one `theme-value-rejected` diagnostic is produced | FR-025 |
| C5 | Given text that does not parse, the appearance is `defaultAppearance()`, `themeApplied` is false, and one `theme-unparseable` diagnostic is produced. **Holding the previous model is the caller's job**, not the resolver's — the resolver stays pure | FR-023 |
| C6 | Keys outside FR-020's closed list are neither applied nor reported | FR-020, FR-021 |
| C7 | Identical input yields a deeply-equal result, every time, in any order | Principle XII |
| C8 | All measurements in the model are in PDF points; no CSS unit appears anywhere in the output | research R8 |
| C9 | No value in the model is a raw substring of the input — every value has been parsed to a typed value | Principle IX |
| C10 | `AppearanceDiagnostic` is this module's own type with its own code union. It MUST NOT restate `RenderDiagnostic` from `packages/asciidoc-pdf` — that would be one type defined in two packages | Arch. Constitution blocking rule 4 |

C9 is the security-relevant one: it is what makes CSS injection through a theme value structurally
impossible rather than merely filtered.

C10 is the boundary-relevant one. `packages/asciidoc-pdf` may depend inward only on
`asciidoc-core`, so the two diagnostic types cannot be unified in `shared`; they stay distinct and
are reconciled by an adapter in `apps/web`, the one place that already imports both. See
[data-model.md §4](../data-model.md).

## CSS custom-property vocabulary (owned by `apps/web`)

The resolver does not produce CSS — but the property names are a contract between two files that do
not import each other: `appearance-to-css.ts` **writes** them and `print-preview.css` **reads** them.
Nothing would fail to compile if they drifted; the page would simply lose a value silently. The
vocabulary is therefore fixed here rather than invented twice.

**Namespace**: every property is `--print-<section>-<property>`, lower-kebab throughout, derived
mechanically from the `AppearanceModel` path — `page.marginPt.top` → `--print-page-margin-top`,
`headings[2].fontColor` → `--print-heading-2-font-color`, `code.backgroundColor` →
`--print-code-background-color`. No abbreviations, no aliases, no second name for one value.

**Rules**

| # | Rule |
|---|------|
| V1 | A property exists for exactly the keys FR-020 enumerates — no more (nothing unclaimed is emitted) and no fewer (nothing claimed is missing) |
| V2 | The name is derived from the model path by the rule above, so adding a model field determines its property name without a decision |
| V3 | Lengths are written in `px`, converted once at the boundary at 96/72 from the model's points; colours as `#RRGGBB`. The model itself stays unit-free in points (C8) |
| V4 | A property is written only for a value the model actually carries. A missing value is **absent**, never an empty string — so the stylesheet's own fallback in `var(--print-x, <default>)` is what applies |
| V5 | The stylesheet reads every property it declares a fallback for, and the writer writes every property the stylesheet reads. A test asserts the two sets are equal — this is the only thing that keeps them from drifting |

V5 is the one that matters: it converts an implicit agreement between two `[P]`-parallel tasks into a
failing test.

## Non-goals

- Producing CSS. The model is engine-neutral; `apps/web` owns the projection (see
  [`appearance-to-css.ts`](#) in the plan's structure) under the vocabulary fixed above.
- Locating the theme file. Callers use `resolveThemePath` from `@asciidocollab/asciidoc-core`.
- Loading fonts. The model *declares* `FontRequirement`s; resolving them to URLs is the web layer's
  job, because only it knows the project's storage origin.
- Anything the PDF renderer does with the theme beyond appearance — running headers/footers, page
  breaks, TOC leaders and title-page geometry are out of scope (FR-037).

## Test obligations

- Breadth (SC-004): every key named in FR-020 has an assertion that the resolver produces its
  expected effective value. Zero keys claimed but unasserted.
- Cascade: fixtures already in the repo (`apps/api/data/demo-project/theme/showcase-theme.yml`, the
  `pdf-parity` fixture themes) resolve without diagnostics.
- Hostile input (SC-008): malformed YAML, absurd sizes, colours that are not colours, a value
  attempting to close a CSS declaration — each yields a usable appearance plus a diagnostic, and
  never a raw substring in the output (C9).
