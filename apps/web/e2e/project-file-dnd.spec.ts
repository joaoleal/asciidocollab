import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import {
  signIn,
  createProject,
  cleanupProject,
  createTestFile,
  createTestFolder,
} from './helpers/test-project';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gotoProject(page: Page, projectId: string) {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/failed to load files/i)).not.toBeVisible();
}

/**
 * Performs a GENUINE native HTML5 drag of one tree node onto a folder, driving Chromium's real
 * drag pipeline via CDP (not synthetic `dispatchEvent`, which bypasses native DnD entirely and
 * gives false confidence). `Input.setInterceptDrags` makes the browser fire the real `dragstart`
 * (so the app's handlers run and the browser captures the drag data); we then dispatch real
 * `dragEnter`/`dragOver`/`drop` events at the target.
 *
 * When `stripData` is set, the `drop` is dispatched with an EMPTY dataTransfer. This reproduces the
 * cross-browser failure mode where `getData('text/plain')` comes back empty on `drop` even though
 * `setData` ran on `dragstart` — the move must still succeed because the app captures the dragged
 * id in React state on `dragstart` rather than depending on the dataTransfer round-trip.
 */
/** The `Input.dispatchDragEvent` payload, as the DevTools protocol declares it. */
interface CdpDragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  files?: string[];
  dragOperationsMask: number;
}

async function nativeDragOntoFolder(
  page: Page,
  sourceTestId: string,
  targetTestId: string,
  options: { stripData?: boolean; dropAtBottom?: boolean } = {},
) {
  const client = await page.context().newCDPSession(page);
  await client.send('Input.setInterceptDrags', { enabled: true });

  const sb = await page.getByTestId(sourceTestId).boundingBox();
  const tb = await page.getByTestId(targetTestId).boundingBox();
  if (!sb || !tb) throw new Error(`drag source/target not found: ${sourceTestId} / ${targetTestId}`);
  const sx = sb.x + sb.width / 2, sy = sb.y + sb.height / 2;
  // `dropAtBottom` aims at the empty lower strip of a tall target (the root drop-zone) so the drop
  // lands on the zone itself, not on a child node.
  const tx = tb.x + tb.width / 2;
  const ty = options.dropAtBottom ? tb.y + tb.height - 8 : tb.y + tb.height / 2;

  const dataPromise = new Promise<CdpDragData>((resolve) =>
    client.on('Input.dragIntercepted', (event: { data: CdpDragData }) => resolve(event.data)),
  );
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + 8, y: sy + 8, button: 'left', buttons: 1 });

  const captured = await Promise.race([
    dataPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!captured) throw new Error('native drag did not start (no dragstart) — the row may not be draggable');

  const dropData = options.stripData ? { items: [], dragOperationsMask: captured.dragOperationsMask } : captured;
  await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x: tx, y: ty, data: dropData });
  await client.send('Input.dispatchDragEvent', { type: 'dragOver', x: tx, y: ty, data: dropData });
  await client.send('Input.dispatchDragEvent', { type: 'drop', x: tx, y: ty, data: dropData });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1 });
}

