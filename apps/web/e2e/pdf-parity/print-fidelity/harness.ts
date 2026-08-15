/**
 * @file The Print style's fidelity oracle: one page, dressed exactly as the application dresses it.
 *
 * The comparison this suite makes is only worth anything if the thing being measured is the shipped
 * styling rather than a re-creation of it. So the page built here is assembled from the SAME three
 * artefacts the application uses and from nothing else: the document converted by Asciidoctor, the
 * appearance resolved by `@asciidocollab/shared`, projected by `appearance-to-css.ts`, and the
 * stylesheet `src/styles/print-preview.css` as committed. Nothing is restated; a change to any of
 * them changes what this measures.
 *
 * What is deliberately NOT here is the application around it — no editor, no collaboration session,
 * no running stack. A stack would add several ways for this to fail that have nothing to do with
 * fidelity, and would tell you nothing extra about whether the page looks like the PDF.
 *
 * The render worker is the one exception, and only where a comparison NEEDS it: converting with
 * Asciidoctor produces the document's structure, but syntax highlighting is the worker's own
 * post-processing, so a check on the colour of a keyword has nothing to look at unless the worker
 * produced the markup. {@link renderWithWorker} is that door, and it is opened explicitly by the one
 * suite whose subject lives behind it — everything else still measures Asciidoctor's own output.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { load as loadAsciidoc } from 'asciidoctor';
import { resolveAppearance } from '@asciidocollab/shared';
import type { Page } from '@playwright/test';
import { appearanceToCssProperties } from '@/lib/print-preview/appearance-to-css';
import { faceMetricDeclarations, metricFamilyOf, planFontFaces } from '@/lib/print-preview/font-faces';
import type { FaceMetricOverrides, FaceRegistration, FaceStyle } from '@/lib/print-preview/font-faces';
import { resolveFaceMetrics } from '@/lib/print-preview/font-metrics';
import type { Rgb } from '../harness/pdftools';

/** Where the anchor fixtures live. */
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** The committed catalogue faces this application serves. */
const CATALOGUE_DIR = path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/fonts');

/** The committed base-14 stand-ins, which are published beside the catalogue and are not part of it. */
const SUBSTITUTE_DIR = path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/base14-fonts');

/** The stylesheet under test, as committed. */
const STYLESHEET = path.join(__dirname, '../../../src/styles/print-preview.css');

/** CSS pixels per PDF point, at the 96 dpi a browser lays out in. */
export const PIXELS_PER_POINT = 96 / 72;

/**
 * Read a colour as three channels — a `#RRGGBB` custom property the page was dressed with, or an
 * `rgb(…)`/`rgba(…)` value a computed style reported.
 *
 * THROWS on anything it cannot read, and that is the whole reason it exists. Three copies of this
 * used to sit in three spec files and two of them answered `[NaN, NaN, NaN]` for a property the page
 * carries no value for — a misspelled custom property, or one the projection stopped emitting.
 * `sameColour` then returns `false` for every comparison against it, because every comparison with
 * NaN is false, and `false` is the ASSERTED value in the negative checks this suite makes: `expect(
 * coloursAgree(frame, grid)).toBe(false)` says "the fixture frames its tables in a colour the grid
 * does not use", and a frame colour that was never read satisfied it. The rest of the file then
 * failed somewhere downstream for a reason that named nothing about the missing property.
 *
 * A colour that cannot be read is a broken measurement, not a measurement of "different".
 *
 * ## …and neither is `transparent`
 *
 * Chromium computes `transparent` to exactly `rgba(0, 0, 0, 0)`, and `src/styles/print-preview.css`
 * writes that keyword as the fallback of five `var()`s — a codespan's chip, a button's cap, a quote's
 * fill, a verse's, an admonition's — so it is the value a computed style really reports for any
 * construct whose custom property the projection failed to emit. Read with the alpha discarded, "this
 * construct is not filled at all" came back as "this construct is filled with BLACK", which is a
 * measurement of a mark the page does not carry: it makes an unbanded table footer read as a banded
 * one drawn in the wrong colour, and would have passed outright against any reference that happens to
 * fill in black.
 *
 * So a fully transparent value throws, like every other value no colour can be read from. A caller
 * that means to ALLOW an unfilled construct has to say so, and `measureConstruct` already reports that
 * case as `backgroundColour: null` for the callers that do.
 *
 * @param value - The value to read.
 * @param what - What was being read, for the failure message.
 * @returns The three channels, 0-255.
 * @throws {Error} When the value is absent, fully transparent, or is not a colour this can read.
 */
