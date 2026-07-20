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
  EDITOR_EDITABLE_TIMEOUT,
} from './helpers/editor';

// Conditional preprocessor directives:
//  - A content-level conditional gated on a main-file attribute shows/hides content, and toggling the
//    attribute updates the preview live (Asciidoctor evaluates the conditional with the seeded scope).
//  - A conditional wrapping an `include::` includes/skips the target in the ASSEMBLER (an inactive
//    branch's include is never expanded), so the gated chapter appears only when the flag is set.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fileId(page: import('@playwright/test').Page, projectId: string, name: string): Promise<string> {
  const tree = await page.request.get(`${API}/projects/${projectId}/files`).then((r) => r.json());
  const node = (tree.children as Array<{ id: string; name: string }>).find((c) => c.name === name);
  if (!node) throw new Error(`file ${name} not found`);
  return node.id;
}

test.describe('preview conditionals across files', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Preview Conditionals ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a content-level conditional gated on a main-file attribute shows/hides content live', async ({ page }) => {
    // The flag is set, so the `ifdef::flag[]` content block renders. Removing the flag hides it live.
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n:flag:\n\nifdef::flag[]\nGATED CONTENT\nendif::[]\n\nAlways here.\n',
    );
    await setMainFile(page, projectId, await fileId(page, projectId, 'main.adoc'));

    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'Book');
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('GATED CONTENT', { timeout: 15_000 });
    await expect(output).toContainText('Always here.');

    // Unset the flag — the conditional block disappears, the always-on content stays.
    // The editor is collaborative (Yjs): it mounts read-only and only becomes editable once its
    // document has synced. Under parallel gate load a `select-all` + `type` issued before then is
    // silently dropped, leaving the buffer EMPTY — and since the preview never renders empty content
    // (it holds its last good render) it keeps showing the pre-edit GATED CONTENT, so `not.toContainText`
    // times out on a preview that is faithfully reflecting a buffer whose edit never registered. Wait for
    // the editor to be editable, then confirm the edit actually landed (the `:flag:` entry line is gone
    // from the source) BEFORE asserting on the preview — the same collab-edit guard `liveReplaceLine`
    // uses. This is a deterministic wait on the edit registering, not a longer preview timeout.
    const editor = editorContent(page);
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('= Book\n\nifdef::flag[]\nGATED CONTENT\nendif::[]\n\nAlways here.\n');
    await expect(editor).not.toContainText(':flag:', { timeout: 15_000 }); // the edit registered
    await expect(output).not.toContainText('GATED CONTENT', { timeout: 15_000 });
    await expect(output).toContainText('Always here.');
  });

  test('a conditional wrapping an include includes the target when the flag is set, skips it when unset', async ({ page }) => {
    // The main file gates an include behind `ifdef::flag[]`; the chapter is assembled only when set.
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n:flag:\n\nifdef::flag[]\ninclude::chapter.adoc[]\nendif::[]\n',
    );
    await createAdocFile(page, projectId, 'chapter.adoc', '== Gated Chapter\n\nChapter body text.\n');
    await setMainFile(page, projectId, await fileId(page, projectId, 'main.adoc'));

    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'Book');
    await expandPreview(page);
    await page.getByTestId('show-includes-toggle').click();

    const output = page.getByTestId('asciidoc-output');
    // Flag set ⇒ the include is expanded by the assembler and the chapter renders.
    await expect(output).toContainText('Chapter body text.', { timeout: 15_000 });

    // Unset the flag — the assembler no longer expands the gated include, so the chapter vanishes.
    // Same collab-sync guard as the sibling test above: wait for the editor to be editable and confirm
    // the edit registered (the `:flag:` entry line is gone) before asserting on the preview, so a
    // keystroke dropped against a not-yet-synced editor can't leave the preview stuck on the pre-edit
    // render and time out. A deterministic wait on the edit landing, not a longer preview timeout.
    const editor = editorContent(page);
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('= Book\n\nifdef::flag[]\ninclude::chapter.adoc[]\nendif::[]\n');
    await expect(editor).not.toContainText(':flag:', { timeout: 15_000 }); // the edit registered
    await expect(output).not.toContainText('Chapter body text.', { timeout: 15_000 });
  });
});
