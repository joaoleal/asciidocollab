import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFolder } from './helpers/test-project';
import { createAdocFile, openProject, setMainFile } from './helpers/editor';

// End-to-end proof that a diagram + math bearing document EXPORTS to a PDF in which the diagram is
// actually embedded and its labels are readable — the two defects this feature shipped and then fixed:
//   1. A root document in a subfolder rewrote its diagram to `../.gen/…`, which escaped the pinned
//      base_dir and failed to embed (Asciidoctor renders a missing image as the literal text
//      "[alt] | <target>", so the `.gen` path appears in the PDF text only when the embed FAILED).
//   2. prawn-svg mangled mermaid's nested per-word label tspans, interleaving words
//      ("Square" + "Rect" → "SRqeucatre"); the shim now flattens them so the labels read cleanly.
// Runs against the real vendored wasm engine, so the whole pre-pass → snapshot → convert → embed chain
// is exercised. The document lives in a subfolder to also guard the base_dir/`.gen` regression.

const ENGINE_WASM_PATH = path.join(process.cwd(), 'public', 'vendor', 'asciidoctor-pdf', 'asciidoctor-pdf.wasm');
const enginePresent = existsSync(ENGINE_WASM_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored; build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the diagram-render checks.';

const DOC = [
  '= Diagrams PDF',
  ':stem:',
  '',
  'A flowchart:',
  '',
  '[mermaid]',
  '----',
  'graph LR',
  '  A[Square Rect] --> B((Circle))',
  '  A --> C(Round Rect)',
  '----',
  '',
  'And some math: stem:[sqrt(4) = 2].',
  '',
].join('\n');

test.describe('PDF diagram rendering', () => {
  test.describe.configure({ timeout: 180_000 });
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test('embeds a subfolder-rooted mermaid diagram with readable (un-mangled) labels', async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);

    await signIn(page);
    const projectId = await createProject(page, `Diagrams PDF ${Date.now()}`);
    try {
      // The render root lives inside a subfolder with a space — the exact shape whose `.gen` reference
      // regressed to `/.gen/…` and failed to embed.
      const folderId = await createTestFolder(page, projectId, null, 'New Folder');
      const mainId = await createAdocFile(page, projectId, 'main.adoc', DOC, folderId);
      await setMainFile(page, projectId, mainId);

      await openProject(page, projectId);
      const exportButton = page.getByRole('button', { name: /export to pdf/i });
      await expect(exportButton).toBeEnabled({ timeout: 20_000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        exportButton.click(),
      ]);
      const pdfPath = path.join(mkdtempSync(path.join(tmpdir(), 'pdf-diagrams-render-')), 'export.pdf');
      await download.saveAs(pdfPath);
      const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });

      // The diagram embedded → its generated target is NOT rendered as placeholder text.
      expect(pdfText).not.toContain('.gen/');
      expect(pdfText).not.toContain('mermaid diagram |');

      // The labels are readable, un-mangled runs — the flatten fix. Each multi-word label appears as a
      // contiguous string, and the interleaved-word artifact never does.
      expect(pdfText).toContain('Square Rect');
      expect(pdfText).toContain('Round Rect');
      expect(pdfText).toContain('Circle');
      expect(pdfText).not.toMatch(/SRqeucatre|RReocutnd/);

      // No embed failure was surfaced for a generated diagram/math asset.
      const diagnostics = page.getByLabel('PDF export diagnostics');
      if (await diagnostics.isVisible()) {
        await expect(diagnostics).not.toContainText(/\.gen\//);
        await expect(diagnostics).not.toContainText(/not found or not readable/i);
      }
    } finally {
      await cleanupProject(page, projectId);
    }
  });
});
