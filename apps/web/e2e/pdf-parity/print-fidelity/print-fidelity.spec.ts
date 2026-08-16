import { test, expect } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  drawnRuns,
  pageGeometries,
  paintedBoxes,
  sameColour,
  textRuns,
  type DrawnRun,
  type PaintedBox,
  type Rgb,
  type TextRun,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  advanceWidthPt,
  baselinesOf,
  colourOf,
  firstLineOf,
  hexOf,
  measureConstruct,
  normaliseFamily,
  preparePrintPage,
  readFixture,
  resolvedFontOf,
} from './harness';
import { resolveAppearance } from '@asciidocollab/shared';
import { CATALOGUE_FAMILIES, planFontFaces } from '@/lib/print-preview/font-faces';
import type { Page } from '@playwright/test';

/**
 * The Print style's fidelity gate.
 *
 * The style's claim is that the preview shows the PDF's appearance. A claim like that can only be
 * checked against a PDF that was really rendered — by the external, canonical Asciidoctor-PDF
 * toolchain, never by this application's own export, which would only prove the preview agrees with
 * something built from the same theme resolver it is built from.
 *
 * Four anchors, chosen for what each is the only witness to: the default appearance every theme-less
 * project gets, a theme that changes every construct, a page that is not A4, and a typeface the
 * project itself ships. Between them they exercise the closed list of constructs the style claims.
 *
 * Every tolerance comes from {@link PRINT_FIDELITY_TOLERANCE}, declared once in the harness. A
 * tolerance widened to make a comparison pass is a decision about how faithful the style claims to
 * be, and belongs there with its reason — not here.
 */

/**
 * The first body paragraph inside the first section.
 *
 * Not the document's first paragraph: the renderer styles that one with its own `lead` role, at a
 * larger size, and roles are not among the theme values this style claims to reproduce. Comparing
 * against it would compare the preview to something it never said it would match.
 */
const BODY_PARAGRAPH = '.sect1 .sectionbody > .paragraph:first-of-type > p';

/** The anchors, and what each one is the only witness to. */
const FIXTURES = [
  { name: 'default-theme', why: 'the appearance a project with no theme gets' },
  { name: 'rich-theme', why: 'a theme that changes every construct the style claims' },
  { name: 'letter-geometry', why: 'a page that is neither A4 nor the default margins' },
  { name: 'project-font', why: 'a typeface the project itself ships' },
  { name: 'base14-substitute', why: "a face the renderer names rather than embeds, and the preview stands in for" },
] as const;

/** The stems of the families the committed catalogue holds, for deciding when a NAME can be compared. */
const CATALOGUE_STEMS = new Set(CATALOGUE_FAMILIES.map((family) => normaliseFamily(family)));

/**
 * Whether two typeface names can be compared at all, and if so whether they agree.
 *
 * A project's own font catalogue may call a family anything — `Project Mono` — while the embedded
 * font keeps the name its FILE carries (`mplus1mn`). They are the same file under two names, and no
 * comparison of names can see that. So names are compared only when the PDF's side names a family
 * the catalogue supplies, where the alias question does not arise.
 *
 * A null from here is NOT an answer, and must never stand in for one: every caller pairs it with
 * {@link expectSameFace}, which decides the same question on the faces' own advance widths and does
 * so whatever the two of them are called.
 *
 * @param previewFamily - The family the browser resolved.
 * @param pdfFamily - The name the embedded font gives itself.
 * @param projectFamilies - The families whose file the project itself supplies.
 * @returns Whether the two agree, or null when a name comparison cannot decide.
 */
function familiesAgree(
  previewFamily: string,
  pdfFamily: string,
  projectFamilies: readonly string[],
): boolean | null {
  if (projectFamilies.includes(previewFamily)) return null;
  const embedded = normaliseFamily(pdfFamily);
  if (!CATALOGUE_STEMS.has(embedded)) return null;
  return normaliseFamily(previewFamily) === embedded;
}

/**
 * How far the advance the preview's face gives a string may sit from the advance the page gave it.
 *
 * A fraction rather than a length, because an advance is a fraction of the size it is set at. Half a
 * per cent: Chromium rounds a glyph's advance to a whole device pixel, and {@link advanceWidthPt}
 * measures at a thousand pixels precisely so that rounding is a tenth of a per cent over a run of a
 * dozen characters. What it has to stay clear of is the difference between the right face and the
 * wrong one, which is several per cent even for two faces of the same colour and weight — the browser
 * fallback measures four to seventeen per cent away from these anchors' own faces.
 */
const FACE_ADVANCE = 0.005;

/**
 * Assert that a construct is set in the very face the reference embedded.
 *
 * A NAME cannot always decide this. A project's own font catalogue may call a family anything —
 * `Project Mono` — while the embedded font keeps the name its FILE carries (`mplus1mn`), and the two
 * are the same file. So the comparison is made on the thing a name is only a label for: the advance
 * widths. Two files that set the same string to the same width at the same size are the same face for
 * every purpose this style claims, and no fallback is within per cents of one.
 *
 * The reference's own run supplies both the string and the width, so nothing here is restated. The
 * run must be one the page did not STRETCH — see {@link unstretchedRun}.
 *
 * @param page - The browser page.
 * @param selector - The construct in the preview whose resolved face is measured.
 * @param reference - The reference's run: its text, its size, and the width the page gave it.
 * @param what - What is being compared, for the failure message.
 */
