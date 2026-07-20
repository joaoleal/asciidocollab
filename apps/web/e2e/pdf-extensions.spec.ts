import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, setMainFile } from './helpers/editor';

/**
 * End-to-end proof of the three promises the converter-extension feature makes to a project owner
 * and to an administrator, each of which spans layers no single-package test can see at once.
 *
 *   SC-015a  Enabling an extension visibly changes the export; disabling it returns the document
 *            EXACTLY as it was — not merely similar, byte for byte.
 *   SC-015b  Every shipped extension can be enabled together, and the result does not depend on the
 *            order the selection happens to be stored in.
 *   SC-013   An administrator adds an extension by dropping a directory into a folder, with no
 *   SC-013a  rebuild and no restart, and anything malformed or conflicting is REPORTED rather than
 *            silently ignored.
 *
 * **What this covers that the engine-level tests do not.** `warm-vm-extensions.integration.test.ts`
 * already proves per-render isolation inside one warm VM, and proves it more rigorously than a
 * browser can (it holds a cold-VM control to compare against). What it cannot see is the chain that
 * gets a selection from the settings a member edits, through the stored render config, through the
 * catalogue and source endpoints the browser fetches at render time, into the worker — which is
 * where an extension that is enabled in the database but never reaches the VM would look exactly
 * like an extension that does nothing.
 *
 * **Byte-identity is a legitimate assertion here** because `invokeConvert` runs every export through
 * `normalizePdfBytes`, which neutralises `/CreationDate` and `/ModDate`. Without that the same
 * document exported twice would differ in its Info dictionary and this whole file would be measuring
 * the clock.
 *
 * The administrator-folder tests need no wasm engine — they exercise the catalogue API — so they are
 * gated separately from the render tests rather than sharing one skip.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const ENGINE_WASM_PATH = path.join(
  process.cwd(),
  'public',
  'vendor',
  'asciidoctor-pdf',
  'asciidoctor-pdf.wasm',
);
const enginePresent = existsSync(ENGINE_WASM_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored; build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the extension render checks.';

/**
 * The administrator drop folder this stack is configured with.
 *
 * Set by the e2e stack scripts to a writable per-run directory. The production default
 * (`/data/pdf-extensions`) is a bind mount that does not exist here, and a MISSING folder is
 * deliberately the "no extensions offered" case rather than an error — so without this the flow
 * would appear to pass while testing nothing.
 */
const DROP_FOLDER = process.env.ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH;
const DROP_FOLDER_GATE_MESSAGE =
  'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH is not set; run through scripts/ci/e2e-local.sh (or e2e-stack-persist.sh), which points the API at a writable drop folder.';

/** How long the API reuses a drop-folder scan, per the stack scripts. Waited out, not guessed at. */
const SCAN_CACHE_TTL_MS = Number(
  process.env.ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SCAN_CACHE_TTL ?? 1000,
);

/**
 * A document every extension under test has something to do with.
 *
 * `:license:` is what `auto-license-page` acts on, and it is the signal the enable/disable test keys
 * on: the extension adds a whole PAGE, so the effect is visible in the page count rather than in a
 * pixel comparison that could be argued with.
 */
const DOC = [
  '= An Extended Document',
  ':doctype: book',
  ':toc:',
  ':license: This document is placed in the public domain.',
  ':copyright: 2026 The Author',
  '',
  '== The First Chapter',
  '',
  'Opening prose, long enough to occupy a visible part of the measure and to be numbered by the',
  'paragraph-numbering extension when that one is switched on.',
  '',
  '=== A Subsection',
  '',
  'So the contents list has more than one level, and a per-chapter list has something to show.',
  '',
  '== The Second Chapter',
  '',
  'More prose, in a second chapter.',
  '',
].join('\n');

