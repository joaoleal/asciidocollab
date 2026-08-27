import { expect, test, type Locator, type Page } from '@playwright/test';
import type { GitProvider } from '@asciidocollab/shared';

/**
 * Shared harness for the git-repository-sync e2e specs.
 *
 * Every helper here drives the app the same way a real user would: clicks, typed input, and
 * assertions against what actually renders (visible text, aria-labels, testids, editor content).
 * Nothing in this file talks to `page.request`, the app's own `@/lib/api/*` client, or a `git`
 * binary — an "external collaborator" is simulated with a SECOND project connected to the SAME
 * remote/branch, driven through its own editor in a second browser context (see each spec's
 * `browser.newContext()` usage), never by mutating the remote out-of-band.
 *
 * ## Requires a real remote (env-gated, SKIPS rather than fails without it)
 * A handful of these specs (import, connect/initialize, pull, conflicts) need an actual git remote
 * reachable over the network — there is no in-process fake for "a git server" the way there is for
 * this app's own API. Point the suite at one with:
 *
 *   - `GIT_E2E_REMOTE_URL`      — an `https://` (or `git@`) URL of a REAL, reachable, and — for the
 *                                 tests that push to it — WRITABLE repository the token below can
 *                                 authenticate against. Use a disposable/test-only repository.
 *   - `GIT_E2E_REMOTE_TOKEN`    — a personal access token (or equivalent) with push access to it.
 *   - `GIT_E2E_REMOTE_PROVIDER` — optional; one of `github` | `gitlab` | `bitbucket`. Defaults to
 *                                 `github`.
 *
 * When either of the first two is unset, `requireRemote()` calls `test.skip(...)` — the affected
 * tests are reported SKIPPED, not failed, so the suite stays green in any environment (like this
 * one) that has no remote wired up, and starts actually exercising the flows the moment CI (or a
 * developer) provides one.
 *
 * `git-branches.spec.ts`'s local-branch-only assertions and the initialize spec's form-validation
 * test do not call `requireRemote()` — see each spec for which of its tests need a remote.
 */

// ─── Test remote config ──────────────────────────────────────────────────────────────────────────

/** The env-derived test remote config a spec needs before it can drive an import/connect/pull/etc. */
export interface GitTestRemoteConfig {
  /** Whether both `GIT_E2E_REMOTE_URL` and `GIT_E2E_REMOTE_TOKEN` are set. */
  readonly configured: boolean;
  /** The remote repository's URL. Empty string when not configured. */
  readonly remoteUrl: string;
  /** The plaintext token to authenticate with. Empty string when not configured. */
  readonly token: string;
  /** The git hosting provider the remote lives on. Defaults to `'github'`. */
  readonly provider: GitProvider;
}

/** Reads the test remote's config straight from the environment; never throws, never caches. */
export function getGitTestRemoteConfig(): GitTestRemoteConfig {
  const remoteUrl = process.env.GIT_E2E_REMOTE_URL ?? '';
  const token = process.env.GIT_E2E_REMOTE_TOKEN ?? '';
  const provider = (process.env.GIT_E2E_REMOTE_PROVIDER as GitProvider | undefined) ?? 'github';
  return { configured: remoteUrl.length > 0 && token.length > 0, remoteUrl, token, provider };
}

/**
 * Guards a test (or a step within one) on a configured test remote being available: skips the
 * CURRENTLY RUNNING test (reported as SKIPPED, not failed) when `GIT_E2E_REMOTE_URL`/
 * `GIT_E2E_REMOTE_TOKEN` are not both set, and otherwise returns the resolved config. Call this
 * first thing inside a `test(...)` body (or a `beforeEach`) — `test.skip` only has an effect while
 * a test is actually running.
 */
export function requireRemote(): GitTestRemoteConfig {
  const config = getGitTestRemoteConfig();
  test.skip(
    !config.configured,
    'Requires a real, reachable, writable test git remote: set GIT_E2E_REMOTE_URL and ' +
      'GIT_E2E_REMOTE_TOKEN (and optionally GIT_E2E_REMOTE_PROVIDER) to run this test.',
  );
  return config;
}

