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
| Live content unavailable (FR-009a) | Open a document in the source in another browser so a session is live, stop the collab container, then clone. Expect a 503 naming that file, and **no new project** anywhere in the list. |
| One clone at a time (FR-027) | Start a clone of a large project, then fire a second from another tab. Expect 409 `CLONE_IN_PROGRESS`, and the first clone unaffected. |
| Non-member (FR-002, FR-026a) | `POST /api/projects/<some other user's project>/clone` → 403, identical to the response for a project id that does not exist. Then confirm an `authz.denied` entry was recorded against the source project. |
| Rate limit | Exceed `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX` (default 20/hour) → 429. Set it to 1 locally to test without cloning twenty times. |
| Nothing visible on failure (FR-024) | Provoke a storage error mid-clone. Nothing appears in the project list, and the clone's directory is gone from project storage (FR-024a). |
| Abrupt stop (FR-024b) | Kill the API mid-clone. Nothing appears in the project list and no project can be opened — but expect the partial directory to still be on disk. That residue is unreachable and deliberately not reclaimed; see the spec's Out of Scope. |

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

## Definition of done

Beyond the tasks themselves, the constitution's End-of-Feature Verification applies: full
lint / typecheck / unit / integration / security / e2e sweep, then `/code-review` repeated until it
returns zero findings. The security scan and the Docker-gated jobs are part of the gate — a skipped
check is not a pass.