export function colourOf(value: string | undefined, what = 'a colour'): Rgb {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${what}: the page carries no value to read a colour from`);
  }
  const functional = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(value);
  if (functional !== null) {
    if (functional[4] !== undefined && Number(functional[4]) === 0) {
      throw new Error(`${what}: ${JSON.stringify(value)} is fully transparent, which is not a colour`);
    }
    return [Number(functional[1]), Number(functional[2]), Number(functional[3])];
  }
  const hex = /^#?([\da-f]{6})$/i.exec(value.trim());
  if (hex === null) throw new Error(`${what}: ${JSON.stringify(value)} is not a colour`);
  return [
    Number.parseInt(hex[1].slice(0, 2), 16),
    Number.parseInt(hex[1].slice(2, 4), 16),
    Number.parseInt(hex[1].slice(4, 6), 16),
  ];
}

/**
 * The same read, rendered back as `#rrggbb`.
 *
 * For the one comparison that works in colour STRINGS rather than in channels: the highlighting
 * inventory declares each divergence as `#003366 bold`, so both sides have to become text before they
 * can be compared against it.
 *
 * It exists here rather than in that spec because the private copy there could not fail. It read a
 * non-`rgb()` value by slicing hex out of fixed offsets, which yields `NaN` for anything that is not
 * one — and `NaN.toString(16)` is `"NaN"`, so the answer was the string `#NaNNaNNaN`. Its companion
 * comparison then measured `Math.abs(NaN - x) > tolerance`, which is `false` for every x, so every
 * character on the page "agreed" with every character in the PDF and the whole inventory passed
 * having compared nothing. Built on {@link colourOf}, the unreadable case throws instead, and the
 * returned string cannot contain `NaN` because there is no path to a channel that is not a number.
 *
 * @param value - The value to read.
 * @param what - What was being read, for the failure message.
 * @returns The colour as `#rrggbb`, lower case.
 * @throws {Error} Whenever {@link colourOf} does.
 */
export function hexOf(value: string | undefined, what = 'a colour'): string {
  return `#${colourOf(value, what)
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** One anchor fixture, as its manifest describes it. */
export interface Fixture {
  /** Directory name, which is also the fixture's name. */
  readonly name: string;
  /** Absolute path of the fixture directory. */
  readonly directory: string;
  /** The AsciiDoc source of its main document. */
  readonly source: string;
  /** The theme document's text, or undefined for the no-theme anchor. */
  readonly themeText?: string;
  /** The theme document's project-relative path, or undefined. */
  readonly themePath?: string;
  /** The committed reference PDF's bytes. */
  readonly referencePdf: Uint8Array;
}

/**
 * Read one anchor fixture.
 *
 * @param name - The fixture's directory name.
 * @returns Everything the comparison needs from it.
 */
export function readFixture(name: string): Fixture {
  const directory = path.join(FIXTURES_DIR, name);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as {
    mainFile: string;
    render?: { themePath?: string };
  };
  const themePath = manifest.render?.themePath;
  return {
    name,
    directory,
    source: readFileSync(path.join(directory, 'source', manifest.mainFile), 'utf8'),
    ...(themePath === undefined
      ? {}
      : {
          themePath,
          themeText: readFileSync(path.join(directory, 'source', themePath), 'utf8'),
        }),
    referencePdf: new Uint8Array(readFileSync(path.join(directory, 'reference.pdf'))),
  };
}

/**
 * Normalise a typeface name so the PDF's spelling and the CSS one can be compared at all.
 *
 * Declared here rather than in the spec that first needed it: two comparisons now decide which ink on
 * the page belongs to which face, and two copies of this would be two answers to the same question.
 *
 * @param name - A family name from either side.
 * @returns The comparable stem.
 */
export function normaliseFamily(name: string): string {
  // `NotoSerif-Bold` in the PDF is `Noto Serif` at weight 700 in CSS: the style is carried by the
  // weight and slant, which are compared separately, so only the stem is compared here.
  const stem = name.split('-')[0];
  // `M+ 1mn` is `mplus1mn` in the file the gem embeds; the catalogue's own converted names spell it
  // the same way, so the two only meet once the plus sign is spelled out.
  return stem.toLowerCase().replaceAll('+', 'plus').replaceAll(/[^a-z\d]/g, '');
}

/** A file read as a `data:` URL, so a blank page can load it with no server. */
function dataUrl(file: string, mime: string): string {
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

/**
 * The `@font-face` rules for one appearance.
 *
 * The faces are the very files the application serves — the committed catalogue assets, and a
 * project's own files out of its source directory — carried as `data:` URLs because this page has no
 * server behind it. The bytes are identical either way, and the bytes are what the metrics live in.
 *
 * @param sourceDirectory - Where a project-supplied face's file is read from, or undefined when the
 *   appearance references none.
 * @param plan - Where each face of each family it references comes from.
 * @param overridesOf - The metric overrides for each of a face's two registrations.
 * @returns A stylesheet of `@font-face` rules.
 */
function fontFaceRules(
  sourceDirectory: string | undefined,
  plan: ReturnType<typeof planFontFaces>,
   overridesOf: (
    family: string,
    style: FaceStyle,
    registration: FaceRegistration,
  ) => FaceMetricOverrides | undefined,
): string {
  const rules: string[] = [];
  for (const face of plan.faces) {
    const project =
      sourceDirectory === undefined ? undefined : path.join(sourceDirectory, face.assetPath ?? '');
    // Keyed on the source rather than on the URL, so a face this harness cannot place fails to
    // compile rather than falling through to `undefined` and being silently skipped — a skipped face
    // is a page measured against the browser's fallback, which is exactly what this suite exists to
    // catch and would be invisible in its results.
    const served: Partial<Record<typeof face.source, string>> = {
      catalogue: CATALOGUE_DIR,
      substitute: SUBSTITUTE_DIR,
    };
    const directory = served[face.source];
    const file =
      directory === undefined ? project : path.join(directory, path.basename(face.url ?? ''));
    // …and a face this harness can NAME but cannot READ throws, for exactly the same reason. The
    // compile-time keying above only covers a `source` nobody taught this function about; it says
    // nothing about a file that is simply not on disk, and the `continue` that used to stand here
    // was the silent skip the paragraph above denies. Renaming any file under
    // `packages/asciidoc-pdf/assets/fonts/` emitted no `@font-face` for it, the page fell back to
    // whatever the machine had, and every face-identity check still passed: `measureConstruct`
    // reports the FIRST family in the resolved list, which is the family that was asked for whether
    // or not it loaded. Measured, on `default-theme` with `noto-serif-normal.woff2` renamed: the
    // body advance moved 4.6% and nothing in the suite noticed.
    //
    // `plan.faces` is the application's own answer to "which files does this appearance need", so a
    // path that is not there is a real disagreement between the plan and the assets — never
    // something a fixture can legitimately be missing.
    if (file === undefined || !existsSync(file)) {
      throw new Error(
        `fontFaceRules: the ${face.style} face of "${face.family}" is planned from the ` +
          `${face.source} source but ${file ?? 'no file at all'} is not readable. A face this ` +
          `harness cannot place would leave the page laid out in the browser's fallback, which no ` +
          `measurement below can tell apart from the real thing.`,
      );
    }
    const mime = file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';
    const source = `src: url(${dataUrl(file, mime)}); font-weight: ${face.weight}; font-style: ${face.slant}; font-display: block;`;
    // The renderer's own vertical metrics on the family the page's TEXT is set in, which is what the
    // application declares them on — see `loadOne` in `font-faces.ts`. Withheld here, this harness
    // would lay every line out from whichever metric table the browser happens to prefer for the
    // file, which is not the table ttfunk read.
    rules.push(
      `@font-face { font-family: "${face.family}"; ${source} ${faceMetricDeclarations(overridesOf(face.family, face.style, 'text'))} }`,
    );
    // The application registers each file a SECOND time under a metric-bearing name, and sets the
    // constructs that paint a box behind their text in that one. A harness that left it out would
    // measure those boxes against a face the application does not draw them with.
    const painted = overridesOf(face.family, face.style, 'box');
    if (painted !== undefined) {
      rules.push(
        `@font-face { font-family: "${metricFamilyOf(face.family)}"; ${source} ${faceMetricDeclarations(painted)} }`,
      );
    }
  }
  return rules.join('\n');
}

