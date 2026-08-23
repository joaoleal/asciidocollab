# Quickstart: Project Cloning

**Feature**: 047-project-clone

## Orientation — read these first

| File | Why |
|---|---|
| `packages/domain/src/use-cases/project/create-project.ts` | The shape a new project must end up in: project row, root folder, owner membership, audit entry. The clone reproduces it with copied values instead of defaults. |
| `packages/domain/src/use-cases/project/download-project.ts` | The closest existing read of a whole project — membership check, all FILE nodes, per-file content resolution. |
| `packages/domain/src/use-cases/project/download-content-source.ts` | The resolver this feature generalizes (research R2). |
| `packages/domain/src/use-cases/project/delete-project.ts` | The cleanup pattern the failure path reuses — but only two of its three steps: `projectRepo.delete` + `fileStore.removeProject`. **Not** `yjsStateStore.deleteAllForProject`: a clone never persists Yjs state (research R3), so there is nothing to remove. |
| `apps/collab/src/extensions/persistence.ts` | Why the clone writes bytes and no Yjs state (research R3) — `onLoadDocument` seeds a room from the file when no state exists. |
| `apps/web/src/components/project-card.tsx` | The menu whose `canManage` gate moves from the menu to its items. |

## Running the stack

```bash
pnpm install
scripts/dev.sh                 # API + web + collab + Postgres
```

Two traps that have cost time on this repo before:

- **Do not run `next build` while the dev stack is up.** It shares `.next` with `next dev` and has
  blown up to hundreds of processes and >12 GB. Stop the stack first.
- **After any schema change, clean-rebuild the API.** An incremental no-op build leaves a stale
  `apps/api/dist`, and project pages start 404-ing with no useful error. This feature needs no
  migration, so it should not bite — but it is the first thing to check if project routes vanish.

## Verifying by hand

1. Sign in as user A, create a project with a folder, an `.adoc` file with an `include::` and an
   image reference, and the image itself. Set a main file. Change a PDF setting. Add a dictionary
   term.
2. Invite user B as **viewer**. Add a review comment.
3. As **B**, open the dashboard. The project card must now show an overflow menu (it did not before)
   containing **Clone** and nothing else — **not** Members, and **not** Settings. Both of those land
   on pages that admit owners only, and the menu must never offer a destination that then refuses the
   user. (Settings was originally listed here for every role; see the FR-001c amendment in spec.md
   for why that was wrong and what was done about it.) Sign in as **A** and confirm the owner's menu
   holds all three.
4. Clone it as "B's copy". B stays on the dashboard, the new card appears without a reload, and the
   confirmation offers to open it.
5. In the clone, confirm: B is owner and the only member; the tree matches; the document opens in the
   editor **with its content** (not blank — this is the failure mode research R3 warns about); the
   include and the image resolve; the main file is set; the PDF setting and the dictionary term
   carried over; there are **no review comments**.
6. Edit a file in the clone. Confirm the source is unchanged, and vice versa.

### Exercising the failure paths

| Path | How |
|---|---|
| Live content unavailable (FR-009a) | Open a document in the source in another browser so a session is live, then stop the collaboration server and clone. Expect a 503 naming that file, and **no new project** anywhere in the list. Locally the collaboration server is a host process, not a container — `dev.sh` and both e2e stacks run `apps/collab/dist/index.js` directly, so stop it by port (it holds the public websocket port and the internal edit port; the API holds its own internal port). Only the production compose file has a collab container. |
| One clone at a time (FR-027) | Start a clone of a large project, then fire a second from another tab. Expect 409 `CLONE_IN_PROGRESS`, and the first clone unaffected. Automating this needs care — see the caution about serialized request contexts below. |
| Non-member (FR-002, FR-026a) | `POST /api/projects/<some other user's project>/clone` → 403, identical to the response for a project id that does not exist. Then confirm an `authz.denied` entry was recorded against the source project. |
| Rate limit | Exceed `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX` (default 20/hour) → 429 with code `RATE_LIMITED`. Set it to 1 locally to test without cloning twenty times — and **restart the API**, because the limit is read once at startup. |
| Nothing visible on failure (FR-024) | Provoke a storage error mid-clone — making the storage root read-only for the duration of the request is enough. Expect 500 `CLONE_FAILED`; nothing appears in the project list, and the clone's directory is gone from project storage (FR-024a). |
| Abrupt stop (FR-024b) | Kill the API mid-clone. Nothing appears in the project list and no project can be opened — a 403, the same answer a stranger gets. **Whether a directory is left on disk depends on when the stop lands**, and both outcomes are correct: killed during the file-tree phase, the copy leaves a project row with no members and *no directory at all*; killed once content is being written, the partial directory remains. Either way the row has zero `ProjectMember` rows, which is what makes it unreachable. That residue is deliberately not reclaimed; see the spec's Out of Scope. |

## Testing

```bash
pnpm --filter @asciidocollab/domain test          # use case against in-memory fakes
pnpm --filter @asciidocollab/infrastructure test  # registry + repos (testcontainers Postgres)
pnpm --filter @asciidocollab/api test             # route + error mapping
pnpm --filter @asciidocollab/web test             # dialog, card menu, api client
pnpm e2e:local                                    # full stack
```

Cautions that apply to this repo:

- **Cap Jest workers.** The default here is 23 workers on 24 cores with no swap, and each API suite
  starts its own Postgres container. Cap workers and run under a memory-limited scope.
- **`e2e-local.sh` is not concurrent-safe.** A second run tears down the first — they share one
  Compose project name.
- **e2e specs share one account**, and editor preferences are per-account, so a spec that changes a
  preference leaks into later specs. The clone spec should not touch preferences.
- **Playwright's request contexts do not race.** `page.request` — and separate `request.newContext()`
  contexts too — dispatch one fetch at a time, so two "concurrent" clone posts leave one after the
  other has finished. Both then return 201 and the one-clone-at-a-time check reads as a missing
  guard when the guard is fine. Use Node's own `fetch`, or separate processes, when the point of the
  check is that two requests overlap.
- **e2e specs also share the clone rate limit.** It is 20 per hour per user in production and the
  window does not reset inside a run, so the suite exhausts it. All four e2e scripts raise
  `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX`, as they already do for every other limit. The
  production default is deliberately left alone — if a clone spec starts failing on an assertion
  about a copy that was never made, check the dialog for "too many clones recently" before
  suspecting the clone itself.
- **An AI agent running the testcontainer suites needs explicit consent.** Prisma ≥7.9 refuses the
  `prisma db push --accept-data-loss` that `startTestContainer` shells out to when it detects an
  agent driving it, so `@asciidocollab/infrastructure` and `@asciidocollab/api` fail wholesale with
  what looks like a database outage. The target is a throwaway container on a random port, but the
  consent is the user's to give: disclose the command and what it destroys, ask, then pass their
  reply verbatim as `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` on the command line only — never
  in a file, a script, or committed config.

## Definition of done

Beyond the tasks themselves, the constitution's End-of-Feature Verification applies: full
lint / typecheck / unit / integration / security / e2e sweep, then `/code-review` repeated until it
returns zero findings. The security scan and the Docker-gated jobs are part of the gate — a skipped
check is not a pass.
