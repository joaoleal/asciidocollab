import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  TEST_USER,
  adminDeleteUserByEmail,
  createInvitedUser,
  ensureTestUser,
  loginAdminViaApi,
  logoutViaApi,
} from './helpers/test-user';
import {
  archiveProject,
  cleanupProject,
  createProject,
  createTestFolder,
  signIn,
} from './helpers/test-project';
import {
  EDITOR_EDITABLE_TIMEOUT,
  createAdocFile,
  editorContent,
  expandPreview,
  openFile,
  openProject,
  setMainFile,
  typeAtEnd,
  waitCollabSynced,
} from './helpers/editor';

// End-to-end coverage for copying a project: the dashboard flow that starts one, and what the copy
// is once it exists. The assertions here are the ones no unit test can make — the dropdown is mocked
// in the component tests, and a document that opens BLANK in the collaborative editor (the failure a
// mishandled Yjs copy produces) is only visible against a real collaboration server.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Text planted in the source's main document, and the proof a copied document is not blank. */
const SOURCE_PARAGRAPH = 'The source paragraph that must survive the copy.';

/** Text that exists ONLY in the included chapter, so seeing it proves the include resolved. */
const INCLUDED_SENTENCE = 'Only the included chapter carries this sentence.';

/** A term accepted into the source project's dictionary, expected to travel with the copy. */
const DICTIONARY_TERM = 'Asciidocollab';

/** A review comment left on the source, expected NOT to travel with the copy. */
const REVIEW_BODY = 'A remark that belongs to the source alone.';

const SOURCE_MAIN = [
  '= Cloned Manual',
  '',
  SOURCE_PARAGRAPH,
  '',
  'image::logo.png[Project logo]',
  '',
  'include::chapters/intro.adoc[]',
  '',
].join('\n');

const SOURCE_INTRO = ['== Introduction', '', INCLUDED_SENTENCE, ''].join('\n');

/** A valid 1x1 PNG, so the image macro has real bytes to resolve to without a fixture on disk. */
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
  0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
  0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xE2, 0x21, 0xBC, 0x33,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

/** Keeps every project name in this file distinct from the ones other specs create concurrently. */
function unique(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
}

interface CollabInfo {
  yjsStateId: string;
  documentId: string;
  role: string;
}

interface MemberCredentials {
  email: string;
  password: string;
}

/** Everything a fidelity check needs to address the project it was copied from. */
interface SeededProject {
  projectId: string;
  mainFileNodeId: string;
  mainDocumentId: string;
}

async function projectTree(page: Page, projectId: string): Promise<TreeNode> {
  const response = await page.request.get(`${API_URL}/projects/${projectId}/files`);
  expect(response.ok(), `reading the file tree of ${projectId}`).toBe(true);
  return response.json();
}

function locateNode(node: TreeNode, name: string): TreeNode | null {
  if (node.name === name) return node;
  for (const child of node.children ?? []) {
    const found = locateNode(child, name);
    if (found) return found;
  }
  return null;
}

async function nodeIdByName(page: Page, projectId: string, name: string): Promise<string> {
  const found = locateNode(await projectTree(page, projectId), name);
  if (!found) throw new Error(`project ${projectId} has no file named ${name}`);
  return found.id;
}

async function collabInfo(page: Page, projectId: string, fileNodeId: string): Promise<CollabInfo> {
  const response = await page.request.get(`${API_URL}/projects/${projectId}/files/${fileNodeId}/collab`);
  expect(response.ok(), `reading the collaborative document of ${fileNodeId}`).toBe(true);
  return response.json();
}

async function readProject(page: Page, projectId: string): Promise<{ mainFileNodeId: string | null; archivedAt: string | null }> {
  const response = await page.request.get(`${API_URL}/api/projects/${projectId}`);
  expect(response.ok(), `reading project ${projectId}`).toBe(true);
  const body = await response.json();
  return body.data;
}

