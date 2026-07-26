import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import {
  createAdocFile,
  setMainFile,
  openProject,
  openFile,
  expandPreview,
  editorContent,
} from './helpers/editor';

// Cross-document attributes: a `{name}` reference in the previewed open
// file resolves to the value in effect at the file's first include-point in the assembled tree,
// anchored to the project main file (root). Editing the parent's value updates the preview live.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fileId(page: import('@playwright/test').Page, projectId: string, name: string): Promise<string> {
  const tree = await page.request.get(`${API}/projects/${projectId}/files`).then((r) => r.json());
  const node = (tree.children as Array<{ id: string; name: string }>).find((c) => c.name === name);
  if (!node) throw new Error(`file ${name} not found`);
  return node.id;
}

test.describe('preview cross-document attributes', () => {
  // Headroom for the write-back the live-update case now waits on explicitly, under parallel load.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Cross-Doc Attributes ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('resolves a parent-defined attribute in the child preview and updates live on parent edit', async ({ page }) => {
    // The main file defines :productName: before including the child; the child references it.
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n:productName: Acme\n\ninclude::child.adoc[]\n',
    );
    await createAdocFile(page, projectId, 'child.adoc', '= Child\n\nProduct is {productName}.\n');
    const mainFileId = await fileId(page, projectId, 'main.adoc');
    await setMainFile(page, projectId, mainFileId);

    await openProject(page, projectId);
    // Open the CHILD file — its preview must resolve {productName} from the parent's scope.
    await openFile(page, 'child.adoc', 'Child');
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('Product is Acme.', { timeout: 15_000 });
    // The literal reference token must not survive — it resolved to the inherited value.
    await expect(output).not.toContainText('{productName}');

    // Edit the PARENT's value, then re-open the child; the preview reflects the new value (live
    // re-resolution rooted at the main file).
    // Wait for the attribute LINE, not just "Book": `= Book` is in the file either way, so waiting for it
    // proves only that an editor mounted — not that the collaborative document has synced in. Selecting
    // all and typing into a not-yet-synced editor discards the edit, which is why the write-back below
    // was previously waiting for a change that never happened.
    await openFile(page, 'main.adoc', ':productName: Acme');
    await editorContent(page).click();
    // Replace "Acme" with "Globex" in the main file's attribute definition.
    await page.keyboard.press('Control+a');
    await page.keyboard.type('= Book\n:productName: Globex\n\ninclude::child.adoc[]\n');
    // Wait for the parent's edit to be observable WHERE THE CHILD READS IT FROM, rather than assuming a
    // file switch takes long enough. The child resolves its inherited scope against the project's stored
    // files, and the parent's keystrokes reach those only after the autosave debounce (4s) and the
    // collaboration server's own write-back debounce (2s) — so "switch files and hope" is a race that
    // loses whenever the machine is busy, which is exactly when the suite runs in parallel.
    await expect(async () => {
      const response = await page.request.get(`${API}/projects/${projectId}/files/${mainFileId}/content`);
      expect(await response.text()).toContain('Globex');
    }).toPass({ timeout: 30_000 });

    await openFile(page, 'child.adoc', 'Child');
    await expect(output).toContainText('Product is Globex.', { timeout: 15_000 });
    await expect(output).not.toContainText('Acme');
  });

  test('an attribute the parent unset before the include is unresolved in the child preview', async ({ page }) => {
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n:productName: Acme\n:productName!:\n\ninclude::child.adoc[]\n',
    );
    await createAdocFile(page, projectId, 'child.adoc', '= Child\n\nProduct is {productName}.\n');
    await setMainFile(page, projectId, await fileId(page, projectId, 'main.adoc'));

    await openProject(page, projectId);
    await openFile(page, 'child.adoc', 'Child');
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');
    // Asciidoctor leaves an unresolved attribute reference as the literal `{productName}` token.
    await expect(output).toContainText('{productName}', { timeout: 15_000 });
  });
});