/** Every shipped extension id, read from the catalogue the API actually serves. */
async function shippedExtensionIds(page: Page, projectId: string): Promise<string[]> {
  const response = await page.request.get(
    `${API_URL}/api/projects/${projectId}/pdf-extensions`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data: { entries: { manifest: { id: string }; origin: string }[] };
  };
  return body.data.entries
    .filter((entry) => entry.origin === 'shipped')
    .map((entry) => entry.manifest.id);
}

/** Store `ids` as the project's enabled extensions, exactly in the order given. */
async function setEnabledExtensions(
  page: Page,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  const saved = await page.request.put(`${API_URL}/api/projects/${projectId}/render-config`, {
    data: ids.length === 0 ? {} : { extensions: { enabled: [...ids] } },
  });
  expect(saved.ok()).toBe(true);
}

/**
 * Export the project's PDF through the UI and return where it landed.
 *
 * Exported through the real button rather than by calling the worker directly: the thing most likely
 * to break is the wiring that fetches each enabled extension's source and hands it to the render, and
 * that wiring only runs on this path.
 */
async function exportPdf(page: Page, projectId: string, scratch: string, name: string): Promise<string> {
  // Reloaded every time: the render config is read when the project view mounts, so an export taken
  // without this would use the selection from BEFORE the change and quietly compare a document to
  // itself — which is the one failure this whole file would not survive.
  await openProject(page, projectId);
  const exportButton = page.getByRole('button', { name: /export to pdf/i });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    exportButton.click(),
  ]);
  const pdfPath = path.join(scratch, name);
  await download.saveAs(pdfPath);
  return pdfPath;
}

