import { Page, Locator, expect } from '@playwright/test';
import { createTestFile } from './test-project';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Shared Playwright helpers for the AsciiDoc editor e2e specs. These
 * drive the live CodeMirror surface — opening a project file, reading/typing
 * content, asserting token classes, folding, autocomplete, lint markers, and
 * active-file switches — so each per-story spec stays focused on its behaviour.
 */

/** Write file content through the existing REST file-content endpoint. */
export async function writeFileContent(
  page: Page,
  projectId: string,
  fileNodeId: string,
  content: string,
): Promise<void> {
  const response = await page.request.put(
    `${API_URL}/projects/${projectId}/files/${fileNodeId}/content`,
    { headers: { 'Content-Type': 'text/plain' }, data: content },
  );
  if (!response.ok()) {
    throw new Error(`writeFileContent failed: ${response.status()} ${await response.text()}`);
  }
}

/** Create an `.adoc` file with seeded content and return its node id. */
export async function createAdocFile(
  page: Page,
  projectId: string,
  name: string,
  content: string,
  parentId: string | null = null,
): Promise<string> {
  const fileNodeId = await createTestFile(page, projectId, parentId, name);
  await writeFileContent(page, projectId, fileNodeId, content);
  return fileNodeId;
}

/** Configure (or clear, with null) the project's main file via the REST endpoint. */
export async function setMainFile(
  page: Page,
  projectId: string,
  mainFileNodeId: string | null,
): Promise<void> {
  const response = await page.request.put(`${API_URL}/projects/${projectId}/main-file`, {
    headers: { 'Content-Type': 'application/json' },
    data: { mainFileNodeId },
  });
  if (!response.ok()) {
    throw new Error(`setMainFile failed: ${response.status()} ${await response.text()}`);
  }
}

/** Navigate to a project and wait until the initial loading indicator is gone. */
export async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
}

/**
 * Open a file from the project tree and wait for the editor to mount.
 *
 * Pass `expectText` to ALSO wait for the collaborative document to sync its
 * content in. The editor mounts (`.cm-content` becomes visible) before its Yjs
 * document has synced, so under load a content-dependent assertion — or an
 * `expandPreview()` call, which silently schedules no render while `content` is
 * empty — can race the empty pre-sync document. Waiting for known text here
 * collapses that race and keeps the sync lag out of later timeout budgets.
 */
export async function openFile(
  page: Page,
  fileName: string,
  expectText?: string | RegExp,
): Promise<void> {
  await page.getByTestId(`tree-node-${fileName}`).click();
  await expect(editorContent(page)).toBeVisible({ timeout: 15_000 }); // cold editor mount under gate load
  if (expectText !== undefined) {
    await expect(editorContent(page)).toContainText(expectText, { timeout: 15_000 });
  }
}

/** Locator for the CodeMirror editable content. */
export function editorContent(page: Page): Locator {
  return page.locator('.cm-editor .cm-content');
}

/** Read the full editor text by joining the rendered `.cm-line` elements. */
export async function getEditorText(page: Page): Promise<string> {
  const lines = await page.locator('.cm-editor .cm-line').allInnerTexts();
  return lines.join('\n');
}

/**
 * Rename the first occurrence of `word` in the editor to `replacement` by double-clicking it and
 * typing over the selection.
 *
 * Robust against the collab-sync race: the editor mounts read-only (`contenteditable="false"`) and
 * only becomes editable once its Yjs document has synced, so under parallel gate load a double-click +
 * type issued too early is silently dropped — the definition never changes, the rename is never
 * detected, and the offer never appears. This waits for the editor to be editable first, then confirms
 * the edit actually registered before returning.
 *
 * @param page - The Playwright page.
 * @param word - The exact word to double-click (its first DOM occurrence).
 * @param replacement - The text typed over the selected word.
 */
/**
 * How long to wait for the collaborative editor to become editable (`contenteditable="true"`).
 *
 * The editor mounts read-only and only flips editable once its Yjs document has synced through the
 * collab server. Under full gate load — several parallel browser workers driving Yjs sessions against
 * one test collab server, on a box that may also be running a dev stack — that handshake occasionally
 * runs well past the couple of seconds it takes idle. 15s was under-budgeted for that worst case and
 * surfaced as retried "editor never became editable" timeouts; this is sized for the loaded handshake,
 * the same worst-case-load reasoning behind the suite's other budgets. One shared constant so every
 * collab-edit site (these helpers and the specs that inline the guard) waits by the SAME rule, and
 * widening a wait can never slow a test that meets it quickly — only the starved case waits longer.
 */
export const EDITOR_EDITABLE_TIMEOUT = 30_000;

