import { test } from '@playwright/test';
import { signIn } from './helpers/test-project';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Environment maintenance (not a product test): deletes every project the signed-in user can see,
 * via the same API the app uses. Used to clear accumulated throwaway demo projects so the git-worker's
 * background remote-refresh sweep (one FETCH per connected repository per interval) stops congesting
 * the single serialized operation queue. App-level only — touches no database directly.
 */
test('ENV CLEANUP: delete all projects', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);

  let deleted = 0;
  for (let round = 0; round < 50; round += 1) {
    const response = await page.request.get(`${API_URL}/api/projects?limit=100`);
    if (!response.ok()) throw new Error(`list failed: ${response.status()} ${await response.text()}`);
    const body = await response.json();
    const projects: Array<{ id: string }> = body.data ?? [];
    if (projects.length === 0) break;
    for (const project of projects) {
      await page.request.delete(`${API_URL}/api/projects/${project.id}`);
      deleted += 1;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[env-cleanup] deleted ${deleted} projects`);
});