/** Confirms the move dialog, then asserts (UI + API) that `name` ended up inside `folderId`. */
async function confirmMoveAndAssert(page: Page, projectId: string, folderId: string, name: string) {
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog, 'a move confirmation dialog must appear on drop').toBeVisible({ timeout: 5000 });
  await dialog.getByRole('button', { name: /^confirm$/i }).click();
  await expect(dialog).not.toBeVisible({ timeout: 5000 });

  // UI: the moved node is still rendered (under the auto-expanded target folder).
  await expect(page.getByTestId(`tree-node-${name}`)).toBeVisible({ timeout: 5000 });

  // API: it is now under the folder and no longer at the root.
  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiUrl}/projects/${projectId}/files`);
      const tree = await response.json();
      const folder = tree.children.find((c: { id: string }) => c.id === folderId);
      const underFolder = folder?.children?.some((c: { name: string }) => c.name === name) ?? false;
      const atRoot = tree.children.some((c: { name: string }) => c.name === name);
      return underFolder && !atRoot;
    }, { timeout: 5000 })
    .toBe(true);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('File tree drag-and-drop move (native)', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `File DnD E2E ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('dragging a root file onto a folder moves it into that folder', async ({ page }) => {
    const folderId = await createTestFolder(page, projectId, null, 'docs');
    await createTestFile(page, projectId, null, 'intro.adoc');

    await gotoProject(page, projectId);
    await expect(page.getByTestId('tree-node-docs')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('tree-node-intro.adoc')).toBeVisible({ timeout: 5000 });

    await nativeDragOntoFolder(page, 'tree-node-intro.adoc', 'tree-node-docs');
    await confirmMoveAndAssert(page, projectId, folderId, 'intro.adoc');
  });

  // Regression: the move must NOT depend on the dataTransfer getData round-trip. When the browser
  // hands the drop an empty dataTransfer (a real cross-browser HTML5-DnD failure mode), the move
  // must still work via the id captured on dragstart — otherwise the drop is a silent no-op and,
  // to the user, "nothing happens on drop".
  test('moves a file even when the drop dataTransfer is empty (getData round-trip fails)', async ({ page }) => {
    const folderId = await createTestFolder(page, projectId, null, 'docs');
    await createTestFile(page, projectId, null, 'note.adoc');

    await gotoProject(page, projectId);
    await expect(page.getByTestId('tree-node-note.adoc')).toBeVisible({ timeout: 5000 });

    await nativeDragOntoFolder(page, 'tree-node-note.adoc', 'tree-node-docs', { stripData: true });
    await confirmMoveAndAssert(page, projectId, folderId, 'note.adoc');
  });

  test('dragging a folder into another folder moves it', async ({ page }) => {
    const destinationId = await createTestFolder(page, projectId, null, 'dest');
    await createTestFolder(page, projectId, null, 'src');

    await gotoProject(page, projectId);
    await expect(page.getByTestId('tree-node-src')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('tree-node-dest')).toBeVisible({ timeout: 5000 });

    await nativeDragOntoFolder(page, 'tree-node-src', 'tree-node-dest');
    await confirmMoveAndAssert(page, projectId, destinationId, 'src');
  });

  // Dropping a file onto another FILE (not a folder) moves it into that file's containing folder.
  test('dropping a file onto another file moves it into that file\'s folder', async ({ page }) => {
    const folderId = await createTestFolder(page, projectId, null, 'docs');
    await createTestFile(page, projectId, folderId, 'inside.adoc'); // a file already inside docs
    await createTestFile(page, projectId, null, 'mover.adoc');      // a root file to move

    await gotoProject(page, projectId);
    // `docs` auto-expands, so inside.adoc is visible.
    await expect(page.getByTestId('tree-node-inside.adoc')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('tree-node-mover.adoc')).toBeVisible({ timeout: 5000 });

    // Drop the root file ONTO the file inside docs → it should move INTO docs.
    await nativeDragOntoFolder(page, 'tree-node-mover.adoc', 'tree-node-inside.adoc');
    await confirmMoveAndAssert(page, projectId, folderId, 'mover.adoc');
  });

  // Dropping a file onto the empty root drop-zone moves it out to the project root.
  test('dropping a file on the root area moves it to the project root', async ({ page }) => {
    const folderId = await createTestFolder(page, projectId, null, 'docs');
    await createTestFile(page, projectId, folderId, 'escape.adoc'); // nested inside docs

    await gotoProject(page, projectId);
    await expect(page.getByTestId('tree-node-escape.adoc')).toBeVisible({ timeout: 5000 });

    // Drop the nested file onto the root drop-zone's empty lower area → move to root.
    await nativeDragOntoFolder(page, 'tree-node-escape.adoc', 'file-tree-drop-zone', { dropAtBottom: true });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog, 'a move dialog must appear when dropping on the root').toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: /^confirm$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // escape.adoc is now at the root and no longer under docs.
    await expect
      .poll(async () => {
        const response = await page.request.get(`${apiUrl}/projects/${projectId}/files`);
        const tree = await response.json();
        const atRoot = tree.children.some((c: { name: string }) => c.name === 'escape.adoc');
        const folder = tree.children.find((c: { id: string }) => c.id === folderId);
        const underFolder = folder?.children?.some((c: { name: string }) => c.name === 'escape.adoc') ?? false;
        return atRoot && !underFolder;
      }, { timeout: 5000 })
      .toBe(true);
  });
});
