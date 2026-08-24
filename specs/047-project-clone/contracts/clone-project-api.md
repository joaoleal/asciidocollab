# API Contract: Clone Project

**Feature**: 047-project-clone

## `POST /api/projects/:projectId/clone`

Creates an independent copy of `:projectId` owned by the caller. Synchronous: the response is sent
only once the clone has fully succeeded or fully failed (FR-022).

**Module**: `apps/api/src/routes/projects/clone.ts`, following the repository convention that heavy,
rate-limited project routes get their own module under `routes/projects/` (as `download.ts`,
`refactoring.ts`, `render-config.ts` and `main-file.ts` do), leaving `routes/projects.ts` for plain
CRUD. Registered with `preHandler: [requireAuth]`.

### Rate limit

Cloning copies an entire project per request, so it is an amplifying route and MUST be limited. The
limit is configuration-driven, never a literal:

| Config key | Env var | Default |
|---|---|---|
| `project.clone.rateLimitMax` | `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX` | `20` |
| `project.clone.rateLimitWindow` | `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_WINDOW` | `3_600_000` (1 hour) |

Declared in `apps/api/src/config/schema-project.ts` alongside the existing `mainFile`,
`renderConfig`, `refactoring` and `search` pairs, and consumed as
`config: { rateLimit: { max: app.config.project.clone.rateLimitMax, timeWindow: ... } }`.

The default is deliberately below `refactoring`'s 60/hour: a clone is the heaviest project operation
in the system. FR-027's one-at-a-time rule bounds *concurrent* cost; this bounds *sustained* cost.

### Request

```http
POST /api/projects/3f7c.../clone
Content-Type: application/json

{ "name": "Handbook 2027" }
```

Fastify schema: `name` is a required string, `minLength: 1`, `maxLength: 100`. The domain still
validates through `ProjectName.create` — the schema is the boundary check, not the authority.

### Responses

#### `201 Created`

The body is a complete `ProjectDto`, field-for-field identical to an element of `GET /api/projects`'s
`data` array (`apps/api/src/routes/projects.ts:100-115`), so the dashboard can insert the card
directly without a follow-up fetch (FR-025).

```json
{
  "data": {
    "id": "9b2e...",
    "name": "Handbook 2027",
    "description": "Team handbook",
    "owners": [{ "userId": "4a1c...", "displayName": "Ada Lovelace" }],
    "tags": ["handbook"],
    "rootFolderId": "77f0...",
    "mainFileNodeId": "1d3b...",
    "language": "en",
    "archivedAt": null,
    "memberCount": 1,
    "fileCount": 42,
    "role": "owner",
    "createdAt": "2026-08-22T10:15:00.000Z",
    "updatedAt": "2026-08-22T10:15:00.000Z"
  }
}
```

Most fields are known to the clone directly. Two are not: `owners[].displayName`, which the route
resolves via `repos.user.findById` exactly as the list route does; and `memberCount` / `fileCount`,
which MUST be derived the same way the list route derives them rather than assumed from what the
clone just wrote — the point of this contract is that the two shapes cannot drift. `owners` is always the
single cloning user, `memberCount` is always `1`, `role` is always `"owner"`, and `archivedAt` is
always `null` (FR-015).

**Note on a pre-existing inconsistency**: `POST /api/projects` (create) returns a *different*,
narrower shape — it omits `owners`, `archivedAt` and `role`, and adds nothing in their place
(`routes/projects.ts:234-243`). This contract deliberately matches the **list** shape, not create's,
because the UI contract inserts the response into the list. Aligning create is out of scope here.

#### Errors

| Status | Code | When | Requirement |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | name empty after trimming, or over 100 characters | FR-003 |
| 403 | `FORBIDDEN` | caller is not a member of `:projectId` — **also when the project does not exist** | FR-002 |
| 409 | `CLONE_IN_PROGRESS` | caller already has a clone running | FR-027 |
| 429 | `RATE_LIMITED` | the caller exceeded the clone rate limit above | security constitution |
| 503 | `LIVE_CONTENT_UNAVAILABLE` | a document's live content could not be read; `details.path` names it | FR-009a |
| 500 | `CLONE_FAILED` | anything else; cleanup has already run | FR-024 |

`403` for a missing project is deliberate: a `404` would confirm the project exists to a
non-member. It falls out of ordering the membership check first, before any project lookup.

Every non-2xx response guarantees no visible or accessible project was created.

```json
{ "error": { "code": "LIVE_CONTENT_UNAVAILABLE",
             "message": "Could not read the current content of /chapters/intro.adoc",
             "details": { "path": "/chapters/intro.adoc" } } }
```

**Constraint on `details.path` and on the message** — this is a security boundary, not a formatting
preference. The value MUST be the **project-relative `FileNode.path`** of the source document: a path
the caller can already see in that project's file tree, and which reveals nothing about server
storage. It MUST NOT be a `ProjectFileStore` `FilePath`, whose port documents it as "the absolute
path of the file within the project" and which is resolved against the storage root. No other error
in this contract carries a path.

This is the narrow, reviewed exception to the rule that domain errors expose no file paths: FR-009a
requires the user to learn *which* document blocked the clone, and a path they already have read
access to is the only way to say it usefully.

### Authorization

Membership in the source project at **any** role — viewer, editor or owner (FR-001). This is a
deliberate widening: a viewer ends up owning a full copy of content they could previously only read.
It grants no new access to the source.

The check lives in the use case, not the route (`recordAuthorizationDenial` is invoked there); the
route only maps `PermissionDeniedError` to `403`.

### Side effects

| Event | Where | When |
|---|---|---|
| `project.cloned` | the new project | success; metadata names the source project id |
| `project.clone_requested` | the source project | success — records that `A` read its content (FR-026) |
| `authz.denied` | the source project | a refused request; actor, resource and reason (FR-026a) |

No change of any kind to the source project's content, settings or membership (FR-007).
