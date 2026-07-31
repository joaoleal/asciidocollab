import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, editorContent, expandPreview } from './helpers/editor';

/** The API the account's editor preferences live behind. */
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

// The preview no longer publishes a render by replacing everything it had on screen. It patches the
// tree it already has into the shape of the new one, which is what lets the expensive things the
// BROWSER produced after the last render survive an edit: a mermaid diagram that took an engine to
// draw, an equation that took MathJax to typeset. The same patch is what keeps the reader where they
// were and keeps the keyboard where they put it.
//
// Every check below is about NODE IDENTITY, never about what the nodes look like. An element replaced
// by an identical one was still redrawn — the engine ran again, the main thread paid for it, and any
// state the browser hung off that node (focus, a selection, a half-finished scroll) went with it. Only
// the same object proves nothing happened, so the drawn `<svg>` and the typeset `<math>` nodes are
// captured before the editing starts and compared by reference afterwards.

/** The preview's rendered-output element — the one the render is patched into. */
const OUTPUT_SELECTOR = '[data-testid="asciidoc-output"]';
/** The element that actually scrolls, which is the pane around the output rather than the output. */
const SCROLL_SELECTOR = '[data-testid="preview-scroll-container"]';
/**
 * A diagram that has been DRAWN: the vector the engine produced, inside the placeholder's output
 * child. The placeholder itself exists from the moment the render lands and says nothing about
 * whether an engine ever ran.
 */
const DRAWN_DIAGRAM_SELECTOR = '.adc-diagram .adc-diagram-output svg';
/**
 * A TYPESET expression. Chromium renders MathML natively, so this app hands it `<math>` rather than
 * MathJax's own CHTML boxes — the typeset node to look for here is the MathML element itself.
 */
const TYPESET_MATH_SELECTOR = 'math';
/** Where the captured node references are parked on the page's global object. */
const PROBE_KEY = 'previewPreservationProbe';
/** Where the element that was focused before a refresh is parked, so it can be compared afterwards. */
const FOCUS_KEY = 'previewFocusedBeforeRefresh';

/** How many parts the diagram-and-equation document has; each contributes one of everything. */
const PARTS = 3;
/** One inline and one block expression per part. */
const MATH_PER_PART = 2;
/** How many edits the sustained session makes. */
const EDIT_ROUNDS = 6;
/** The rounds that insert a whole paragraph rather than extending one. */
const INSERTING_ROUNDS = new Set([3, 5]);

/** The paragraph every edit is made in — prose, and no part of any diagram or equation. */
const EDITED_PARAGRAPH = 'Editing lands in this paragraph.';

/** Budget for the first render plus the diagram draws and equation typesetting that follow it. */
const FIRST_DRAW_TIMEOUT_MS = 60_000;
/** Budget for one edit to reach the preview. */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * A document with several mermaid diagrams and several equations, and one prose paragraph at the top
 * for the editing to happen in.
 *
 * The editable paragraph is ABOVE everything else on purpose. Inserting a line there renumbers every
 * block below it, which is precisely the case a patcher can get wrong while still looking correct: the
 * ids the renderer invents for unnamed blocks carry the line number, so treating one as an identity
 * makes every block below an insertion look like a different block and rebuilds the lot.
 *
 * @returns The AsciiDoc source.
 */
