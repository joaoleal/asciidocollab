import { test, expect } from '@playwright/test';
import { ensureTestUser, loginAdminViaApi, TEST_USER } from './helpers/test-user';

test.describe('Dashboard shell', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('dashboard loads without runtime errors or crash screen', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    // Header brand link is SSR-rendered by the dashboard layout — confirms the layout rendered without crashing.
    // exact: true so we match only the brand link and not other links whose accessible name contains
    // "AsciiDoCollab" as a substring (e.g. a "Guided Tour — AsciidoCollab" project card overlay).
    await expect(page.getByRole('link', { name: 'AsciiDoCollab', exact: true })).toBeVisible({ timeout: 10_000 });
    expect(pageErrors, `Unhandled JS errors: ${pageErrors.join('\n')}`).toHaveLength(0);
  });

  test('user menu shows the authenticated user name', async ({ page }) => {
    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await expect(page.getByRole('button').filter({ hasText: TEST_USER.displayName })).toBeVisible({ timeout: 10_000 });
  });

  test('user menu Account link navigates to /dashboard/account (not 404)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await page.getByRole('button').filter({ hasText: TEST_USER.displayName }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Account' }).click();

    await expect(page).toHaveURL(/\/dashboard\/account/);
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('h1, h2').filter({ hasText: '404' })).not.toBeVisible();
    expect(pageErrors, `Unhandled JS errors: ${pageErrors.join('\n')}`).toHaveLength(0);
  });

  test('user menu Settings link navigates to /dashboard/settings (not 404)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await page.getByRole('button').filter({ hasText: TEST_USER.displayName }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/settings/);
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('h1, h2').filter({ hasText: '404' })).not.toBeVisible();
    expect(pageErrors, `Unhandled JS errors: ${pageErrors.join('\n')}`).toHaveLength(0);
  });

  test('user menu Administrator Settings link navigates to /dashboard/admin (not 404)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await page.getByRole('button').filter({ hasText: TEST_USER.displayName }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Administrator Settings' }).click();

    await expect(page).toHaveURL(/\/dashboard\/admin/);
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('h1, h2').filter({ hasText: '404' })).not.toBeVisible();
    expect(pageErrors, `Unhandled JS errors: ${pageErrors.join('\n')}`).toHaveLength(0);
  });

  test('user menu Audit Log link navigates to /dashboard/admin/audit-log (not 404)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAdminViaApi(page);
    await page.goto('/dashboard');

    await page.getByRole('button').filter({ hasText: TEST_USER.displayName }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Audit Log' }).click();

    await expect(page).toHaveURL(/\/dashboard\/admin\/audit-log/);
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('h1, h2').filter({ hasText: '404' })).not.toBeVisible();
    expect(pageErrors, `Unhandled JS errors: ${pageErrors.join('\n')}`).toHaveLength(0);
  });
});
