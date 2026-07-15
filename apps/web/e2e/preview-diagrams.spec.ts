import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, expandPreview } from './helpers/editor';

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
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');

    // The diagram placeholder is hydrated client-side into an <svg> by the lazily-imported engine.
    const diagramSvg = output.locator('.adc-diagram svg');
    await expect(diagramSvg.first()).toBeVisible({ timeout: 45_000 });

    // The shape labels must be present as real text (the foreignObject-stripping regression left them
    // blank). Native <text> labels put the words in the SVG's text content.
    const diagramText = (await output.locator('.adc-diagram').first().textContent()) ?? '';
    expect(diagramText).toContain('Square Rect');
    expect(diagramText).toContain('Circle');
    expect(diagramText).toContain('Round Rect');

    // The math block typesets alongside the diagram (native MathML in Chromium).
    await expect(output.locator('math').first()).toBeVisible({ timeout: 45_000 });

    // No mermaid error bomb, and no un-rendered raw diagram source may survive on screen.
    const text = (await output.textContent()) ?? '';
    expect(text).not.toContain('Syntax error');
    expect(text).not.toContain('graph LR');
  });
});
