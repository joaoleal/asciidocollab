import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, expandPreview, waitCollabSynced } from './helpers/editor';

// End-to-end guard for NATIVE on-screen diagram rendering in the HTML preview. The heavy engines
// (mermaid) run only in a real browser — a seam the unit suites cannot exercise — so this is the test
// that would have caught the shipped defects:
//   - mermaid labels vanished (foreignObject HTML labels were stripped by the svg-profile sanitizer),
//   - a malformed diagram painted mermaid's giant "Syntax error" bomb graphic instead of failing soft.
// It asserts a real `[mermaid]` diagram renders to an <svg> whose shape LABELS are visible, that a
// `[stem]` math block typesets alongside it, and that no bomb / no raw diagram source survives.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fileId(page: import('@playwright/test').Page, projectId: string, name: string): Promise<string> {
  const tree = await page.request.get(`${API}/projects/${projectId}/files`).then((r) => r.json());
  const node = (tree.children as Array<{ id: string; name: string }>).find((c) => c.name === name);
  if (!node) throw new Error(`file ${name} not found`);
  return node.id;
}

test.describe('preview diagram (mermaid) rendering', () => {
  // The heavy diagram engine is lazy-imported and renders on the main thread; give headroom under CI load.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Diagrams ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('renders a mermaid diagram with visible labels and a math block, with no bomb or raw source', async ({
    page,
  }) => {
    await createAdocFile(
      page,
      projectId,
      'doc.adoc',
      [
        '= Diagrams',
        ':stem:',
        '',
        'A flowchart:',
        '',
        '[mermaid]',
        '----',
        'graph LR',
        '  A[Square Rect] -- Link text --> B((Circle))',
        '  A --> C(Round Rect)',
        '----',
        '',
        'And math: stem:[sqrt(4) = 2].',
        '',
      ].join('\n'),
    );
    await setMainFile(page, projectId, await fileId(page, projectId, 'doc.adoc'));

    await openProject(page, projectId);
    await openFile(page, 'doc.adoc');
    await waitCollabSynced(page);
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');

    // The diagram placeholder is hydrated client-side into an <svg> by the lazily-imported engine.
    const diagramSvg = output.locator('.adc-diagram svg');
    await expect(diagramSvg.first()).toBeVisible({ timeout: 45_000 });

    // The shape labels must be present as real text in the RENDERED SVG — not the preserved inert
    // source. `renderDiagrams` keeps the source in a hidden `.adc-diagram-source` child for idempotent
    // re-renders, so asserting on the whole container's text would pass even with blank labels (the
    // foreignObject-stripping regression). Assert on the injected output node, which holds only the SVG.
    const renderedText = (await output.locator('.adc-diagram-output').first().textContent()) ?? '';
    expect(renderedText).toContain('Square Rect');
    expect(renderedText).toContain('Circle');
    expect(renderedText).toContain('Round Rect');
    // No mermaid error bomb in the rendered SVG.
    expect(renderedText).not.toContain('Syntax error');

    // The preserved source is kept for idempotency but must be HIDDEN (never shown as raw text).
    await expect(output.locator('.adc-diagram-source').first()).toBeHidden();

    // The math block typesets alongside the diagram (native MathML in Chromium).
    await expect(output.locator('math').first()).toBeVisible({ timeout: 45_000 });
  });
});