export async function renameFirstWord(page: Page, word: string, replacement: string): Promise<void> {
  const content = editorContent(page);
  await expect(content).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
  await content.getByText(word, { exact: false }).first().dblclick();
  await page.keyboard.type(replacement);
  await expect(content).toContainText(replacement, { timeout: 10_000 }); // the edit registered
}

/**
 * Live-edit: deterministically replace the whole logical line that contains `matchText` with
 * `newLine`, by selecting the line (Home → Shift+End) and typing over it.
 *
 * Prefer this over double-clicking a word to edit it: `getByText(word)` resolves to the enclosing
 * `.cm-line`, so `dblclick()` lands on the LINE's centre and selects whichever word sits there — for
 * `:productName: Acme` that is `productName`, not `Acme`, silently corrupting the edit. Selecting the
 * whole line by keyboard (the same reliable sequence `liveDeleteLineContaining` uses) has no such
 * word-position ambiguity. Waits for the collaborative editor to be editable first (Yjs sync race).
 *
 * @param page - The Playwright page whose editor is edited.
 * @param matchText - Text uniquely identifying the target line (clicked to place the caret in it).
 * @param newLine - The full replacement line text typed over the selected line.
 */
export async function liveReplaceLine(page: Page, matchText: string, newLine: string): Promise<void> {
  const content = editorContent(page);
  await expect(content).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
  await content.getByText(matchText, { exact: false }).first().click();
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.keyboard.type(newLine);
  await expect(content).toContainText(newLine, { timeout: 10_000 }); // the edit registered
}

/** Place the cursor at the end of the document and type `text`. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editorContent(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

/** Toggle the HTML preview open (expand) / closed. */
export async function expandPreview(page: Page): Promise<void> {
  // Collapse the pre-sync race systemically: expanding while the collaborative (Yjs) document is
  // still empty schedules NO preview render, so the panel would stay blank and cross-file assertions
  // would flake. Wait for the editor to show synced (non-whitespace) content first. Soft (`.catch`)
  // so a legitimately empty document still expands — that path just eats the short wait.
  await page
    .locator('.cm-editor .cm-content')
    .filter({ hasText: /\S/ })
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {
      /* genuinely empty document — expand anyway */
    });
  await page.getByRole('button', { name: /expand preview/i }).click();
  // Cold-start tolerant: the first preview render must spin up the AsciiDoc→HTML web worker (bundle
  // load + Asciidoctor init), which under gate load occasionally exceeds a tighter budget on the
  // first attempt (warm on retry). Kept within the per-test timeout so it absorbs the cold start.
  await expect(page.getByTestId('asciidoc-output')).toBeVisible({ timeout: 25_000 });
}

export async function collapsePreview(page: Page): Promise<void> {
  await page.getByRole('button', { name: /collapse preview/i }).click();
}

/**
 * Assert that some highlighted token element with the given CSS class contains
 * `text`. Token classes are emitted by the AsciiDoc HighlightStyle (e.g.
 * `cm-ad-link`, `cm-ad-conditional`).
 */
export async function expectToken(page: Page, className: string, text: string): Promise<void> {
  await expect(
    page.locator(`.cm-content .${className}`, { hasText: text }).first(),
  ).toBeVisible({ timeout: 5000 });
}

/** Locator for the autocomplete listbox; trigger it with Ctrl+Space first. */
export function autocompleteList(page: Page): Locator {
  return page.locator('.cm-tooltip-autocomplete');
}

export async function triggerAutocomplete(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+Space');
  const list = autocompleteList(page);
  await expect(list).toBeVisible({ timeout: 5000 });
  return list;
}

/** Locator for lint underline ranges produced by `@codemirror/lint`. */
export function lintMarkers(page: Page): Locator {
  return page.locator('.cm-lintRange');
}

/**
 * Locator for *open* foldable fold-gutter cells — the cell carries a
 * `title="Fold line"` marker and has real layout (CM also emits a hidden
 * zero-height "Unfold line" measurement cell, which this selector excludes).
 * CM's gutter delegates the fold click to the line, so clicking the cell folds it.
 */
export function foldGutterMarkers(page: Page): Locator {
  return page.locator('.cm-lnfold-gutter .cm-gutterElement:has(span[title="Fold line"])');
}

/** Click the first foldable gutter cell. */
export async function clickFirstFold(page: Page): Promise<void> {
  await foldGutterMarkers(page).first().click();
}

/** Locator for collapsed fold placeholders. */
export function foldPlaceholders(page: Page): Locator {
  return page.locator('.cm-foldPlaceholder');
}

/** Assert that the named file is the active file in the tree (selected). */
export async function expectActiveFile(page: Page, fileName: string): Promise<void> {
  await expect(page.getByTestId(`tree-node-${fileName}`)).toHaveAttribute(
    'aria-current',
    'true',
    { timeout: 8000 },
  );
}
