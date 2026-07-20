# Contract: PDF Extension Catalogue API

**Feature**: 041-pdf-theme-project-options

Resolves the catalogue's layer ownership. Written after an architecture review found the catalogue
unassigned, which had produced a cross-package DTO outside `packages/shared`, assembly logic in a
route handler, filesystem access with no port, and two competing delivery paths.

---

## Layering

```
apps/api/src/routes/projects/pdf-extensions.ts     thin route — validate, delegate, map errors
        ↓
GetPdfExtensionCatalogueUseCase                    packages/domain/src/use-cases/project/
        ↓
PdfExtensionSourcePort                             packages/domain/src/ports/pdf-extensions/
        ↓
filesystem adapter                                 packages/infrastructure/src/persistence/pdf-extensions/
        ↓
/data/pdf-extensions                               bind-mounted, outside the image
```

The route holds **no** assembly logic and **no** permission check of its own — both live in the use
case (Architecture Constitution §Business Logic Placement, P0 rule 2; Security Constitution
§Authentication & Authorization).

Types come from `packages/shared/src/pdf-extensions/`. No package redeclares them.

---

## Endpoints

```
GET /api/projects/:projectId/pdf-extensions
    → { data: PdfExtensionCatalogueEntry[] }

GET /api/projects/:projectId/pdf-extensions/:extensionId/source
    → Ruby source, text/plain
```

**Authorization**: project membership, enforced in the use case. A non-member receives 403 — the same
shape the existing render-config routes return.

**Validation**: Fastify schema-first for params and responses, matching
`apps/api/src/routes/projects/render-config.ts` (Architecture Constitution §Technology Mandates).
`:extensionId` is validated against the catalogue by lookup — **never** joined onto a filesystem path,
or the id becomes a traversal vector.

**Rate limiting** — recorded decision, per Security Constitution §API & Integration Security (a
forgotten decision is the violation; an explicit justified one is compliant). **Both routes are
limited:**

| Route | Decision | Reason |
|---|---|---|
| `GET …/pdf-extensions` | **Limited** — 120 / hour | Same shape and cost profile as `GET …/render-config`, which uses the same budget. Each request may fan out into a directory scan, so it amplifies load even though it is authenticated. |
| `GET …/pdf-extensions/:id/source` | **Limited** — 240 / hour | Serves file bytes and is fetched once per enabled extension per render, so the budget is higher than the catalogue read while still bounded. |

An earlier draft left the catalogue read unlimited on the grounds that it was "bounded by a small
on-disk directory". Nothing bounded that directory — the bounds below now exist, and the limit is kept
regardless, because a per-request filesystem scan is amplification whichever way the directory is
sized.

---

## Configuration

All values configurable, none hardcoded (Security Constitution §API & Integration Security; the
`storage.path` precedent in `apps/api/src/config/schema-storage.ts` covers the directory).

Added to `apps/api/src/config/schema-project.ts` under `pdfExtensions`, following the existing
interface + convict-block convention (`doc`, `format`, `default`, `env`):

| Key | Env | Default | Purpose |
|---|---|---|---|
| `path` | `ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH` | `/data/pdf-extensions` | Administrator drop-folder. Bind-mounted, outside the image (FR-033b) |
| `maxExtensions` | `…_PDF_EXTENSIONS_MAX` | `50` | Cap on catalogue entries; beyond it the scan stops and reports |
| `maxSourceBytes` | `…_PDF_EXTENSIONS_MAX_SOURCE_BYTES` | `262144` | Per-file cap (256 KiB); a larger file is excluded and reported |
| `scanCacheTtl` | `…_PDF_EXTENSIONS_SCAN_CACHE_TTL` | `30000` | How long a scan is reused. Bounds "takes effect without a redeployment" (FR-033b) to ≤30s while keeping repeated reads cheap |
| `rateLimitMax` | `…_PDF_EXTENSIONS_RATE_LIMIT_MAX` | `120` | Catalogue read budget |
| `rateLimitWindow` | `…_PDF_EXTENSIONS_RATE_LIMIT_WINDOW` | `3600000` | Catalogue read window (1 hour) |
| `sourceRateLimitMax` | `…_PDF_EXTENSIONS_SOURCE_RATE_LIMIT_MAX` | `240` | Source read budget |
| `sourceRateLimitWindow` | `…_PDF_EXTENSIONS_SOURCE_RATE_LIMIT_WINDOW` | `3600000` | Source read window (1 hour) |

`maxExtensions` and `maxSourceBytes` are what make the scan bounded work rather than
attacker-influenced work, and `scanCacheTtl` is what makes FR-033b's "without a redeployment" a
stated interval rather than a vague promise.

Documented in `CONFIGURATION.md` alongside the existing storage and collaboration sections.

---

## Behaviour

- A malformed or unloadable manifest is **excluded and reported**, never fatal to the response
  (FR-033d).
- Two entries declaring the same id are reported as a conflict; neither silently wins (FR-033e).
- Entries are returned in deterministic order by id (FR-031c, Principle XII).
- `available: false` marks an id a project still has enabled but the deployment no longer offers
  (FR-030) — the case that arises when an administrator removes an extension.

## Errors

Typed domain errors mapped by Fastify's existing handler. No filesystem paths, no internal state in
any client-facing message (Security Constitution §Secure-by-Design Patterns) — an administrator's
directory layout must not leak to project members.