/**
 * The document, converted by the same processor the preview's render worker loads.
 *
 * Same package, same entry point, and the same two attributes the worker seeds: converting with a
 * different Asciidoctor — or without `showtitle` — would compare the preview's styling against
 * markup the preview never produces.
 *
 * @param source - The main document's AsciiDoc.
 * @param baseDirectory - The directory `include::` targets resolve against. A multi-file fixture whose
 *   includes are not resolved converts to a document with the chapters MISSING, and every
 *   comparison against it would then be a comparison of a document the reference PDF is not of.
 * @returns The converted HTML, as the preview receives it.
 */
async function convertDocument(source: string, baseDirectory?: string): Promise<string> {
  const document_ = await loadAsciidoc(source, {
    safe: 'safe',
    ...(baseDirectory === undefined ? {} : { base_dir: baseDirectory }),
    // `showtitle` is what makes the level-0 title an `h1` in embedded output, which is the markup
    // the worker produces and the stylesheet is written against.
    attributes: { icons: 'font', showtitle: '' },
  });
  return String(await document_.convert());
}

/** What the browser was given, so a failure can be read without re-deriving it. */
export interface PreparedPage {
  /** The resolved appearance's custom properties, as set on the page column. */
  readonly cssProperties: Record<string, string>;
  /** The page's own size in points, from the resolved appearance. */
  readonly pageWidthPt: number;
  /** The page's own height in points. */
  readonly pageHeightPt: number;
  /** The theme's margins in points, in CSS edge order. */
  readonly marginPt: { top: number; right: number; bottom: number; left: number };
  /**
   * Families the PROJECT supplies the file for.
   *
   * A project catalogue may call a family anything, while the embedded font keeps the name its file
   * carries — so for these two, a name comparison cannot decide anything, and the caller has to know
   * which they are rather than guess from the name.
   */
  readonly projectFamilies: readonly string[];
}

/**
 * Render one fixture's project through the SHIPPING render worker.
 *
 * The worker is where syntax highlighting happens: Asciidoctor emits `<pre class="highlight"><code
 * class="language-ruby">` and the worker replaces its body with highlight.js token spans. A check on
 * the colour of a keyword therefore has nothing to look at unless the worker ran, which is why this
 * exists and why nothing else in the suite uses it.
 *
 * It is driven the way a worker scope drives it — the module registers its handler on `onmessage` at
 * import and answers through `postMessage` — so what comes back is the markup the application shows,
 * produced by the same code, not a re-creation of it.
 *
 * @param fixture - The fixture whose main document to render.
 * @returns The rendered HTML.
 */
export async function renderWithWorker(fixture: Fixture): Promise<string> {
  return renderSourceWithWorker(fixture.source, path.basename(readMainFile(fixture)));
}

/**
 * Render one AsciiDoc source through the SHIPPING render worker.
 *
 * The fixture-free half of {@link renderWithWorker}, for the checks whose subject is the worker's own
 * post-processing on a document written for the occasion rather than on an anchor.
 *
 * @param source - The document's AsciiDoc.
 * @param mainPath - The name the worker knows the file by.
 * @returns The rendered HTML.
 */
export async function renderSourceWithWorker(source: string, mainPath = 'main.adoc'): Promise<string> {
  const worker = attachWorker();
  worker.answers.length = 0;
  await worker.handler({
    data: {
      requestId: 1,
      content: source,
      mainPath,
      rootFileId: mainPath,
      openFileId: mainPath,
      files: { [mainPath]: source },
      showIncludes: true,
    },
  });
  const answer = worker.answers.at(-1);
  if (answer === undefined) throw new Error('the render worker answered nothing');
  if (!answer.ok || answer.html === null) throw new Error(`the render worker failed: ${answer.error}`);
  return answer.html;
}

/** What one worker answer carries, of the fields a render needs. */
interface WorkerAnswer {
  readonly ok: boolean;
  readonly html: string | null;
  readonly error: string | null;
}

/** The attached worker, once attached. */
let attached: { handler: (event: { data: unknown }) => Promise<void>; answers: WorkerAnswer[] } | null = null;

