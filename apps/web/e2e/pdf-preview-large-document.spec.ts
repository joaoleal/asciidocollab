import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { MAX_PAGE_FORMAT_SOURCE_BYTES, sourceByteLength } from '@asciidocollab/asciidoc-pdf';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, editorContent } from './helpers/editor';

// The page-formatted render now declares how large a document it supports, and this spec is what makes
// that declaration true from an author's seat rather than only inside the engine package.
//
// The engine is a 32-bit WebAssembly program: everything a render allocates has to fit in one 4 GiB
// address space that only grows, and past a certain amount of content it does not. Before the bound
// existed, a document that crossed that line spent a minute exhausting the space and then surfaced the
// runtime's own words — an allocation failure, or a pointer read as a negative offset — which tells an
// author nothing they can act on and leaves nothing rendering afterwards.
//
// So there are exactly two acceptable outcomes for a big document, and both are checked here: it
// renders, or it is refused in terms the author can act on, with the preview still working for the
// next document. Nothing in between — no engine text, no silently empty panel.

// Resolved from the app root (Playwright's testDir is ./e2e). Without the vendored engine there is no
// page-formatted render at all, so the spec gates on it exactly as the other live-preview specs do.
const ENGINE_WASM_PATH = path.join(
  process.cwd(),
  'public',
  'vendor',
  'asciidoctor-pdf',
  'asciidoctor-pdf.wasm',
);
const enginePresent = existsSync(ENGINE_WASM_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored (public/vendor/asciidoctor-pdf/asciidoctor-pdf.wasm). ' +
  'Build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the size-limit checks.';

/**
 * The document size the page format was previously observed to fail at, in source lines.
 *
 * Recorded in section 6 of `specs/043-preview-responsiveness/baseline.md`. It is the size a report
 * described, and the size the measurement sweep reproduced a failure at — for one document shape.
 */
const PREVIOUS_FAILURE_THRESHOLD_LINES = 1700;

/** The supported document, in lines: twice the size that used to fail, which is the claim under test. */
const SUPPORTED_DOCUMENT_LINES = PREVIOUS_FAILURE_THRESHOLD_LINES * 2;

/**
 * The oversized document, in lines, written in the shape that packs the most source into each one.
 *
 * The same line count as the supported document's half — deliberately. Two documents of identical line
 * count landing on opposite sides of the bound is the clearest possible statement that the bound is
 * about how much writing there is, not how many newlines it is spread across, which is precisely the
 * correction the measured limit made to the reported one.
 */
const OVERSIZED_DOCUMENT_LINES = PREVIOUS_FAILURE_THRESHOLD_LINES;

/** Characters per paragraph in the dense shape; several printed lines each once wrapped. */
const DENSE_PARAGRAPH_CHARACTERS = 400;

/**
 * How long the supported document's first page may take to appear.
 *
 * This is the heaviest render the suite performs: a cold engine start — downloading and instantiating
 * the wasm module, then booting its Ruby VM — followed by laying out tens of printed pages, and then
 * pdf.js painting the first of them. Wide on purpose, and well inside the per-test budget: the claim
 * is that the document renders, not that it renders quickly.
 */
const LARGE_RENDER_TIMEOUT_MS = 360_000;

/** How long a refusal may take to appear. It is decided before the engine is asked for anything. */
const REFUSAL_TIMEOUT_MS = 60_000;

/** How long the small document that follows the refusal may take to render. */
const RECOVERY_RENDER_TIMEOUT_MS = 180_000;

/**
 * Engine wording that must never reach an author.
 *
 * These are the two texts the sweep recorded coming out of an exhausted address space. They describe
 * the runtime rather than the document, and either one appearing on screen would mean the refusal had
 * simply repackaged the crash it exists to replace.
 */
const ENGINE_CRASH_WORDING: readonly string[] = [
  'NoMemoryError',
  'failed to allocate memory',
  'outside the bounds of the buffer',
];

/**
 * A document of `lines` source lines in the sparse shape: sections of prose, a short list and a Ruby
 * source block.
 *
 * The same shape sections 1, 5 and 6 of the baseline were measured on, so a size stated here means the
 * same thing it means there. About 16 bytes to the line, which is what lets a document of twice the
 * previously failing line count still sit inside a bound stated in bytes.
 *
 * @param lines - How many source lines the document should have.
 * @returns The AsciiDoc source.
 */
function sparseDocument(lines: number): string {
  const out: string[] = [
    '= A Long Supported Document',
    '',
    `This document is ${lines} source lines long and is expected to render.`,
    '',
  ];
  let index = 0;
  while (out.length < lines) {
    index += 1;
    out.push(
      `== Section ${index}`,
      '',
      `Prose for section ${index}, long enough that the renderer has real text to lay out and`,
      'the paragraph is not a single short line.',
      '',
      '* a bullet',
      '* another bullet',
      '',
      '[source,ruby]',
      '----',
      `def method_${index}(argument)`,
      '  argument * 2',
      'end',
      '----',
      '',
    );
  }
  return `${out.slice(0, lines).join('\n')}\n`;
}

/**
 * A document of `lines` source lines in the dense shape: long prose paragraphs that wrap across
 * several printed lines each.
 *
 * About 200 bytes to the line — an order of magnitude more writing per line than the sparse shape, and
 * the shape the reported failure was actually written in.
 *
 * @param lines - How many source lines the document should have.
 * @returns The AsciiDoc source.
 */
function denseDocument(lines: number): string {
  const out: string[] = ['= A Document Past The Supported Size', ''];
  let index = 0;
  while (out.length < lines) {
    index += 1;
    const sentence = `Paragraph ${index} of continuous prose that runs on well past the width of a printed page. `;
    const paragraph = sentence
      .repeat(Math.ceil(DENSE_PARAGRAPH_CHARACTERS / sentence.length))
      .slice(0, DENSE_PARAGRAPH_CHARACTERS)
      .trimEnd();
    out.push(paragraph, '');
  }
  return `${out.slice(0, lines).join('\n')}\n`;
}

/** The page-formatted preview surface. */
function pdfPreview(page: Page): Locator {
  return page.locator('[aria-label="PDF preview"]');
}

/** The first `<canvas>` a rendered page is painted into; its presence is a produced document. */
function previewCanvas(page: Page): Locator {
  return page.locator('[aria-label="PDF preview"] canvas').first();
}

/** The panel's fatal-failure notice — the one surface a refused render can explain itself on. */
function previewFailure(page: Page): Locator {
  return page.getByTestId('pdf-preview-error');
}

/**
 * Open the project, open `fileName`, and switch the preview panel to the page format.
 *
 * Waits for the editor to become editable first: the collaborative document mounts read-only and syncs
 * afterwards, and a preview opened over an empty document renders an empty document.
 *
 * @param page - The page to drive.
 * @param projectId - The project to open.
 * @param fileName - The file to open in the editor.
 * @param expectText - Text from that file, waited for so the panel opens over synced content.
 */
async function openPageFormattedPreview(
  page: Page,
  projectId: string,
  fileName: string,
  expectText: string | RegExp,
): Promise<void> {
  await openProject(page, projectId);
  await openFile(page, fileName, expectText);
  await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 60_000 });

  await page.getByRole('button', { name: /expand preview/i }).click();
  await page.getByTestId('preview-mode-pdf').click();
  await expect(pdfPreview(page)).toBeVisible();
}

