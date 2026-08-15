/**
 * @file Captures the bundled demo project as the Print style draws it, for eyes-on comparison against
 * the same project rendered to a real PDF.
 *
 * Hard-gated on `PRINT_CAPTURE=1`, like the reference-input emitter: it asserts nothing and produces
 * no verdict, so a normal suite run must not execute it.
 *
 * What makes this worth capturing rather than reusing the anchor fixtures: the markup is produced by
 * the SHIPPING render worker, not by Asciidoctor directly. Highlighting, callout markers, checklist
 * markers and footnote separators are all worker post-processing, and every defect reported against
 * this style so far has lived in one of them — a capture that skipped the worker would picture a page
 * no reader ever sees.
 *
 * The device scale is chosen so one PDF point is the same number of pixels here as in a 150 dpi
 * rasterization of the PDF, which is what makes the two captures directly comparable.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { resolveAppearance } from '@asciidocollab/shared';
import { appearanceToCssProperties } from '@/lib/print-preview/appearance-to-css';
import { faceMetricDeclarations, metricFamilyOf, planFontFaces } from '@/lib/print-preview/font-faces';
import { resolveFaceMetrics } from '@/lib/print-preview/font-metrics';

const WEB_ROOT = process.cwd();
const DEMO_DIR = path.join(WEB_ROOT, '..', 'api', 'data', 'demo-project');
const CATALOGUE_DIR = path.join(WEB_ROOT, '..', '..', 'packages', 'asciidoc-pdf', 'assets', 'fonts');
const SUBSTITUTE_DIR = path.join(WEB_ROOT, '..', '..', 'packages', 'asciidoc-pdf', 'assets', 'base14-fonts');
const ICONS_DIR = path.join(WEB_ROOT, '..', '..', 'packages', 'asciidoc-pdf', 'assets', 'admonition-icons');
const STYLESHEET = path.join(WEB_ROOT, 'src', 'styles', 'print-preview.css');
const OUT_DIR = process.env['PRINT_CAPTURE_OUT'] ?? path.join(WEB_ROOT, '.print-capture');
const THEME_PATH = 'theme/showcase-theme.yml';
const PAGE_ORIGIN = 'http://print-capture.test';

/** CSS pixels per point, then scaled so the device pixels land at 150 dpi. */
const DEVICE_SCALE = 150 / 96;