/** The SHA-256 of a file, for the byte-identity assertions. */
async function hashOf(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/** Page count via poppler, which the parity suite already depends on. */
function pageCount(pdfPath: string): number {
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  const match = /^Pages:\s+(\d+)$/m.exec(info);
  expect(match, `pdfinfo reported no page count for ${pdfPath}`).not.toBeNull();
  return Number(match![1]);
}

/** True when the poppler tools this spec reads PDFs with are installed. */
function popplerAvailable(): boolean {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Write one extension directory into the drop folder. */
function dropExtension(directory: string, manifest: unknown, source = "# no-op\n"): void {
  const base = path.join(DROP_FOLDER!, directory);
  mkdirSync(base, { recursive: true });
  writeFileSync(
    path.join(base, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
  );
  writeFileSync(path.join(base, 'extension.rb'), source);
}

/** Remove a previously dropped extension directory. */
function removeDroppedExtension(directory: string): void {
  rmSync(path.join(DROP_FOLDER!, directory), { recursive: true, force: true });
}

/** A valid manifest for an administrator-provided extension. */
function manifestFor(id: string): Record<string, unknown> {
  return {
    id,
    displayName: `Administrator extension ${id}`,
    description: 'Dropped into the administrator folder by the end-to-end suite.',
  };
}

/** Read the catalogue once the drop-folder scan cache has certainly expired. */
async function catalogueAfterRescan(
  page: Page,
  projectId: string,
): Promise<{
  entries: { manifest: { id: string }; origin: string }[];
  excluded: { source: string; reason: string }[];
  conflicts: { id: string; reason: string }[];
  staleSelections: string[];
}> {
  // Waited out rather than raced: the scan is cached for a bounded time by design (it bounds how
  // long a newly added extension takes to appear), so a read before the cache expires legitimately
  // returns the old listing. Polling instead of sleeping would make a real regression look flaky.
  await new Promise((resolve) => setTimeout(resolve, SCAN_CACHE_TTL_MS + 500));
  const response = await page.request.get(`${API_URL}/api/projects/${projectId}/pdf-extensions`);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  return body.data;
}

test.describe('PDF converter extensions — enabling, disabling and combining', () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('enabling an extension changes the export; disabling it restores it byte for byte', async ({
    page,
  }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    test.skip(!popplerAvailable(), 'poppler-utils is not installed; pdfinfo is needed to count pages.');

    await signIn(page);
    const projectId = await createProject(page, `Extensions Toggle ${Date.now()}`);
    const scratch = mkdtempSync(path.join(tmpdir(), 'pdf-extensions-toggle-'));
    try {
      const mainId = await createAdocFile(page, projectId, 'main.adoc', DOC);
      await setMainFile(page, projectId, mainId);

      // 1. The unextended document, which every later assertion is measured against.
      await setEnabledExtensions(page, projectId, []);
      const baselinePath = await exportPdf(page, projectId, scratch, 'baseline.pdf');
      const baselineHash = await hashOf(baselinePath);
      const baselinePages = pageCount(baselinePath);

      // 2. Enabled: the licence page is a whole extra page, so the effect is visible in the page
      //    count rather than in a comparison that could be argued with.
      await setEnabledExtensions(page, projectId, ['auto-license-page']);
      const enabledPath = await exportPdf(page, projectId, scratch, 'enabled.pdf');
      expect(
        pageCount(enabledPath),
        'enabling auto-license-page adds the licence page to the export',
      ).toBe(baselinePages + 1);
      expect(await hashOf(enabledPath)).not.toBe(baselineHash);

      // 3. Disabled again. Byte-identical, NOT merely the same page count — an extension that left
      //    anything behind (a registered footnote, a bumped counter, a mutated theme) would still
      //    produce the right number of pages while having changed the document.
      await setEnabledExtensions(page, projectId, []);
      const restoredPath = await exportPdf(page, projectId, scratch, 'restored.pdf');
      expect(
        await hashOf(restoredPath),
        'disabling every extension returns the export to the unextended document, byte for byte (SC-015a)',
      ).toBe(baselineHash);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await cleanupProject(page, projectId);
    }
  });

  test('every shipped extension can be enabled at once, whatever order it is stored in', async ({
    page,
  }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    test.skip(!popplerAvailable(), 'poppler-utils is not installed; pdfinfo is needed to count pages.');

    await signIn(page);
    const projectId = await createProject(page, `Extensions All ${Date.now()}`);
    const scratch = mkdtempSync(path.join(tmpdir(), 'pdf-extensions-all-'));
    try {
      const mainId = await createAdocFile(page, projectId, 'main.adoc', DOC);
      await setMainFile(page, projectId, mainId);

      // Read from the catalogue rather than hardcoded, so shipping a tenth extension widens this
      // test instead of leaving it quietly testing nine.
      const allIds = await shippedExtensionIds(page, projectId);
      expect(allIds.length).toBeGreaterThan(0);

      await setEnabledExtensions(page, projectId, allIds);
      const forwardPath = await exportPdf(page, projectId, scratch, 'forward.pdf');
      // Rendered at all: several of these prepend onto the same converter hooks, and a pair that
      // could not coexist would raise rather than produce a document.
      expect(pageCount(forwardPath)).toBeGreaterThan(1);

      // The SAME set, stored in the opposite order. Load order decides output wherever two
      // extensions touch one hook, so the registry sorts by id — and this is what says so. Storing
      // the reverse and getting different bytes would mean a project's output depended on the order
      // an owner happened to tick the boxes in (FR-031c, SC-015b).
      await setEnabledExtensions(page, projectId, allIds.toReversed());
      const reversedPath = await exportPdf(page, projectId, scratch, 'reversed.pdf');
      expect(
        await hashOf(reversedPath),
        'the export does not depend on the order the selection is stored in',
      ).toBe(await hashOf(forwardPath));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await cleanupProject(page, projectId);
    }
  });
});

test.describe('PDF converter extensions — the administrator drop folder', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('an extension dropped into the folder appears without a rebuild or a restart', async ({
    page,
  }) => {
    test.skip(DROP_FOLDER === undefined, DROP_FOLDER_GATE_MESSAGE);

    await signIn(page);
    const projectId = await createProject(page, `Extensions Drop ${Date.now()}`);
    const id = `dropped-${Date.now()}`;
    try {
      // Absent before it is dropped — otherwise "it appeared" could be satisfied by an entry that
      // was there all along.
      const before = await catalogueAfterRescan(page, projectId);
      expect(before.entries.map((entry) => entry.manifest.id)).not.toContain(id);

      dropExtension(id, manifestFor(id));

      const after = await catalogueAfterRescan(page, projectId);
      const entry = after.entries.find((candidate) => candidate.manifest.id === id);
      expect(entry, 'the dropped extension is offered by the catalogue (SC-013)').toBeDefined();
      // Offered as administrator-provided, which is what decides the mount its code is written to.
      expect(entry?.origin).toBe('administrator-provided');
    } finally {
      removeDroppedExtension(id);
      await cleanupProject(page, projectId);
    }
  });

  test('a malformed extension is excluded WITH a reason, and does not take the folder down', async ({
    page,
  }) => {
    test.skip(DROP_FOLDER === undefined, DROP_FOLDER_GATE_MESSAGE);

    await signIn(page);
    const projectId = await createProject(page, `Extensions Malformed ${Date.now()}`);
    const brokenId = `broken-${Date.now()}`;
    const goodId = `good-${Date.now()}`;
    try {
      // A malformed one BESIDE a valid one, deliberately. An administrator's folder failing closed —
      // one bad directory hiding every good one — is the failure worth catching, and a folder
      // containing only the bad entry could not distinguish that from correct exclusion.
      dropExtension(brokenId, '{ not valid json');
      dropExtension(goodId, manifestFor(goodId));

      const catalogue = await catalogueAfterRescan(page, projectId);

      expect(
        catalogue.entries.map((entry) => entry.manifest.id),
        'the valid extension beside it is still offered',
      ).toContain(goodId);
      expect(catalogue.entries.map((entry) => entry.manifest.id)).not.toContain(brokenId);

      // Reported, not silently dropped: an administrator who mistyped a manifest has no other way to
      // learn that the extension they added is not there (FR-033d).
      const exclusion = catalogue.excluded.find((item) => item.source === brokenId);
      expect(exclusion, 'the malformed extension is reported as excluded').toBeDefined();
      expect(exclusion?.reason).toMatch(/manifest\.json/i);
    } finally {
      removeDroppedExtension(brokenId);
      removeDroppedExtension(goodId);
      await cleanupProject(page, projectId);
    }
  });

  test('an id that collides with a shipped extension is reported as a conflict', async ({ page }) => {
    test.skip(DROP_FOLDER === undefined, DROP_FOLDER_GATE_MESSAGE);

    await signIn(page);
    const projectId = await createProject(page, `Extensions Conflict ${Date.now()}`);
    const shipped = await shippedExtensionIds(page, projectId);
    expect(shipped.length).toBeGreaterThan(0);
    const collidingId = shipped[0];
    try {
      dropExtension(collidingId, manifestFor(collidingId));

      const catalogue = await catalogueAfterRescan(page, projectId);

      // The conflict is surfaced (SC-013a). Which side wins is the use case's decision and is
      // asserted where that decision lives; what matters end to end is that the collision reaches an
      // administrator instead of one extension silently shadowing the other.
      const conflict = catalogue.conflicts.find((item) => item.id === collidingId);
      expect(conflict, 'a duplicate id is reported as a conflict').toBeDefined();
      expect(conflict?.reason.length ?? 0).toBeGreaterThan(0);

      // And the id is still offered exactly once — a catalogue listing it twice would put two
      // identically-named toggles in front of an owner.
      const occurrences = catalogue.entries.filter(
        (entry) => entry.manifest.id === collidingId,
      ).length;
      expect(occurrences).toBe(1);
    } finally {
      removeDroppedExtension(collidingId);
      await cleanupProject(page, projectId);
    }
  });
});