// ─── Provider radio group (shared by the import/connect/initialize dialogs) ─────────────────────

const PROVIDER_LABELS: Readonly<Record<GitProvider, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

/** Picks `provider` in a dialog's `role="radiogroup" aria-label="Git hosting provider"`. */
async function selectProviderInDialog(dialog: Locator, provider: GitProvider): Promise<void> {
  await dialog
    .getByRole('radiogroup', { name: 'Git hosting provider' })
    .getByRole('radio', { name: PROVIDER_LABELS[provider] })
    .click();
}

// ─── Project / file creation ──────────────────────────────────────────────────────────────────────

/**
 * Creates a project through `ProjectForm` at `/dashboard/projects/new`, follows the redirect to
 * `/dashboard`, opens the new project's card (matched by its exact accessible name, the card's
 * `aria-label={project.name}`), and returns the id captured from the resulting
 * `/dashboard/projects/<id>` URL. `name` should be unique per call (e.g. suffixed with
 * `Date.now()`) so the card lookup can never match an unrelated project.
 */
export async function createProjectViaUi(page: Page, name: string): Promise<string> {
  await page.goto('/dashboard/projects/new');
  await page.getByLabel(/Project Name/i).fill(name);
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });

  await page.getByRole('link', { name, exact: true }).click();
  await page.waitForURL(/\/dashboard\/projects\/[^/]+$/, { timeout: 15_000 });
  const match = page.url().match(/\/dashboard\/projects\/([^/?#]+)/);
  if (!match) throw new Error(`createProjectViaUi: could not extract a project id from ${page.url()}`);
  return match[1];
}

/**
 * Creates a file at the project root through the file tree's root "actions" menu (`New File` →
 * fill the dialog's name input → `Confirm`), and waits for the corresponding
 * `tree-node-<fileName>` node to appear. Must be called with the page already on a project's
 * editor route (e.g. straight after {@link createProjectViaUi}, which lands there).
 */
export async function createFileViaUi(page: Page, fileName: string): Promise<void> {
  await page.getByTestId('tree-root-actions').getByRole('button', { name: 'actions' }).click();
  await page.getByRole('menuitem', { name: 'New File', exact: true }).click();

  const dialog = page.getByRole('dialog').filter({ has: page.getByText('New File', { exact: true }) });
  await expect(dialog.getByText('New File', { exact: true })).toBeVisible({ timeout: 10_000 });
  await dialog.locator('input').fill(fileName);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  await expect(page.getByTestId(`tree-node-${fileName}`)).toBeVisible({ timeout: 10_000 });
}

// ─── Import ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens the dashboard's `Import from Git` dialog, fills the provider/remote URL/token/branch
 * fields, submits (`Start import`), and returns the id the app then redirects to
 * (`/dashboard/projects/<id>`). Assumes `page` is already signed in.
 *
 * Deliberately does NOT assert on the dialog's `Import succeeded — opening your project…` copy —
 * it is shown for exactly one tick before the dialog closes and navigates away, so asserting on it
 * races that navigation. The durable post-condition is the URL actually landing on the new
 * project, which is what this waits on instead.
 */
export async function importViaUi(
  page: Page,
  remote: GitTestRemoteConfig,
  options: { branch?: string } = {},
): Promise<string> {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Import from Git' }).click();

  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Import a repository') });
  await expect(dialog.getByText('Import a repository')).toBeVisible({ timeout: 10_000 });

  await selectProviderInDialog(dialog, remote.provider);
  await dialog.getByLabel('Remote URL').fill(remote.remoteUrl);
  await dialog.getByLabel('Access token').fill(remote.token);
  if (options.branch) await dialog.getByLabel('Branch (optional)').fill(options.branch);

  await dialog.getByRole('button', { name: 'Start import' }).click();
  await page.waitForURL(/\/dashboard\/projects\/[^/?#]+/, { timeout: 60_000 });

  const match = page.url().match(/\/dashboard\/projects\/([^/?#]+)/);
  if (!match) throw new Error(`importViaUi: could not extract a project id from ${page.url()}`);
  return match[1];
}

// ─── Connect / initialize (project settings page) ───────────────────────────────────────────────

/**
 * On `projectId`'s settings page, opens `Initialize & publish`, fills the provider/remote
 * URL/token/branch fields, submits, and waits for the connected view (`Disconnect` button
 * visible). Leaves the browser on the settings page — callers that need the editor next should
 * navigate/open a file explicitly (e.g. via `openFileInEditor`).
 *
 * Deliberately does NOT assert on the dialog's `Repository initialized and published.` copy — it
 * is shown for exactly one tick before the dialog closes, so asserting on it races that close. The
 * durable post-conditions are the dialog actually closing and the connected view appearing, which
 * is what this waits on instead.
 */
export async function initializeViaUi(
  page: Page,
  projectId: string,
  remote: GitTestRemoteConfig,
  branch: string,
): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}/settings?section=repository`);
  await expect(page.getByText('This project is not connected to a remote git repository.')).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole('button', { name: 'Initialize & publish' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Initialize a new repository') });
  await expect(dialog.getByText('Initialize a new repository')).toBeVisible({ timeout: 10_000 });

  await selectProviderInDialog(dialog, remote.provider);
  await dialog.getByLabel('Remote URL').fill(remote.remoteUrl);
  await dialog.getByLabel('Access token').fill(remote.token);
  await dialog.getByLabel('Branch (optional)').fill(branch);

  const submitButton = dialog.getByRole('button', { name: 'Initialize & publish', exact: true });
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 15_000 });
}

/**
 * On `projectId`'s settings page, opens `Connect to a remote`, fills the provider/remote
 * URL/token/(optional) branch fields, submits (`Connect`), and waits for the connected view
 * (`Disconnect` button visible). Leaves the browser on the settings page, same as
 * {@link initializeViaUi}.
 */
export async function connectViaUi(
  page: Page,
  projectId: string,
  remote: GitTestRemoteConfig,
  branch?: string,
): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}/settings?section=repository`);
  await expect(page.getByText('This project is not connected to a remote git repository.')).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole('button', { name: 'Connect to a remote' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Connect a remote repository') });
  await expect(dialog.getByText('Connect a remote repository')).toBeVisible({ timeout: 10_000 });

  await selectProviderInDialog(dialog, remote.provider);
  await dialog.getByLabel('Remote URL').fill(remote.remoteUrl);
  await dialog.getByLabel('Access token').fill(remote.token);
  if (branch) await dialog.getByLabel('Branch (optional)').fill(branch);

  const connectButton = dialog.getByRole('button', { name: 'Connect', exact: true });
  await expect(connectButton).toBeEnabled();
  await connectButton.click();

  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 15_000 });
}

// ─── Commit / push ────────────────────────────────────────────────────────────────────────────────

/** Locates the open `Commit changes` dialog. */
function commitDialogLocator(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.getByText('Commit changes') });
}

/**
 * Opens the editor header's `Commit…` dialog, waits for the just-made edit to appear as a staged
 * change, fills the commit message, and submits. Requires there to be at least one staged change —
 * for the "nothing staged" refusal case, drive the dialog directly instead (see
 * `git-commit-push.spec.ts`).
 *
 * `commit-dialog.tsx` fetches staged status exactly ONCE, when it opens — it never re-polls while
 * staying open. If the editor's debounced writeback has not yet flushed the just-typed edit into a
 * staged change by the time this first opens the dialog, "Nothing staged to commit." would never
 * disappear on its own. Rather than adding a direct API call here (which would race the
 * writeback's own flush through a different path), this polls for the staged change by
 * RE-OPENING the dialog until it shows up: `Escape` is a no-op here (the dialog explicitly
 * swallows it), so each retry closes via `Cancel` and reopens via `Commit…`, which re-mounts the
 * form and re-runs its on-open fetch. Uses a generous overall timeout to absorb the writeback
 * debounce.
 */
export async function commitViaUi(page: Page, message: string): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'Commit…' }).click();
    const dialog = commitDialogLocator(page);
    await expect(dialog.getByText('Commit changes')).toBeVisible({ timeout: 10_000 });
    try {
      await expect(dialog.getByText('Nothing staged to commit.')).toHaveCount(0, { timeout: 3000 });
    } catch (error) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      throw error;
    }
  }).toPass({ timeout: 30_000 });

  const dialog = commitDialogLocator(page);
  await dialog.getByLabel('Commit message').fill(message);
  const commitButton = dialog.getByRole('button', { name: 'Commit', exact: true });
  await expect(commitButton).toBeEnabled({ timeout: 10_000 });
  await commitButton.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/**
 * Clicks the status bar's Push button — targeted by its ACCESSIBLE NAME, which is its aria-label
 * `ahead by N — push available` (the visible text is just `Push`/`Pushing…`, but the aria-label
 * wins for accessible-name matching). Deliberately does NOT match `/push/i` alone, which would also
 * match the read-only "Preview push" button when both are rendered. Waits until the push has fully
 * landed: once the branch is no longer ahead, the button's gating (`canPush && ahead > 0`) removes
 * it from the DOM entirely.
 */