function diagramAndMathDocument(): string {
  const out: string[] = ['= Preview Morph Preservation', ':stem:', '', EDITED_PARAGRAPH, ''];
  for (let index = 1; index <= PARTS; index += 1) {
    out.push(
      `== Part ${index}`,
      '',
      `Prose before the diagram in part ${index}.`,
      '',
      '[mermaid]',
      '----',
      `graph TD; A${index}[Start ${index}] --> B${index}{Choice}; B${index} -->|yes| C${index}[Go]; B${index} -->|no| D${index}[Stop];`,
      '----',
      '',
      `An inline equation stem:[a^2 + b^${index} = c^2] and a block one:`,
      '',
      '[stem]',
      '++++',
      String.raw`\sqrt{` + `${index * 4}} = ${index * 2}`,
      '++++',
      '',
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * A document that is mostly images, and tall enough to scroll a long way.
 *
 * Images are what made wholesale replacement lurch: a replaced `<img>` has no height until its source
 * has decoded again, so the document under the reader collapses and their offset lands somewhere else
 * entirely. The pictures are inline data so they decode without a network round trip and their
 * intrinsic size is known — the height is real, and it is the same on every machine.
 *
 * @returns The AsciiDoc source.
 */
function imageDocument(): string {
  const out: string[] = ['= Illustrated Document', '', EDITED_PARAGRAPH, ''];
  for (let index = 1; index <= 8; index += 1) {
    out.push(
      `== Figure ${index}`,
      '',
      `Prose introducing figure ${index}, long enough to occupy a line of its own on any window width.`,
      '',
      `image::${figureDataUri(index)}[Figure ${index}]`,
      '',
    );
  }
  out.push('Trailing prose, so the document does not end on a picture.', '');
  return `${out.join('\n')}\n`;
}

/**
 * An inline SVG picture with a stated intrinsic size, as a data URI.
 *
 * @param index - Distinguishes one figure from the next.
 * @returns The `data:` URI to use as an image target.
 */
function figureDataUri(index: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">` +
    `<rect width="480" height="320" fill="#dde5f0"/>` +
    `<circle cx="240" cy="160" r="${60 + index * 8}" fill="#4a6ea9"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * A document holding a link for the keyboard to land on, plus prose to edit somewhere else entirely.
 *
 * @returns The AsciiDoc source.
 */
function linkDocument(): string {
  return [
    '= Linked Document',
    '',
    'A paragraph with https://example.com/reference[the reference link] in it.',
    '',
    '== A Section',
    '',
    'Prose under a heading, which the link does not belong to.',
    '',
    EDITED_PARAGRAPH,
    '',
  ].join('\n');
}

/** How many of a set of nodes are still the very same objects they were. */
interface NodeSetComparison {
  /** How many were captured before the editing began. */
  readonly before: number;
  /** How many are there now. */
  readonly now: number;
  /** How many of the current ones are the same objects, in the same order. */
  readonly identical: number;
}

/** The captured-and-compared state of everything the browser produced after a render. */
interface PreservationOutcome {
  /** The drawn diagrams. */
  readonly diagrams: NodeSetComparison;
  /** The typeset expressions. */
  readonly math: NodeSetComparison;
}

/**
 * Take a reference to every drawn diagram and every typeset expression currently on screen.
 *
 * References, not descriptions: the whole question is whether these exact objects are still there
 * afterwards, and any description of them would go on matching a replacement that looks the same.
 *
 * @param page - The page holding the preview.
 * @returns How many of each were captured.
 */
async function capturePreviewNodes(page: Page): Promise<{ diagrams: number; math: number }> {
  return page.evaluate(
    (options: { output: string; diagram: string; math: string; key: string }) => {
      const output = document.querySelector(options.output);
      if (output === null) throw new Error('the preview has no rendered output to capture');
      const captured = {
        diagrams: [...output.querySelectorAll(options.diagram)],
        math: [...output.querySelectorAll(options.math)],
      };
      Reflect.set(globalThis, options.key, captured);
      return { diagrams: captured.diagrams.length, math: captured.math.length };
    },
    {
      output: OUTPUT_SELECTOR,
      diagram: DRAWN_DIAGRAM_SELECTOR,
      math: TYPESET_MATH_SELECTOR,
      key: PROBE_KEY,
    },
  );
}

/**
 * Compare what is on screen now against what was captured, by reference.
 *
 * @param page - The page holding the preview.
 * @returns The comparison for diagrams and for expressions.
 */
async function comparePreviewNodes(page: Page): Promise<PreservationOutcome> {
  return page.evaluate(
    (options: { output: string; diagram: string; math: string; key: string }) => {
      const output = document.querySelector(options.output);
      if (output === null) throw new Error('the preview has no rendered output to compare');
      const captured: unknown = Reflect.get(globalThis, options.key);
      if (typeof captured !== 'object' || captured === null) {
        throw new Error('nothing was captured to compare against');
      }
      const comparisons: Record<string, NodeSetComparison> = {};
      for (const [name, selector] of [
        ['diagrams', options.diagram],
        ['math', options.math],
      ]) {
        const capturedNodes: unknown = Reflect.get(captured, name);
        const before: unknown[] = Array.isArray(capturedNodes) ? capturedNodes : [];
        const current = [...output.querySelectorAll(selector)];
        let identical = 0;
        for (const [index, node] of current.entries()) {
          if (node === before[index]) identical += 1;
        }
        comparisons[name] = { before: before.length, now: current.length, identical };
      }
      return { diagrams: comparisons['diagrams'], math: comparisons['math'] };
    },
    {
      output: OUTPUT_SELECTOR,
      diagram: DRAWN_DIAGRAM_SELECTOR,
      math: TYPESET_MATH_SELECTOR,
      key: PROBE_KEY,
    },
  );
}

/**
 * Place the caret at the end of the prose paragraph the edits are made in.
 *
 * @param page - The page holding the editor.
 */
async function caretAtEndOfEditedParagraph(page: Page): Promise<void> {
  await editorContent(page).getByText(EDITED_PARAGRAPH, { exact: false }).first().click();
  await page.keyboard.press('End');
}

/**
 * Turn off the preference that has the preview follow the editor's caret and scroll position.
 *
 * With it on, moving the caret smooth-scrolls the preview to the matching block — the preview being
 * ASKED to move, which would be indistinguishable here from a refresh moving it. The preference lives
 * on the account and is remembered between runs, so it is set through the API before the page is
 * opened rather than clicked in the interface: the panel reads it once at mount, and a click issued
 * before that read has landed is silently overwritten by the stored value moments later.
 *
 * @param page - The page whose signed-in account the preference belongs to.
 */
async function disableScrollSync(page: Page): Promise<void> {
  const current = await page.request.get(`${API_URL}/auth/me/editor-preferences`);
  expect(current.ok(), 'the account must report its editor preferences').toBe(true);
  const preferences: unknown = await current.json();
  if (typeof preferences !== 'object' || preferences === null) {
    throw new TypeError('the editor-preferences endpoint answered with something that is not an object');
  }
  // The other two are sent back exactly as stored: the endpoint requires them, and this must change
  // nothing but the one preference it is here to change.
  const saved = await page.request.put(`${API_URL}/auth/me/editor-preferences`, {
    data: {
      fontSize: Number(Reflect.get(preferences, 'fontSize')),
      theme: String(Reflect.get(preferences, 'theme')),
      scrollSyncEnabled: false,
    },
  });
  expect(saved.ok(), 'the scroll-sync preference must be saved before the editor opens').toBe(true);
}

/**
 * Confirm the preview is not following the editor, once the panel has certainly read the preference.
 *
 * @param page - The page holding the preview.
 */
async function expectScrollSyncOff(page: Page): Promise<void> {
  await expect(page.getByTestId('scroll-sync-toggle')).toHaveAttribute('aria-pressed', 'false');
}

/**
 * Wait until the whole first render is on screen: the markup, every diagram drawn, every expression
 * typeset, and the render reported as finished.
 *
 * @param page - The page holding the preview.
 * @param diagrams - How many diagrams the document has.
 * @param expressions - How many expressions it has.
 */
async function waitForDrawnPreview(page: Page, diagrams: number, expressions: number): Promise<void> {
  await expect(page.locator(`${OUTPUT_SELECTOR} ${DRAWN_DIAGRAM_SELECTOR}`)).toHaveCount(diagrams, {
    timeout: FIRST_DRAW_TIMEOUT_MS,
  });
  await expect(page.locator(`${OUTPUT_SELECTOR} ${TYPESET_MATH_SELECTOR}`)).toHaveCount(expressions, {
    timeout: FIRST_DRAW_TIMEOUT_MS,
  });
  await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: FIRST_DRAW_TIMEOUT_MS });
}

/**
 * The reader's position in the preview.
 *
 * @param page - The page holding the preview.
 * @returns The scroll offset in pixels and how far the document can scroll.
 */
async function previewScroll(page: Page): Promise<{ top: number; range: number }> {
  return page.evaluate((selector: string) => {
    const scroller = document.querySelector(selector);
    if (scroller === null) throw new Error('the preview has no scroll container');
    return { top: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight };
  }, SCROLL_SELECTOR);
}

/**
 * Wait until the preview has stopped scrolling of its own accord.
 *
 * Navigating from the editor scrolls the preview SMOOTHLY, over several hundred milliseconds. An
 * offset read while that animation is still running is not where anything ended up, and a position
 * established mid-animation would be overwritten by the rest of it.
 *
 * @param page - The page holding the preview.
 */
async function waitForPreviewScrollToSettle(page: Page): Promise<void> {
  await page.evaluate(
    async (options: { selector: string; stillMs: number; timeoutMs: number }) => {
      const scroller = document.querySelector(options.selector);
      if (scroller === null) throw new Error('the preview has no scroll container');
      const deadline = performance.now() + options.timeoutMs;
      let last = scroller.scrollTop;
      let stillSince = performance.now();
      while (performance.now() - stillSince < options.stillMs && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        if (scroller.scrollTop === last) continue;
        last = scroller.scrollTop;
        stillSince = performance.now();
      }
    },
    { selector: SCROLL_SELECTOR, stillMs: 600, timeoutMs: 10_000 },
  );
}

/**
 * Scroll the preview to a fraction of the way down the document.
 *
 * @param page - The page holding the preview.
 * @param fraction - How far down to go, between 0 and 1.
 * @returns Where it actually ended up.
 */
async function scrollPreviewTo(page: Page, fraction: number): Promise<{ top: number; range: number }> {
  return page.evaluate(
    (options: { selector: string; fraction: number }) => {
      const scroller = document.querySelector(options.selector);
      if (scroller === null) throw new Error('the preview has no scroll container');
      scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * options.fraction);
      return { top: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight };
    },
    { selector: SCROLL_SELECTOR, fraction },
  );
}

/**
 * How many of the preview's images have finished decoding with a real size.
 *
 * @param page - The page holding the preview.
 * @returns The count of images present and the count that have loaded.
 */
async function previewImages(page: Page): Promise<{ total: number; loaded: number }> {
  return page.evaluate((selector: string) => {
    const images = [...document.querySelectorAll(`${selector} img`)];
    return {
      total: images.length,
      loaded: images.filter(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalHeight > 0,
      ).length,
    };
  }, OUTPUT_SELECTOR);
}

/**
 * Put keyboard focus on the preview's link and remember which element that is.
 *
 * Also reports whether the pending refresh had already landed, because a check that focus survives a
 * refresh proves nothing if the refresh happened before the focus did.
 *
 * @param page - The page holding the preview.
 * @param marker - Text the pending edit will put on screen, used to tell whether it already has.
 * @returns Whether focus took, whether the refresh had already landed, and the link's text.
 */
async function focusPreviewLink(
  page: Page,
  marker: string,
): Promise<{ focused: boolean; alreadyRefreshed: boolean; text: string }> {
  return page.evaluate(
    (options: { output: string; marker: string; key: string }) => {
      const output = document.querySelector(options.output);
      if (output === null) throw new Error('the preview has no rendered output to focus in');
      const link = output.querySelector('a');
      if (!(link instanceof HTMLElement)) throw new Error('the rendered preview holds no link to focus');
      const alreadyRefreshed = (output.textContent ?? '').includes(options.marker);
      link.focus();
      Reflect.set(globalThis, options.key, link);
      return {
        focused: document.activeElement === link,
        alreadyRefreshed,
        text: link.textContent ?? '',
      };
    },
    { output: OUTPUT_SELECTOR, marker, key: FOCUS_KEY },
  );
}

/**
 * Where the keyboard ended up after the refresh.
 *
 * @param page - The page holding the preview.
 * @returns Whether the same element still exists, still holds focus, and where focus is.
 */
async function focusAfterRefresh(
  page: Page,
): Promise<{ stillInDocument: boolean; stillFocused: boolean; activeText: string }> {
  return page.evaluate(
    (options: { output: string; key: string }) => {
      const output = document.querySelector(options.output);
      if (output === null) throw new Error('the preview has no rendered output to inspect');
      const remembered: unknown = Reflect.get(globalThis, options.key);
      const active = document.activeElement;
      return {
        stillInDocument: remembered instanceof HTMLElement && output.contains(remembered),
        stillFocused: remembered instanceof HTMLElement && active === remembered,
        activeText: active instanceof HTMLElement ? active.textContent ?? '' : '',
      };
    },
    { output: OUTPUT_SELECTOR, key: FOCUS_KEY },
  );
}

/**
 * Print a measurement so a run reports what it observed, not merely that it passed.
 *
 * @param line - The line to write, without its newline.
 */
function report(line: string): void {
  process.stdout.write(`\n  ${line}\n`);
}

test.describe('preview refreshes without discarding what the browser already produced', () => {
  // Wide per-test budget: a cold engine start, three mermaid draws, six typeset expressions, and a
  // session of edits each of which is waited out to the screen.
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Preview Morph ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a session of prose edits redraws no diagram and re-typesets no equation', async ({ page }) => {
    await createAdocFile(page, projectId, 'diagrams-and-math.adoc', diagramAndMathDocument());
    await disableScrollSync(page);
    await openProject(page, projectId);
    await openFile(page, 'diagrams-and-math.adoc', /Preview Morph Preservation/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await waitForDrawnPreview(page, PARTS, PARTS * MATH_PER_PART);
    await expectScrollSyncOff(page);

    const captured = await capturePreviewNodes(page);
    expect(captured.diagrams, 'the document must have several drawn diagrams to preserve').toBe(PARTS);
    expect(captured.math, 'the document must have several typeset expressions to preserve').toBe(
      PARTS * MATH_PER_PART,
    );

    // Real editing, and none of it anywhere near a diagram or an equation. Two of the rounds insert a
    // whole paragraph, so every block below shifts down the source and each one's line number — and
    // with it the id the renderer invents for it — is different from the one before.
    for (let round = 1; round <= EDIT_ROUNDS; round += 1) {
      const marker = `mark${round}`;
      await caretAtEndOfEditedParagraph(page);
      await page.keyboard.type(` ${marker}`);
      if (INSERTING_ROUNDS.has(round)) {
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.keyboard.type(`Inserted paragraph ${round}.`);
      }
      await expect(page.getByTestId('asciidoc-output')).toContainText(marker, {
        timeout: REFRESH_TIMEOUT_MS,
      });
    }
    // The last edit's own refresh has landed by the assertion above; the passes that draw diagrams and
    // typeset expressions run after a commit, so let them run before anything is counted.
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: REFRESH_TIMEOUT_MS });
    await expect(page.locator(`${OUTPUT_SELECTOR} ${DRAWN_DIAGRAM_SELECTOR}`)).toHaveCount(PARTS, {
      timeout: FIRST_DRAW_TIMEOUT_MS,
    });

    const outcome = await comparePreviewNodes(page);
    report(
      `${EDIT_ROUNDS} prose edits (${INSERTING_ROUNDS.size} of them inserting a paragraph above ` +
        `everything): ${outcome.diagrams.identical}/${outcome.diagrams.before} diagrams and ` +
        `${outcome.math.identical}/${outcome.math.before} equations are the same nodes as before`,
    );

    expect(
      outcome.diagrams.now,
      'the preview must still show every diagram after the editing session',
    ).toBe(captured.diagrams);
    expect(
      outcome.diagrams.identical,
      `${captured.diagrams - outcome.diagrams.identical} of ${captured.diagrams} diagrams are different ` +
        'nodes than before the editing session, so the engine drew them again',
    ).toBe(captured.diagrams);
    expect(
      outcome.math.now,
      'the preview must still show every equation after the editing session',
    ).toBe(captured.math);
    expect(
      outcome.math.identical,
      `${captured.math - outcome.math.identical} of ${captured.math} equations are different nodes than ` +
        'before the editing session, so they were typeset again',
    ).toBe(captured.math);
  });

  test('a refresh leaves the reader where they were in an image-bearing document', async ({ page }) => {
    await createAdocFile(page, projectId, 'illustrated.adoc', imageDocument());
    await disableScrollSync(page);
    await openProject(page, projectId);
    await openFile(page, 'illustrated.adoc', /Illustrated Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await expect(page.getByTestId('asciidoc-output')).toContainText('Trailing prose', {
      timeout: FIRST_DRAW_TIMEOUT_MS,
    });
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: FIRST_DRAW_TIMEOUT_MS });
    await expectScrollSyncOff(page);

    // The pictures have to be real pictures with real heights, or "the offset survived" would only be
    // saying that a document of text did not move.
    const images = await previewImages(page);
    expect(images.total, 'the document must actually render its images').toBeGreaterThan(0);
    expect(images.loaded, 'every image must have decoded to a real height before the offset is taken').toBe(
      images.total,
    );

    // Put the caret where the typing will go BEFORE choosing where the reader is sitting. Clicking a
    // line in the editor is itself a navigation — the preview is asked to scroll to the block that
    // line produced, whether or not scroll sync is on — so a click made afterwards would move the
    // reader for a reason that has nothing to do with a refresh, and would be indistinguishable from
    // one that did.
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await waitForPreviewScrollToSettle(page);

    const scrolled = await scrollPreviewTo(page, 0.5);
    expect(scrolled.range, 'the document must be tall enough to scroll a meaningful distance').toBeGreaterThan(
      500,
    );
    expect(scrolled.top, 'the reader must actually be somewhere other than the top').toBeGreaterThan(0);

    // Typed at the very END of the document, below where the reader is sitting: nothing above their
    // position changes size, so an unchanged offset means an unchanged view rather than a coincidence.
    await page.keyboard.type('\n\nA paragraph typed while the reader was halfway down.');
    await expect(page.getByTestId('asciidoc-output')).toContainText('while the reader was halfway down', {
      timeout: REFRESH_TIMEOUT_MS,
    });

    const after = await previewScroll(page);
    report(
      `${images.total} images, scrollable range ${scrolled.range} px: offset ${scrolled.top} px before the ` +
        `refresh, ${after.top} px after`,
    );
    expect(
      after.top,
      `the reader was ${scrolled.top} px down an illustrated document and the refresh moved them to ` +
        `${after.top} px`,
    ).toBe(scrolled.top);
  });

  test('a refresh leaves the keyboard on the preview element it was on', async ({ page }) => {
    await createAdocFile(page, projectId, 'linked.adoc', linkDocument());
    await disableScrollSync(page);
    await openProject(page, projectId);
    await openFile(page, 'linked.adoc', /Linked Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await expect(page.getByTestId('asciidoc-output')).toContainText('the reference link', {
      timeout: FIRST_DRAW_TIMEOUT_MS,
    });
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: FIRST_DRAW_TIMEOUT_MS });
    await expectScrollSyncOff(page);

    // Start an edit in a paragraph the link has nothing to do with, then move the keyboard into the
    // preview while that edit is still on its way — which is exactly when an author following a link
    // in the preview has a refresh land underneath them.
    const marker = 'typed while the keyboard was in the preview';
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(` ${marker}`);

    const focused = await focusPreviewLink(page, marker);
    expect(focused.focused, 'the preview link must actually take keyboard focus').toBe(true);
    expect(focused.text, 'the focused element must be the document link').toContain('the reference link');
    expect(
      focused.alreadyRefreshed,
      'the refresh landed before the keyboard reached the preview, so this would prove nothing',
    ).toBe(false);

    await expect(page.getByTestId('asciidoc-output')).toContainText(marker, { timeout: REFRESH_TIMEOUT_MS });

    const after = await focusAfterRefresh(page);
    report(
      `refresh with the keyboard on a preview link: the link ${after.stillInDocument ? 'survived' : 'was replaced'} ` +
        `and focus is on "${after.activeText.trim()}"`,
    );
    expect(
      after.stillInDocument,
      'the link the keyboard was on must survive a refresh that changed a different paragraph',
    ).toBe(true);
    expect(
      after.stillFocused,
      `the refresh moved the keyboard off the link and onto "${after.activeText.trim()}"`,
    ).toBe(true);
  });
});
