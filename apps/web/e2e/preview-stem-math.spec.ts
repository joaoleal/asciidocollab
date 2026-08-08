import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, expandPreview, waitCollabSynced } from './helpers/editor';

// Client-side STEM rendering. A `:stem:` file's math must be typeset by
// self-hosted MathJax in the live preview — and WITHOUT the stray `$` artifact the old auto
// delimiter-scan produced for Asciidoctor's `\$…\$` asciimath delimiters. This is the end-to-end
// guard that:
//   - inline asciimath `stem:[sqrt(4) = 2]` (emitted as `\$…\$`),
//   - a `[stem]` block, AND
//   - a per-notation `latexmath:[x^2]` override (emitted as `\(…\)`)
// all render into `mjx-container`s, and that NO raw `$` / `\$` / source text survives.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fileId(page: import('@playwright/test').Page, projectId: string, name: string): Promise<string> {
  const tree = await page.request.get(`${API}/projects/${projectId}/files`).then((r) => r.json());
  const node = (tree.children as Array<{ id: string; name: string }>).find((c) => c.name === name);
  if (!node) throw new Error(`file ${name} not found`);
  return node.id;
}

test.describe('preview STEM (MathJax) rendering', () => {
  // The preview renders the collaboratively-synced Yjs document and MathJax is a large self-hosted
  // bundle that loads + typesets lazily — give generous headroom under parallel CI load.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `STEM Math ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('typesets inline asciimath, a [stem] block, and a latexmath override with NO stray `$`', async ({ page }) => {
    // `:stem:` enables math. Inline `stem:[…]` is AsciiMath (the default) → Asciidoctor emits `\$…\$`,
    // the `[stem]` block becomes `<div class="stemblock">…\$…\$…</div>`, and the per-notation
    // `latexmath:[x^2]` override is emitted as TeX `\(…\)`. All three must be typeset.
    await createAdocFile(
      page,
      projectId,
      'math.adoc',
      [
        '= Math',
        ':stem:',
        '',
        'Inline: stem:[sqrt(4) = 2] here.',
        '',
        'Override: latexmath:[x^2] inline.',
        '',
        '[stem]',
        '++++',
        'sum_(i=1)^n i = (n(n+1))/2',
        '++++',
        '',
      ].join('\n'),
    );
    await setMainFile(page, projectId, await fileId(page, projectId, 'math.adoc'));

    await openProject(page, projectId);
    await openFile(page, 'math.adoc');
    // The preview renders the collaboratively-synced editor document; wait for the sync to finish
    // (the "connecting" banner clears) before expanding so it never renders an empty pre-sync doc.
    await waitCollabSynced(page);
    await expandPreview(page);

    const output = page.getByTestId('asciidoc-output');

    // The test browser (Chromium) supports native MathML, so render-math converts each expression to a
    // native `<math>` element (not CHTML). Generous timeout: the self-hosted MathJax bundle is
    // lazy-imported and loads on first typeset. (In a non-MathML browser this would be `mjx-container`.)
    await expect(output.locator('math').first()).toBeVisible({ timeout: 45_000 });
    // Three distinct expressions (inline asciimath, latexmath override, block) must all be typeset.
    // Native MathML emits exactly one <math> per expression (no CHTML assistive-MML duplicate).
    await expect(output.locator('math')).toHaveCount(3, { timeout: 45_000 });

    // THE REGRESSION GUARD: no delimiter or source text may survive. The old auto delimiter-scan left
    // a stray `$` (from `\$`) glued to the asciimath, which is what the user saw as "broken". The
    // per-expression convert path strips all delimiters, so the rendered output contains no `$`,
    // no `\$`, and none of the raw `sqrt(4) = 2` / `x^2` source.
    const text = (await output.textContent()) ?? '';
    expect(text).not.toContain('$');
    expect(text).not.toContain(String.raw`\$`);
    expect(text).not.toContain('sqrt(4) = 2');
    expect(text).not.toContain('x^2');
  });
});