/**
 * Attach to the worker module, once per process.
 *
 * Once, because the module registers its handler on `onmessage` at IMPORT — and `require` caches, so
 * a second attempt to install the globals and re-import would find nothing to capture and leave the
 * caller looking at a worker that never registered. The handler and the answers it posts are kept
 * here instead, and every render after the first reuses them.
 *
 * @returns The registered handler, and the list its answers are appended to.
 */
function attachWorker(): { handler: (event: { data: unknown }) => Promise<void>; answers: WorkerAnswer[] } {
  if (attached !== null) return attached;

  let handler: ((event: { data: unknown }) => Promise<void>) | null = null;
  const answers: WorkerAnswer[] = [];
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
    value: (message: WorkerAnswer) => {
      answers.push(message);
    },
    writable: true,
    configurable: true,
  });
  // The worker registers its handler as a side effect of being loaded, so the import is the call.
  require('@/workers/asciidoc-render.worker');
  if (handler === null) throw new Error('the render worker registered no handler');

  attached = { handler, answers };
  return attached;
}

/** The main document's project-relative path, from the fixture's manifest. */
function readMainFile(fixture: Fixture): string {
  const manifest = JSON.parse(readFileSync(path.join(fixture.directory, 'manifest.json'), 'utf8')) as {
    mainFile: string;
  };
  return manifest.mainFile;
}

/**
 * Put one fixture's document on the page, dressed in the Print style.
 *
 * @param page - The browser page.
 * @param fixture - The fixture to render.
 * @param markup - Markup to put on the page instead of converting the fixture here. The one caller
 *   that passes it needs the worker's output rather than Asciidoctor's, because what it measures is
 *   produced by the worker; everything else converts here so the suite keeps measuring the styling
 *   rather than the worker.
 * @returns What the page was dressed with.
 */
