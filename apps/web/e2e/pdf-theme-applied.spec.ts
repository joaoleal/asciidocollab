import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFolder } from './helpers/test-project';
import { createAdocFile, openProject, setMainFile } from './helpers/editor';

// End-to-end proof that a project's PDF theme is actually APPLIED to the exported document — the whole
// chain, from the selection stored in project options through snapshot construction and attribute
// wiring to the real wasm engine.
//
// This exists because of a defect that unit tests could not see. Every layer was individually correct:
// the settings page stored a project-relative path, the snapshot builder resolved that path and derived
// `pdf-themesdir` from it, and the convert layered the project's own attributes last so a project could
// override the wiring. Combined, the raw path overrode the resolved leaf name while the directory was
// already the theme's own — so the engine resolved `branding/branding/corporate-theme.yml`, found
// nothing, and fell back to the built-in theme.
//
// The failure mode is what makes an end-to-end check necessary: an unresolvable theme is not an error
// in Asciidoctor-PDF. It renders a perfectly good PDF in the default theme. Nothing logs, nothing
// warns, and every assertion about text content still passes. Only looking at what the PDF is actually
// STYLED with catches it, so this test keys on the theme's colours rather than on its words.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const ENGINE_WASM_PATH = path.join(process.cwd(), 'public', 'vendor', 'asciidoctor-pdf', 'asciidoctor-pdf.wasm');
const enginePresent = existsSync(ENGINE_WASM_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored; build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the theme-application checks.';

/**
 * The theme lives in a SUBFOLDER on purpose. A theme at the project root resolves correctly even when
 * the directory is doubled, so a root-level fixture would have passed throughout the regression.
 */
const THEME_FOLDER = 'branding';
const THEME_FILE = 'corporate-theme.yml';

/**
 * The theme's heading colour (B03A2E), chosen to be far from anything the default theme uses.
 *
 * Verified to discriminate: rendering this document WITH the theme puts ~2000 pixels within tolerance
 * of it on page one, and rendering it without the theme puts exactly zero.
 */
const HEADING_RGB: readonly [number, number, number] = [176, 58, 46];
/** Per-channel tolerance, absorbing the antialiasing around glyph edges. */
const COLOUR_TOLERANCE = 24;
/** How many matching pixels count as "the heading is drawn in this colour" rather than noise. */
const MIN_MATCHING_PIXELS = 200;

const THEME = [
  'extends: default',
  'heading:',
  // B03A2E — nothing in the default theme is near it.
  '  font-color: B03A2E',
  'base:',
  '  font-color: 1B3A57',
  '',
].join('\n');

const DOC = ['= Themed Document', '', '== A heading the theme colours', '', 'Body text.', ''].join('\n');

/**
 * Count the pixels on a rasterised page within `tolerance` of `target`.
 *
 * Parses the binary PPM `pdftoppm` emits — a tiny header followed by raw RGB triples — so the check
 * needs no image library and no canvas backend, only the poppler tools the parity suite already
 * depends on. Rasterising rather than reading the content stream is deliberate: it measures what the
 * page LOOKS like, which is the thing a theme is responsible for.
 *
 * @param ppmPath - The rasterised page.
 * @param target - The RGB colour to look for.
 * @param tolerance - Per-channel tolerance, absorbing glyph antialiasing.
 * @returns How many pixels matched.
 */
/** True for the whitespace bytes a PPM header separates its fields with. */
function isPpmSpace(byte: number): boolean {
  return byte === 32 || byte === 10 || byte === 13 || byte === 9;
}

function countPixelsNear(
  ppmPath: string,
  target: readonly [number, number, number],
  tolerance: number,
): number {
  const bytes = readFileSync(ppmPath);
  // Header: magic, width, height, maxval — whitespace-separated, with `#` comment lines allowed.
  let cursor = 0;
  const fields: string[] = [];
  while (fields.length < 4) {
    while (isPpmSpace(bytes[cursor])) cursor += 1;
    if (bytes[cursor] === 35) {
      while (bytes[cursor] !== 10) cursor += 1;
      continue;
    }
    const start = cursor;
    while (!isPpmSpace(bytes[cursor])) cursor += 1;
    fields.push(bytes.toString('latin1', start, cursor));
  }
  cursor += 1; // the single whitespace byte after the header

  let matched = 0;
  for (let offset = cursor; offset + 2 < bytes.length; offset += 3) {
    if (
      Math.abs(bytes[offset] - target[0]) <= tolerance &&
      Math.abs(bytes[offset + 1] - target[1]) <= tolerance &&
      Math.abs(bytes[offset + 2] - target[2]) <= tolerance
    ) {
      matched += 1;
    }
  }
  return matched;
}

/**
 * Rasterise page one of `pdfPath` and count pixels matching the theme's heading colour.
 *
 * @param pdfPath - The exported PDF.
 * @param directory - A scratch directory to rasterise into.
 * @returns The matching pixel count.
 */
function headingColourPixels(pdfPath: string, directory: string): number {
  const prefix = path.join(directory, 'page');
  execFileSync('pdftoppm', ['-r', '60', '-f', '1', '-l', '1', pdfPath, prefix]);
  const page = readdirSync(directory).find((name) => name.startsWith('page') && name.endsWith('.ppm'));
  if (page === undefined) throw new Error('pdftoppm produced no page raster');
  return countPixelsNear(path.join(directory, page), HEADING_RGB, COLOUR_TOLERANCE);
}

/** True when the poppler tools this spec reads PDFs with are installed. */
function popplerAvailable(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.describe('PDF theme application', () => {
  test.describe.configure({ timeout: 180_000 });
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('applies a theme selected in project options to the exported PDF', async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    test.skip(!popplerAvailable(), 'poppler-utils is not installed; pdftoppm is needed to rasterise the PDF.');

    await signIn(page);
    const projectId = await createProject(page, `Theme Applied ${Date.now()}`);
    try {
      const folderId = await createTestFolder(page, projectId, null, THEME_FOLDER);
      await createAdocFile(page, projectId, THEME_FILE, THEME, folderId);
      const mainId = await createAdocFile(page, projectId, 'main.adoc', DOC);
      await setMainFile(page, projectId, mainId);

      // Select the theme the way an owner does: through project options. Stored as the
      // project-relative PATH, which is the value the regression mishandled.
      const saved = await page.request.put(`${API_URL}/api/projects/${projectId}/render-config`, {
        data: { pdfTheme: `${THEME_FOLDER}/${THEME_FILE}` },
      });
      expect(saved.ok()).toBe(true);

      await openProject(page, projectId);
      const exportButton = page.getByRole('button', { name: /export to pdf/i });
      await expect(exportButton).toBeEnabled({ timeout: 20_000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        exportButton.click(),
      ]);
      const scratch = mkdtempSync(path.join(tmpdir(), 'pdf-theme-applied-'));
      const pdfPath = path.join(scratch, 'export.pdf');
      await download.saveAs(pdfPath);

      // The document still renders either way — an unresolvable theme is not an error — so the text
      // assertion proves only that the export worked, not that the theme did.
      const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
      expect(pdfText).toContain('A heading the theme colours');

      // THE assertion: the heading is drawn in the theme's colour. Rendering this document without
      // the theme produces zero matching pixels, so this is the signal — and the only signal — that
      // separates "themed" from "silently fell back to the built-in theme".
      expect(
        headingColourPixels(pdfPath, scratch),
        'the exported PDF is drawn with the project theme’s heading colour',
      ).toBeGreaterThan(MIN_MATCHING_PIXELS);
    } finally {
      await cleanupProject(page, projectId);
    }
  });
});
