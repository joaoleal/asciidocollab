# UI Contract: Clone from the Projects Dashboard

**Feature**: 047-project-clone

## Project card menu — `apps/web/src/components/project-card.tsx`

Today the overflow menu renders only when `project.role === "owner"` (line 22). That gate moves from
the menu to its items.

| Item | Shown to | Destination |
|---|---|---|
| Members | owner only | `/dashboard/projects/:id/members` — refuses non-owners, so it must not be offered to them |
| Settings | owner only | `/dashboard/projects/:id/settings` — `getProjectAccess(id, "owner")` refuses non-owners, so it must not be offered to them either |
| Clone | every role | opens the clone dialog |

**Settings was corrected from "every role" during implementation.** The original row rested on
research R8's claim that the settings page admits any member and hides its owner-only section. The
*section* filtering is real, but the *page* gate is `getProjectAccess(id, "owner")` and redirects
non-owners to `/403`. See the amendment under FR-001c in spec.md for the full reasoning and for why
relaxing that gate was deferred rather than adopted.

A viewer's menu therefore contains Clone alone. That is still a change from today, where a viewer
gets no menu at all.

FR-001c states the invariant behind the table: **the menu must not offer an item whose destination
would then refuse the user.**

The same component backs the archived view (`dashboard/archived/page.tsx:80`), so archived projects
get the menu and Clone with no separate work (FR-004).

Accessibility and theming carry over unchanged: the existing trigger keeps its
`aria-label="Project options"` and `stopPropagation` (the card is a stretched link), and the dialog
uses the existing token-driven dialog primitives (Principle V).

## Clone dialog

**Opens with**: a name field pre-filled with a suggestion derived from the source name (`Copy of
<name>`, truncated to 100 characters), selected so typing replaces it.

**States**

| State | Behaviour |
|---|---|
| idle | Clone enabled when the name is non-empty after trimming |
| invalid | inline message; Clone disabled; nothing sent (FR-003) |
| pending | indeterminate busy indicator; Clone disabled — this both shows progress and prevents double submission (FR-022) |
| error | dialog stays open with the name preserved, showing the server's message; the user can retry |
| success | dialog closes (FR-025) |

**On success** the user stays on the dashboard, the list refreshes to include the new project without
a page reload, and a confirmation names it and offers a direct action to open it (FR-025).

The refresh inserts the **response body directly** — no follow-up fetch. That only works because the
API contract pins the 201 body to the same full `ProjectDto` the list route emits, including
`owners`, `memberCount`, `fileCount` and `role`. `ProjectCard` renders the member and file counts in
its footer, so a narrower body would produce a card with blank counts. If the response shape is ever
narrowed, this insert must become a refetch — the two are a single decision, not two.

**Error copy** is driven by the response code:

| Code | Message |
|---|---|
| `CLONE_IN_PROGRESS` | a clone is already running; wait for it to finish |
| `RATE_LIMITED` (429) | too many clones recently; try again later |
| `LIVE_CONTENT_UNAVAILABLE` | names the file whose current content could not be read, and invites a retry |
| `FORBIDDEN` | no longer have access to that project |
| `VALIDATION_ERROR` / `CLONE_FAILED` | the server's message |

## Client API — `apps/web/src/lib/api/projects.ts`

```ts
async clone(id: string, name: string): Promise<{ data: Project }>
```

`Project` here is the existing web-side type in that file, structurally the shared `ProjectDto`.

Follows the existing `projectsApi` shape (`create`, `archive`, `restore`); no new transport concerns.
