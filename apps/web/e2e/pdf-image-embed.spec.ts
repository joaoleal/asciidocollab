import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFolder } from './helpers/test-project';
import { createAdocFile, openProject, setMainFile } from './helpers/editor';

// End-to-end proof that the client-side PDF export embeds a real project image and that a referenced-
// but-absent image degrades to a VISIBLE diagnostic (never a silent blank). Both run against the real
// vendored wasm engine, so the whole fetch → snapshot → VFS-mount → convert → embed chain is exercised.
// This is the regression guard for "images don't render in the PDF": Asciidoctor-PDF renders a missing
// image as the literal text "[alt] | <target>", so the target path appears in the PDF text only when
// the image FAILED to embed — which is exactly what the assertions below key on.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const ENGINE_WASM_PATH = path.join(process.cwd(), 'public', 'vendor', 'asciidoctor-pdf', 'asciidoctor-pdf.wasm');
const enginePresent = existsSync(ENGINE_WASM_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored; build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the image-embed checks.';

/** Build a valid 64x64 RGBA PNG (Node zlib + crc32) so the test needs no binary fixture on disk. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA colour type
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = 200;
      raw[offset + 1] = 40;
      raw[offset + 2] = 40;
      raw[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The render root document lives INSIDE "New Folder" (a subfolder with a space), and references its
// images project-root-relative — exactly the shape that regressed: without pinning the convert base_dir
// to the project root, Asciidoctor resolved `New Folder/present.png` against the doc's own folder,
// doubling it to `/project/New Folder/New Folder/present.png` so every image failed to embed.
const DOC = [
  '= Image Embed',
  '',
  '.A present image',
  'image::New Folder/present.png[a present picture]',
  '',
  '.A missing image',
  'image::New Folder/missing.png[a missing picture]',
  '',
].join('\n');

test.describe('PDF image embedding', () => {
  // A cold wasm export (tens of MiB engine + a warm Ruby VM, then a full render, optimize and
  // download) is the binding constraint here, not any single step. Under gate load on a contended box
  // it can approach several minutes; 180s was tighter than the identical work next door in
  // pdf-extensions.spec.ts (which budgets 600s), so the whole test hit its own deadline mid-export and
  // surfaced as a retried `download`-event timeout. Sized to the same worst-case wasm-export reasoning.
  test.describe.configure({ timeout: 300_000 });
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('embeds a subfolder-rooted document\'s image and surfaces a diagnostic for a missing one', async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);

    await signIn(page);
    const projectId = await createProject(page, `Image Embed ${Date.now()}`);
    try {
      const folderId = await createTestFolder(page, projectId, null, 'New Folder');
      const upload = await page.request.post(`${API_URL}/projects/${projectId}/assets?parentId=${folderId}`, {
        multipart: { file: { name: 'present.png', mimeType: 'image/png', buffer: makePng(64, 64) } },
      });
      expect(upload.ok()).toBe(true);

      // The document lives in the subfolder; it is the render root (drives the export via the main file).
      const mainId = await createAdocFile(page, projectId, 'main.adoc', DOC, folderId);
      await setMainFile(page, projectId, mainId);

      await openProject(page, projectId);
      const exportButton = page.getByRole('button', { name: /export to pdf/i });
      await expect(exportButton).toBeEnabled({ timeout: 30_000 });

      // Kept below the test-level budget above so a genuinely stalled export fails HERE with a clear
      // "download never arrived" message rather than tripping the overall test deadline mid-wait.
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 240_000 }),
        exportButton.click(),
      ]);
      const pdfPath = path.join(mkdtempSync(path.join(tmpdir(), 'pdf-image-embed-')), 'export.pdf');
      await download.saveAs(pdfPath);
      const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });

      // The present image embedded → its target path is NOT rendered as placeholder text.
      expect(pdfText).not.toContain('present.png');
      // The missing image degraded to the placeholder → its target path IS rendered as text.
      expect(pdfText).toContain('missing.png');

      // ...and the failure is surfaced in the (visible) diagnostics panel, not swallowed.
      const diagnostics = page.getByLabel('PDF export diagnostics');
      await expect(diagnostics).toBeVisible();
      await expect(diagnostics).toContainText(/missing\.png/);
      await expect(diagnostics).toContainText(/not found or not readable|could not embed/i);
    } finally {
      await cleanupProject(page, projectId);
    }
  });
});
