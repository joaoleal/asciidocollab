import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Request } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile } from './helpers/editor';

// Zero source-egress guard for the three new diagram/math render surfaces — the client-side PDF export,
// the live PDF preview, and the HTML preview's native diagram pass. Rendering happens ENTIRELY in the
// browser: the diagram/math SOURCE is inert data, and a referenced remote resource (a vega `data.url`
// or a remote image) is SKIPPED WITH A WARNING, never fetched. This spec proves that end to end by
// intercepting every outbound browser request while all three surfaces render and asserting that:
//   - no request ever reaches a non-loopback (external) host — the whole app stack is loopback, so any
//     foreign request is, by construction, a leak;
//   - no request URL touches the planted canary host, and no diagram/math source token rides out in any
//     foreign request URL or body;
//   - the remote `data.url` / remote image produces a surfaced skip-with-warning instead of a fetch.
// Foreign requests are additionally ABORTED at the interceptor, so even a regression can leak nothing
// during the run — the recorded attempt is what fails the test.

const ENGINE_WASM_PATH = path.join(process.cwd(), 'public', 'vendor', 'asciidoctor-pdf', 'asciidoctor-pdf.wasm');
const PDF_WORKER_PATH = path.join(process.cwd(), 'public', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
const enginePresent = existsSync(ENGINE_WASM_PATH);
const pdfWorkerPresent = existsSync(PDF_WORKER_PATH);
const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored (public/vendor/asciidoctor-pdf/asciidoctor-pdf.wasm); ' +
  'the PDF export + live-preview surfaces cannot render, so the egress guard is skipped.';

// A host that resolves nowhere: any request reaching it is an unmistakable leak. Every remote reference
// in the canary document points at it, so a fetch of ANY of them is instantly attributable.
const CANARY_HOST = 'egress-canary.invalid';
const REMOTE_DATA_URL = `https://${CANARY_HOST}/leak-data.json`;

// Unique source markers, one per renderable block, embedded in the diagram/math SOURCE. None may appear
// in any outbound foreign request — that would mean the source text itself left the client.
const MERMAID_TOKEN = 'EgressCanaryMermaidLabel';
const GRAPHVIZ_TOKEN = 'EgressCanaryGraphvizNode';
const VEGA_TOKEN = 'EgressCanaryVegaField';
const MATH_BLOCK_TOKEN = 'EgressCanaryMathBlock';
const MATH_INLINE_TOKEN = 'EgressCanaryInlineMath';
const SOURCE_TOKENS = [
  MERMAID_TOKEN,
  GRAPHVIZ_TOKEN,
  VEGA_TOKEN,
  MATH_BLOCK_TOKEN,
  MATH_INLINE_TOKEN,
] as const;

// The canary document. Mermaid + Graphviz + a self-contained Vega chart all render offline (no `://`
// anywhere in their source, so the exporter's remote-reference guard leaves them alone). A SECOND Vega
// spec carries a remote `data.url` — the FR-027 case: a diagram DATA resource that must be
// skipped-with-warning, never fetched, on every surface. Block + inline math complete the set. The
// self-contained Vega spec deliberately omits `$schema` (a `://` URL) so the PDF stage's broad
// remote-reference guard renders it instead of skipping.
//
// NB: a standalone `image::https://…[]` macro is deliberately NOT planted here. The on-screen HTML
// preview passes absolute image targets through unchanged (asciidoc-render.worker.ts `rewriteImageSources`),
// so the browser natively fetches a remote `<img src>` — that is the preview's documented image
// behaviour, independent of the diagram/math render pass and outside FR-027 (which governs diagram data
// resources). The PDF export/preview image guard already skips remote images; that path is covered by
// the dedicated pdf-image-embed spec.
const SELF_CONTAINED_VEGA = JSON.stringify({
  width: 200,
  height: 100,
  padding: 5,
  data: [{ name: 'table', values: [{ category: VEGA_TOKEN, amount: 42 }] }],
  scales: [
    { name: 'xscale', type: 'band', domain: { data: 'table', field: 'category' }, range: 'width', padding: 0.1 },
    { name: 'yscale', domain: { data: 'table', field: 'amount' }, range: 'height' },
  ],
  marks: [
    {
      type: 'rect',
      from: { data: 'table' },
      encode: {
        enter: {
          x: { scale: 'xscale', field: 'category' },
          width: { scale: 'xscale', band: 1 },
          y: { scale: 'yscale', field: 'amount' },
          y2: { scale: 'yscale', value: 0 },
          fill: { value: 'steelblue' },
        },
      },
    },
  ],
});

const REMOTE_VEGA = JSON.stringify({
  data: [{ name: 'remote', url: REMOTE_DATA_URL }],
  marks: [{ type: 'symbol', from: { data: 'remote' } }],
});

const CANARY_DOC = [
  '= Egress Canary Diagrams and Math',
  ':stem: latexmath',
  '',
  'A mermaid flowchart:',
  '',
  '[mermaid]',
  '....',
  'graph LR',
  `  A[${MERMAID_TOKEN}] --> B{Decide}`,
  '  B -->|yes| C[Render]',
  '....',
  '',
  'A graphviz directed graph:',
  '',
  '[graphviz]',
  '....',
  'digraph {',
  '  rankdir=LR;',
  `  ${GRAPHVIZ_TOKEN} -> b -> c;`,
  '}',
  '....',
  '',
  'A self-contained vega bar chart:',
  '',
  '[vega]',
  '....',
  SELF_CONTAINED_VEGA,
  '....',
  '',
  'A vega chart that references a REMOTE data url (must be skipped, never fetched):',
  '',
  '[vega]',
  '....',
  REMOTE_VEGA,
  '....',
  '',
  'A displayed block equation:',
  '',
  '[latexmath]',
  '++++',
  String.raw`E = mc^2 \quad \text{` + MATH_BLOCK_TOKEN + '}',
  '++++',
  '',
  `Inline math stem:[${MATH_INLINE_TOKEN} = 1] mid-sentence, without breaking the flow.`,
  '',
].join('\n');

interface RecordedRequest {
  url: string;
  method: string;
  postData: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** A URL the browser may legitimately reach: the whole app stack is loopback; inert schemes carry no I/O. */
function isAllowedUrl(url: string): boolean {
  if (/^(data|blob|about|chrome|chrome-extension):/i.test(url)) return true;
  const host = hostOf(url);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/**
 * Collect every egress violation observed so far: a request to a non-loopback host, any request whose
 * URL mentions the canary host, a source token riding out in a foreign request, or a websocket opened to
 * a foreign host. Empty means the client kept every diagram/math source and remote reference to itself.
 */
function egressViolations(requests: readonly RecordedRequest[], websockets: readonly string[]): string[] {
  const violations: string[] = [];
  for (const request of requests) {
    if (request.url.includes(CANARY_HOST)) {
      violations.push(`canary host reached: ${request.method} ${request.url}`);
    }
    if (!isAllowedUrl(request.url)) {
      violations.push(`foreign request: ${request.method} ${request.url}`);
      for (const token of SOURCE_TOKENS) {
        if (request.url.includes(token) || request.postData.includes(token)) {
          violations.push(`source token ${token} left the client in ${request.method} ${request.url}`);
        }
      }
    }
  }
  for (const url of websockets) {
    if (url.includes(CANARY_HOST)) violations.push(`canary host websocket: ${url}`);
    const host = hostOf(url);
    if (host === null || !LOOPBACK_HOSTS.has(host)) violations.push(`foreign websocket: ${url}`);
  }
  return [...new Set(violations)];
}

test.describe('diagram and math rendering keeps all source in the browser', () => {
  // Three heavy surfaces (a cold wasm engine renders the export AND the live preview) back to back.
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    await signIn(page);
    projectId = await createProject(page, `Egress Canary ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('renders diagrams and math across export, PDF preview, and HTML preview with no source egress', async ({
    page,
  }) => {
    // Seed the document (via the Node-side request context, which is NOT browser egress) before arming
    // the interceptor, so only the in-app render traffic is scrutinised.
    const mainId = await createAdocFile(page, projectId, 'main.adoc', CANARY_DOC);
    await setMainFile(page, projectId, mainId);

    const requests: RecordedRequest[] = [];
    const websockets: string[] = [];

    // Record every browser request for the token/host scan and log any websocket. The HTML preview
    // surfaces its remote-skip in the diagnostics panel (asserted below), not the console.
    page.on('request', (request: Request) => {
      requests.push({ url: request.url(), method: request.method(), postData: request.postData() ?? '' });
    });
    page.on('websocket', (ws) => websockets.push(ws.url()));

    // Actively BLOCK any foreign request: loopback + inert schemes pass through; everything else is
    // aborted so a regression cannot actually exfiltrate anything during the run — the recorded attempt
    // is what the assertions below catch.
    await page.route('**', async (route) => {
      if (isAllowedUrl(route.request().url())) {
        await route.continue();
        return;
      }
      await route.abort();
    });

    const assertNoEgress = (surface: string): void => {
      const violations = egressViolations(requests, websockets);
      expect(violations, `${surface}: outbound source/remote-reference leak detected`).toEqual([]);
    };

    await openProject(page, projectId);
    await openFile(page, 'main.adoc', /Egress Canary Diagrams and Math/);
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });

    // ---- Surface 1: the HTML preview's native diagram pass ----------------------------------------
    // Open the (default HTML) preview; the render worker emits inert `.adc-diagram` placeholders and the
    // main-thread pass renders each engine's SVG in place. The self-contained diagrams render; the
    // remote-data vega is skipped with a console warning (no fetch).
    await page.getByRole('button', { name: /expand preview/i }).click();
    const output = page.getByTestId('asciidoc-output');
    await expect(output).toBeVisible({ timeout: 25_000 });

    // At least one diagram must actually render natively (proof the pass ran end to end).
    await expect(output.locator('.adc-diagram-output svg').first()).toBeVisible({ timeout: 45_000 });
    // The math pass also runs client-side (self-hosted MathJax) — its presence keeps the render honest.
    await expect(output.locator('math').first()).toBeVisible({ timeout: 45_000 });

    // The remote-data vega is skipped with a warning rather than fetched — surfaced in the preview
    // diagnostics panel (the same panel the PDF export uses), not silently dropped.
    await expect(
      page.getByLabel('Preview diagnostics'),
      'the HTML preview must skip the remote vega data url with a warning (no fetch)',
    ).toContainText(/remote data reference blocked/i, { timeout: 20_000 });
    assertNoEgress('HTML preview diagram pass');

    // ---- Surface 2: the live PDF preview ----------------------------------------------------------
    // Switch the shared preview panel to PDF mode; the worker pipeline renders the PDF (mermaid via the
    // main-thread pre-pass, math + graphviz + the self-contained vega in-worker) and the remote-data
    // vega is skipped-with-warning in the diagnostics panel.
    await page.getByTestId('preview-mode-pdf').click();
    await expect(page.locator('[aria-label="PDF preview"]')).toBeVisible();
    if (pdfWorkerPresent) {
      await expect(page.locator('[aria-label="PDF preview"] canvas').first()).toBeVisible({ timeout: 120_000 });
    }
    await expect(page.locator('[aria-label="PDF preview"][aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });

    // The live PDF preview and the export button can each mount a diagnostics panel with this label, so
    // scope to the first match rather than the (strict-mode) whole set.
    const previewDiagnostics = page.getByLabel('PDF export diagnostics').first();
    await expect(previewDiagnostics).toBeVisible({ timeout: 30_000 });
    await expect(previewDiagnostics).toContainText(/references a remote resource and was skipped/i);
    assertNoEgress('live PDF preview');

    // ---- Surface 3: the PDF export ----------------------------------------------------------------
    const exportButton = page.getByRole('button', { name: /export to pdf/i });
    await expect(exportButton).toBeEnabled({ timeout: 20_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180_000 }),
      exportButton.click(),
    ]);
    // Materialise the download to confirm a real PDF was produced (its bytes never touch the network).
    const pdfPath = path.join(mkdtempSync(path.join(tmpdir(), 'pdf-egress-')), 'export.pdf');
    await download.saveAs(pdfPath);
    expect(existsSync(pdfPath)).toBe(true);

    const exportDiagnostics = page.getByLabel('PDF export diagnostics').first();
    await expect(exportDiagnostics).toBeVisible({ timeout: 30_000 });
    await expect(exportDiagnostics).toContainText(/references a remote resource and was skipped/i);
    assertNoEgress('PDF export');

    // Final belt-and-suspenders: across the whole run, nothing ever reached the canary host, and no
    // source token or remote reference left the client on any surface.
    expect(egressViolations(requests, websockets)).toEqual([]);
    expect(requests.some((r) => r.url.includes(CANARY_HOST))).toBe(false);
  });
});
