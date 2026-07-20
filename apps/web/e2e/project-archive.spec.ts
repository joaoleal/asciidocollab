import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, archiveProject } from './helpers/test-project';

test.describe('Project archive and restore', () => {
  let projectId: string;

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, 'Archive Test Project');
  });

  test.afterEach(async ({ page }) => {
    await cleanupProject(page, projectId);
  });

  test('Archive Project button opens confirmation dialog', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=danger`);

    await page.getByRole('button', { name: 'Archive Project' }).click();

    // Dialog title contains "Archive"
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText(/archive/i);

    // Confirm button labelled "Archive" is visible inside the dialog
    await expect(
      page.getByRole('dialog').getByRole('button', { name: /^archive$/i }),
    ).toBeVisible();

    // Cancel without archiving
    await page.getByRole('dialog').getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Project is still active — "Archive Project" button must still be present
    await expect(page.getByRole('button', { name: 'Archive Project' })).toBeVisible();
  });

  test('Confirming archive shows archived state in settings', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=danger`);

    // Open dialog and confirm archive
    await page.getByRole('button', { name: 'Archive Project' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^archive$/i }).click();

    // After archiving, onArchive pushes to /dashboard — wait for navigation then go back to settings
    await page.waitForURL(/\/dashboard/);
    await page.goto(`/dashboard/projects/${projectId}/settings`);

    // Archived banner must be visible
    await expect(page.getByText(/this project is archived/i)).toBeVisible();

    // Name input must be disabled
    await expect(page.getByLabel(/project name/i)).toBeDisabled();

    // Save button must not be rendered
    await expect(page.getByRole('button', { name: /save changes/i })).not.toBeVisible();
  });

  test('Restore Project button restores the project', async ({ page }) => {
    // Archive via API so the page starts in the archived state
    await archiveProject(page, projectId);

    await page.goto(`/dashboard/projects/${projectId}/settings?section=danger`);

    // "Restore Project" button must be present
    await expect(page.getByRole('button', { name: 'Restore Project' })).toBeVisible();

    // Open dialog and confirm restore
    await page.getByRole('button', { name: 'Restore Project' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^restore$/i }).click();

    // After restoring, onRestore calls router.refresh() — wait for the page to update
    await expect(page.getByRole('button', { name: 'Archive Project' })).toBeVisible();

    // Editing must be possible again. The name field lives in the General section, not this one, so
    // the check has to go there — restoring is only meaningful if it re-enables the settings a
    // reader could not change while archived.
    await page.goto(`/dashboard/projects/${projectId}/settings`);
    await expect(page.getByLabel(/project name/i)).not.toBeDisabled();
  });
});
