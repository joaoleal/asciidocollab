import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, expandPreview, editorContent } from './helpers/editor';

/**
 * Clicking a line in the editor must reveal THAT line's block in the preview — including when an
 * `include::` above it has inlined a hundred lines of someone else's file.
 *
 * This is the case the suite could not see. Asciidoctor reports every block's line in ASSEMBLED
 * coordinates, while the editor only knows the open file's own lines; the two diverge by exactly the
 * amount of inlined content above the click. The preview looked the open-file number up in a DOM keyed
 * by assembled numbers and — because the lookup falls back to the nearest preceding block rather than
 * failing — silently scrolled to the wrong place. Every existing fixture missed it twice over: none had
 * an `include::` at all, so the two coordinate spaces coincided, and the scroll assertions only checked
 * that `scrollTop` had moved, never WHICH block it moved to.
 *
 * So the assertion here is about identity: the clicked paragraph must end up at the top of the preview's
 * scroll container. A wrong-block scroll still moves `scrollTop`, and would pass the old style of check.
 */

const TARGET = 'UNIQUETARGET paragraph below the include';

/** Enough inlined content that a wrong translation cannot coincidentally land near the right block. */
const CHILD = Array.from({ length: 25 }, (_, index) => `Child filler paragraph ${index + 1}.`).join('\n\n');

/** Trailing content so the target can actually reach the top of the container (no bottom clamp). */
const TAIL = Array.from({ length: 25 }, (_, index) => `Tail filler paragraph ${index + 1}.`).join('\n\n');

const MAIN = `= Book\n\ninclude::child.adoc[]\n\n== Target Section\n\n${TARGET}.\n\n${TAIL}\n`;

/**
 * Distance in CSS pixels between the top of the element rendering `text` and the top of the preview's
 * scroll container. Near zero means the preview scrolled to that block; a large value means it scrolled
 * somewhere else, which is precisely the bug this guards.
 *
 * @param page - The page under test.
 * @param text - Text identifying the rendered block.
 * @returns The signed offset, or NaN when the block is not rendered.
 */
async function offsetFromTop(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const container = document.querySelector('[data-testid="preview-scroll-container"]');
    const output = document.querySelector('[data-testid="asciidoc-output"]');
    if (!container || !output) return Number.NaN;
    const target = [...output.querySelectorAll('p')].find((element) => element.textContent?.includes(needle));
    if (!target) return Number.NaN;
    return target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }, text);
}

test.describe('editor click below an include', () => {
  // Collaborative sync, an assembled render of two files, and a real scroll animation.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Click Below Include ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('reveals the clicked line\'s own block, not one shifted by the inlined include', async ({ page }) => {
    await createAdocFile(page, projectId, 'child.adoc', `${CHILD}\n`);
    await createAdocFile(page, projectId, 'main.adoc', MAIN);

    await openProject(page, projectId);
    // Wait for the TARGET itself: it proves the collaborative document synced in, not merely that an
    // editor mounted with some content.
    await openFile(page, 'main.adoc', TARGET);
    await expandPreview(page);

    // Inline the include. With bodies hidden the assembler emits a short placeholder, so the two
    // coordinate spaces barely diverge and the bug can hide; inlining is what makes them disagree.
    await page.getByTestId('show-includes-toggle').click();
    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('Child filler paragraph 25.', { timeout: 20_000 });
    await expect(output).toContainText(TARGET, { timeout: 20_000 });

    // Put the caret on the target line and confirm it before clicking — pressing/clicking and acting in
    // the same breath is the race that made other preview specs flaky.
    const targetLine = editorContent(page).getByText(TARGET, { exact: false }).first();
    await targetLine.click();
    await expect(page.locator('.cm-editor .cm-activeLine')).toContainText(TARGET, { timeout: 10_000 });

    await page.locator('.cm-editor .cm-activeLine').click({ modifiers: ['Control'] });

    await expect(async () => {
      const offset = await offsetFromTop(page, TARGET);
      expect(Number.isNaN(offset), 'the target paragraph must be rendered in the preview').toBe(false);
      // Tolerance covers container padding and the heading margin above the block, nothing more. A scroll
      // to a neighbouring block in a document this size is hundreds of pixels away.
      expect(
        Math.abs(offset),
        'the preview must scroll to the clicked line\'s own block',
      ).toBeLessThan(150);
    }).toPass({ timeout: 15_000 });
  });
});