async function expectSameFace(
  page: Page,
  selector: string,
  reference: TextRun,
  what: string,
): Promise<void> {
  const font = await resolvedFontOf(page, selector);
  expect(font, `the preview lays out ${selector}`).not.toBeNull();
  if (font === null) return;

  const measured = await advanceWidthPt(page, reference.text, font, reference.fontSizePt);
  expect(
    Math.abs(measured - reference.widthPt) / reference.widthPt,
    `${what}: the preview sets "${reference.text}" ${measured.toFixed(2)}pt wide in ${font.family}, the page ${reference.widthPt.toFixed(2)}pt`,
  ).toBeLessThanOrEqual(FACE_ADVANCE);

  // …and the page really is set in the face it asked for, rather than in whatever the browser
  // reached for when the registration failed.
  //
  // This used to be an advance comparison against the browser's generic `serif`, asserted to sit
  // FURTHER from the reference than the tolerance — the argument being that a page which had fallen
  // back would then have been caught by the comparison above. That argument holds only while the
  // fallback happens to be far from the reference's own face, and it is not a property of the
  // preview at all. On the base-14 anchor it fails outright: the reference's face is Times-Roman and
  // this machine's `serif` sets "First Section" 119.14pt wide against the page's 119.7pt, 0.4 per
  // cent apart — inside `FACE_ADVANCE`, so the guard reported "this comparison would not have told
  // apart" on a page that is set perfectly well. It was a true statement about the instrument and a
  // false one about the preview, and no reading of a generic family can be made into the other.
  //
  // The document's own font set answers the question exactly instead: a face is in it only because
  // something registered it, and `status` is `'loaded'` only once the bytes were accepted. A page
  // whose `@font-face` never arrived carries no such entry, whatever its fallback measures. Faces
  // declared in a stylesheet are members of `document.fonts` just as constructed ones are, which is
  // what lets the harness's own `@font-face` rules be checked the same way the application's
  // `FontFace` objects would be.
  const asked = font.family.split(',')[0].trim().replaceAll(/^["']|["']$/g, '');
  const registered = await page.evaluate(
    (family) =>
      [...document.fonts].map((face) => ({
        family: face.family.replaceAll(/^["']|["']$/g, ''),
        status: face.status,
      })).filter((face) => face.family === family),
    asked,
  );
  expect(
    registered.map((face) => face.status),
    `${what}: the page has "${asked}" registered, so the advance above measured that file rather than a fallback`,
  ).toContain('loaded');
}

/**
 * A run of the reference the page did not stretch, at one size, as wide as the reference has.
 *
 * These documents set their body text JUSTIFIED, and prawn spends justification entirely on the
 * spaces: it sets a word spacing for the line and leaves every glyph advance alone. So a run carrying
 * a space is a run whose width says as much about where the line broke as about the face, while a run
 * without one has exactly the width the FILE gives it. The longest such run is taken, because the
 * longer the string the less any single glyph's rounding matters.
 *
 * ## Which face a run is in is the run's own property
 *
 * This used to decide that by membership: it collected the trimmed texts of the operator stream's
 * runs in the wanted face and kept only text-layer runs whose whole text was one of them. That is an
 * identity between two DIFFERENT segmentations of the same page, and the two do not always segment
 * alike. Measured on the anchors: the catalogue-faced pages carry the section heading as a single
 * `"First Section"` run in both layers, while the project-faced page carries it as `"First"` and
 * `"Section"` in the text layer and as one `"First Section"` in the operator stream — so no
 * text-layer run was a member and the answer was `undefined` for a page that sets the heading
 * perfectly well. `TextRun` already reports the embedded face name itself (`pdftools.ts:328-329`),
 * so the run's own face is asked for directly. That is strictly narrower than the membership test it
 * replaces — it can no longer be satisfied by a run that merely happens to spell the same word — and
 * it does not depend on the two layers agreeing about where a run ends.
 *
 * @param runs - The reference's text layer.
 * @param sizePt - The size the construct is set at.
 * @param drawnIn - The face, by embedded name, that counts as this construct's; a run at the right
 *   size in the wrong face would otherwise measure the wrong file.
 * @returns The run, or undefined when the reference has none.
 */
function unstretchedRun(
  runs: readonly TextRun[],
  sizePt: number,
  drawnIn: string,
): TextRun | undefined {
  return runs
    .filter(
      (run) =>
        run.page === 1 &&
        run.fontFamily === drawnIn &&
        Math.abs(run.fontSizePt - sizePt) < 0.01 &&
        !/\s/.test(run.text) &&
        run.text.length >= 6,
    )
    .toSorted((a, b) => b.text.length - a.text.length)[0];
}

/**
 * The widest run of one LEFT-ALIGNED construct, which may carry a space.
 *
 * {@link unstretchedRun} refuses a run with a space in it because the body text of these documents is
 * justified and prawn spends justification on the spaces. A heading is not justified —
 * `ink_general_heading` sets it at `heading_text_align`, which is left for every one of these themes
 * — so its inter-word space is the face's own advance and a run carrying one still has exactly the
 * width the FILE gives it. Refusing those here would throw away the only run the catalogue-faced
 * anchors have: their text layer carries the whole heading as a single `"First Section"` run
 * (139.92pt at 22pt), while the project-faced page carries `"First"` and `"Section"` separately
 * (92.40pt for the latter). The widest is taken for the same reason as there — the longer the string,
 * the less any single glyph's rounding matters.
 *
 * @param runs - The reference's text layer.
 * @param sizePt - The size the construct is set at.
 * @param drawnIn - The face, by embedded name, that counts as this construct's.
 * @returns The run, or undefined when the reference has none.
 */
function widestRunInFace(
  runs: readonly TextRun[],
  sizePt: number,
  drawnIn: string,
): TextRun | undefined {
  return runs
    .filter(
      (run) =>
        run.page === 1 &&
        run.fontFamily === drawnIn &&
        Math.abs(run.fontSizePt - sizePt) < 0.01 &&
        run.text.trim().length >= 6,
    )
    .toSorted((a, b) => b.widthPt - a.widthPt)[0];
}

/** Text with its spaces removed, so two engines' ways of writing inter-word space cannot differ. */
function withoutSpaces(text: string): string {
  return text.replaceAll(/\s+/g, '');
}


/** The body-text runs on the first page: the ones set at the theme's own base size. */
function bodyRuns(runs: readonly DrawnRun[], baseSizePt: number): DrawnRun[] {
  return runs.filter(
    (run) => run.page === 1 && Math.abs(run.fontSizePt - baseSizePt) < 0.01 && run.text.trim() !== '',
  );
}

/**
 * The size the REFERENCE sets its body text at, read off the reference and nothing else.
 *
 * This used to come from `--print-base-font-size`, which {@link preparePrintPage} had just written
 * onto the page — so the comparison that followed it read the preview's own number back out of the
 * DOM and compared it to itself, and the reference's only role was to be FILTERED by that number
 * before being asserted to be non-empty. A filter asserted against its own predicate cannot fail for
 * any value the reference happens to carry: every one of these four pages sets four different sizes
 * with more than three runs each, so the projection could have carried the CODE size, the list-title
 * size or the LEAD's and every assertion in the comparison still passed. The lead is the dangerous
 * one — `expectSameFace` measures an advance AT the reference run's own size, so it is size-invariant
 * and would have agreed too.
 *
 * The size most of the page's RUNS are set at is what "the body is set in" means here. Runs rather
 * than characters, deliberately: prawn opens a new run at every change of face or colour, so body
 * text broken by links, emphasis and codespans is many runs while the lead paragraph — three long
 * lines of one face — is a handful. Weighted by characters the lead WINS on two of the four anchors
 * (350 characters against the body's 286 on `default-theme`), which is the very reading this
 * derivation exists to avoid. Measured by runs the body leads every anchor comfortably: 29 against a
 * runner-up of 12, 28 against 17, 30 against 12, 28 against 12.
 *
 * @param runs - The reference's drawn runs.
 * @returns The size, in points.
 */
function baseSizeOf(runs: readonly DrawnRun[]): number {
  const sizes = runs
    .filter((run) => run.page === 1 && run.text.trim() !== '')
    .map((run) => run.fontSizePt.toFixed(3));
  const counts = new Map<string, number>();
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1);
  const ranked = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
  expect(ranked.length, 'the reference sets text on its first page').toBeGreaterThan(1);
  // A clear plurality rather than a coin flip between two constructs that happen to share a page.
  // The narrowest margin across the four anchors is 28 runs against 17.
  expect(
    ranked[0][1],
    `the reference sets most of its first page at one size: ${ranked.map(([size, count]) => `${size}pt x${count}`).join(', ')}`,
  ).toBeGreaterThan(ranked[1][1] * 1.5);
  return Number(ranked[0][0]);
}

/** The single most common value in a list, which is what "the body is set in" means for a page. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

/** One laid-out line of the reference PDF. */
interface ReferenceLine {
  /** 1-based page it is drawn on. */
  readonly page: number;
  /** Baseline in points from the bottom of the page. */
  readonly yPt: number;
  /** Everything drawn on that baseline, left to right. */
  readonly text: string;
  /** Left edge of the leftmost run, in points. */
  readonly leftPt: number;
  /** Right edge of the rightmost run, in points. */
  readonly rightPt: number;
  /** The size most of the line is set at, which is what says which construct it belongs to. */
  readonly fontSizePt: number;
}

/** Lines of text on the first page, grouped by baseline, in reading order. */
function linesOf(runs: readonly TextRun[]): ReferenceLine[] {
  const byBaseline = new Map<string, TextRun[]>();
  for (const run of runs) {
    if (run.text.trim() === '') continue;
    const key = `${run.page}|${Math.round(run.yPt * 10) / 10}`;
    const existing = byBaseline.get(key);
    if (existing === undefined) byBaseline.set(key, [run]);
    else existing.push(run);
  }
  return [...byBaseline.entries()]
    .map(([key, group]): ReferenceLine => {
      const ordered = group.toSorted((a, b) => a.xPt - b.xPt);
      const [page, yPt] = key.split('|').map(Number);
      return {
        page,
        yPt,
        text: ordered.map((run) => run.text).join(''),
        leftPt: ordered[0].xPt,
        rightPt: Math.max(...ordered.map((run) => run.xPt + run.widthPt)),
        // Weighted by how much of the line each run carries, so one inline codespan cannot decide
        // what size the line as a whole is set at.
        fontSizePt:
          mode(ordered.flatMap((run) => Array.from({ length: run.text.length }, () => run.fontSizePt))) ??
          0,
      };
    })
    .toSorted((a, b) => a.page - b.page || b.yPt - a.yPt);
}

/**
 * How far the baseline below one of the reference PDF's lines sits, in points.
 *
 * Located by what the line says rather than by a font size, because a size is not unique on a page —
 * a theme that sets its captions at the code size would otherwise have this measuring the distance
 * between two captions and calling it the code block's leading.
 *
 * @param lines - The page's lines, in reading order.
 * @param opening - The start of the line to measure from, spaces removed.
 * @returns The distance to the next baseline, or undefined when there is no such line or no line
 *   under it.
 */
function baselineStepAfter(lines: readonly ReferenceLine[], opening: string): number | undefined {
  const index = lines.findIndex((line) => withoutSpaces(line.text).startsWith(withoutSpaces(opening)));
  if (index === -1 || index + 1 >= lines.length) return undefined;
  // Never across a page break: the distance from the last line of one page to the first of the next
  // is a page's worth of geometry, not a leading.
  if (lines[index + 1].page !== lines[index].page) return undefined;
  return lines[index].yPt - lines[index + 1].yPt;
}

for (const { name, why } of FIXTURES) {
  test.describe(`${name} — ${why}`, () => {
    test("the page is the size and shape the PDF's page is", async ({ page }) => {
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const [reference] = await pageGeometries(fixture.referencePdf, 150);

      expect(prepared.pageWidthPt).toBeCloseTo(reference.widthPt, 1);
      expect(prepared.pageHeightPt).toBeCloseTo(reference.heightPt, 1);

      // …and the browser drew it at that size, which is the half a resolved value cannot prove.
      const drawn = await page.locator('[data-testid="page"]').evaluate((element, perPoint) => {
        const style = getComputedStyle(element);
        return {
          widthPt: element.getBoundingClientRect().width / perPoint,
          leftPt: Number.parseFloat(style.paddingLeft) / perPoint,
          rightPt: Number.parseFloat(style.paddingRight) / perPoint,
          topPt: Number.parseFloat(style.paddingTop) / perPoint,
        };
      }, PIXELS_PER_POINT);
      expect(Math.abs(drawn.widthPt - reference.widthPt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.geometryPt,
      );

      // The margins, against the PAGE rather than against the resolver that produced them. Comparing
      // `paddingLeft` to `marginPt.left` is the same value read twice: both come out of
      // `resolveAppearance`, so an asymmetric error that preserved their sum — or any error at all in
      // the top one — passed. What the page says instead is where it put its ink: prawn sets a
      // left-aligned line AT the left margin and stretches a justified one TO the right margin, so
      // the leftmost run's own x and the rightmost run's own far edge are the two margins exactly.
      const inked = await textRuns(fixture.referencePdf);
      const runs = inked.filter((run) => run.page === 1 && run.text.trim() !== '');
      const referenceLeftPt = Math.min(...runs.map((run) => run.xPt));
      const referenceRightPt = reference.widthPt - Math.max(...runs.map((run) => run.xPt + run.widthPt));
      // What the reference says, before the preview is asked anything: these are real margins, not a
      // page whose text happens to start near an edge.
      expect(referenceLeftPt, 'the reference indents its text from the left edge').toBeGreaterThan(10);
      expect(referenceRightPt, 'and stops short of the right one').toBeGreaterThan(10);
      expect(Math.abs(drawn.leftPt - referenceLeftPt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.geometryPt,
      );
      expect(Math.abs(drawn.rightPt - referenceRightPt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.geometryPt,
      );

      // The top edge cannot be read off an x the way the sides can: what a page records above its
      // first line is a BASELINE, and a baseline sits below the margin by that line's own ascent. So
      // the two are compared where both engines do record the same thing — the distance from the top
      // of the page to the first baseline on it. That folds the top margin together with the title's
      // line box, which is why it carries the allowance below and the sides do not.
      const referenceFirstBaselinePt =
        reference.heightPt - Math.max(...runs.map((run) => run.yPt));
      // `baselinesOf` throws when the title sets no line, so `[0]` is a real baseline here.
      const titleBaselines = await baselinesOf(page, 'h1');
      // Signed, not absolute, and that is what keeps the allowance from swallowing an error of its
      // own size. The quantisation is nearly one-signed: Chromium rounds the face's ascent and its
      // descent to whole pixels and then FLOORS the half-leading it derives from them, and it is the
      // floor that dominates — the derivation at `lineBoxQuantisationPt` puts the placement error in
      // (-1.5, +0.5) CSS pixels, so the preview's baseline may sit up to the allowance above the
      // page's and 0.375pt below it. The lower bound is `geometryPt`, which is wider than that
      // 0.375pt and so admits the whole of the quantisation while still catching a top margin a
      // couple of points too large the moment it appears — where an absolute comparison would have
      // had four points of room to hide in.
      const raisedPt = referenceFirstBaselinePt - titleBaselines[0];
      const where =
        `preview sets the first baseline ${titleBaselines[0].toFixed(2)}pt below the page's top edge, the page ${referenceFirstBaselinePt.toFixed(2)}pt` +
        ` (padding-top ${drawn.topPt.toFixed(2)}pt)`;
      expect(raisedPt, where).toBeGreaterThanOrEqual(-PRINT_FIDELITY_TOLERANCE.geometryPt);
      expect(raisedPt, where).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.geometryPt + PRINT_FIDELITY_TOLERANCE.lineBoxQuantisationPt,
      );
    });

    test('a full line of body text is as wide in the preview as it is on the page', async ({
      page,
    }) => {
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const runs = await textRuns(fixture.referencePdf);

      // The default theme justifies body text, so a full line's right edge is the measure's right
      // edge exactly. Taking the widest line is what makes this a measurement of the column rather
      // than of one ragged line.
      const lines = linesOf(runs).filter((line) => line.page === 1);
      const widest = Math.max(...lines.map((line) => line.rightPt - line.leftPt));
      const columnPt = prepared.pageWidthPt - prepared.marginPt.left - prepared.marginPt.right;

      // A drawn line can only be narrower than the measure it is set in, never wider — so the check
      // is that the measure the preview lays text out in is the one the page used.
      expect(widest).toBeLessThanOrEqual(columnPt + PRINT_FIDELITY_TOLERANCE.geometryPt);
      expect(columnPt - widest).toBeLessThanOrEqual(2);

      const measured = await page.locator('[data-testid="page"]').evaluate((element, perPoint) => {
        const style = getComputedStyle(element);
        const inner =
          element.getBoundingClientRect().width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        return inner / perPoint;
      }, PIXELS_PER_POINT);
      expect(Math.abs(measured - columnPt)).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    });

    test('body text is set in the same typeface, at the same size, in the same colour', async ({
      page,
    }) => {
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);

      // Everything expected below is the REFERENCE's, read before the preview is asked anything.
      const drawn = await drawnRuns(fixture.referencePdf);
      const baseSizePt = baseSizeOf(drawn);
      // …and the reference's own statement that the derivation did not land on the LEAD. The
      // renderer gives the document's first paragraph a role of its own at a larger size, and that
      // paragraph is four to nine runs of every one of these first pages — enough, on its own, to
      // satisfy a "more than three runs" test and every comparison under it. Stating the two apart
      // here is what makes the size below a measurement rather than a choice.
      const lead = drawn.find(
        (run) => run.page === 1 && run.text.startsWith('A paragraph of body text'),
      );
      expect(lead, "the reference sets the document's lead paragraph").toBeDefined();
      expect(
        lead?.fontSizePt ?? 0,
        `the renderer sets the lead larger than body text (lead ${String(lead?.fontSizePt)}pt, body ${String(baseSizePt)}pt)`,
      ).toBeGreaterThan(baseSizePt);

      const runs = bodyRuns(drawn, baseSizePt);
      expect(runs.length, 'the reference PDF has body text set at the theme base size').toBeGreaterThan(3);

      const referenceFamily = mode(runs.map((run) => normaliseFamily(run.fontFamily)));
      const referenceColour = mode(runs.map((run) => run.colour.join(',')));

      // The body paragraph inside the first section: the document's FIRST paragraph is styled as a
      // lead by the renderer's own role, which the preview does not model and does not claim to.
      const measured = await measureConstruct(page, BODY_PARAGRAPH);
      expect(measured, 'the converted document has a body paragraph in the first section').not.toBeNull();
      if (measured === null) return;

      const bodyFamily = mode(runs.map((run) => run.fontFamily));
      expect(referenceFamily, 'the reference names the face its body text is set in').toBeDefined();
      const agree = familiesAgree(measured.fontFamily, bodyFamily ?? '', prepared.projectFamilies);
      // The name, when a name can decide it — and the FACE either way. On the project-font anchor the
      // name cannot decide anything (the catalogue calls the file `Project Mono`, the embedded font
      // calls itself `mplus1mn`), and the anchor whose entire purpose is a project-supplied face was
      // therefore the one construct nothing checked at all: the `@font-face` could have failed to
      // register and this still reported "verified".
      if (agree !== null) expect(agree, `${measured.fontFamily} vs ${bodyFamily}`).toBe(true);
      const sample = unstretchedRun(await textRuns(fixture.referencePdf), baseSizePt, bodyFamily ?? '');
      expect(sample, 'the reference sets a word of body text the justification did not stretch').toBeDefined();
      if (sample !== undefined) await expectSameFace(page, BODY_PARAGRAPH, sample, 'the body face');
      expect(Math.abs(measured.fontSizePt - baseSizePt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.fontSizePt,
      );
      const expected = (referenceColour ?? '0,0,0').split(',').map(Number);
      for (const [channel, value] of measured.colour.entries()) {
        expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(
          PRINT_FIDELITY_TOLERANCE.colourChannel,
        );
      }
    });

    test('a section heading is set in the same typeface, size and colour', async ({ page }) => {
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const runs = await drawnRuns(fixture.referencePdf);
      const heading = runs.find((run) => run.text.startsWith('First Section'));
      expect(heading, 'the reference PDF draws the section heading').toBeDefined();
      if (heading === undefined) return;

      const measured = await measureConstruct(page, 'h2');
      expect(measured).not.toBeNull();
      if (measured === null) return;

      const headingAgree = familiesAgree(
        measured.fontFamily,
        heading.fontFamily,
        prepared.projectFamilies,
      );
      if (headingAgree !== null) {
        expect(headingAgree, `${measured.fontFamily} vs ${heading.fontFamily}`).toBe(true);
      }
      // And the face itself, which is the only thing that decides it on the project-font anchor —
      // where the name comparison above is skipped and nothing else here looked at the heading's
      // typeface at all. `ink_general_heading` sets a heading at `heading_text_align`, which is left
      // for every one of these themes, so the run's width is the width the file gives it.
      //
      // Located with {@link widestRunInFace} rather than by `find(startsWith('First Section'))`,
      // because whether the two words arrive as one run or as two is the reference's business and
      // not this comparison's. They really do differ: with the anchor set in the catalogue's own
      // mono face the text layer carries a single `"First Section"` run, and with the project's own
      // file it carries `"First"` (66.00pt) and `"Section"` (92.40pt) separately — same page, same
      // heading, same size. The `startsWith` lookup found nothing in the second case and the whole
      // face comparison went out on "the reference's text layer carries the section heading",
      // naming a fixture defect that did not exist. `unstretchedRun` asks for what this actually
      // needs — a run at the heading's size, in the heading's face, with no space in it to have
      // been stretched — and is stricter than the lookup it replaces on every count.
      const inked = await textRuns(fixture.referencePdf);
      const headingRun = widestRunInFace(inked, heading.fontSizePt, heading.fontFamily);
      expect(
        headingRun,
        `the reference sets a word of the section heading in ${heading.fontFamily} at ${String(heading.fontSizePt)}pt that the page did not stretch`,
      ).toBeDefined();
      if (headingRun !== undefined) await expectSameFace(page, 'h2', headingRun, 'the heading face');
      expect(Math.abs(measured.fontSizePt - heading.fontSizePt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.fontSizePt,
      );
      for (const [channel, value] of measured.colour.entries()) {
        expect(Math.abs(value - heading.colour[channel])).toBeLessThanOrEqual(
          PRINT_FIDELITY_TOLERANCE.colourChannel,
        );
      }
    });

    test('a link is drawn in the same colour', async ({ page }) => {
      const fixture = readFixture(name);
      await preparePrintPage(page, fixture);
      const runs = await drawnRuns(fixture.referencePdf);
      const link = runs.find((run) => run.text.includes('an external site'));
      expect(link, 'the reference PDF draws the link text').toBeDefined();
      if (link === undefined) return;

      const measured = await measureConstruct(page, 'a');
      expect(measured).not.toBeNull();
      if (measured === null) return;
      for (const [channel, value] of measured.colour.entries()) {
        expect(Math.abs(value - link.colour[channel])).toBeLessThanOrEqual(
          PRINT_FIDELITY_TOLERANCE.colourChannel,
        );
      }
    });

    test('a code block is set in the same typeface and size', async ({ page }) => {
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const runs = await drawnRuns(fixture.referencePdf);
      const code = runs.find((run) => run.text.includes('asciidoctor-pdf'));
      expect(code, 'the reference PDF draws the code block').toBeDefined();
      if (code === undefined) return;

      const measured = await measureConstruct(page, '.listingblock pre');
      expect(measured).not.toBeNull();
      if (measured === null) return;

      const codeAgree = familiesAgree(measured.fontFamily, code.fontFamily, prepared.projectFamilies);
      if (codeAgree !== null) expect(codeAgree, `${measured.fontFamily} vs ${code.fontFamily}`).toBe(true);
      // A code block is verbatim: nothing stretches it, so the run's own width is the file's.
      const inked = await textRuns(fixture.referencePdf);
      const codeRun = inked.find((run) => run.text.includes('asciidoctor-pdf'));
      expect(codeRun, "the reference's text layer carries the code block").toBeDefined();
      if (codeRun !== undefined) {
        await expectSameFace(page, '.listingblock pre', codeRun, 'the code face');
      }
      expect(Math.abs(measured.fontSizePt - code.fontSizePt)).toBeLessThanOrEqual(
        PRINT_FIDELITY_TOLERANCE.fontSizePt,
      );
    });

    test('consecutive lines of body text sit as far apart as the page sets them', async ({
      page,
    }) => {
      // The leading is not the theme's line height. The renderer's line box is the FACE's own built-in
      // height plus `(line-height - 1) x font-size`, so a preview that writes the theme's number into
      // CSS — where it is the whole box — sets its lines about a fifth too close on the renderer's own
      // default theme. Nothing above this catches it: every horizontal measurement is unaffected.
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const baseSizePt =
        Number.parseFloat(prepared.cssProperties['--print-base-font-size']) / PIXELS_PER_POINT;

      const lines = linesOf(await textRuns(fixture.referencePdf));
      const reference = baselineStepAfter(lines, 'Body text with a link to');
      expect(reference, 'the reference PDF sets the section body paragraph over two lines').toBeDefined();
      if (reference === undefined) return;

      const baselines = await baselinesOf(page, BODY_PARAGRAPH);
      expect(baselines.length, 'the previewed paragraph runs to more than one line').toBeGreaterThan(1);
      const preview = baselines[1] - baselines[0];

      expect(
        Math.abs(preview - reference),
        `preview leading ${preview.toFixed(2)}pt, page ${reference.toFixed(2)}pt at ${baseSizePt}pt body text`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    });

    test('consecutive lines of a code block sit as far apart as the page sets them', async ({
      page,
    }) => {
      // A second face and a second size, which is what makes this more than a repeat of the check
      // above: the code family's built-in height is nothing like the body family's, so one global
      // number for the whole page is wrong here even when it is right for body text.
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const codeSizePt =
        Number.parseFloat(prepared.cssProperties['--print-code-font-size']) / PIXELS_PER_POINT;

      const lines = linesOf(await textRuns(fixture.referencePdf));
      const reference = baselineStepAfter(lines, "require 'asciidoctor-pdf'");
      expect(reference, 'the reference PDF sets the code block over two lines').toBeDefined();
      if (reference === undefined) return;

      const baselines = await baselinesOf(page, '.listingblock pre');
      expect(baselines.length, 'the previewed code block runs to more than one line').toBeGreaterThan(1);
      const preview = baselines[1] - baselines[0];

      expect(
        Math.abs(preview - reference),
        `preview leading ${preview.toFixed(2)}pt, page ${reference.toFixed(2)}pt at ${codeSizePt}pt code`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    });

    test('a section heading is the same distance above the text it introduces', async ({ page }) => {
      // Measured baseline to baseline across the boundary, so it holds the heading's own line box and
      // its bottom margin together. A heading set at the browser's idea of a line box lands its own
      // text in the right place and everything after it in the wrong one.
      //
      // ## Why this is baseline to baseline and not tighter than half a point
      //
      // A heading's baseline sits a fraction of a point higher INSIDE its own line box than the page
      // sets it, and the same fraction comes back out of the gap below. That is Chromium quantising,
      // not arithmetic anywhere in this style, and it was settled by measuring the two engines' font
      // metrics against each other rather than by reasoning about the CSS:
      //
      //   - The metrics agree. Measured from the face itself at 2000px, where rounding is nothing,
      //     Chromium reads Noto Serif as ascent 1.0690 em and descent 0.2930 em; prawn reports
      //     1.0680 and 0.2920 for the same file. A thousandth of an em is not a defect anyone can
      //     see, and it is not where the difference comes from.
      //   - What Chromium USES is quantised. Swept from 8.0pt to 30.0pt in half-point steps, the
      //     ascent and descent it lays a line box out with are whole numbers of CSS pixels at every
      //     one of the 45 sizes, while prawn's are exact reals: at 20pt (26.667px) Chromium lays out
      //     28px over 8px against an exact 28.51 over 7.81. So every first baseline lands on a whole
      //     CSS pixel — 17px for body text and 19, 23, 30 and 41px for h4 down to h1 in the anchor
      //     theme — and one CSS pixel is 0.75pt.
      //   - It cannot accumulate. The line box itself is the stated line-height (41.594px measured
      //     against a stated 41.6), so whatever the baseline gains inside the box is exactly what the
      //     gap below it loses. Measured over two fixtures: h2 -0.05pt above and +0.05 below, h3
      //     -0.10 and +0.08, h4 +0.50 and -0.50.
      //
      // Half a point is therefore a floor rather than a slack allowance. Tightening it would not find
      // a defect; it would fail on the pixel grid, and the only way to pass would be to push the
      // heading's text off the browser's own line box — which is the defect this test exists to catch.
      const fixture = readFixture(name);
      await preparePrintPage(page, fixture);
      const lines = linesOf(await textRuns(fixture.referencePdf));
      const reference = baselineStepAfter(lines, 'First Section');
      expect(reference, 'the reference PDF draws body text under the section heading').toBeDefined();
      if (reference === undefined) return;

      const headingBaselines = await baselinesOf(page, 'h2');
      const bodyBaselines = await baselinesOf(page, BODY_PARAGRAPH);
      const heading = headingBaselines[0];
      const body = bodyBaselines[0];

      expect(
        Math.abs(body - heading - reference),
        `preview ${(body - heading).toFixed(2)}pt from heading to body, page ${reference.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    });

    test('the document header carries the doctitle and nothing else', async ({ page }) => {
      // `convert_document` inks exactly one thing above the body when there is no title page:
      // `ink_general_heading doc, doc.doctitle …`, under `unless title_as_page`. The author line and
      // the revision line are written only by `ink_title_page`, which this style deliberately does
      // not reproduce — so a details line in the preview is a line, and a block margin, that the
      // export does not have, pushing the whole document down by that much.
      const fixture = readFixture(name);
      await preparePrintPage(page, fixture);
      // The anchor documents carry an author line and a revision line under the title; taken from the
      // source rather than restated, so a fixture that changes them cannot leave this passing on a
      // string nothing writes any more.
      const [title, author, revision] = fixture.source.split('\n');
      expect(author, 'the anchor document carries an author line').toMatch(/\w/);
      // The revision DATE rather than the author's name: these documents also quote that author, so
      // the name is on the page for a reason that has nothing to do with the header. The date appears
      // nowhere else, which is what makes its absence a statement about the header alone.
      const revisionDate = revision.split(', ')[1] ?? '';
      expect(revisionDate, 'the anchor document carries a revision date').toMatch(/\d{4}/);

      const runs = await textRuns(fixture.referencePdf);
      const drawn = (text: string): boolean =>
        runs.some((run) => withoutSpaces(run.text).includes(withoutSpaces(text)));
      expect(drawn(title.replace('= ', '')), 'the reference PDF inks the doctitle').toBe(true);
      expect(drawn(revisionDate), 'the reference PDF inks no revision line').toBe(false);

      // What the preview actually SHOWS, rather than what any one element's style says. The details
      // block reaches this style by two routes and the claim is the same either way, so BOTH are put
      // on the page: Asciidoctor's embedded output — which is what the harness converts and what the
      // render worker produces — writes no `#header` at all, so a check that only looked at the
      // converted markup was asking about an element that is never there and could not fail. The
      // standalone markup is appended here so the rule that hides it has something to hide.
      const previewed = await page.evaluate(
        ({ author: authorLine, revision: revisionLine }) => {
          const column = document.querySelector('[data-testid="page"]');
          if (column === null) return null;
          const converted = {
            // `innerText`, not `textContent`, and that is the whole point: `textContent` reports the
            // text of a `display: none` element too, so it would read the details line the page is
            // being asserted not to show.
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- see above
            text: (column as HTMLElement).innerText,
            title: column.querySelector('h1')?.textContent ?? '',
            hasHeader: column.querySelector('#header') !== null,
          };
          // Asciidoctor's standalone header, spelled the way its HTML5 converter spells it.
          const standalone = document.createElement('div');
          standalone.id = 'header';
          standalone.innerHTML = `<div class="details"><span id="author" class="author">${authorLine}</span><br><span id="revdate">${revisionLine}</span></div>`;
          column.prepend(standalone);
          const details = column.querySelector('#header .details');
          const measured = {
            detailsHeightPx: (details as HTMLElement | null)?.getBoundingClientRect().height ?? -1,
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- as above
            textWithHeader: (column as HTMLElement).innerText,
          };
          standalone.remove();
          return { ...converted, ...measured };
        },
        { author, revision },
      );
      expect(previewed, 'the preview lays out the page column').not.toBeNull();
      if (previewed === null) return;
      // The embedded markup the preview really renders carries none of it…
      expect(previewed.hasHeader, "the converted document writes no header block of its own").toBe(false);
      expect(withoutSpaces(previewed.text)).not.toContain(withoutSpaces(revisionDate));
      // …and the standalone markup, where an author meets it, is hidden rather than merely empty: a
      // details block that took room would push the whole document down by a line and a block margin.
      expect(previewed.detailsHeightPx, 'a details block, where one is written, takes no room').toBe(0);
      expect(withoutSpaces(previewed.textWithHeader)).not.toContain(withoutSpaces(revisionDate));
      expect(withoutSpaces(previewed.title)).toBe(withoutSpaces(title.replace('= ', '')));
    });

    test("a striped table row is filled with the colour the page fills it with", async ({ page }) => {
      // Nothing about a fill reaches a PDF's text layer, so a stripe can be resolved, projected and
      // written into the stylesheet — and drawn by neither engine — while every measurement above
      // passes. The anchor document's table asks for `stripes=even`, which the renderer turns into
      // alternating row colours, so the fill is on the page and can be looked for.
      //
      // ## Why the row is located geometrically
      //
      // Both sides of this used to be the preview's own projection: the wanted colour came off
      // `--print-table-body-stripe-background-color`, the reference side asked only whether SOME
      // filled path anywhere in the document carried it, and the preview side compared row 1 to the
      // same projected value. `rich-theme` fills its header rows with `#dde6f0` six times, so a
      // resolver that read `table.head.background-color` into the stripe key drew a table striped in
      // its own header colour and satisfied all three assertions. What the reference actually says
      // about a stripe is which ROW is filled and with what, so the row is found by its own text and
      // its rectangle read there.
      const fixture = readFixture(name);
      await preparePrintPage(page, fixture);

      const runs = await textRuns(fixture.referencePdf);
      // `paintedBoxes` rather than `filledColours`: it maps each path through the transform in force
      // and confines it to the clipping region, so what it reports is the rectangle a reader sees
      // and where it is — which is the whole of what makes this a measurement of a ROW.
      const painted = await paintedBoxes(fixture.referencePdf);
      const boxes = painted.filter((box) => box.filled);
      const fillBehind = (label: string): Rgb => {
        const run = runs.find((candidate) => candidate.text.trim() === label);
        expect(run, `the reference draws the table cell reading "${label}"`).toBeDefined();
        if (run === undefined) return [0, 0, 0];
        const around = boxes.filter(
          (box: PaintedBox) =>
            box.page === run.page &&
            box.bottomPt < run.yPt &&
            box.topPt > run.yPt &&
            box.leftPt <= run.xPt &&
            box.rightPt >= run.xPt,
        );
        expect(around.length, `and fills the row "${label}" sits in`).toBeGreaterThan(0);
        // The tightest box around the run, which is the row's own rectangle: a themed page also
        // paints the whole sheet, and that rectangle contains every row on it.
        return around.toSorted((a, b) => a.widthPt * a.heightPt - b.widthPt * b.heightPt)[0].colour;
      };

      const header = fillBehind('Construct');
      const bodyFills = ['Paragraphs', 'Lists', 'Tables', 'Blocks'].map((label) => fillBehind(label));
      const plain = bodyFills[0];
      const stripe = bodyFills.find((fill) => !sameColour(fill, plain));
      expect(stripe, 'the reference stripes this table: a body row is filled unlike the first').toBeDefined();
      if (stripe === undefined) return;
      // …and the stripe is not the header's fill. `table.head.background-color` and
      // `table.body.stripe-background-color` are separate theme values that a projection can confuse,
      // and this is the assertion that can tell them apart at all.
      expect(
        sameColour(stripe, header),
        `the reference stripes in ${hexOf(`rgb(${stripe.join(',')})`)} and heads in ${hexOf(`rgb(${header.join(',')})`)}`,
      ).toBe(false);

      // …and the preview fills the same row with it. `stripes=even` colours the SECOND body row:
      // prawn-table indexes body rows from zero and takes `[body, stripe]` in turn, so the stripe
      // lands on index 1. (Which body row the REFERENCE stripes is a page-by-page matter — the cycle
      // restarts wherever a table breaks across a page, as `rich-theme`'s does — so what is held
      // here is the colour of a striped row and not its ordinal.)
      const measured = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-testid="page"] table.tableblock tbody tr')].map(
          (row) => getComputedStyle(row).backgroundColor,
        ),
        head:
          document.querySelector('[data-testid="page"] table.tableblock thead th.tableblock') === null
            ? 'missing'
            : getComputedStyle(
                document.querySelector(
                  '[data-testid="page"] table.tableblock thead th.tableblock',
                ) as HTMLElement,
              ).backgroundColor,
      }));
      expect(measured.rows.length, 'the anchor document has a table with body rows').toBeGreaterThan(1);
      expect(
        sameColour(colourOf(measured.rows[1], 'the previewed stripe'), stripe),
        `preview stripes ${measured.rows[1]}, page rgb(${stripe.join(', ')})`,
      ).toBe(true);
      // The row above it is not striped, which is what makes the fill a stripe rather than a table
      // colour…
      expect(measured.rows[0], 'the row above it is not striped').not.toBe(measured.rows[1]);
      // …and the header keeps its own fill, which is the other half of telling the two keys apart.
      expect(
        sameColour(colourOf(measured.head, 'the previewed header fill'), header),
        `preview heads ${measured.head}, page rgb(${header.join(', ')})`,
      ).toBe(true);
    });

    test("a quote's rule and its text sit where the page puts them", async ({ page }) => {
      // The rule is stroked, not framed: `stroke_vertical_rule` draws a straight line with square
      // ends, on the block's own left edge, and `pad_box` then insets the text by the theme's padding
      // measured from that same edge. A CSS border sits OUTSIDE the padding and takes a corner radius
      // from anything that offers one, so both halves of that have to be undone deliberately.
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const lines = linesOf(await textRuns(fixture.referencePdf));
      const quoted = lines.find((line) =>
        withoutSpaces(line.text).startsWith(withoutSpaces('The Analytical Engine weaves')),
      );
      expect(quoted, 'the reference PDF sets the quotation').toBeDefined();
      if (quoted === undefined) return;

      const measured = await page.locator('[data-testid="page"] .quoteblock').evaluate(
        (element, perPoint) => {
          const style = getComputedStyle(element);
          const text = element.querySelector('blockquote p');
          const box = element.getBoundingClientRect();
          return {
            radius: style.borderTopLeftRadius,
            // Where the quotation's own text starts, measured from the block's left edge, which is
            // where the renderer strokes the rule.
            textInsetPt:
              ((text?.getBoundingClientRect().left ?? box.left) - box.left) / perPoint,
            pageLeftPt: (text?.getBoundingClientRect().left ?? 0) / perPoint,
          };
        },
        PIXELS_PER_POINT,
      );

      // A rule has square ends. A radius here is the base radius leaking in through a fallback the
      // renderer does not have.
      expect(Number.parseFloat(measured.radius)).toBe(0);

      const columnLeftPt = prepared.marginPt.left;
      const referenceInsetPt = quoted.leftPt - columnLeftPt;
      expect(
        Math.abs(measured.textInsetPt - referenceInsetPt),
        `preview insets the quotation ${measured.textInsetPt.toFixed(2)}pt, page ${referenceInsetPt.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    });

    test('a full line of body text breaks in the same place', async ({ page }) => {
      // The strongest single check in this file: where a line breaks is a consequence of the
      // typeface, its size and the measure all at once. It is also the one an author would notice.
      const fixture = readFixture(name);
      const prepared = await preparePrintPage(page, fixture);
      const baseSizePt =
        Number.parseFloat(prepared.cssProperties['--print-base-font-size']) / PIXELS_PER_POINT;

      const runs = await textRuns(fixture.referencePdf);
      const lines = linesOf(runs);
      // Located and compared without spaces: the two engines write inter-word space differently (one
      // draws it, one advances past it), and how a space is represented is not what is being compared.
      const referenceLine = lines.find((line) =>
        withoutSpaces(line.text).startsWith(withoutSpaces('Body text with a link to')),
      );
      expect(referenceLine, 'the reference PDF sets the section body paragraph').toBeDefined();
      if (referenceLine === undefined) return;

      const previewLine = await firstLineOf(page, BODY_PARAGRAPH);
      expect(previewLine).not.toBeNull();
      if (previewLine === null) return;

      // Compare where the break falls, in characters. The reference line's own text is the yardstick.
      const referenceText = withoutSpaces(referenceLine.text);
      const previewText = withoutSpaces(previewLine);
      expect(
        Math.abs(previewText.length - referenceText.length),
        `preview broke after ${previewText.length} characters, the page after ${referenceText.length}` +
          ` (base size ${baseSizePt}pt)`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.lineBreakCharacters);
    });
  });
}

/**
 * The project-supplied-font anchor's own competence, stated before anything is measured against it.
 *
 * Every other comparison on that anchor decides "is the preview set in the file the project ships"
 * on the FACE — `familiesAgree` returns null for a project family, so the name never decides it, and
 * `expectSameFace` compares advance widths. That is the right instrument, and it is only as good as
 * the distance between the two files it has to tell apart.
 *
 * It was not good enough. The fixture used to ship `project-mono-regular.ttf` and friends as byte
 * copies of the catalogue's own M+ 1mn: nameID 1 `M+ 1mn`, nameID 6 `mplus1mn-regular`, the same
 * 500/1000 monospace advances, and `normaliseFamily` folding both spellings to `mplus1mn`. The
 * anchor whose entire purpose is a project-supplied face could not distinguish that face from the
 * one the renderer already bundles — a `planFontFaces` that fell back to the catalogue when a
 * project asset was missing left all four of its comparisons green while the preview read a
 * different file from the export. The faces are now Liberation Mono (nameID 1 `Liberation Mono`,
 * nameID 6 `LiberationMono`, 1229/2048 = 0.600 em advances against M+ 1mn's 0.500), so the two are
 * twenty per cent apart on every glyph.
 *
 * This test is what keeps that true. Both halves are read out of the reference at run time: that the
 * page really embedded a face the catalogue does not supply, and that the catalogue's own face — the
 * one a fallback would reach, and which this very page also embeds for its code — sets the
 * reference's own string to a width the comparison would notice. Neither is a claim about the
 * preview; together they are the claim that the preview's comparisons can fail.
 */
test('the project-supplied-font anchor can tell the project file from the catalogue', async ({
  page,
}) => {
  const fixture = readFixture('project-font');
  const prepared = await preparePrintPage(page, fixture);
  const drawn = await drawnRuns(fixture.referencePdf);
  const inked = await textRuns(fixture.referencePdf);

  const baseSizePt = baseSizeOf(drawn);
  const bodyFamily = mode(bodyRuns(drawn, baseSizePt).map((run) => run.fontFamily));
  expect(bodyFamily, 'the reference names the face its body text is set in').toBeDefined();

  // Half one: the embedded name is not one the catalogue supplies. `normaliseFamily` is the same
  // fold `familiesAgree` uses, so this says precisely what that function would have had to decide.
  expect(
    CATALOGUE_STEMS.has(normaliseFamily(bodyFamily ?? '')),
    `the reference sets its body in ${String(bodyFamily)}, which the catalogue does not supply` +
      ` (catalogue: ${[...CATALOGUE_STEMS].join(', ')})`,
  ).toBe(false);

  // Half two: the catalogue face a fallback would reach is measurably different. Which face that is
  // comes off the reference as well — this page embeds the catalogue's mono for its code blocks, so
  // the fallback's own file is present on the page and can be measured rather than assumed.
  const catalogueEmbedded = [...new Set(drawn.map((run) => normaliseFamily(run.fontFamily)))].filter(
    (stem) => CATALOGUE_STEMS.has(stem),
  );
  expect(
    catalogueEmbedded.length,
    'the reference also embeds a catalogue face, which is the file a fallback would reach',
  ).toBeGreaterThan(0);
  const fallbackFamily = CATALOGUE_FAMILIES.find((family) =>
    catalogueEmbedded.includes(normaliseFamily(family)),
  );
  expect(fallbackFamily, 'the catalogue names that face').toBeDefined();

  const sample = unstretchedRun(inked, baseSizePt, bodyFamily ?? '');
  expect(sample, 'the reference sets a word of body text the justification did not stretch').toBeDefined();
  if (sample === undefined || fallbackFamily === undefined) return;

  const font = await resolvedFontOf(page, BODY_PARAGRAPH);
  expect(font, 'the preview lays out the body paragraph').not.toBeNull();
  if (font === null) return;

  const asCatalogue = await advanceWidthPt(
    page,
    sample.text,
    { ...font, family: `"${fallbackFamily}"` },
    sample.fontSizePt,
  );
  expect(
    Math.abs(asCatalogue - sample.widthPt) / sample.widthPt,
    `a preview that fell back to ${fallbackFamily} would set "${sample.text}" ${asCatalogue.toFixed(2)}pt wide` +
      ` against the page's ${sample.widthPt.toFixed(2)}pt, which expectSameFace would not have told apart`,
  ).toBeGreaterThan(FACE_ADVANCE);

  // …and the fixture really does supply the family the page is set in, so the assertion above is
  // about the project's file rather than about a family nothing declared.
  expect(prepared.projectFamilies, 'the fixture declares a project-supplied family').not.toHaveLength(0);
});

/**
 * The base-14 anchor's own competence, on the same terms as the project-font one above.
 *
 * `Times-Roman` is one of the fourteen faces every PDF reader is required to have, so the renderer
 * writes the NAME into the file and embeds nothing. The preview cannot do that — a browser has no
 * such guarantee — so `planFontFaces` reaches its `substitute` branch and serves a committed
 * stand-in out of `packages/asciidoc-pdf/assets/base14-fonts`. Until this fixture existed no anchor's
 * theme named a base-14 family, so that branch and `SUBSTITUTE_DIR` in the harness beside it were
 * reached by nothing in this suite: the whole of the stand-in work had no evidence behind it, and the
 * comparisons in this file would have gone on passing had it never been written.
 *
 * Both halves are read at run time. The reference's own bytes say the face was named rather than
 * embedded — a non-embedded base-14 font is written without the six-letter subset prefix every
 * embedded face carries, and this page carries both spellings, so the two are distinguished on the
 * page rather than assumed. And the plan the application builds for this appearance says the
 * substitute branch is the one that answered.
 */
test('the base-14 anchor reaches the substitute branch, on a face the reference named rather than embedded', async ({
  page,
}) => {
  const fixture = readFixture('base14-substitute');
  const prepared = await preparePrintPage(page, fixture);
  const drawn = await drawnRuns(fixture.referencePdf);

  const bodyFamily = mode(bodyRuns(drawn, baseSizeOf(drawn)).map((run) => run.fontFamily));
  expect(bodyFamily, 'the reference names the face its body text is set in').toBeDefined();

  // Latin-1 rather than UTF-8: a PDF's object dictionaries are bytes, and decoding them as UTF-8
  // would corrupt the compressed streams around the names being looked for.
  const raw = Buffer.from(fixture.referencePdf).toString('latin1');
  expect(
    raw.includes(`/BaseFont /${bodyFamily ?? ''}`),
    `the reference names ${String(bodyFamily)} without a subset prefix, which is how a face it did not embed is written`,
  ).toBe(true);
  // …and the same page embeds something, so the absence above is a reading rather than a property of
  // every font name in every PDF. The code face is the catalogue's own and is embedded in full.
  expect(
    /\/BaseFont \/[\da-f]{6}\+/i.test(raw),
    'the same reference embeds another face with a subset prefix, so the two spellings are distinguishable here',
  ).toBe(true);

  // The application's own plan for this appearance, which is what decides where the preview's file
  // comes from. Asserted rather than inferred: a plan that quietly took the catalogue or a project
  // path instead would leave every comparison on this anchor measuring a different question.
  const resolved = resolveAppearance({
    themeText: fixture.themeText ?? '',
    themePath: fixture.themePath ?? '',
  });
  const plan = planFontFaces(resolved.appearance.fonts, fixture.themePath ?? '');
  const substituted = plan.faces.filter((face) => face.source === 'substitute');
  expect(
    substituted.map((face) => face.family),
    'the appearance plans a base-14 family through the substitute branch',
  ).toContain(prepared.cssProperties['--print-base-font-family']?.replaceAll(/^["']|["']$/g, ''));
});