export async function pushViaUi(page: Page): Promise<void> {
  const pushButton = page.getByRole('button', { name: /push available/i });
  await expect(pushButton).toBeVisible({ timeout: 30_000 });
  await pushButton.click();
  await expect(page.getByRole('button', { name: /push available/i })).toHaveCount(0, { timeout: 30_000 });
}

// ─── Pull ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Clicks the status bar's Pull button (aria-label `behind by N — pull available`), then works
 * through `PullDialog`: optionally asserts the "may change files that are currently open for live
 * editing" warning is shown (pass `expectAffectsOpenFiles: true` for a spec that keeps the document
 * open across the pull), then confirms with `Pull anyway` — there is no separate two-step confirm;
 * the warning plus that one button IS the confirmation.
 *
 * The Pull button now surfaces ON ITS OWN once the collaborator has pushed: the git-worker's
 * background remote-refresh sweep advances this project's remote-tracking ref, the client's
 * ahead/behind poll then sees `behind > 0`, and the button appears — no manual refresh/reload step.
 * This waits up to 30s for it. For that discovery to fit the test timeout, CI must run the worker
 * with a short `ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_INTERVAL_MS` (e.g. 3000); its 60s
 * production default would outlast this wait.
 */
export async function pullViaUi(page: Page, options: { expectAffectsOpenFiles?: boolean } = {}): Promise<void> {
  const pullButton = page.getByRole('button', { name: /pull available/i });
  await expect(pullButton).toBeVisible({ timeout: 30_000 });
  await pullButton.click();

  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Pull from remote') });
  await expect(dialog.getByText('Pull from remote')).toBeVisible({ timeout: 10_000 });

  if (options.expectAffectsOpenFiles) {
    await expect(
      dialog.getByText('Pulling now may change files that are currently open for live editing.'),
    ).toBeVisible({ timeout: 15_000 });
  }

  await dialog.getByRole('button', { name: 'Pull anyway' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

// ─── Branches ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens the branch switcher and creates a new branch from the current tip via `New branch…` →
 * fill `Branch name` → `Create branch`. A freshly created branch is never switched to (matches
 * `BranchSwitcher`'s own behavior) — the caller stays on whatever branch it was on before.
 */
export async function createBranchViaUi(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Switch branch' }).click();
  await page.getByRole('menuitem', { name: 'New branch…', exact: true }).click();

  const dialog = page.getByRole('dialog').filter({ has: page.getByText('New branch') });
  await expect(dialog.getByText('New branch')).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel('Branch name').fill(name);
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/**
 * Opens the branch switcher dropdown and clicks the named branch, then — when the resulting
 * `BranchSwitchDialog` refusal-confirm appears (open files / uncommitted changes, both worded
 * "Switch anyway") — clicks through it. Leaves the dropdown closed either way. The branch switcher
 * and its confirm dialog have no testids, so this locates purely by role/label.
 */
export async function switchBranchViaUi(page: Page, branchName: string): Promise<void> {
  await page.getByRole('button', { name: 'Switch branch' }).click();
  await page.getByRole('menuitem', { name: branchName, exact: true }).click();

  // `open_files_need_confirm` is a git-worker round trip (not a synchronous local check), so give
  // it a window wide enough to actually land before falling back to "the switch already went
  // through" below.
  const confirmButton = page.getByRole('button', { name: /Switch anyway/ });
  if (await confirmButton.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await confirmButton.click();
  }
}

// ─── Conflicts ────────────────────────────────────────────────────────────────────────────────────

/**
 * Clicks the header's destructive `Resolve conflicts` button (shown once a paused pull leaves the
 * repository `CONFLICTED`) and returns the resulting `ConflictPanel` dialog locator, once its title
 * is visible.
 */
export async function openConflictPanel(page: Page): Promise<Locator> {
  const resolveButton = page.getByRole('button', { name: 'Resolve conflicts' });
  await expect(resolveButton).toBeVisible({ timeout: 30_000 });
  await resolveButton.click();

  const panel = page.getByRole('dialog').filter({ has: page.getByText('Resolve conflicts') });
  await expect(panel.getByText('Resolve conflicts')).toBeVisible({ timeout: 10_000 });
  return panel;
}

/** The conflicting-file row (a plain `<li>`, no role of its own) whose path text matches `filePath`. */
function conflictFileRow(panel: Locator, filePath: string): Locator {
  return panel.locator('li').filter({ hasText: filePath });
}

/** Clicks `Keep ours` on the conflicting file's row matching `filePath`. */
export async function keepOursViaUi(panel: Locator, filePath: string): Promise<void> {
  await conflictFileRow(panel, filePath).getByRole('button', { name: 'Keep ours' }).click();
}

/** Clicks `Take theirs` on the conflicting file's row matching `filePath`. */
export async function takeTheirsViaUi(panel: Locator, filePath: string): Promise<void> {
  await conflictFileRow(panel, filePath).getByRole('button', { name: 'Take theirs' }).click();
}

/** Waits for `Complete` to become enabled (every file resolved), clicks it, and waits for the panel to close. */
export async function completeConflictResolutionViaUi(panel: Locator): Promise<void> {
  const completeButton = panel.getByRole('button', { name: 'Complete' });
  await expect(completeButton).toBeEnabled({ timeout: 15_000 });
  await completeButton.click();
  await expect(panel).toBeHidden({ timeout: 20_000 });
}

/** Clicks `Undo pull`, abandoning the paused pull, and waits for the panel to close. */
export async function undoPullViaUi(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Undo pull' }).click();
  await expect(panel).toBeHidden({ timeout: 20_000 });
}

// ─── Status-bar assertions ────────────────────────────────────────────────────────────────────────

/**
 * Asserts the status bar's ahead-count badge is visible — the plain `<span>` carrying
 * `aria-label="N commits ahead"` (matched by attribute rather than `getByLabel`, since it is not a
 * form control). Pass `count` to require an exact N; omit it to accept any positive count.
 */
export async function expectAheadBadge(page: Page, count?: number): Promise<void> {
  const locator =
    count === undefined
      ? page.locator('[aria-label$="commits ahead"]')
      : page.locator(`[aria-label="${count} commits ahead"]`);
  await expect(locator).toBeVisible({ timeout: 15_000 });
}

/** Same as {@link expectAheadBadge}, for the behind-count badge (`aria-label="N commits behind"`). */
export async function expectBehindBadge(page: Page, count?: number): Promise<void> {
  const locator =
    count === undefined
      ? page.locator('[aria-label$="commits behind"]')
      : page.locator(`[aria-label="${count} commits behind"]`);
  await expect(locator).toBeVisible({ timeout: 15_000 });
}

/** Asserts the status bar's sync-status readout shows `Up to date`. */
export async function expectUpToDate(page: Page): Promise<void> {
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible({ timeout: 30_000 });
}

// ─── Editor content (used to simulate a collaborator's edit through their own project's UI) ──────

/**
 * Selects the whole editor content and retypes it as `content` — the UI equivalent of a
 * collaborator replacing a file's full text before committing. Used both for a second-context
 * "external collaborator" project and for the local edit half of a conflict scenario.
 */
export async function replaceEditorContentViaUi(page: Page, content: string): Promise<void> {
  await page.locator('.cm-editor .cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(content);
}