export async function preparePrintPage(
  page: Page,
  fixture: Fixture,
  markup?: string,
): Promise<PreparedPage> {
  const resolved = resolveAppearance({
    ...(fixture.themeText === undefined ? {} : { themeText: fixture.themeText }),
    ...(fixture.themePath === undefined ? {} : { themePath: fixture.themePath }),
  });
  const plan = planFontFaces(resolved.appearance.fonts, fixture.themePath ?? '');
  // The same metrics the application resolves, from the same two places: the committed catalogue
  // manifest, and the project's own font file read out of the fixture. A harness that skipped them
  // would measure a page dressed in ratios while the application dresses it in line boxes.
  const metrics = resolveFaceMetrics(plan, (assetPath) => {
    const file = path.join(fixture.directory, 'source', assetPath);
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
  });
  const cssProperties = appearanceToCssProperties(resolved.appearance, metrics.boxOf);

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${fontFaceRules(path.join(fixture.directory, 'source'), plan, metrics.overridesOf)}</style>
<style>${readFileSync(STYLESHEET, 'utf8')}</style>
<style>
  /* The application's own reset, in the one respect it matters here: Tailwind's Preflight zeroes
     margins and list styles app-wide, and the Print stylesheet is written against that. Without it
     the browser's defaults would be measured instead of the style under test. */
  * { margin: 0; padding: 0; }
  body { margin: 0; }
</style>
</head>
<body>
<div class="asciidoc-preview-content" data-preview-style="print" data-testid="page">
${markup ?? (await convertDocument(fixture.source, path.join(fixture.directory, 'source')))}
</div>
</body></html>`;

  // Served at an origin rather than set into `about:blank`, exactly as {@link preparePrintDocument}
  // serves its own page and for the same reason: the stylesheet reaches the admonition masks by
  // root-relative path, every fixture is converted with `icons: font`, and a page with no origin can
  // resolve none of them. Nothing measured here reads that ink today — an icon's box is sized by CSS,
  // so the glyph's absence moved nothing — but "the mark this page draws is missing and the
  // measurement cannot tell" is the shape of failure this whole suite exists to prevent, and it was
  // one route registration away from being possible.
  await servePrintPage(page, html, path.join(fixture.directory, 'source'));
  // Set through the CSSOM rather than into a `style` attribute in the markup: a family name is
  // quoted, and a quote inside an HTML attribute ends the attribute — which silently drops every
  // property after the first family and leaves a page dressed in almost nothing. This is exactly the
  // shape of failure the application avoids by handing React an object, so the harness does the same.
  await page.evaluate((properties) => {
    const column = document.querySelector('[data-testid="page"]');
    if (column instanceof HTMLElement) {
      for (const [name, value] of Object.entries(properties)) column.style.setProperty(name, value);
    }
  }, cssProperties);
  await page.evaluate(() => document.fonts.ready);

  return {
    cssProperties,
    pageWidthPt: resolved.appearance.page.widthPt,
    pageHeightPt: resolved.appearance.page.heightPt,
    marginPt: resolved.appearance.page.marginPt,
    projectFamilies: [
      ...new Set(plan.faces.filter((face) => face.source === 'project').map((face) => face.family)),
    ],
  };
}

/** A document and the theme to dress it in, for a check that needs no reference PDF. */
export interface PrintDocument {
  /** AsciiDoc source. */
  readonly source: string;
  /** The theme document's text, or undefined for the renderer's default appearance. */
  readonly themeText?: string;
}

/**
 * Where the admonition icons are read from.
 *
 * The SOURCE assets, deliberately, and not `apps/web/public/vendor/admonition-icons` — which is where
 * the running application serves them from, and which `apps/web/scripts/build-catalogue-fonts.mjs`
 * copies this very directory to. `public/vendor` is a build output and is gitignored, so serving it
 * would make this suite pass or fail on whether a font build had been run, which is a different
 * question from the one it asks. What the route below therefore establishes is that the stylesheet's
 * mask URLs name files that EXIST under the committed source directory, at the paths the stylesheet
 * spells; that the build then publishes that directory under `/vendor` is the copy step's business.
 * An earlier note here claimed the route tested "a path the build publishes", which it does not.
 */
const ICONS_DIR = path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/admonition-icons');

/** A stand-in origin for the page, so its root-relative asset paths resolve to something. */
const PAGE_ORIGIN = 'http://print-preview.test';

/** The content types the served assets need; anything else is handed over as an octet stream. */
const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Put one page of HTML at {@link PAGE_ORIGIN}, with `/vendor/` served from the committed icons and
 * every other path served from the document's own source directory.
 *
 * `page.setContent` would be shorter and is what both preparers used to do. It leaves the document at
 * `about:blank`, where a root-relative URL resolves to nothing — so every `mask-image:
 * url("/vendor/admonition-icons/…")` in the stylesheet 404s and the glyph is simply not painted. That
 * is indistinguishable, to a measurement of anything else, from a page that is perfectly dressed.
 *
 * Giving the page an origin has a second consequence, and it is why EVERY request is answered here
 * rather than only the two that matter: four of the anchor documents carry `image::figure.svg[]`, and
 * with an origin that is a real outbound request for `http://print-preview.test/figure.svg` on every
 * run of every spec that opens one. It resolves to nothing and moves no measurement — Asciidoctor
 * writes the image's width and height into the markup, so the replaced box is the same size whether
 * the file arrives or not — but a suite that reaches the network on a DNS server's whim is a suite
 * that fails for reasons that have nothing to do with fidelity. The catch-all serves the fixture's own
 * file where there is one and answers 404 where there is not; nothing leaves the process either way.
 *
 * @param page - The browser page.
 * @param html - The document to serve.
 * @param assetsRoot - Where the document's own relative assets are read from, or undefined for a
 *   document with no directory behind it.
 */
async function servePrintPage(page: Page, html: string, assetsRoot?: string): Promise<void> {
  // Registered FIRST so the narrower `/vendor/` route below wins for the paths it claims: Playwright
  // tries the most recently registered handler first.
  await page.route(`${PAGE_ORIGIN}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const file =
      assetsRoot === undefined ? undefined : path.join(assetsRoot, path.normalize(pathname).slice(1));
    if (file === undefined || !file.startsWith(assetsRoot ?? '') || !existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({
      contentType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });
  await page.route('**/vendor/admonition-icons/*', (route) => {
    const file = path.join(ICONS_DIR, path.basename(new URL(route.request().url()).pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'image/svg+xml', body: readFileSync(file, 'utf8') });
  });
  await page.goto(`${PAGE_ORIGIN}/`, { waitUntil: 'load' });
}

/**
 * Put an arbitrary document on the page, dressed in the Print style.
 *
 * The fidelity anchors measure typography, colour and geometry against reference PDFs. This is for
 * the constructs those anchors cannot reach — an admonition's icon, a header column, a callout
 * number — where the question is not "is this the same as the PDF's measurement" but "did the theme's
 * value reach this construct at all". Every one of those was silently wrong at some point, because a
 * construct nothing renders is a construct no measurement notices.
 *
 * `/vendor/` is served from the committed assets, so a mask pointing at a path the build does not
 * publish fails here rather than showing an author an empty icon column.
 *
 * It is dressed in the catalogue's own faces, exactly as {@link preparePrintPage} dresses a fixture,
 * and waits for them the same way. It once was not, and the consequence was not confined to the
 * checks that measure a face: a page whose "Noto Serif" and "M+ 1mn" the browser could not find is
 * laid out in a substitute with a different ascent and a different set of advances, so where a mark
 * landed inside a construct was decided by whatever font the machine happened to have. What it does
 * NOT get is a project's own font file, because a document given here has no project to read one
 * from — an appearance resolved without a theme path references only catalogue families.
 *
 * @param page - The browser page.
 * @param document_ - The source and theme to dress it in.
 * @param markup - Markup to put on the page instead of converting the source here. The one caller
 *   that passes it needs the render worker's output rather than Asciidoctor's, because syntax
 *   highlighting is the worker's own post-processing and there is nothing to look at without it.
 * @returns The custom properties the page was dressed with.
 */
export async function preparePrintDocument(
  page: Page,
  document_: PrintDocument,
  markup?: string,
): Promise<Record<string, string>> {
  const resolved = resolveAppearance(
    document_.themeText === undefined ? {} : { themeText: document_.themeText },
  );
  const plan = planFontFaces(resolved.appearance.fonts, '');
  const metrics = resolveFaceMetrics(plan, () => undefined);
  const cssProperties = appearanceToCssProperties(resolved.appearance, metrics.boxOf);

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${fontFaceRules(undefined, plan, metrics.overridesOf)}</style>
<style>${readFileSync(STYLESHEET, 'utf8')}</style>
<style>* { margin: 0; padding: 0; } body { margin: 0; }</style>
</head><body>
<div class="asciidoc-preview-content" data-preview-style="print" data-testid="page">
${markup ?? (await convertDocument(document_.source))}
</div></body></html>`;

  // Served at an origin rather than set into `about:blank`: the stylesheet reaches its masks by
  // root-relative path, and a page with no origin cannot resolve one — so the very thing worth
  // checking would go unrequested and the check would pass on a page that draws nothing.
  await servePrintPage(page, html);
  await page.evaluate((properties) => {
    const column = document.querySelector('[data-testid="page"]');
    if (column instanceof HTMLElement) {
      for (const [name, value] of Object.entries(properties)) column.style.setProperty(name, value);
    }
  }, cssProperties);
  await page.evaluate(() => document.fonts.ready);

  return cssProperties;
}

/**
 * The advance width of one string, as the face the browser resolved sets it.
 *
 * Measured at a thousand pixels and scaled back down, which is the whole trick: Chromium rounds a
 * glyph's advance to a whole device pixel, so a thirteen-character heading measured at its own size
 * comes out two and a quarter per cent wide of the face's real metrics — enough to swamp the
 * difference between the right face and the wrong one. At a thousand pixels the same rounding is a
 * tenth of a per cent, and the advance is a property of the FILE rather than of the size it is drawn
 * at, so scaling it back is exact.
 *
 * ## Why a laid-out span rather than `measureText`
 *
 * A canvas context takes a FONT and nothing else. The page is set with `font-variant-ligatures: none`
 * and `text-rendering: geometricPrecision` — deliberately, because prawn substitutes no ligature and
 * lays out in fractional points — and neither of those is expressible in the `context.font`
 * shorthand, so a canvas measurement of `definition` silently applied the `fi` ligature the page
 * never draws. One ligature is one glyph of a different width: over a ~57pt run that is 0.3 to 0.5pt,
 * at or past the half a per cent the face comparison is held to, and it would have read as the wrong
 * FACE rather than as the wrong measurement. Today's anchors happen to pick words with no ligating
 * pair in them, so the defect is latent — a fixture whose longest space-free body word became
 * `different` would have failed a page that is correct.
 *
 * A span laid out by the same engine, carrying the same two declarations, has no such gap: it is the
 * page's own text-shaping path, which is the thing being measured.
 *
 * @param page - The browser page.
 * @param text - The string to measure.
 * @param font - The family list, weight and slant to set it in.
 * @param sizePt - The size to report the width at, in points.
 * @returns The advance width in points.
 */
export async function advanceWidthPt(
  page: Page,
  text: string,
  font: { family: string; weight: string; style: string },
  sizePt: number,
): Promise<number> {
  const REFERENCE_PX = 1000;
  return page.evaluate(
    async ({ text: string_, family, weight, style, sizePt: size, referencePx }) => {
      // Forced before measuring: an unloaded `@font-face` makes the browser report the FALLBACK's
      // metrics, which is a measurement of the wrong file that looks exactly like a measurement of
      // the right one.
      await document.fonts.load(`${style} ${weight} ${String(referencePx)}px ${family}`, string_);

      const probe = document.createElement('span');
      // `pre` so a leading or trailing space is measured rather than collapsed away, and absolute so
      // a thousand-pixel line cannot reflow the document it is measured in.
      probe.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'visibility:hidden',
        'white-space:pre',
        `font-family:${family}`,
        `font-weight:${weight}`,
        `font-style:${style}`,
        `font-size:${String(referencePx)}px`,
        // The two the canvas cannot carry, and the reason this is a span. Both are what the Print
        // stylesheet sets on the page column itself.
        'font-variant-ligatures:none',
        'text-rendering:geometricPrecision',
        // Neither is inherited here — the probe hangs off `body`, outside the page column — but they
        // are stated so a page that did set one cannot move a measurement of the FACE.
        'letter-spacing:normal',
        'word-spacing:normal',
      ].join(';');
      probe.textContent = string_;
      document.body.append(probe);
      // The width comes back in em (advance over the size it was measured at), so scaling it to the
      // size the page draws at is a multiplication and nothing else.
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return (width / referencePx) * size;
    },
    {
      text,
      family: font.family,
      weight: font.weight,
      style: font.style,
      sizePt,
      referencePx: REFERENCE_PX,
    },
  );
}

/** The family list, weight and slant the browser resolved for one element. */
export async function resolvedFontOf(
  page: Page,
  selector: string,
): Promise<{ family: string; weight: string; style: string } | null> {
  return page.evaluate((css) => {
    const element = document.querySelector(`[data-testid="page"] ${css}`);
    if (element === null) return null;
    const computed = getComputedStyle(element);
    return { family: computed.fontFamily, weight: computed.fontWeight, style: computed.fontStyle };
  }, selector);
}

/** One construct as the browser draws it. */
export interface MeasuredConstruct {
  /** The resolved `font-family` list, first family first. */
  readonly fontFamily: string;
  /** The used font size, in points. */
  readonly fontSizePt: number;
  /** The used text colour, as three channels out of 255. */
  readonly colour: readonly [number, number, number];
  /** The used background colour, or null when it is fully transparent. */
  readonly backgroundColour: readonly [number, number, number] | null;
}

/**
 * Measure one construct on the prepared page.
 *
 * THROWS when the construct's text colour cannot be read, which is the same rule {@link colourOf}
 * enforces and for the same reason. It used to answer `[0, 0, 0]` there, and black is not a reading
 * of `transparent` — it is a mark the page does not draw. `src/styles/print-preview.css` writes
 * `transparent` as the fallback of five `var()`s, so an unemitted custom property really does
 * compute to `rgba(0, 0, 0, 0)`; a caller comparing that against a reference that draws in black
 * would have agreed exactly. `backgroundColour` stays nullable because "this construct is not
 * filled" is a real answer callers ask for; "this construct's text is not coloured" is not.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column; the first match is measured.
 * @returns What the browser resolved for it, or null when nothing matched.
 * @throws {Error} When the match's `color` is absent or fully transparent.
 */
export async function measureConstruct(
  page: Page,
  selector: string,
): Promise<MeasuredConstruct | null> {
  const measured = await page.evaluate(
    ({ selector: css, perPoint }) => {
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (element === null) return null;
      const style = getComputedStyle(element);
      const channels = (value: string): [number, number, number] | null => {
        const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(value);
        if (match === null) return null;
        if (match[4] !== undefined && Number(match[4]) === 0) return null;
        return [Number(match[1]), Number(match[2]), Number(match[3])];
      };
      return {
        // The first family in the list is the one asked for; the rest are the fallbacks after it.
        fontFamily: style.fontFamily.split(',')[0].trim().replaceAll(/^["']|["']$/g, ''),
        fontSizePt: Number.parseFloat(style.fontSize) / perPoint,
        // Reported as-is, including the unreadable case. It is turned into a throw on the Node side
        // rather than here so the message can name the selector and so the returned type stays the
        // three channels every caller already reads.
        colour: channels(style.color),
        rawColour: style.color,
        backgroundColour: channels(style.backgroundColor),
      };
    },
    { selector, perPoint: PIXELS_PER_POINT },
  );
  if (measured === null) return null;
  if (measured.colour === null) {
    throw new Error(
      `measureConstruct: ${selector} has no readable text colour (${JSON.stringify(measured.rawColour)}). ` +
        `A construct whose colour is absent or fully transparent draws nothing, and reporting it as ` +
        `black would have compared a mark the page does not make against a reference that does.`,
    );
  }
  return {
    fontFamily: measured.fontFamily,
    fontSizePt: measured.fontSizePt,
    colour: measured.colour,
    backgroundColour: measured.backgroundColour,
  };
}

/**
 * The text of the first laid-out line of an element, and how many characters it holds.
 *
 * Measured from the line boxes the browser actually produced rather than from the text: where a line
 * breaks is the one property that is a consequence of the typeface, the size and the measure all at
 * once, which is why it is the strongest single check that the preview is set like the PDF.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column.
 * @returns The first line's text, or null when nothing matched.
 */
export async function firstLineOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((css) => {
    const element = document.querySelector(`[data-testid="page"] ${css}`);
    if (element === null) return null;

    // Every text node in the paragraph, in order, so the walk crosses the inline elements a real
    // paragraph carries. A measurement that stopped at the first `<a>` would report the link's
    // position as the line break, which is how a line-break check comes to pass on a page it should
    // have failed and fail on one it should have passed.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let text = '';
    while (walker.nextNode() !== null) {
      const node = walker.currentNode as Text;
      nodes.push(node);
      text += node.data;
    }
    if (nodes.length === 0) return null;

    /** The node and offset one global character offset falls at. */
    const locate = (offset: number): [Text, number] => {
      let remaining = offset;
      for (const node of nodes) {
        if (remaining <= node.data.length) return [node, remaining];
        remaining -= node.data.length;
      }
      const last = nodes.at(-1) as Text;
      return [last, last.data.length];
    };

    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes[0], Math.min(1, nodes[0].data.length));
    const firstTop = range.getClientRects()[0]?.top ?? 0;

    // Grow the range a character at a time; the first line ends where a rectangle appears below the
    // first one. Counting rectangles would not do: a range crossing an inline element produces one
    // rectangle per element on the SAME line.
    for (let length = 1; length <= text.length; length += 1) {
      const [node, offset] = locate(length);
      range.setEnd(node, offset);
      const rects = [...range.getClientRects()];
      const lowest = rects.at(-1);
      if (lowest !== undefined && lowest.top > firstTop + 1) return text.slice(0, length - 1).trimEnd();
    }
    return text;
  }, selector);
}

/**
 * Where the baselines of an element's laid-out lines are, in points from the top of the page column.
 *
 * Baselines rather than box edges, because a baseline is the only vertical position two engines can
 * be compared on: a box top depends on how each of them distributes half-leading, while a baseline is
 * where the glyphs actually sit. The PDF's own text runs report baselines, so this is the same
 * measurement on both sides.
 *
 * The first one is measured rather than computed: a zero-sized inline-block takes its baseline from
 * its bottom margin edge, so one placed at the very start of the element reports that first line's
 * baseline exactly, whatever the face, the size or the browser's own rounding did to the line box.
 * Only the FIRST — an atomic inline dropped at a later line's start is zero-wide, so it still fits at
 * the end of the line before it and would report that line's baseline a second time. The lines after
 * it are stepped down by the distance between the line boxes the browser actually produced, which is
 * the same difference for every line set in one face.
 *
 * Only text set in the element's own face is measured. An inline codespan sits on the same baseline
 * but in a different font, so its rectangle starts somewhere else, and mixing the two would report a
 * step that no line ever took.
 *
 * THROWS when the selector matches nothing, and when what it matches lays out no line in its own
 * face. It used to answer `null` and `[]` for those two, and a caller cannot guard against them
 * without writing a skip: `expect(baselines).not.toBeNull()` is satisfied by `[]`, and the `if
 * (length === 0) return` under it then walked past the comparison the test exists for. One caller
 * really did — the callout ring's signed pair in `print-list-geometry.spec.ts` — and an empty answer
 * would have taken the whole of it out in silence. A measurement that could not be made is a failure
 * of this harness, not a result a spec should have to interpret.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column; the first match is measured.
 * @returns One baseline per line, in reading order; never empty.
 * @throws {Error} When the selector matches nothing, or the match sets no line in its own face.
 */
export async function baselinesOf(page: Page, selector: string): Promise<number[]> {
  const measured = await page.evaluate(
    ({ selector: css, perPoint }) => {
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (element === null) return null;
      const own = getComputedStyle(element);
      const face = `${own.fontFamily}|${own.fontSize}`;

      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const tops: number[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!(node instanceof Text) || parent === null || node.data.trim() === '') continue;
        const parentStyle = getComputedStyle(parent);
        if (`${parentStyle.fontFamily}|${parentStyle.fontSize}` !== face) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.height > 0) tops.push(rect.top);
        }
      }
      if (tops.length === 0) return [];

      const lineTops: number[] = [];
      for (const top of tops.toSorted((a, b) => a - b)) {
        if (lineTops.length === 0 || top - lineTops.at(-1)! > 1) lineTops.push(top);
      }

      const probe = document.createElement('span');
      // Zero-sized so it cannot move anything, and inline-block so its baseline IS its bottom edge.
      probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
      element.insertBefore(probe, element.firstChild);
      const pageTop = document.querySelector('[data-testid="page"]')?.getBoundingClientRect().top ?? 0;
      const firstBaseline = probe.getBoundingClientRect().bottom - pageTop;
      probe.remove();

      return lineTops.map((top) => (firstBaseline + top - lineTops[0]) / perPoint);
    },
    { selector, perPoint: PIXELS_PER_POINT },
  );
  if (measured === null) {
    throw new Error(`baselinesOf: nothing inside the page column matches ${selector}`);
  }
  if (measured.length === 0) {
    throw new Error(`baselinesOf: ${selector} lays out no line in its own face`);
  }
  return measured;
}