test.describe('demo project print capture', () => {
  test.skip(process.env['PRINT_CAPTURE'] !== '1', 'capture-only; set PRINT_CAPTURE=1');
  test.use({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: DEVICE_SCALE });

  test('captures the Print style over the bundled demo project', async ({ page }) => {
    test.setTimeout(600_000);

    // The project's text files, keyed the way the app keys them: project-relative paths.
    const files: Record<string, string> = {};
    const collect = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const nested = path.join(directory, entry.name);
        const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) collect(nested, key);
        else if (entry.name.endsWith('.adoc')) files[key] = readFileSync(nested, 'utf8');
      }
    };
    collect(DEMO_DIR, '');

    // ── the shipping worker, driven directly ──────────────────────────────────
    // Its globals are the two a worker scope provides; the module registers its handler on import.
    let handler: ((event: { data: unknown }) => Promise<void>) | null = null;
    let result: { ok: boolean; html: string | null; error: string | null } | null = null;
    Object.defineProperty(globalThis, 'onmessage', {
      set(value: (event: { data: unknown }) => Promise<void>) {
        handler = value;
      },
      get() {
        return handler;
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'postMessage', {
      value: (message: { ok: boolean; html: string | null; error: string | null }) => {
        result = message;
      },
      writable: true,
      configurable: true,
    });
    // Imported for its side effect: the module registers its handler on the global set above.
    require('@/workers/asciidoc-render.worker');
    if (handler === null) throw new Error('the worker registered no handler');
    await (handler as (event: { data: unknown }) => Promise<void>)({
      data: {
        requestId: 1,
        content: files['index.adoc'] ?? '',
        mainPath: 'index.adoc',
        rootFileId: 'index.adoc',
        openFileId: 'index.adoc',
        files,
        showIncludes: true,
        imagesDir: '/project-images',
      },
    });
    if (result === null) throw new Error('the worker answered nothing');
    const rendered = result as { ok: boolean; html: string | null; error: string | null };
    if (!rendered.ok || rendered.html === null) throw new Error(`worker failed: ${rendered.error}`);

    // ── the appearance, resolved from the project's own theme ─────────────────
    const themeText = readFileSync(path.join(DEMO_DIR, THEME_PATH), 'utf8');
    const resolved = resolveAppearance({ themeText, themePath: THEME_PATH });
    const plan = planFontFaces(resolved.appearance.fonts, THEME_PATH);
    const metrics = resolveFaceMetrics(plan, () => undefined);
    const cssProperties = appearanceToCssProperties(resolved.appearance, metrics.boxOf);

    const faceRules = plan.faces
      .map((face) => {
        const directory = face.source === 'substitute' ? SUBSTITUTE_DIR : CATALOGUE_DIR;
        const file = path.join(directory, path.basename(face.url ?? ''));
        if ((face.source !== 'catalogue' && face.source !== 'substitute') || !existsSync(file)) return '';
        const mime = file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';
        const data = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
        const source = `src: url(${data}); font-weight: ${face.weight}; font-style: ${face.slant}; font-display: block;`;
        // The metric-bearing second registration, as the application makes it: the constructs that
        // paint a box behind their text are set in that face rather than in this one, and it carries
        // the other of the two readings of the face's metrics.
        const painted = metrics.overridesOf(face.family, face.style, 'box');
        return (
          `@font-face { font-family: "${face.family}"; ${source} ${faceMetricDeclarations(metrics.overridesOf(face.family, face.style, 'text'))} }\n` +
          (painted === undefined
            ? ''
            : `@font-face { font-family: "${metricFamilyOf(face.family)}"; ${source} ${faceMetricDeclarations(painted)} }`)
        );
      })
      .join('\n');

    const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${faceRules}</style>
<style>${readFileSync(STYLESHEET, 'utf8')}</style>
<style>* { margin: 0; padding: 0; } body { margin: 0; background: #888; }</style>
</head><body>
<div class="asciidoc-preview-content" data-preview-style="print" data-testid="page">
${rendered.html}
</div></body></html>`;

    await page.route('**/vendor/admonition-icons/*', (route) => {
      const file = path.join(ICONS_DIR, path.basename(new URL(route.request().url()).pathname));
      return existsSync(file)
        ? route.fulfill({ contentType: 'image/svg+xml', body: readFileSync(file, 'utf8') })
        : route.fulfill({ status: 404, body: '' });
    });
    await page.route('**/project-images/**', (route) => {
      const file = path.join(DEMO_DIR, 'images', path.basename(new URL(route.request().url()).pathname));
      return existsSync(file)
        ? route.fulfill({ contentType: 'image/svg+xml', body: readFileSync(file, 'utf8') })
        : route.fulfill({ status: 404, body: '' });
    });
    await page.route(`${PAGE_ORIGIN}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(`${PAGE_ORIGIN}/`, { waitUntil: 'load' });
    await page.evaluate((properties) => {
      const column = document.querySelector('[data-testid="page"]');
      if (column instanceof HTMLElement) {
        for (const [name, value] of Object.entries(properties)) column.style.setProperty(name, value);
      }
    }, cssProperties);
    await page.evaluate(() => document.fonts.ready);

    // Every painted line, with the text it carries and the points it spans. This is what makes a
    // wrapping divergence findable: the PDF's own text layer is a list of lines, so the two can be
    // compared line for line instead of paragraph by paragraph or by eye.
    const lines = await page.evaluate(() => {
      const column = document.querySelector('[data-testid="page"]');
      if (!(column instanceof HTMLElement)) return [];
      const range = document.createRange();
      const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
      const collected: { centre: number; left: number; right: number; text: string }[] = [];
      let current: { centre: number; left: number; right: number; text: string } | null = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent ?? '';
        // A `while` over UTF-16 code units, not `for…of`: a Range offset is measured in code units,
        // and iterating the string by code point would mis-address every node after an astral
        // character.
        let index = 0;
        while (index < text.length) {
          const offset = index;
          // Advanced before the skip below, not at a loop head: a `continue` past an un-drawn
          // character would otherwise never move on.
          index += 1;
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          // Group by the run's vertical CENTRE, against a threshold well under a line's pitch.
          //
          // Grouping by the top edge looked right and was not: a superscript, a subscript and an
          // inline code span each sit in a box of their own height, so their tops differ from the
          // surrounding text's by a few pixels. At a tight threshold every one of them opened a
          // spurious new line, and the wrap comparison then reported divergences that were entirely
          // this tool's doing — including one that appeared only because a real fix legitimately
          // changed a code span's metrics. Centres of raised and lowered runs stay within a few
          // pixels of the line's, while the next line's centre is a whole pitch away.
          const centre = rect.top + rect.height / 2;
          if (current === null || Math.abs(current.centre - centre) > 10) {
            current = { centre, left: rect.left, right: rect.right, text: '' };
            collected.push(current);
          }
          current.text += text[offset];
          current.left = Math.min(current.left, rect.left);
          current.right = Math.max(current.right, rect.right);
        }
      }
      return collected;
    });
    const toPoints = (value: number): number => Math.round((value * 72) / 96 / 0.01) * 0.01;

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, 'lines.json'),
      `${JSON.stringify(
        lines.map((line) => ({
          topPx: Math.round(line.centre),
          leftPt: Number(toPoints(line.left).toFixed(2)),
          rightPt: Number(toPoints(line.right).toFixed(2)),
          widthPt: Number(toPoints(line.right - line.left).toFixed(2)),
          text: line.text.replaceAll(/\s+/g, ' ').trim(),
        })),
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(OUT_DIR, 'preview.html'), html);
    writeFileSync(
      path.join(OUT_DIR, 'css-properties.json'),
      `${JSON.stringify(cssProperties, null, 2)}\n`,
    );

    // Sliced at the theme's own page height so a slice covers about as much as a PDF page does, and
    // because a single capture of a document this long exceeds what the browser will encode.
    const box = await page.locator('[data-testid="page"]').boundingBox();
    if (box === null) throw new Error('the page column has no box');
    const sliceHeight = Math.round((resolved.appearance.page.heightPt * 96) / 72);
    const slices = Math.ceil(box.height / sliceHeight);
    for (let index = 0; index < slices; index += 1) {
      await page.screenshot({
        path: path.join(OUT_DIR, `print-${String(index + 1).padStart(2, '0')}.png`),
        fullPage: true,
        clip: {
          x: box.x,
          y: box.y + index * sliceHeight,
          width: box.width,
          height: Math.min(sliceHeight, box.height - index * sliceHeight),
        },
      });
    }
    // eslint-disable-next-line no-console -- this is a capture tool; the paths are its output
    console.log(`captured ${slices} slices of ${Math.round(box.height)}px into ${OUT_DIR}`);
  });
});
