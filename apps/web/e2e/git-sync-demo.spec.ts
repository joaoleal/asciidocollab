import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { GitProvider } from '@asciidocollab/shared';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { openFileInEditor, typeInEditor } from './helpers/review';
import {
  createFileViaUi,
  createProjectViaUi,
  expectAheadBadge,
  expectUpToDate,
  importViaUi,
  pushViaUi,
  requireRemote,
  type GitTestRemoteConfig,
} from './helpers/git';

/**
 * Demo/tooling spec — NOT part of the regular gate. Drives the REAL running web app (a live
 * apps/web + apps/api + apps/collab + git-worker stack, and a real git remote) through the full
 * git-repository-sync journey end to end, taking a labelled full-page screenshot at every
 * meaningful state so the flow can be reviewed visually.
 *
 * Requires the same real, reachable, WRITABLE test git remote every other git e2e spec needs — see
 * `helpers/git.ts` for `GIT_E2E_REMOTE_URL` / `GIT_E2E_REMOTE_TOKEN` / `GIT_E2E_REMOTE_PROVIDER`.
 * `requireRemote()` below skips this test (not fails it) when those are unset, exactly like the
 * gated tests in the other six git specs.
 *
 * Screenshots land in `process.env.DEMO_SHOT_DIR` (falls back to a fixed local scratch directory),
 * named zero-padded and kebab-case in journey order (`01-dashboard.png`, …). The base URL for the
 * driven app comes from `process.env.DEMO_BASE_URL` (falls back to `http://localhost:3100`), which
 * this spec sets for itself via `test.use` rather than the shared `playwright.config.ts`.
 *
 * Conflict resolution is deliberately OUT of this journey: producing a real merge conflict needs a
 * THIRD divergent branch of its own (a local unpushed commit that collides with a collaborator's
 * push on the same line — see `git-conflicts.spec.ts`), which would mean either abandoning the
 * single shared branch this whole journey narrates against, or bolting on a second, disconnected
 * mini-scenario purely to reach one more dialog. `ConflictPanel` is exercised end to end by
 * `git-conflicts.spec.ts` already; this demo stays a single coherent story instead.
 */

const shotDirectory = process.env.DEMO_SHOT_DIR ?? '/home/joao/.claude/jobs/2e5cded3/tmp/shots';
const demoBaseUrl = process.env.DEMO_BASE_URL ?? 'http://localhost:3100';

test.use({ baseURL: demoBaseUrl });

/** Takes a labelled, full-page screenshot into `shotDirectory`, logging its name first. */
async function shot(page: Page, name: string): Promise<void> {
  console.log(`[shot] ${name}`);
  await page.screenshot({ path: path.join(shotDirectory, `${name}.png`), fullPage: true });
}

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

/**
 * Opens the settings page's `Initialize & publish` dialog and fills it, WITHOUT submitting — the
 * caller screenshots the filled form, then drives the submit + wait-for-connected steps itself.
 * Mirrors `helpers/git.ts`'s `initializeViaUi`, split in two so a mid-dialog screenshot fits between
 * "filled" and "submitted".
 */
async function openInitializeDialogFilled(
  page: Page,
  projectId: string,
  remote: GitTestRemoteConfig,
  branch: string,
): Promise<Locator> {
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
  return dialog;
}

/**
 * Opens the editor header's `Commit…` dialog and fills the message, WITHOUT submitting. Mirrors
 * `helpers/git.ts`'s `commitViaUi`'s "wait for the staged change to show up" polling loop (the
 * commit dialog fetches staged status once, on open, so it must be re-opened until the just-typed
 * edit's writeback has flushed), split so a mid-dialog screenshot fits between "filled" and
 * "submitted".
 */
