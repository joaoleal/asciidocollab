# API Contracts: Grammar & Spelling Checking

REST routes under `apps/api/src/routes/grammar/`, registered in `di/routes.ts`; repositories wired in `di/repositories.ts` + `AppContainer['repos']` (`apps/api/src/index.ts`). DTOs + zod in `packages/shared/src/grammar/`. Auth mirrors existing project routes (session-based). All payloads are JSON; none carries document prose text (only accepted terms and privacy-hashed lint records).

## Project dictionary

### `GET /api/projects/:projectId/dictionary`
- **Auth**: any project member.
- **200**: `{ terms: string[] }` — all accepted terms for the project (for `importWords` on load).
- **403**: not a member. **404**: unknown project.

### `POST /api/projects/:projectId/dictionary`
- **Auth**: editor or owner.
- **Body**: `{ term: string }` — validated: trimmed, non-empty, `length ≤ 128`, no whitespace/control chars.
- **201**: `{ id, term, createdByUserId, createdAt }`. Idempotent on case-insensitive duplicate → **200** with the existing term.
- **400**: invalid term. **403**: insufficient role.
- **Side effect**: audit-log entry.

### `DELETE /api/projects/:projectId/dictionary/:termId`
- **Auth**: editor or owner.
- **204**: removed. **404**: unknown term. **403**: insufficient role.
- **Side effect**: audit-log entry.

## Ignored lints (per-user, per-document — private)

**Pinned shape**: one opaque blob per (user, document). The blob is exactly the harper.js `exportIgnoredLints()` output (a privacy-hashed JSON string) and is fed back verbatim to `importIgnoredLints()` on load. Full-replace semantics — the client owns the authoritative set in its worker and writes the whole blob after each change. This deliberately does **not** parse the blob's internal structure (unstable, early-access) and does not depend on enumerating individual hashes.

### `GET /api/documents/:documentId/ignored-lints`
- **Auth**: authenticated user with access to the document (document → project membership verified in the use case); returns **only the caller's** record.
- **200**: `{ ignoredLintsJson: string }` — empty string when the caller has ignored nothing.

### `PUT /api/documents/:documentId/ignored-lints`
- **Auth**: authenticated user (scoped to the caller's own record).
- **Body**: `{ ignoredLintsJson: string }` — full replace (upsert) of the caller's blob for this document.
- **200**: persisted. Never visible to other users. Never enters the Yjs doc.
- **Concurrency**: last-write-wins on the caller's own private blob (cross-device concurrent ignores are rare and never touch shared content). Revisit to per-hash append only if the `exportIgnoredLints` format is later confirmed stable and clobbering proves real.

*(Storage: one row per (userId, documentId) holding `ignoredLintsJson` — see data-model §2.)*

## Project grammar settings

### `GET /api/projects/:projectId/grammar-settings`
- **Auth**: any member.
- **200**: `{ enabled: boolean, dialect: 'en-GB' | 'en-US' | null, languageIsEnglish: boolean }`.
- May be folded into the existing `GET …/render-config` + project `language` rather than a new route — **preferred** to reuse `use-project-render-config`. This route documents the logical contract regardless of physical endpoint.

### `PUT /api/projects/:projectId/grammar-settings`
- **Auth**: editor or owner.
- **Body**: `{ enabled?: boolean, dialect?: 'en-GB' | 'en-US' }`.
- **200**: updated settings. **403**: insufficient role. **409/400**: dialect set while language is non-English (reject or ignore per FR-023).
- **Side effect**: audit-log entry. Physically: `enabled` → `ProjectRenderConfig.config.grammarCheckEnabled`; `dialect` → project language/dialect field.

## Rate limiting (deliberate per-route decision — Security Constitution §API & Integration Security)

The global limiter runs `global: false`; the decision is recorded here so it is not silently omitted.

| Route | Decision | Justification |
|-------|----------|---------------|
| `GET …/dictionary` | **No dedicated limit** | Authenticated, project-scoped, bounded read (a project's accepted-term list is small — hundreds of short strings — and cached client-side, fetched ~once per editor load). Low amplification. |
| `POST` / `DELETE …/dictionary[/:termId]` | **No dedicated limit** | Authenticated editor/owner writes, cheap, bounded by project membership; each is a single small row. |
| `GET` / `PUT …/ignored-lints` | **No dedicated limit** | Authenticated, per-user, single small private blob; not user-facing bulk or fan-out. |
| `GET` / `PUT …/grammar-settings` | **Inherits render-config policy** | Folded into the existing project render-config route, whose rate-limit decision already applies. |

**Guardrail**: if any of these is later exposed to unauthenticated callers, made expensive, or turned into a fan-out/bulk read, it MUST switch to a configurable limit — a `rateLimitMax` + `rateLimitWindow` pair in `apps/api/src/config/schema.ts` bound to env vars — and the route contract MUST document the limit and its `429` response. No hardcoded literal limits.

## Validation authority

All term/dialect validation lives in `packages/shared/src/grammar/grammar-config.ts` (zod), mirroring `render-config/config.ts` as the single validation authority reused by both API and web. No parallel validation path.

## Non-goals (explicitly not endpoints)

- No endpoint accepts or returns document prose. Linting is entirely client-side (Principle X).
- Diagnostics, counts, and tooltips are never sent to or stored on the server.
