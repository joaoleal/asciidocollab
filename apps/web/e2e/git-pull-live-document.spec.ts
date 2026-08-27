import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { commentOnPassage, openFileInEditor, typeInEditor } from './helpers/review';
import {
  commitViaUi,
  createFileViaUi,
  createProjectViaUi,
  importViaUi,
  initializeViaUi,
  pullViaUi,
  pushViaUi,
  replaceEditorContentViaUi,
  requireRemote,
} from './helpers/git';

// Requires a real, reachable, WRITABLE test git remote (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN /
// optionally GIT_E2E_REMOTE_PROVIDER — see helpers/git.ts) plus apps/api + apps/collab + the
// git-worker running.
//
// There is NO server-side git<->review integration: when a pull replaces a file's full content
// (collab "apply full content" -> a Yjs doc rewrite), it is the CLIENT that re-resolves every
// comment/task anchor (relpos -> text-quote -> section -> detached). That resolution only runs while
// a live editing session for the document is open, so every test below keeps `openFileInEditor`'s
// session open across the pull and asserts on what the rail/tray render afterward, rather than on
// anything server-side.
//
// The "external" change comes from a SECOND project, connected to the SAME remote branch, edited and
// pushed through its OWN editor in a second browser context — never by mutating the remote directly.

const FILE_NAME = 'pull-live-doc.adoc';

test.describe('Git pull into a live document — comment anchors react to what the remote change touched', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a pulled change that leaves the commented passage untouched keeps the comment — and a task made from it — anchored', async ({
    page,
    browser,
  }) => {
    const remote = requireRemote();
    const branch = `e2e-pull-stable-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Pull Stable ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, 'Intro line\nSTABLE passage the remote change leaves alone\nOutro line\n');
    await initializeViaUi(page, projectId, remote, branch);
    await openFileInEditor(page, projectId, FILE_NAME);

    await commentOnPassage(page, 'STABLE passage the remote change leaves alone', 'Keep an eye on this section.');
    const rail = page.getByTestId('comment-rail');
    const card = rail.getByTestId('review-thread-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Convert it to a task too, so the survival assertion below covers both surfaces.
    await card.getByTestId('task-controls-convert').click();
    await expect(card.getByTestId('task-controls')).toBeVisible({ timeout: 10_000 });

    // A second collaborator, entirely through their own project's UI (a second browser context,
    // imported from the same remote branch), appends a new line — the commented passage's text is
    // untouched.
    const collaboratorContext = await browser.newContext();
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await signIn(collaboratorPage);
      const collaboratorProjectId = await importViaUi(collaboratorPage, remote, { branch });
      await openFileInEditor(collaboratorPage, collaboratorProjectId, FILE_NAME);
      await typeInEditor(collaboratorPage, 'Appended by an external push.\n');
      await commitViaUi(collaboratorPage, 'Append a trailing line');
      await pushViaUi(collaboratorPage);
      await cleanupProject(collaboratorPage, collaboratorProjectId);
    } finally {
      await collaboratorContext.close();
    }

    await pullViaUi(page, { expectAffectsOpenFiles: true });
    await expect(page.locator('.cm-editor .cm-content')).toContainText('Appended by an external push.', {
      timeout: 30_000,
    });

    // The passage survived unrelocated: the thread (now a task) is still a normal, anchored card —
    // no section-degraded indicator, no detached-tray entry for it.
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Keep an eye on this section.', { timeout: 10_000 });
    await expect(card.getByTestId('thread-card-section-indicator')).toHaveCount(0);
    await expect(page.getByTestId('detached-tray')).toHaveCount(0);
  });

  test('a pulled change that rewrites the commented passage degrades the comment to its section, or fully detaches it', async ({
    page,
    browser,
  }) => {
    const remote = requireRemote();
    const branch = `e2e-pull-rewrite-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Pull Rewrite ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, 'Intro line\nREWRITTEN passage the remote change replaces\nOutro line\n');
    await initializeViaUi(page, projectId, remote, branch);
    await openFileInEditor(page, projectId, FILE_NAME);

    await commentOnPassage(page, 'REWRITTEN passage the remote change replaces', 'This needs a rewrite.');
    const rail = page.getByTestId('comment-rail');
    await expect(rail.getByTestId('review-thread-card').first()).toBeVisible({ timeout: 10_000 });

    // A second collaborator replaces the commented line's text entirely, through their own editor.
    const collaboratorContext = await browser.newContext();
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await signIn(collaboratorPage);
      const collaboratorProjectId = await importViaUi(collaboratorPage, remote, { branch });
      await openFileInEditor(collaboratorPage, collaboratorProjectId, FILE_NAME);
      await replaceEditorContentViaUi(collaboratorPage, 'Intro line\nCompletely different wording now.\nOutro line\n');
      await commitViaUi(collaboratorPage, 'Reword the middle passage');
      await pushViaUi(collaboratorPage);
      await cleanupProject(collaboratorPage, collaboratorProjectId);
    } finally {
      await collaboratorContext.close();
    }

    await pullViaUi(page, { expectAffectsOpenFiles: true });
    await expect(page.locator('.cm-editor .cm-content')).toContainText('Completely different wording now.', {
      timeout: 30_000,
    });

    // The passage the comment anchored to no longer exists verbatim: the anchor resolver falls back
    // to the section (a degraded-but-located indicator on the thread card) or, failing that, fully
    // detaches — either is a "correctly degraded" outcome for the anchor model, so accept both.
    const sectionIndicator = rail.getByTestId('thread-card-section-indicator');
    const detachedTray = page.getByTestId('detached-tray');
    await expect(sectionIndicator.or(detachedTray)).toBeVisible({ timeout: 20_000 });
  });
});