async function readRenderConfig(page: Page, projectId: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${API_URL}/api/projects/${projectId}/render-config`);
  expect(response.ok(), `reading the render config of ${projectId}`).toBe(true);
  const body = await response.json();
  return body.data;
}

async function writeRenderConfig(page: Page, projectId: string, config: Record<string, unknown>): Promise<void> {
  const response = await page.request.put(`${API_URL}/api/projects/${projectId}/render-config`, { data: config });
  expect(response.ok(), `saving the render config of ${projectId}`).toBe(true);
}

async function addDictionaryTerm(page: Page, projectId: string, term: string): Promise<void> {
  const response = await page.request.post(`${API_URL}/api/projects/${projectId}/dictionary`, { data: { term } });
  expect(response.ok(), `adding "${term}" to the dictionary of ${projectId}`).toBe(true);
}

async function dictionaryTerms(page: Page, projectId: string): Promise<string[]> {
  const response = await page.request.get(`${API_URL}/api/projects/${projectId}/dictionary`);
  expect(response.ok(), `reading the dictionary of ${projectId}`).toBe(true);
  const body = await response.json();
  return body.data.terms.map((entry: { term: string }) => entry.term);
}

async function addReviewComment(page: Page, projectId: string, documentId: string, body: string): Promise<void> {
  const response = await page.request.post(`${API_URL}/projects/${projectId}/documents/${documentId}/review-items`, {
    data: { kind: 'comment', body, anchor: { quote: { exact: SOURCE_PARAGRAPH } } },
  });
  expect(response.ok(), `leaving a review comment on ${documentId}`).toBe(true);
}

async function reviewThreadCount(page: Page, projectId: string, documentId: string): Promise<number> {
  const response = await page.request.get(`${API_URL}/projects/${projectId}/documents/${documentId}/review-items`);
  expect(response.ok(), `listing the review items of ${documentId}`).toBe(true);
  const body = await response.json();
  return body.data.threads.length;
}

async function readFileContent(page: Page, projectId: string, fileNodeId: string): Promise<string> {
  const response = await page.request.get(`${API_URL}/projects/${projectId}/files/${fileNodeId}/content`);
  expect(response.ok(), `reading the content of ${fileNodeId}`).toBe(true);
  return response.text();
}

/** Invites a fresh user and gives them `role` on the project, so the menu can be seen through their eyes. */
async function addMember(page: Page, projectId: string, role: 'editor' | 'viewer'): Promise<MemberCredentials> {
  const email = `clone-${role}-${unique()}@example.com`;
  const password = 'MemberP@ssw0rd123!';
  await createInvitedUser(page, email, password, `Clone ${role}`);
  const response = await page.request.post(`${API_URL}/api/projects/${projectId}/members`, {
    data: { email, role },
  });
  expect(response.ok(), `adding a ${role} to ${projectId}`).toBe(true);
  return { email, password };
}

/** Starts a clone through the API and returns the new project's id. */
async function cloneViaApi(page: Page, projectId: string, name: string): Promise<string> {
  const response = await page.request.post(`${API_URL}/api/projects/${projectId}/clone`, { data: { name } });
  expect(response.ok(), `cloning ${projectId} as "${name}" (${response.status()} ${await response.text()})`).toBe(true);
  const body = await response.json();
  return body.data.id;
}

/**
 * The card for a named project. Its stretched link carries the project name as its accessible name
 * and is a direct child of the card, so the card is that link's parent.
 */
function projectCard(page: Page, projectName: string): Locator {
  return page.getByRole('link', { name: projectName, exact: true }).locator('xpath=..');
}

async function openProjectMenu(page: Page, projectName: string): Promise<void> {
  await projectCard(page, projectName).getByRole('button', { name: 'Project options' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/**
 * Runs the clone dialog from an already-open card menu and returns the copy's id, read from the
 * confirmation's own link rather than from the API — the link is what the user is offered.
 */
async function cloneThroughDialog(page: Page, cloneName: string): Promise<string> {
  await page.getByRole('menuitem', { name: /^clone$/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The menu must not survive into the modal: it would sit behind it and still be hanging over the
  // card once the dialog closes. Only an end-to-end run can see this — the dropdown is mocked in the
  // component tests.
  await expect(page.getByRole('menu')).toHaveCount(0);

  await dialog.getByLabel(/name for the copy/i).fill(cloneName);
  await dialog.getByRole('button', { name: /^clone$/i }).click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('menu')).toHaveCount(0);

  const openLink = page.getByRole('link', { name: `Open ${cloneName}`, exact: true });
  await expect(openLink).toBeVisible();
  const href = await openLink.getAttribute('href');
  const cloneId = (href ?? '').split('/').pop();
  if (!cloneId) throw new Error(`the confirmation for "${cloneName}" carries no link to the copy`);
  return cloneId;
}

/**
 * Reads a ZIP's central directory into `path → checksum:size`.
 *
 * Comparing the two archives byte for byte would compare their timestamps as well, which differ by
 * construction; the per-entry CRC the format already carries is the content comparison, and it needs
 * no decompression to read.
 */
function zipEntryChecksums(archive: Buffer): Record<string, string> {
  const END_OF_CENTRAL_DIRECTORY = 0x06_05_4B_50;
  const CENTRAL_DIRECTORY_ENTRY = 0x02_01_4B_50;

  let end = -1;
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('the downloaded archive has no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries: Record<string, string> = {};
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`central-directory entry ${index} of the downloaded archive is malformed`);
    }
    const checksum = archive.readUInt32LE(cursor + 16).toString(16);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries[name] = `${checksum}:${uncompressedSize}`;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function exportedEntries(page: Page, projectId: string): Promise<Record<string, string>> {
  const response = await page.request.get(`${API_URL}/projects/${projectId}/download`);
  expect(response.ok(), `exporting ${projectId}`).toBe(true);
  return zipEntryChecksums(await response.body());
}

test.describe('Project cloning', () => {
  /** Every project this file creates, torn down as the administrator whatever session a test ended in. */
  let createdProjectIds: string[] = [];
  /** Every user this file invites, likewise. */
  let invitedEmails: string[] = [];

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test.afterEach(async ({ page }) => {
    // A role test signs in as someone else; the cleanup below is the administrator's to do.
    await loginAdminViaApi(page);
    for (const projectId of createdProjectIds) await cleanupProject(page, projectId);
    for (const email of invitedEmails) await adminDeleteUserByEmail(page, email);
    createdProjectIds = [];
    invitedEmails = [];
  });

  /** Creates a project, remembering it for teardown. */
  async function newProject(page: Page, name: string): Promise<string> {
    const projectId = await createProject(page, name);
    createdProjectIds.push(projectId);
    return projectId;
  }

  /**
   * Builds a project worth copying: a main document that includes a chapter and references an
   * uploaded image, with the main file designated so the include is assembled in the preview.
   */
  async function seedSourceProject(page: Page, name: string): Promise<SeededProject> {
    const projectId = await newProject(page, name);
    const { id: rootFolderId } = await projectTree(page, projectId);
    const chaptersId = await createTestFolder(page, projectId, rootFolderId, 'chapters');
    await createAdocFile(page, projectId, 'intro.adoc', SOURCE_INTRO, chaptersId);
    const mainFileNodeId = await createAdocFile(page, projectId, 'main.adoc', SOURCE_MAIN, rootFolderId);

    const upload = await page.request.post(`${API_URL}/projects/${projectId}/assets?parentId=${rootFolderId}`, {
      multipart: { file: { name: 'logo.png', mimeType: 'image/png', buffer: MINIMAL_PNG } },
    });
    expect(upload.ok(), `uploading the source image to ${projectId}`).toBe(true);

    await setMainFile(page, projectId, mainFileNodeId);
    const { documentId } = await collabInfo(page, projectId, mainFileNodeId);
    return { projectId, mainFileNodeId, mainDocumentId: documentId };
  }

  test.describe('from the projects dashboard', () => {
    let sourceName: string;
    let sourceId: string;

    test.beforeEach(async ({ page }) => {
      await signIn(page);
      sourceName = `Clone Source ${unique()}`;
      sourceId = await newProject(page, sourceName);
    });

    test('the card menu offers Clone to every role and members and settings to the owner alone', async ({ page }) => {
      const editor = await addMember(page, sourceId, 'editor');
      const viewer = await addMember(page, sourceId, 'viewer');
      invitedEmails.push(editor.email, viewer.email);

      await page.goto('/dashboard');
      await openProjectMenu(page, sourceName);
      await expect(page.getByRole('menuitem')).toHaveText([/^Members$/, /^Settings$/, /^Clone$/]);
      await page.keyboard.press('Escape');

      // A member who is not the owner is offered Clone and nothing else: both other destinations
      // refuse a non-owner, and the menu must never offer an item that would then be refused.
      for (const member of [editor, viewer]) {
        await logoutViaApi(page);
        await signIn(page, member.email, member.password);
        await page.goto('/dashboard');
        await openProjectMenu(page, sourceName);
        await expect(page.getByRole('menuitem')).toHaveText([/^Clone$/]);
        await page.keyboard.press('Escape');
      }
    });

    test('a clone appears on the dashboard without a reload and its confirmation opens a project the cloner alone owns', async ({ page }) => {
      await page.goto('/dashboard');
      await openProjectMenu(page, sourceName);

      const dialog = page.getByRole('dialog');
      await page.getByRole('menuitem', { name: /^clone$/i }).click();
      await expect(dialog).toBeVisible();
      const nameField = dialog.getByLabel(/name for the copy/i);
      await expect(nameField).toHaveValue(`Copy of ${sourceName}`);
      await expect(page.getByRole('menu')).toHaveCount(0);

      // The menu closes and the dialog takes the focus with it, landing on the name with the whole
      // suggestion selected so the first keystroke replaces it. Both halves are asserted before
      // anything types into the field: filling it would focus and deselect it, and a hand-off that
      // never happened would look identical afterwards. Only a real browser can see this — the
      // menu is mocked away in the component tests.
      await expect(nameField).toBeFocused();
      const selection = await nameField.evaluate((element: HTMLInputElement) =>
        element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0),
      );
      expect(selection).toBe(`Copy of ${sourceName}`);

      const cloneName = `Clone Copy ${unique()}`;
      await nameField.fill(cloneName);
      await dialog.getByRole('button', { name: /^clone$/i }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByRole('menu')).toHaveCount(0);

      // The user is left where they were, and the listing gains the copy without being refetched.
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(projectCard(page, cloneName)).toBeVisible();

      const openLink = page.getByRole('link', { name: `Open ${cloneName}`, exact: true });
      await expect(openLink).toBeVisible();
      const cloneId = (await openLink.getAttribute('href') ?? '').split('/').pop() ?? '';
      expect(cloneId, 'the confirmation must link to the copy').not.toBe('');
      createdProjectIds.push(cloneId);

      await openLink.click();
      await page.waitForURL(`**/dashboard/projects/${cloneId}`);

      const members = await page.request.get(`${API_URL}/api/projects/${cloneId}/members`).then((r) => r.json());
      expect(members.data.members).toHaveLength(1);
      expect(members.data.members[0]).toMatchObject({ email: TEST_USER.email, role: 'owner' });
    });

    test('an archived project can be cloned from the archived listing and the copy is active', async ({ page }) => {
      await archiveProject(page, sourceId);

      await page.goto('/dashboard/archived');
      await openProjectMenu(page, sourceName);
      const cloneName = `Clone Of Archived ${unique()}`;
      const cloneId = await cloneThroughDialog(page, cloneName);
      createdProjectIds.push(cloneId);

      // An active project has no place in an archived listing, so the copy is deliberately NOT
      // inserted here — the confirmation is what carries it.
      await expect(projectCard(page, cloneName)).toHaveCount(0);

      // …and the copy really is active: it is listed among the active projects.
      await page.goto('/dashboard');
      await expect(projectCard(page, cloneName)).toBeVisible();
      const copy = await readProject(page, cloneId);
      expect(copy.archivedAt).toBeNull();
    });
  });

  test.describe('fidelity and isolation of the copy', () => {
    // Each test here drives the collaborative editor and/or the preview worker against a freshly
    // copied project: a cold Yjs handshake plus a cold render is more than the suite's default budget.
    test.describe.configure({ timeout: 180_000 });

    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test('a cloned document opens in the editor with its content, and its include and image resolve unedited', async ({ page }) => {
      const source = await seedSourceProject(page, `Clone Fidelity Source ${unique()}`);
      const cloneId = await cloneViaApi(page, source.projectId, `Clone Fidelity Copy ${unique()}`);
      createdProjectIds.push(cloneId);

      await openProject(page, cloneId);
      await openFile(page, 'main.adoc', SOURCE_PARAGRAPH);
      await waitCollabSynced(page);
      // The copy's text arrives through the collaboration server, which is the only place a
      // mishandled document copy shows itself — as an empty editor rather than a wrong one.
      await expect(editorContent(page)).toContainText(SOURCE_PARAGRAPH);

      await expandPreview(page);
      await page.getByTestId('show-includes-toggle').click();
      const output = page.getByTestId('asciidoc-output');
      await expect(output).toContainText(INCLUDED_SENTENCE, { timeout: 30_000 });
      await expect(output).not.toContainText('include::chapters/intro.adoc');

      // The image macro is unchanged from the source, so it can only resolve if the bytes were
      // copied to the same project-relative path.
      const image = output.locator('img');
      await expect(image).toHaveCount(1);
      await expect(async () => {
        const naturalHeight = await image.evaluate((element: HTMLImageElement) => element.naturalHeight);
        expect(naturalHeight, 'the copied image must load, not break').toBeGreaterThan(0);
      }).toPass({ timeout: 15_000 });
    });

    test('the copy carries the main file, the render settings and the dictionary, and none of the review discussion', async ({ page }) => {
      const source = await seedSourceProject(page, `Clone Settings Source ${unique()}`);
      await writeRenderConfig(page, source.projectId, { doctype: 'book', sectnums: true });
      await addDictionaryTerm(page, source.projectId, DICTIONARY_TERM);
      await addReviewComment(page, source.projectId, source.mainDocumentId, REVIEW_BODY);
      // Without this the "no comments in the copy" assertion below would pass on an unseeded source.
      expect(await reviewThreadCount(page, source.projectId, source.mainDocumentId)).toBe(1);

      const cloneId = await cloneViaApi(page, source.projectId, `Clone Settings Copy ${unique()}`);
      createdProjectIds.push(cloneId);

      const cloneMainFileNodeId = await nodeIdByName(page, cloneId, 'main.adoc');
      const clone = await readProject(page, cloneId);
      expect(clone.mainFileNodeId).toBe(cloneMainFileNodeId);
      expect(clone.mainFileNodeId).not.toBe(source.mainFileNodeId);

      expect(await readRenderConfig(page, cloneId)).toMatchObject({ doctype: 'book', sectnums: true });
      expect(await dictionaryTerms(page, cloneId)).toContain(DICTIONARY_TERM);

      const cloneDocument = await collabInfo(page, cloneId, cloneMainFileNodeId);
      expect(await reviewThreadCount(page, cloneId, cloneDocument.documentId)).toBe(0);
    });

    test('editing either project after the copy leaves the other untouched', async ({ page }) => {
      const source = await seedSourceProject(page, `Clone Isolation Source ${unique()}`);
      const cloneId = await cloneViaApi(page, source.projectId, `Clone Isolation Copy ${unique()}`);
      createdProjectIds.push(cloneId);

      const cloneMainFileNodeId = await nodeIdByName(page, cloneId, 'main.adoc');
      const cloneDocument = await collabInfo(page, cloneId, cloneMainFileNodeId);
      const sourceDocument = await collabInfo(page, source.projectId, source.mainFileNodeId);
      // Sharing either identity would make the two documents one, live edits included.
      expect(cloneDocument.documentId).not.toBe(sourceDocument.documentId);
      expect(cloneDocument.yjsStateId).not.toBe(sourceDocument.yjsStateId);

      const cloneMarker = 'EditedInTheCopyOnly';
      const sourceMarker = 'EditedInTheSourceOnly';

      await openProject(page, cloneId);
      await openFile(page, 'main.adoc', SOURCE_PARAGRAPH);
      await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
      await typeAtEnd(page, `\n${cloneMarker}\n`);
      await expect(editorContent(page)).toContainText(cloneMarker);

      await openProject(page, source.projectId);
      await openFile(page, 'main.adoc', SOURCE_PARAGRAPH);
      await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: EDITOR_EDITABLE_TIMEOUT });
      await expect(editorContent(page)).not.toContainText(cloneMarker);
      await typeAtEnd(page, `\n${sourceMarker}\n`);
      await expect(editorContent(page)).toContainText(sourceMarker);

      // Reopening the copy proves its edit reached the server (so the check above was not satisfied
      // by an edit that never left the browser) and that the source's edit did not follow it there.
      await openProject(page, cloneId);
      await openFile(page, 'main.adoc', cloneMarker);
      await expect(editorContent(page)).not.toContainText(sourceMarker);

      // Settings are separate too: the copy's render config is its own.
      await writeRenderConfig(page, cloneId, { doctype: 'book' });
      expect(await readRenderConfig(page, source.projectId)).toEqual({});
      expect(await readFileContent(page, source.projectId, source.mainFileNodeId)).not.toContain(cloneMarker);
    });

    test('exporting the copy yields the same files and the same bytes as exporting the source', async ({ page }) => {
      const source = await seedSourceProject(page, `Clone Export Source ${unique()}`);
      const cloneId = await cloneViaApi(page, source.projectId, `Clone Export Copy ${unique()}`);
      createdProjectIds.push(cloneId);

      // A plain equality check between the two exports, deliberately: this feature adds no rendering
      // path, so what has to hold is copy ≡ source — not that either matches a reference build.
      const sourceEntries = await exportedEntries(page, source.projectId);
      expect(Object.keys(sourceEntries)).toEqual(
        expect.arrayContaining(['main.adoc', 'chapters/intro.adoc', 'logo.png']),
      );
      expect(await exportedEntries(page, cloneId)).toEqual(sourceEntries);
    });
  });
});