/**
 * Where the ink inside one element actually is, as a fraction of that element's own box.
 *
 * A computed style says what a rule asked for; it does not say where a glyph landed. The callout
 * ring's digit was positioned by baseline arithmetic that only held by luck, and every property
 * involved read back exactly as written while the digit sat low and left of the ring around it — so
 * the only check that could have caught it is one that looks at the paint.
 *
 * The browser decodes its own screenshot: handing the PNG back in as a data URL and reading it off a
 * canvas is what makes this measurement possible without an image-decoding dependency.
 *
 * ## Centroid and bounding box are not the same claim
 *
 * The centroid is where the ink's WEIGHT is; the bounding box is where its extent is. For "is this
 * box painted at all, and roughly where", the centroid is the right reading. For "is this glyph
 * centred in the ring around it", it is not: a digit's ink is not symmetric about its own middle —
 * `1` in M+ 1mn carries a flag at the top left and nothing at the bottom right — so its centroid sits
 * off its own bounding box's centre by four per cent of the glyph, whatever the layout did. Both are
 * returned, and a caller asking about placement wants the box.
 *
 * ## …and neither can be read off a sixteen-pixel screenshot
 *
 * A callout ring is twelve to sixteen CSS pixels across. Half a pixel of rasteriser rounding is four
 * per cent of that, which is the whole tolerance such a check can be given — so the measurement is
 * dominated by the raster rather than by the layout. `magnify` scales the page up for the duration of
 * the capture, so the same construct is drawn over hundreds of pixels and the fraction it reports is
 * the layout's rather than the grid's.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column; the first match is captured.
 * @param mute - CSS applied for the duration of the capture, to take out ink that is not the subject
 *   — the ring's own stroke, when it is the digit inside it being measured.
 * @param magnify - How much to scale the page by while capturing. One leaves it as it is drawn.
 * @returns The centroid and the bounding-box centre of the inked pixels, as fractions of the
 *   element's width and height, and how much of the box the ink covers; null when nothing matched or
 *   nothing was inked.
 */