async function openCommitDialogFilled(page: Page, message: string): Promise<Locator> {
  await expect(async () => {
    await page.getByRole('button', { name: 'Commit…' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByText('Commit changes') });
    await expect(dialog.getByText('Commit changes')).toBeVisible({ timeout: 10_000 });
    try {
      // Positively wait for the on-open status fetch to FINISH loading and reveal the staged edit —
      // the row carries the file's path. Checking only that "Nothing staged" is absent races the
      // loading window (during which neither that copy nor the staged list is on screen yet), which
      // can let the retry proceed before the debounced writeback has flushed the edit into a staged
      // change, leaving the Commit button correctly-but-permanently disabled. Waiting for the actual
      // staged row closes that race; a still-loading or genuinely-empty open re-opens on the next try.
      await expect(dialog.getByText('Loading changes…')).toHaveCount(0, { timeout: 5000 });
      await expect(dialog.getByText(FILE_NAME, { exact: false })).toBeVisible({ timeout: 3000 });
    } catch (error) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      throw error;
    }
    // The collaborative writeback that projects a live edit onto disk (where `git status` can see it
    // as a pending change) runs on an interval — up to ~30s — so the retry window must comfortably
    // outlast one full interval for the just-typed edit to surface as a committable change. A freshly
    // imported collaborator project can start its session late, pushing its first writeback out, so the
    // window spans two full intervals rather than one.
  }).toPass({ timeout: 75_000 });

  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Commit changes') });
  await dialog.getByLabel('Commit message').fill(message);
  const commitButton = dialog.getByRole('button', { name: 'Commit', exact: true });
  await expect(commitButton).toBeEnabled({ timeout: 10_000 });
  return dialog;
}

/**
 * Submits an already-filled commit dialog, retrying past the intended single-flight collision. The
 * git-worker schedules a background FETCH for every connected repo (~60s interval); while that FETCH
 * holds the single-flight slot (a few seconds — both contend on the same `.git` locks), a commit is
 * correctly refused with "A git operation is already in progress. Try again shortly." That is a
 * retryable transient, not a defect, so re-submit until the slot frees.
 */
async function submitCommitWithRetry(page: Page, dialog: Locator): Promise<void> {
  const commitButton = dialog.getByRole('button', { name: 'Commit', exact: true });
  const inProgressAlert = dialog.getByText('A git operation is already in progress', { exact: false });
  const deadline = Date.now() + 90_000;
  for (;;) {
    await commitButton.click();
    const outcome = await Promise.race([
      dialog
        .waitFor({ state: 'hidden', timeout: 15_000 })
        .then(() => 'committed' as const)
        .catch(() => 'still-open' as const),
      inProgressAlert
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => 'in-progress' as const)
        .catch(() => 'still-open' as const),
    ]);
    if (outcome === 'committed') break;
    if (Date.now() >= deadline) {
      throw new Error(`Commit still refused after retries (last outcome: ${outcome}).`);
    }
    // Background FETCH still holds the slot — wait a beat and re-submit.
    await page.waitForTimeout(3000);
  }
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/**
 * Switches to `branchName` through the toolbar's branch menu, confirming the "files are open"
 * warning, and retries the whole gesture until the switch actually lands. A branch switch enqueues
 * an async operation, and while a background FETCH holds the project's single-flight slot the enqueue
 * is refused (the same transient collision the commit path retries past); the confirm dialog then
 * shows a generic failure and stays open rather than auto-retrying. Re-driving the switch clears it.
 */
async function switchBranchWithRetry(page: Page, branchName: string): Promise<void> {
  const switchButton = page.getByRole('button', { name: 'Switch branch' });
  const onTarget = () =>
    switchButton
      .filter({ hasText: branchName })
      .isVisible({ timeout: 500 })
      .catch(() => false);
  const deadline = Date.now() + 180_000;
  for (;;) {
    // A prior attempt's async switch may have landed late — if we're already on the target, done.
    if (await onTarget()) return;

    // Dismiss any confirm dialog left open by a previous refused attempt before re-opening the menu.
    const lingeringCancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    if (await lingeringCancel.isVisible({ timeout: 500 }).catch(() => false)) {
      await lingeringCancel.click().catch(() => undefined);
    }

    await switchButton.click();
    const targetItem = page.getByRole('menuitem', { name: branchName, exact: true });
    await targetItem.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    // A disabled target item means it is the current branch — the switch already landed. Clicking a
    // disabled item would block on Playwright actionability until the whole test times out, so bail.
    if (await targetItem.isDisabled().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    }
    await targetItem.click();

    const confirmButton = page.getByRole('button', { name: /Switch anyway/ });
    if (await confirmButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await confirmButton.click();
    }

    // The switch is an async operation polled to completion — allow generous time under queue load.
    const landed = await switchButton
      .filter({ hasText: branchName })
      .isVisible({ timeout: 30_000 })
      .catch(() => false);
    if (landed) return;

    if (Date.now() >= deadline) {
      throw new Error(`Branch switch to ${branchName} never landed after retries.`);
    }
    // The enqueue collided with a background FETCH — wait a beat and re-drive the switch.
    await page.waitForTimeout(3000);
  }
}