/**
 * Print a measurement so a run reports what it observed, not merely that it passed.
 *
 * @param line - The line to write, without its newline.
 */
function report(line: string): void {
  process.stdout.write(`\n  ${line}\n`);
}

test.describe('page-formatted preview against the declared document size', () => {
  // Serial, with a wide budget: each test drives a real wasm engine over a document of tens of
  // kilobytes, and two of those running side by side would compete for the same cores and memory.
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    await signIn(page);
    projectId = await createProject(page, `PDF Large Document ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a document twice the size that used to fail renders to the page format', async ({ page }) => {
    const source = sparseDocument(SUPPORTED_DOCUMENT_LINES);
    const bytes = sourceByteLength(source);

    // The document has to be on the supported side of the bound for a successful render to prove
    // anything about the bound, and on the far side of the reported failure for it to be worth
    // proving. Both are properties of the generated document, so both are checked rather than assumed.
    expect(
      SUPPORTED_DOCUMENT_LINES,
      'the supported document must be at least twice the size that was observed to fail',
    ).toBeGreaterThanOrEqual(PREVIOUS_FAILURE_THRESHOLD_LINES * 2);
    expect(
      bytes,
      `the supported document is ${bytes} bytes and must sit inside the declared ` +
        `${MAX_PAGE_FORMAT_SOURCE_BYTES}-byte bound`,
    ).toBeLessThan(MAX_PAGE_FORMAT_SOURCE_BYTES);

    // The page format renders the project's MAIN document, so being previewable here is a matter of
    // what the project points at, not of what happens to be open.
    const nodeId = await createAdocFile(page, projectId, 'supported.adoc', source);
    await setMainFile(page, projectId, nodeId);

    await openPageFormattedPreview(page, projectId, 'supported.adoc', /A Long Supported Document/);

    // A painted page is the whole claim: the engine was asked for this document and produced one.
    await expect(previewCanvas(page)).toBeVisible({ timeout: LARGE_RENDER_TIMEOUT_MS });
    await expect(
      previewFailure(page),
      'a document inside the supported size must render rather than be refused',
    ).toHaveCount(0);

    // And it produced the whole of it, not a first page over a render that gave up: the panel's page
    // count is read from the loaded document, so a document this long must report many pages.
    const totalPagesText = await page.getByTestId('pdf-page-total').textContent();
    const totalPages = Number(totalPagesText ?? '');
    expect(
      totalPages,
      'a document of this length must render to many pages, not to a truncated stub',
    ).toBeGreaterThan(10);

    report(
      `${SUPPORTED_DOCUMENT_LINES} lines / ${bytes} bytes (bound ${MAX_PAGE_FORMAT_SOURCE_BYTES}) → ` +
        `rendered to ${totalPages} pages`,
    );
  });

  test('a document past the supported size is refused in terms the author can act on', async ({
    page,
  }) => {
    const oversized = denseDocument(OVERSIZED_DOCUMENT_LINES);
    const bytes = sourceByteLength(oversized);
    expect(
      bytes,
      `the oversized document is ${bytes} bytes and must exceed the declared ` +
        `${MAX_PAGE_FORMAT_SOURCE_BYTES}-byte bound`,
    ).toBeGreaterThan(MAX_PAGE_FORMAT_SOURCE_BYTES);

    // A second, small document that is NOT part of the main document's tree. The panel previews an
    // out-of-tree file on its own, which is how the recovery below asks for a page-formatted render
    // without reloading the page — the same session, the same panel, a different document.
    await createAdocFile(
      page,
      projectId,
      'aside.adoc',
      '= A Small Aside\n\nA short document that is not part of the main tree.\n',
    );
    const oversizedId = await createAdocFile(page, projectId, 'oversized.adoc', oversized);
    await setMainFile(page, projectId, oversizedId);

    await openPageFormattedPreview(page, projectId, 'oversized.adoc', /A Document Past The Supported Size/);

    const failure = previewFailure(page);
    await expect(
      failure,
      'a document past the supported size must say so rather than fail silently',
    ).toBeVisible({ timeout: REFUSAL_TIMEOUT_MS });
    const messageText = await failure.textContent();
    const message = (messageText ?? '').replaceAll(/\s+/g, ' ').trim();
    report(`${OVERSIZED_DOCUMENT_LINES} lines / ${bytes} bytes → refused with: ${message}`);

    // What the message has to contain to be worth showing. The size it was measured at and the size it
    // is allowed to be, so the author knows how far over they are; and somewhere to go next, since a
    // refusal with no way forward is a dead end however politely it is worded.
    expect(message, 'the refusal must name the size the document was measured at').toContain(
      `${Math.round(bytes / 1000)} kB`,
    );
    expect(message, 'the refusal must name the supported limit').toContain(
      `${Math.round(MAX_PAGE_FORMAT_SOURCE_BYTES / 1000)} kB`,
    );
    expect(message, 'the refusal must say what to do about it').toContain('main document');
    expect(message, 'the refusal must offer a preview that still works').toContain('web-formatted');

    // And what it must NOT contain: the runtime's own account of running out of memory, which is the
    // outcome the bound was introduced to stop authors from ever seeing.
    for (const wording of ENGINE_CRASH_WORDING) {
      expect(message, 'the refusal must not pass the engine’s own crash text through').not.toContain(
        wording,
      );
    }

    // The panel is not left broken by the refusal. Opening a file outside the main document's tree
    // makes it the previewed document, and the page format renders it — in the same session, with no
    // reload, so the engine that never got asked for the oversized document is still there to be asked
    // for this one.
    await openFile(page, 'aside.adoc', /A Small Aside/);
    await expect(page.getByTestId('outside-main-tree-notice')).toBeVisible({ timeout: 30_000 });
    await expect(previewCanvas(page)).toBeVisible({ timeout: RECOVERY_RENDER_TIMEOUT_MS });
    await expect(
      failure,
      'the refusal belongs to the document that caused it and must clear with it',
    ).toHaveCount(0);
  });
});
