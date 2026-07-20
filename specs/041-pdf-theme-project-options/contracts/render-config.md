# Contract: Render Config — Extension Selection

**Feature**: 041-pdf-theme-project-options

Extension selection rides the **existing** `ProjectRenderConfig` surface. No new endpoint, no new
table, no migration — `project_render_configs.config` is an opaque JSON blob.

---

## Schema addition

`packages/shared/src/render-config/config.ts` — `renderConfigSchema` is `.strict()`, so the new key
**must** be declared there or every save fails validation.

```
extensions?: {
  enabled?: string[]                  // catalogue entry ids
}
```

Identifiers only. Every extension's code comes from the deployment, so a project's stored selection is
a list of names and can carry nothing executable.

**Validation**

- `enabled` entries referencing an unknown id are **surfaced, not dropped** (FR-030) — so
  normalisation must not silently filter them. This is the path exercised when an administrator
  removes an extension that projects still have enabled.
- An id MUST NOT be interpreted as a path. Resolution is a lookup against the catalogue, never a
  filesystem join — otherwise the selection becomes a way to name arbitrary files.
- Resolution order is deterministic: sort by id (FR-031c).
- `PINNED_ATTRIBUTE_KEYS` discipline is unchanged; extensions MUST NOT become a route to setting pinned
  attributes such as `pdf-themesdir` or `pdf-fontsdir`.

---

## Endpoints — unchanged

```
GET /api/projects/:projectId/render-config   → { data: RenderConfig }
PUT /api/projects/:projectId/render-config   → { data: RenderConfig }
```

`PUT` remains a **full replace** (`apps/api/src/routes/projects/render-config.ts`), validated by
`safeNormalizeRenderConfig`, rate-limited, audit-logged.

### The FR-006 hazard

Because `PUT` is a full replace and `RenderConfig` is one flat object spanning document, page, font,
image, custom-attribute **and now extension** settings, a sectioned settings page that PUTs only the
current section's keys **wipes every other section**.

**Contract for the client**: all sections share one `RenderConfig` draft; every save sends the merged
whole. The response must re-seed **all** sections' drafts, or a stale draft clobbers on the next save.

Server-side PATCH/merge semantics were considered and rejected for now (research R11) — a wider change
to route, use case and audit entry for no user-visible benefit. Revisit only if sections ever need
genuinely independent saves.

---

## Audit

Enabling or disabling extensions is audit-logged with who changed it and which entries were affected
(FR-032). No content digest is needed — the selection references deployment code by identifier, so
there is no project-authored content whose approval would have to be pinned.

---

## Snapshot propagation

`ProjectSnapshot` (`packages/asciidoc-pdf/src/protocol.ts`) gains the resolved enabled extensions so
the worker can load them. Built in `apps/web/src/lib/pdf/build-project-snapshot.ts` alongside the
existing `themePath` / `bibPath` resolution.

Extension **code** does not travel in the snapshot at all — the worker loads it from the shipped gem or
from the deployment's served extension folder. The snapshot carries only the resolved list of enabled
identifiers.

Note that `populateProject` writes every key of `snapshot.files` to `/project/<key>` with no extension
allowlist (research R7), so a project's `.rb` file *is* mounted — it is simply never loaded. That is
the whole of FR-035: the file is inert data, exactly as Principle IX requires.