const FILE_NAME = 'git-sync-demo.adoc';
const SEEDED_CONTENT =
  '= Git Sync Demo\n' +
  ':toc:\n\n' +
  '== Introduction\n\n' +
  'This document showcases the *git-repository-sync* feature end to end: initialize and publish, ' +
  'commit and push, branch and switch, history, diff, blame, and pull.\n\n' +
  '* Initialize and publish\n' +
  '* Commit and push\n' +
  '* Branch and switch\n' +
  '* History, diff, and blame\n' +
  '* Pull a collaborator\'s change\n\n' +
  'TIP: Watch the status bar for the sync state changing as each step lands.\n';

test.describe('Git repository sync — demo journey', () => {
  test.beforeAll(async () => {
    mkdirSync(shotDirectory, { recursive: true });
    await ensureTestUser();
  });

  let projectId: string | undefined;
  let collaboratorProjectId: string | undefined;

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
    if (collaboratorProjectId) await cleanupProject(page, collaboratorProjectId);
  });

  test('drives the full git-repository-sync journey against the real app, screenshotting every state', async ({
    page,
    browser,
  }) => {
    // A single run walks first-run login through pull, exercising a real remote end to end — well
    // past the shared suite's per-test budget, so this overrides it for itself alone.
    test.setTimeout(600_000);

    const remote = requireRemote();
    const branch = `demo-git-sync-${Date.now()}`;

    // ── 1. First-run/admin seed + login ──────────────────────────────────────────────────────
    await signIn(page);
    await shot(page, '01-dashboard');

    // ── 2. Create/open a project with a real .adoc document ─────────────────────────────────
    projectId = await createProjectViaUi(page, `Git Sync Demo ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, SEEDED_CONTENT);
    await shot(page, '02-editor-with-content');

    // ── 3. Repository panel, pre-connect ─────────────────────────────────────────────────────
    await page.goto(`/dashboard/projects/${projectId}/settings?section=repository`);
    await expect(page.getByText('This project is not connected to a remote git repository.')).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, '03-repository-disconnected');

    // ── 4. Initialize & publish to the remote ────────────────────────────────────────────────
    const initializeDialog = await openInitializeDialogFilled(page, projectId, remote, branch);
    await shot(page, '04-initialize-dialog-filled');

    await initializeDialog
      .getByRole('button', { name: 'Initialize & publish', exact: true })
      .click();
    await expect(initializeDialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(branch)).toBeVisible();
    await shot(page, '05-initialize-success');

    // Back into the editor for the rest of the flow — initialize navigated to settings.
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, '\nA paragraph added after publishing, ready to commit.\n');

    // ── 5. Commit ─────────────────────────────────────────────────────────────────────────────
    const commitDialog = await openCommitDialogFilled(page, 'Add a paragraph via the demo journey');
    await shot(page, '06-commit-dialog-filled');

    await submitCommitWithRetry(page, commitDialog);
    await expectAheadBadge(page, 1);
    await shot(page, '07-commit-success-ahead');

    // ── 6. Push preview, then push ───────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Preview push' }).click();
    const pushPreviewDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Push preview' }) });
    await expect(pushPreviewDialog.getByRole('heading', { name: 'Push preview' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(pushPreviewDialog.getByText('Add a paragraph via the demo journey')).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, '08-push-preview');

    await pushPreviewDialog.getByRole('button', { name: 'Close' }).click();
    await expect(pushPreviewDialog).toBeHidden({ timeout: 10_000 });

    await pushViaUi(page);
    await expectUpToDate(page);
    await shot(page, '09-push-success');

    // ── 7. Branch: create, then switch ───────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Switch branch' }).click();
    await expect(page.getByRole('menuitem', { name: 'New branch…', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, '10-branch-switcher-open');
    await page.getByRole('menuitem', { name: 'New branch…', exact: true }).click();

    const newBranch = `demo-git-sync-second-${Date.now()}`;
    const newBranchDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'New branch' }) });
    await expect(newBranchDialog.getByRole('heading', { name: 'New branch' })).toBeVisible({ timeout: 10_000 });
    await newBranchDialog.getByLabel('Branch name').fill(newBranch);
    await newBranchDialog.getByRole('button', { name: 'Create branch' }).click();
    await expect(newBranchDialog).toBeHidden({ timeout: 15_000 });

    await switchBranchWithRetry(page, newBranch);
    await shot(page, '11-branch-switched');

    // ── 8. History panel ──────────────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'History' }).click();
    const historyDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Commit history' }) });
    await expect(historyDialog.getByRole('heading', { name: 'Commit history' })).toBeVisible({ timeout: 10_000 });
    await expect(historyDialog.getByText('Add a paragraph via the demo journey')).toBeVisible({ timeout: 15_000 });
    await shot(page, '12-history-panel');

    // ── 9. AsciiDoc-aware diff, opened by selecting a commit row ────────────────────────────
    await historyDialog.getByText('Add a paragraph via the demo journey').click();
    const diffDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Diff', exact: true }) });
    await expect(diffDialog.getByRole('heading', { name: 'Diff', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.cm-diff-container')).toBeVisible({ timeout: 15_000 });
    await shot(page, '13-diff-view');

    await diffDialog.getByRole('button', { name: 'Close' }).click();
    await expect(diffDialog).toBeHidden({ timeout: 10_000 });
    await historyDialog.getByRole('button', { name: 'Close' }).click();
    await expect(historyDialog).toBeHidden({ timeout: 10_000 });

    // ── 10. Blame ─────────────────────────────────────────────────────────────────────────────
    // Blame is an inline CodeMirror gutter, toggled from the editor settings panel rather than a
    // dialog of its own — open the settings surface, then flip the "Blame" toggle on.
    await page.getByRole('button', { name: 'Editor settings' }).click();
    const blameToggle = page.getByRole('button', { name: 'Blame' });
    await expect(blameToggle).toBeVisible({ timeout: 10_000 });
    await blameToggle.click();
    await expect(blameToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.cm-blame-gutter').first()).toBeVisible({ timeout: 15_000 });
    await shot(page, '14-blame-view');

    // Close the settings panel back down before continuing the journey.
    await page.getByRole('button', { name: 'Editor settings' }).click();

    // Switch back to the branch the collaborator below actually pushes to.
    await switchBranchWithRetry(page, branch);

    // ── 11. A collaborator pushes, then this project pulls it in ────────────────────────────
    const collaboratorContext = await browser.newContext();
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await signIn(collaboratorPage);
      collaboratorProjectId = await importViaUi(collaboratorPage, remote, { branch });
      await openFileInEditor(collaboratorPage, collaboratorProjectId, FILE_NAME);
      await typeInEditor(collaboratorPage, '\nAppended by a collaborator through their own project.\n');
      const collaboratorCommitDialog = await openCommitDialogFilled(
        collaboratorPage,
        'Append a line as an external collaborator',
      );
      await submitCommitWithRetry(collaboratorPage, collaboratorCommitDialog);
      await pushViaUi(collaboratorPage);
    } finally {
      await collaboratorContext.close();
    }

    const pullButton = page.getByRole('button', { name: /pull available/i });
    await expect(pullButton).toBeVisible({ timeout: 90_000 });
    await pullButton.click();
    const pullDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Pull from remote' }) });
    await expect(pullDialog.getByRole('heading', { name: 'Pull from remote' })).toBeVisible({ timeout: 10_000 });
    await expect(pullDialog.getByText('Append a line as an external collaborator')).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, '15-pull-preview');

    await pullDialog.getByRole('button', { name: 'Pull anyway' }).click();
    await expect(pullDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.cm-editor .cm-content')).toContainText(
      'Appended by a collaborator through their own project.',
      { timeout: 30_000 },
    );
    await expectUpToDate(page);
    await shot(page, '16-pull-success');

    // ── 12. Conflict resolution — SKIPPED, see the spec's own header comment for why. ──────────
  });
});
