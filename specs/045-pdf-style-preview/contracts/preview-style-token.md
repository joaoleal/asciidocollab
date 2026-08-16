# Contract: the `print` preview-style token

The token crosses four boundaries. All four must accept it, and the existing two tokens must behave
exactly as before (FR-008).

## Single definition — a new leaf package

The token union and its value list are defined **once**, in a new zero-dependency package
`packages/primitives`:

```ts
// packages/primitives/src/preview-style.ts
export type PreviewStyleValue = 'asciidocollab' | 'asciidoctor' | 'print';
export const PREVIEW_STYLE_VALUES: readonly PreviewStyleValue[];
export function isPreviewStyleValue(value: string): value is PreviewStyleValue;
```

### Why a new package rather than an existing one

No existing package can hold it. `domain` may depend on nothing but `asciidoc-core`; `apps/web` does
not depend on `domain` at all; `shared` and `domain` are siblings that import neither. The only
pre-existing package all three can reach is `asciidoc-core` — and that is chartered as the **AsciiDoc
language kernel**, which a preview-style UI token plainly is not. Putting it there would be the
second non-language rule in that package and would leave its charter describing something it no
longer is.

### Why the package earns its keep

It is not a package for one union. The same duplication pattern already exists, unfixed, for **three**
closed value sets that both rings must agree on — one of which the code itself documents as a mirror:

| Value set | Domain | Shared DTO | Web |
|-----------|--------|-----------|-----|
| Preview style | `value-objects/editor/preview-style.ts:6` | `editor-preferences.dto.ts:12` | `preview-style-control.tsx:6` |
| Editor theme | `value-objects/editor/editor-theme.ts:5` | `editor-preferences.dto.ts:6` | `use-editor-preferences.ts:18` |
| Spellcheck language | `constants/editor-preferences.ts:17` | `editor-preferences.dto.ts:23` — *"mirrors the domain's SPELLCHECK_LANGUAGES"* | — |

`packages/primitives` is the home for all three. **This feature moves only the preview-style
token**, because that is the one it touches; the other two are named here as the obvious next tenants
so the package's purpose is legible, not so that this feature grows to include them.

### Charter

> **`@asciidocollab/primitives`** — primitive types and closed value sets that more than one ring
> must agree on, with no behaviour attached.

The name is deliberately generic because the need is: any leaf type that both the server ring and the
browser ring must share ends up in the same bind as the preview-style token. Three hard rules keep a
generic name from becoming a junk drawer, and they are testable:

| # | Rule |
|---|------|
| P1 | **Zero dependencies, permanently.** Its `package.json` has no `dependencies` block. Anything needing an import belongs elsewhere |
| P2 | **No behaviour.** Type aliases, `as const` value lists, and type-guard predicates only. No classes, no `Result`, no validation that produces errors, no I/O, no framework types |
| P3 | **Two rings or it does not belong.** A type used by only one ring stays in that ring. The entry criterion is that `domain` *and* something outside it both need it |

`PreviewStyle` — the `Result`-returning value object with `parse`/`parseOrDefault`/`default()` —
stays in `domain` under P2. Only the union, the value list and the membership guard move.

## Boundaries

Each boundary now *consumes* the single definition rather than restating it.

| Boundary | File | Change |
|----------|------|--------|
| Primitives | `packages/primitives/src/preview-style.ts` | **NEW** — the one definition, incl. `'print'` |
| Domain value object | `packages/domain/src/value-objects/editor/preview-style.ts` | type and value list imported; the `PreviewStyle` value object, `parse`/`parseOrDefault` and `default()` stay in domain |
| DTO | `packages/shared/src/dtos/editor-preferences.dto.ts` | inline union replaced by the imported type |
| API route | `apps/api/src/routes/auth/me/editor-preferences.ts` | schema derives its accepted values from the imported list |
| Web guard + control | `apps/web/src/components/preview-style-control.tsx` | local `PreviewStyleValue`/`OPTIONS` deleted; imports the list. `PREVIEW_STYLE_LABELS` stays in web — labels are presentation and are correctly app-owned |

**Wiring**: `packages/primitives` must be added as a `workspace:*` dependency **and** a tsconfig
project reference in `domain`, `shared`, `apps/web` and `apps/api`.

## Enforcement — via the existing architecture guard

No new check is written. `scripts/ci/architecture-guard.mjs` already enforces exactly this and
already runs in the quality gate (`scripts/ci/quality.sh:81`, job 1/8; `pnpm run architecture`
locally). It checks three things per layer — imports (bare *and* relative), declared
`dependencies`/`peerDependencies`, and tsconfig `references` — so a standing permission cannot hide
behind the absence of an import.

Registering the package is a config change to `onion.config.json`:

