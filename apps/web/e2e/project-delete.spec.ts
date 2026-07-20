import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';

const PROJECT_NAME = 'My Delete Test Project';

test.describe('Project deletion', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('Delete Project button disabled until project name typed', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, PROJECT_NAME);

    await page.goto(`/dashboard/projects/${projectId}/settings?section=danger`);

    // Open the delete dialog via the trigger button
    await page.getByRole('button', { name: /delete project/i }).first().click();

    // The confirm button inside the dialog should be disabled initially
    const confirmButton = page.getByRole('button', { name: /delete project/i }).last();
    await expect(confirmButton).toBeDisabled();

    // Type the wrong name — confirm button should remain disabled
    await page.getByLabel(/^type /i).fill('wrong name');
    await expect(confirmButton).toBeDisabled();

    // Type the exact project name — confirm button should become enabled
    await page.getByLabel(/^type /i).fill(PROJECT_NAME);
    await expect(confirmButton).toBeEnabled();

    // Cleanup: close the dialog then delete the project via API
    await page.getByRole('button', { name: /cancel/i }).click();
    await cleanupProject(page, projectId);
  });

  test('Confirm deletion redirects to dashboard with success notice', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, PROJECT_NAME);

    await page.goto(`/dashboard/projects/${projectId}/settings?section=danger`);

    // Open the delete dialog
    await page.getByRole('button', { name: /delete project/i }).first().click();

    // Type the exact project name to enable the confirm button
    await page.getByLabel(/^type /i).fill(PROJECT_NAME);

    // Click the confirm button inside the dialog
    const confirmButton = page.getByRole('button', { name: /delete project/i }).last();
    await confirmButton.click();

    // Must navigate to /dashboard — times out and fails if deletion didn't complete.
    await page.waitForURL(url => url.pathname === '/dashboard', { timeout: 10_000 });
    const hasDeletedParameter = page.url().includes('deleted=1');
    const hasSuccessText = await page.getByText('Project deleted successfully.').isVisible();
    expect(hasDeletedParameter || hasSuccessText, 'Expected a success indicator after deletion').toBe(true);

    // No afterEach cleanup needed — the project was deleted by this test
  });
});