export async function inkCentreOf(
  page: Page,
  selector: string,
  mute = '',
  magnify = 1,
): Promise<{ x: number; y: number; boxX: number; boxY: number; coverage: number } | null> {
  const locator = page.locator(`[data-testid="page"] ${selector}`).first();
  if ((await locator.count()) === 0) return null;
  const style = await page.evaluate(
    ({ css, factor }) => {
      const element = document.createElement('style');
      element.textContent = css;
      element.dataset.inkProbe = 'true';
      document.head.append(element);
      if (factor !== 1) document.documentElement.style.zoom = String(factor);
      return true;
    },
    { css: mute, factor: magnify },
  );
  if (!style) return null;

  const png = await locator.screenshot();
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('style[data-ink-probe]')) element.remove();
    document.documentElement.style.zoom = '';
  });

  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

    // The background is whatever colour most of the box is; anything far enough from it is ink. Taken
    // from the paint rather than from a theme value, so the measurement makes no assumption about
    // what the block behind the mark is filled with.
    const counts = new Map<string, number>();
    for (let index = 0; index < data.length; index += 4) {
      const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const background = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0][0].split(',').map(Number);

    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    let left = Number.NaN;
    let right = Number.NaN;
    let top = Number.NaN;
    let bottom = Number.NaN;
    for (let index = 0; index < data.length; index += 4) {
      const distance = Math.max(
        Math.abs(data[index] - background[0]),
        Math.abs(data[index + 1] - background[1]),
        Math.abs(data[index + 2] - background[2]),
      );
      // Weighted by how far from the background each pixel is, so an antialiased edge contributes in
      // proportion to how much of it is inked rather than all or nothing.
      if (distance < 24) continue;
      const pixel = index / 4;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      weight += distance;
      sumX += x * distance;
      sumY += y * distance;
      left = Number.isNaN(left) ? x : Math.min(left, x);
      right = Number.isNaN(right) ? x : Math.max(right, x);
      if (Number.isNaN(top)) top = y;
      bottom = y;
    }
    if (weight === 0) return null;
    return {
      x: sumX / weight / canvas.width,
      y: sumY / weight / canvas.height,
      // The extent's own middle, in the same fractions. A pixel's index is its left/top edge, so the
      // far edge is one pixel past the last inked one.
      boxX: (left + right + 1) / 2 / canvas.width,
      boxY: (top + bottom + 1) / 2 / canvas.height,
      coverage: weight / (255 * canvas.width * canvas.height),
    };
  }, png.toString('base64'));
}
