import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import {
  signIn,
  createProject,
  cleanupProject,
  archiveProject,
} from './helpers/test-project';

test.describe('Project settings page', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  // Tests that need a real project share state via these variables.
  // Each test that needs them must sign in + create a project in beforeEach
  // and clean up in afterEach.
  let projectId: string;

  test.beforeEach(async ({ page }, testInfo) => {
    // The unauthenticated test handles its own setup — skip sign-in there.
    if (testInfo.title.startsWith('unauthenticated')) return;

    await signIn(page);
    projectId = await createProject(page, `Settings E2E ${Date.now()}`);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.title.startsWith('unauthenticated')) return;
    if (projectId) {
      await cleanupProject(page, projectId);
    }
  });

  test('unauthenticated visit to project settings → redirect to /login', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/dashboard/projects/some-fake-id/settings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('navigating to a non-existent project settings page → redirect to /404', async ({
    page,
  }) => {
    await page.goto(
      '/dashboard/projects/00000000-0000-4000-8000-000000000000/settings',
    );
    await expect(page).toHaveURL(/\/404/);
  });

  test('owner can update project name', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings`);

    const nameInput = page.getByLabel(/project name/i);
    await nameInput.clear();
    await nameInput.fill('Updated Project Name');

    await page.getByRole('button', { name: /save changes/i }).click();

    await expect(
      page.getByText(/project settings updated successfully/i),
    ).toBeVisible();
  });

  test('each section is reachable and shows only its own settings', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings`);

    // The default section is General.
    await expect(page.getByLabel(/project name/i)).toBeVisible();
    await expect(page.getByLabel('Page size')).toHaveCount(0);
    // Grammar checking is gated on the project language, so it is shown with it rather than in a
    // section of its own.
    await expect(page.getByRole('checkbox', { name: 'Enable grammar checking' })).toBeVisible();

    await page.getByRole('link', { name: 'AsciiDoc', exact: true }).click();
    await expect(page).toHaveURL(/section=rendering/);
    await expect(page.getByLabel('Document type')).toBeVisible();
    await expect(page.getByLabel(/project name/i)).toHaveCount(0);
    await expect(page.getByLabel('English dialect')).toHaveCount(0);

    await page.getByRole('link', { name: 'PDF Layout & Theme' }).click();
    await expect(page).toHaveURL(/section=pdf/);
    await expect(page.getByLabel('Page size')).toBeVisible();
    await expect(page.getByLabel('Document type')).toHaveCount(0);

    await page.getByRole('link', { name: 'PDF Extensions' }).click();
    await expect(page).toHaveURL(/section=extensions/);

    await page.getByRole('link', { name: 'Danger Zone' }).click();
    await expect(page).toHaveURL(/section=danger/);
    await expect(page.getByRole('button', { name: 'Archive Project' })).toBeVisible();
  });

  test('a section link opens the page with that section selected', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=pdf`);
    await expect(page.getByLabel('Page size')).toBeVisible();
    await expect(page.getByRole('link', { name: 'PDF Layout & Theme' })).toHaveAttribute('aria-current', 'page');
  });

  test('an unknown section falls back to the default', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=not-a-section`);
    await expect(page.getByLabel(/project name/i)).toBeVisible();
  });

  test('changing sections does not silently discard unsaved edits', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings`);

    const nameInput = page.getByLabel(/project name/i);
    await nameInput.clear();
    await nameInput.fill('Unsaved Rename');

    await page.getByRole('link', { name: 'PDF Layout & Theme' }).click();

    // The move is held until the viewer decides what happens to the edit.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/unsaved/i);
    await dialog.getByRole('button', { name: /stay here/i }).click();
    await expect(nameInput).toHaveValue('Unsaved Rename');

    // Choosing to discard proceeds.
    await page.getByRole('link', { name: 'PDF Layout & Theme' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /discard and leave/i }).click();
    await expect(page).toHaveURL(/section=pdf/);
  });

  test('render options edited in one section survive a save from another', async ({ page }) => {
    // `PUT /render-config` is a full replace, so this is the regression that catches a section
    // sending only its own fields and wiping its siblings.
    await page.goto(`/dashboard/projects/${projectId}/settings?section=rendering`);
    await page.getByLabel('Document type').selectOption('book');

    await page.getByRole('link', { name: 'PDF Layout & Theme' }).click();
    await page.getByLabel('Page size').selectOption('A4');
    await page.getByRole('button', { name: 'Save render options' }).click();
    await expect(page.getByText('Render options saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Page size')).toHaveValue('A4');
    await page.getByRole('link', { name: 'AsciiDoc', exact: true }).click();
    await expect(page.getByLabel('Document type')).toHaveValue('book');
  });

  test('grammar checking follows the language chosen in the General form', async ({ page }) => {
    // The reason the two sit together: the dependency has to be visible at the point of decision,
    // not discovered later when checking has silently stopped running.
    await page.goto(`/dashboard/projects/${projectId}/settings`);

    const grammarToggle = page.getByRole('checkbox', { name: 'Enable grammar checking' });
    await page.getByLabel('Language').selectOption('en');
    await expect(grammarToggle).toBeEnabled();

    await page.getByLabel('Language').selectOption('fr');
    await expect(grammarToggle).toBeDisabled();
    await expect(page.getByText(/set the project language to english/i)).toBeVisible();
  });

  test('grammar settings saved from General survive a save from another section', async ({ page }) => {
    // General now writes the SAME full-replace render-config document as the other sections, so this
    // is the regression that catches its save dropping their fields — or theirs dropping its.
    await page.goto(`/dashboard/projects/${projectId}/settings?section=rendering`);
    await page.getByLabel('Document type').selectOption('book');

    await page.getByRole('link', { name: 'General' }).click();
    await page.getByLabel('Language').selectOption('en');
    await page.getByLabel('English dialect').selectOption('en-US');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/project settings updated successfully/i)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('English dialect')).toHaveValue('en-US');
    await page.getByRole('link', { name: 'AsciiDoc', exact: true }).click();
    await expect(page.getByLabel('Document type')).toHaveValue('book');
  });

  test('the PDF section names the theme file the project renders with', async ({ page }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=pdf`);
    // A project with no theme file says so, rather than leaving the question open.
    await expect(page.getByTestId('resolved-theme')).toContainText(/default theme/i);
  });

  test('archived project shows disabled fields and archive banner', async ({ page }) => {
    await archiveProject(page, projectId);

    await page.goto(`/dashboard/projects/${projectId}/settings`);

    // Banner indicating the project is archived
    await expect(page.getByText(/this project is archived/i)).toBeVisible();

    // Name input must be disabled
    const nameInput = page.getByLabel(/project name/i);
    await expect(nameInput).toBeDisabled();
  });
});