```jsonc
"layers": {
  "asciidoc-core":  "./packages/asciidoc-core/src",
+ "primitives":     "./packages/primitives/src",
  …
},
"rules": [
  { "from": "asciidoc-core",  "allowedImports": [] },
+ { "from": "primitives",     "allowedImports": [] },
- { "from": "domain",         "allowedImports": ["asciidoc-core"] },
+ { "from": "domain",         "allowedImports": ["asciidoc-core", "primitives"] },
- { "from": "shared",         "allowedImports": ["asciidoc-core"] },
+ { "from": "shared",         "allowedImports": ["asciidoc-core", "primitives"] },
- { "from": "api",            "allowedImports": ["domain", "infrastructure", "shared"] },
+ { "from": "api",            "allowedImports": ["domain", "infrastructure", "shared", "primitives"] },
- { "from": "web",            "allowedImports": ["shared", "asciidoc-core", "asciidoc-pdf"] },
+ { "from": "web",            "allowedImports": ["shared", "asciidoc-core", "asciidoc-pdf", "primitives"] },
  …
]
```

`"allowedImports": []` **is** rule P1, enforced by the mechanism that already enforces the same rule
for `asciidoc-core`: any workspace dependency, tsconfig reference or import added to `primitives`
later fails the gate. `apps/collab` is deliberately not granted access — if it ever needs the tokens,
that must be an explicit config change rather than a silent new edge.

**What this does and does not catch**

| | Covered |
|---|---|
| A workspace dependency added to `primitives` | ✅ declared-dependency check |
| A tsconfig reference added to `primitives` | ✅ references check |
| An import from `primitives` into any other layer | ✅ import scan |
| A consumer importing `primitives` without declaring it | ✅ — the import is governed, and an undeclared workspace dep would not resolve |
| An **external** (npm) dependency added to `primitives` | ❌ — `checkDeclarations` skips names that are not layers, so third-party deps are outside this guard for *every* layer, `asciidoc-core` included |

The external half of P1 therefore rides on the package shipping with no `dependencies` block and on
review. That is stated rather than implied, so nobody reads the guard as proving more than it does.
Closing it would mean a new per-rule flag in the guard, which is deliberately out of scope here.

**Ordering constraint**: `loadConfig` throws if a layer points at a missing directory, and throws
again if a layer has no rule. The `onion.config.json` change must therefore land in the **same
commit** as `packages/primitives/src` — it cannot be staged ahead of the package.

**Invariant**: after this change, `grep`ping the repository for `'asciidocollab'` as a type-union or
list member finds exactly one production definition. Adding a fourth style later touches one file.

**Persistence**: none required. `User.previewStyle` is `String @default("asciidocollab")` and already
admits the value.

## Behavioural contract

| # | Rule | Requirement |
|---|------|-------------|
| T1 | `PreviewStyle.parse('print')` succeeds | FR-002 |
| T2 | `PreviewStyle.parseOrDefault(x)` returns the default for any unrecognised `x`, unchanged | FR-009 |
| T3 | A stored `asciidocollab` or `asciidoctor` resolves exactly as before, and renders identically | FR-008, SC-010 |
| T4 | The default for a user who has never chosen remains `asciidocollab` | FR-008, FR-009 |
| T5 | The style control offers three options with the active one indicated, and the label for `print` is "Print" | FR-001 |
| T6 | Selecting `print` persists per-user and survives reload and document switch | FR-007 |
| T7 | One user's selection has no effect on a collaborator's view of the same document | Principle VII |

## Migration and compatibility

- No data migration. No default change. No existing row is written.
- Rolling back the feature leaves any user who selected `print` with a token the older code does not
  recognise; T2 means they fall back to the default rather than breaking. This is the existing,
  tested behaviour of `parseOrDefault` and needs no additional handling.

## The duplication this replaces

Before this change the union was defined **three** times, two of them in different packages — a P0
blocking violation (rule 4, "same type defined in multiple packages"):

| # | Location | Form | Now |
|---|----------|------|-----|
| 1 | `packages/domain/src/value-objects/editor/preview-style.ts:6,8` | `PreviewStyleValue` + `VALID_STYLES` | imports |
| 2 | `packages/shared/src/dtos/editor-preferences.dto.ts:12` | inline `'asciidocollab' \| 'asciidoctor'` | imports |
| 3 | `apps/web/src/components/preview-style-control.tsx:6,14` | second `PreviewStyleValue` + `OPTIONS` | deleted |

The duplication pre-dates this feature, but adding a third value to three hand-maintained lists would
have widened it — and this codebase has already been bitten by a two-copy rule drifting apart (the
theme-filename rule, which `packages/asciidoc-core/src/theme-file.ts` exists to de-duplicate for
exactly this reason: one copy lowercased the extension but not the suffix, so a file was a theme to
the editor and not to the renderer).

**Test consequence**: existing tests asserting a two-element list will fail. They must be corrected
by updating the expectation — **never** by weakening the assertion. Domain tests for `PreviewStyle`
keep testing `parse`/`parseOrDefault`/`default()`; only the source of the value list moves.
