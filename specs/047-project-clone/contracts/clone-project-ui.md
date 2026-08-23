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

**On success** the user stays where they were, and a confirmation names the copy and offers a direct
action to open it (FR-025). On the active dashboard the listing gains the new card without a page
reload. The **archived** listing deliberately does not gain it: the copy is active, so it does not
belong in a list of archived projects, and there the confirmation is the only direct route to a
project that will never appear below it.

**Two attempts can be on screen at once.** The busy dialog is dismissable, so a user may close one
mid-copy and start another before the first answers. A copy that lands always reports to the page —
that is how the listing and the confirmation are fed — whereas a *failure* reports to the page only
when the dialog that would have shown it has already been dismissed. Each page therefore keeps a
confirmation and a refusal as two **independent single-slot** notices, governed entirely by
this table:

| Event | Confirmation | Refusal |
|---|---|---|
| a new attempt starts | left standing | cleared |
| a copy lands | replaced by the new copy | left standing, unless it said a clone was still running |
| an attempt is refused | left standing | replaced by the new reason |
| the user presses Dismiss | left standing | cleared |

Each notice is displaced only by a newer notice of its own kind. The exceptions in the table are
deliberate, and each has a reason:

- **A refusal is cleared when a retry starts**, because leaving it beside a running copy reads as
  though the retry has already failed.
- **A confirmation is never cleared by a refusal or by a start.** It is not the status of an attempt
  — it names a project that exists and links to it. A refusal aimed at one attempt says nothing
  about a copy another really made, and clearing it when a new attempt begins would blank the page
  whenever that attempt then failed inside its own still-open dialog, since such a failure never
  reaches the page. On the archived listing that would strand the copy outright, the confirmation
  being its only route to it.
- **A landing copy retires a `CLONE_IN_PROGRESS` refusal**, and only that one. Clones are serialised
  per user, so when two attempts overlap the second is usually refused with exactly this reason —
  whose entire content is "the other clone is still running", and whose falsifier is that clone
  finishing. Every other reason (`LIVE_CONTENT_UNAVAILABLE`, `FORBIDDEN`, `RATE_LIMITED`,
  `VALIDATION_ERROR`, `CLONE_FAILED`) stays true after an unrelated copy lands, and stays on screen.

Because both notices are single-slot, three or more overlapping attempts can show only the most
recent outcome of each kind. That is a known limit, not an oversight: with clones serialised per
user, at most one attempt is doing work at a time. The same bound makes the retirement above
slightly eager — with three attempts outstanding, a copy landing retires a `CLONE_IN_PROGRESS`
refusal even though a third copy may still be running. Retiring a true notice early is accepted in
exchange for never leaving a false one up.

**The refusal notice carries a Dismiss control**, and the retirement rule is why. It reaches only a
refusal already on screen when the copy lands. In the opposite order — the copy lands first, its
refusal arrives after — the page cannot tell a stale claim from a true one: the clone registry is
per user across the whole API process, so a clone running in *another tab* refuses this one with the
same code and the same words. Suppressing the refusal whenever a confirmation stands was considered
and rejected: it would trade a rare stale notice for a rare silent one, and a user who pressed Clone
and was refused must not be told nothing at all. Showing it and letting the user clear it hides no
truth in either direction. Dismissing a refusal never touches the confirmation.

The refresh inserts the **response body directly** — no follow-up fetch. That only works because the
API contract pins the 201 body to the same full `ProjectDto` the list route emits, including
`owners`, `memberCount`, `fileCount` and `role`. `ProjectCard` renders the member and file counts in
its footer, so a narrower body would produce a card with blank counts. If the response shape is ever
narrowed, this insert must become a refetch — the two are a single decision, not two.

**One field may legitimately be absent.** The copy is committed before it is described, so a read
that fails while describing it must not turn a clone that succeeded into an error. Owner display
names absorb their own failure and come back empty. If the reads behind the counts fail, the route
still answers 201, stating `memberCount: 1` and `role: "owner"` — known by construction, the owner
membership row being the clone's commit point — and **omitting `fileCount` entirely**. `fileCount`
is optional on `ProjectDto` precisely so "unknown" can be said, and `ProjectCard` drops the chip when
it is absent. Reporting `0` instead would render a confident wrong number on a project that was
copied whole, which is worse than the blank this paragraph warns about. The next listing supplies
the real count.

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
