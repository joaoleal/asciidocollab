/* @jest-environment jsdom */

// Tests for morph-preview.ts.
//
// The preview used to be replaced wholesale on every refresh: the newly rendered markup was assigned
// as the container's inner HTML, which threw away every DOM node and everything the client had put
// inside them — drawn diagrams, typeset math, keyboard focus, scroll position. `morphPreview` patches
// the existing DOM to match the new render instead, so the parts that did not change are left exactly
// as they are.
//
// The fixtures below mirror what the render worker actually emits: block wrappers whose ids are
// SYNTHETIC and line-derived (`__src_<context>_<line>`), diagram placeholders carrying their source as
// inert text, and — on the already-displayed side — the client-rendered results of those placeholders
// (an injected `<svg>`, a MathJax container tagged with the expression it came from).

import { morphPreview } from '@/lib/preview/morph-preview';

/** The already-displayed preview, inside a scrolling parent, mounted so focus and layout queries work. */
interface Mounted {
  /** The scrolling ancestor — the element whose scroll position a refresh must not disturb. */
  scroller: HTMLElement;
  /** The preview output element the morph patches (its own identity is preserved). */
  container: HTMLElement;
}

function mount(html: string): Mounted {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const container = document.createElement('div');
  container.className = 'asciidoc-preview-content';
  container.innerHTML = html;
  scroller.append(container);
  document.body.append(scroller);
  return { scroller, container };
}

/** Build the incoming render the way the preview does: already-sanitized markup as a fragment. */
function incomingFragment(html: string): DocumentFragment {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const fragment = document.createDocumentFragment();
  fragment.append(...holder.childNodes);
  return fragment;
}

/** Markup for a block wrapper whose id is the worker's line-derived synthetic one. */
function paragraph(line: number, text: string): string {
  return `<div class="paragraph" id="__src_main_${line}" data-source-line="${line}"><p>${text}</p></div>`;
}

/**
 * The provenance the worker stamps on every rendered block: the line it came from, and — for an
 * assembled render spanning several files — which file that line is in.
 */
function provenance(line: number, file?: string): string {
  return ` data-source-line="${line}"${file === undefined ? '' : ` data-source-file="${file}"`}`;
}

/** Markup for a diagram placeholder as the worker emits it: engine, provenance, and the inert source. */
function diagramPlaceholder(line: number, source: string, file?: string): string {
  return `<div class="adc-diagram" data-diagram-engine="mermaid"${provenance(line, file)}>${source}</div>`;
}

/** A delimited expression as Asciidoctor emits it, before the browser typesets it. */
const BLOCK_EXPRESSION = String.raw`\$x+1\$`;
const EDITED_BLOCK_EXPRESSION = String.raw`\$x+2\$`;
const INLINE_EXPRESSION = String.raw`\(a^2\)`;

/** Markup for a stem block holding either the delimited expression or what it was typeset into. */
function stemBlock(inner: string): string {
  return `<div class="stemblock" id="__src_main_5"><div class="content">${inner}</div></div>`;
}

/** Markup for one typeset expression, tagged with the source the math renderer produced it from. */
function typesetMath(source: string): string {
  return `<mjx-container data-stem-source="${source}">typeset</mjx-container>`;
}

/** Markup for a paragraph holding an inline expression, typeset or not. */
function inlineMathParagraph(expression: string): string {
  return `<div class="paragraph" id="__src_main_3"><p>Given ${expression} we go on.</p></div>`;
}

/**
 * Markup for a paragraph holding an inline expression alongside prose the author can restyle without
 * touching a character of the text — the case where two renders read alike but do not look alike.
 */
function inlineMathBesideEmphasis(expression: string, emphasis: 'strong' | 'em'): string {
  return (
    `<div class="paragraph" id="__src_main_3"><p>Given ${expression} this is ` +
    `<${emphasis}>important</${emphasis}>.</p></div>`
  );
}

/** Markup for a paragraph holding an inline expression and a link whose text outlives its target. */
function inlineMathBesideLink(expression: string, target: string): string {
  return (
    `<div class="paragraph" id="__src_main_3"><p>Given ${expression} see ` +
    `<a href="${target}">the appendix</a>.</p></div>`
  );
}

/** Markup for a diagram the client has already drawn: preserved source plus the injected SVG. */
function drawnDiagram(line: number, source: string, failedCode?: string, file?: string): string {
  const failed = failedCode === undefined ? '' : ` data-diagram-failed="${failedCode}"`;
  return (
    `<div class="adc-diagram" data-diagram-engine="mermaid"${provenance(line, file)}${failed}>` +
    `<div class="adc-diagram-source" hidden>${source}</div>` +
    `<div class="adc-diagram-output"><svg><g>drawn</g></svg></div>` +
    `</div>`
  );
}

/**
 * The provenance a block on screen currently claims — read the way the preview's own navigation reads
 * it, so a test states what a click would actually find.
 *
 * @param element - The block to read, as `querySelector` hands it back.
 * @returns Its source line and source file, each undefined when the block does not claim one.
 */
function provenanceOf(element: HTMLElement | null): { line?: string; file?: string } {
  if (element === null) throw new Error('no such block in the preview');
  return { line: element.dataset['sourceLine'], file: element.dataset['sourceFile'] };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('morphPreview', () => {
  it('applies every top-level block of the incoming render, not just the first', () => {
    // Guards a library detail with a silent failure mode: handed a fragment, morphdom narrows it to
    // its first element child, which would publish a one-block document on every refresh.
    const { container } = mount(paragraph(1, 'one'));

    morphPreview(container, incomingFragment(paragraph(1, 'one') + paragraph(3, 'two') + paragraph(5, 'three')));

    expect(container.children).toHaveLength(3);
    expect(container.textContent).toBe('onetwothree');
  });

  it('patches an edited paragraph in place and leaves its neighbours as the same DOM nodes', () => {
    const { container } = mount(paragraph(1, 'one') + paragraph(3, 'two') + paragraph(5, 'three'));
    const [first, second, third] = [...container.children];

    morphPreview(container, incomingFragment(paragraph(1, 'one') + paragraph(3, 'two edited') + paragraph(5, 'three')));

    expect(container.children[1].textContent).toBe('two edited');
    expect(container.children[0]).toBe(first);
    expect(container.children[1]).toBe(second);
    expect(container.children[2]).toBe(third);
  });

  it('reuses the blocks below an insertion instead of rebuilding them when every line renumbers', () => {
    // Inserting a paragraph at the TOP shifts every line below it, so every synthetic id changes:
    // 1/3/8 become 3/5/10 while the new block takes id 1. Keying the morph on those ids would read
    // each renumbered block as a different node — the third block's id (8) has no counterpart in the
    // incoming render at all, so it would be discarded and rebuilt from scratch, taking whatever the
    // client had rendered inside it with it. Ignoring line-derived ids lets the blocks match up
    // structurally and be patched where they stand.
    const { container } = mount(
      paragraph(1, 'Intro line.') + paragraph(3, 'A paragraph that runs across several lines.') + paragraph(8, 'Closing line.'),
    );
    const original = [...container.children];
    const originalInnerParagraphs = original.map((block) => block.querySelector('p'));

    morphPreview(
      container,
      incomingFragment(
        paragraph(1, 'Brand new opening.') +
          paragraph(3, 'Intro line.') +
          paragraph(5, 'A paragraph that runs across several lines.') +
          paragraph(10, 'Closing line.'),
      ),
    );

    // One block was added; none of the three that were already on screen was thrown away and rebuilt.
    expect(container.children).toHaveLength(4);
    for (const block of original) expect(container.contains(block)).toBe(true);
    for (const inner of originalInnerParagraphs) expect(inner?.isConnected).toBe(true);
    expect(container.textContent).toBe('Brand new opening.Intro line.A paragraph that runs across several lines.Closing line.');
  });

  it('ignores an ordinal diagram id the same way it ignores a line-derived one', () => {
    // The worker numbers an un-anchored diagram by its position among the diagrams — `__adc_diagram_0`
    // — which renumbers the moment a diagram is added above it. Read as an identity, the diagram below
    // an insertion would be matched to a DIFFERENT diagram's element and rebuilt, throwing away a
    // drawing that had not changed at all.
    const { container } = mount(
      `<div class="adc-diagram" id="__adc_diagram_0"${provenance(4)}>graph TD; A-->B;</div>`,
    );
    const drawn = container.firstElementChild;

    morphPreview(
      container,
      incomingFragment(
        `<div class="adc-diagram" id="__adc_diagram_1"${provenance(9)}>graph TD; A-->B;</div>`,
      ),
    );

    expect(container.firstElementChild).toBe(drawn);
  });

  it('keeps a stable author or heading id as the identity of its element', () => {
    // A heading id comes from the title text, not from a line number, so it survives an insertion and
    // is the one identity worth keying on: the heading is matched by id and patched, even though the
    // insertion has moved it.
    const { container } = mount(`<h2 id="overview" data-source-line="1">Overview</h2>${paragraph(3, 'body')}`);
    const heading = container.querySelector('#overview');

    morphPreview(
      container,
      incomingFragment(`${paragraph(1, 'new opening')}<h2 id="overview" data-source-line="3">Overview</h2>${paragraph(5, 'body')}`),
    );

    expect(container.querySelector('#overview')).toBe(heading);
  });

  it('keeps a drawn diagram untouched when its source is unchanged, however far its line moved', () => {
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B') + paragraph(9, 'after'));
    const svg = container.querySelector('svg');

    const outcome = morphPreview(
      container,
      incomingFragment(diagramPlaceholder(5, 'graph TD; A-->B') + paragraph(11, 'after, edited')),
    );

    expect(outcome.diagramsSkipped).toBe(1);
    // The same <svg> node: the drawing was preserved, not re-derived from the incoming placeholder.
    expect(container.querySelector('svg')).toBe(svg);
    expect(container.children[1].textContent).toBe('after, edited');
    // …and it now says where it came from in THIS render. Keeping the drawing is the point; keeping
    // the line it was drawn at is not, because that line is what both directions of navigation are
    // looked up by — a click in the preview would jump to a line the block has moved off, and a click
    // in the editor would match this diagram for a line that now belongs to another block.
    expect(provenanceOf(container.querySelector('.adc-diagram')).line).toBe('5');
  });

  it('moves a preserved diagram to the file the new render says it came from', () => {
    // An assembled document spans several files, so the file is half of a block's provenance: the
    // editor scopes its lookups by it, and a stale one takes the diagram out of the scope it belongs
    // to entirely rather than merely pointing at the wrong line.
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B', undefined, 'chapter-one.adoc'));

    const outcome = morphPreview(
      container,
      incomingFragment(diagramPlaceholder(4, 'graph TD; A-->B', 'chapter-two.adoc')),
    );

    expect(outcome.diagramsSkipped).toBe(1);
    expect(provenanceOf(container.querySelector('.adc-diagram'))).toEqual({ line: '4', file: 'chapter-two.adoc' });
  });

  it('drops a preserved diagram\'s file provenance when the new render carries none', () => {
    // A single-file render states only the line, and a stale file attribute left standing would scope
    // the block to a file this render does not have — matching nothing where it used to match.
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B', undefined, 'chapter-one.adoc'));

    morphPreview(container, incomingFragment(diagramPlaceholder(3, 'graph TD; A-->B')));

    expect(provenanceOf(container.querySelector('.adc-diagram')).file).toBeUndefined();
  });

  it('replaces a drawn diagram whose source changed so it is drawn again', () => {
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B'));

    const outcome = morphPreview(container, incomingFragment(diagramPlaceholder(3, 'graph TD; A-->C')));

    expect(outcome.diagramsSkipped).toBe(0);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('graph TD; A-->C');
  });

  it('replaces a drawn diagram when the block in its place is no longer a diagram at all', () => {
    // The author deleted the diagram block and wrote prose there instead; the drawing must go with it.
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B'));

    const outcome = morphPreview(container, incomingFragment(paragraph(3, 'prose instead')));

    expect(outcome.diagramsSkipped).toBe(0);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('prose instead');
  });

  it('replaces a diagram marked as having failed to draw, even though its source is unchanged', () => {
    // "Source unchanged" and "successfully drawn" are different conditions. Without the marker the
    // first would stand in for the second, and a diagram that failed once would be frozen on screen
    // for the rest of the session: its source never changes, so every later refresh would skip it and
    // it would never be handed back to the renderer.
    const failed = mount(drawnDiagram(3, 'graph TD; A-->B', 'render-failed'));
    const unmarked = mount(drawnDiagram(3, 'graph TD; A-->B'));

    const failedOutcome = morphPreview(failed.container, incomingFragment(diagramPlaceholder(3, 'graph TD; A-->B')));
    const unmarkedOutcome = morphPreview(unmarked.container, incomingFragment(diagramPlaceholder(3, 'graph TD; A-->B')));

    // Same source, same markup, opposite decisions — the marker is what separates them.
    expect(failedOutcome.diagramsSkipped).toBe(0);
    expect(failed.container.querySelector('.adc-diagram-output')).toBeNull();
    expect(unmarkedOutcome.diagramsSkipped).toBe(1);
    expect(unmarked.container.querySelector('.adc-diagram-output')).not.toBeNull();
  });

  it('redraws a diagram whose engine changed, however untouched its source is', () => {
    // The source is only half of what a drawing is made of: the same text handed to mermaid and to
    // Graphviz produces two different pictures, or a failure the author needs to see. Judged on
    // source alone, switching the block's engine would leave the previous engine's drawing on screen
    // for the rest of the session, and the author would have no way to tell it had not been redrawn.
    const { container } = mount(drawnDiagram(3, 'graph TD; A-->B'));

    const outcome = morphPreview(
      container,
      incomingFragment(`<div class="adc-diagram" data-diagram-engine="graphviz"${provenance(3)}>graph TD; A-->B</div>`),
    );

    expect(outcome.diagramsSkipped).toBe(0);
    // Back to a bare placeholder, which is what hands it to the renderer again — under its new engine.
    expect(container.querySelector('.adc-diagram-output')).toBeNull();
    expect(container.querySelector<HTMLElement>('.adc-diagram')?.dataset['diagramEngine']).toBe('graphviz');
  });

  it('keeps typeset block math whose expression is unchanged', () => {
    const { container } = mount(paragraph(1, 'before') + stemBlock(typesetMath(BLOCK_EXPRESSION)));
    const typeset = container.querySelector('mjx-container');

    const outcome = morphPreview(
      container,
      incomingFragment(paragraph(1, 'before, edited') + stemBlock(BLOCK_EXPRESSION)),
    );

    expect(outcome.mathSkipped).toBe(1);
    expect(container.querySelector('mjx-container')).toBe(typeset);
    expect(container.children[0].textContent).toBe('before, edited');
  });

  it('moves a block holding preserved math to its new line, because only its inner element is skipped', () => {
    // Stated rather than assumed. Preserving a typeset expression skips the element that HOLDS the
    // expressions, and that is never the block carrying the provenance — the wrapper around it is
    // patched normally, so a math block's line moves with the render on its own. A diagram is the
    // case where the two are the same element, which is why only that one needs its provenance
    // carried across the skip.
    const { container } = mount(
      `<div class="stemblock" id="__src_main_5"${provenance(5)}><div class="content">${typesetMath(BLOCK_EXPRESSION)}</div></div>`,
    );
    const typeset = container.querySelector('mjx-container');

    const outcome = morphPreview(
      container,
      incomingFragment(
        `<div class="stemblock" id="__src_main_9"${provenance(9)}><div class="content">${BLOCK_EXPRESSION}</div></div>`,
      ),
    );

    expect(outcome.mathSkipped).toBe(1);
    expect(container.querySelector('mjx-container')).toBe(typeset);
    expect(provenanceOf(container.querySelector('.stemblock')).line).toBe('9');
  });

  it('keeps typeset inline math when only its surrounding prose is untouched', () => {
    const { container } = mount(paragraph(1, 'before') + inlineMathParagraph(typesetMath(INLINE_EXPRESSION)));
    const typeset = container.querySelector('mjx-container');

    const outcome = morphPreview(
      container,
      incomingFragment(paragraph(1, 'before, edited') + inlineMathParagraph(INLINE_EXPRESSION)),
    );

    expect(outcome.mathSkipped).toBe(1);
    expect(container.querySelector('mjx-container')).toBe(typeset);
  });

  it('publishes a markup change around an expression, even though the text either side of it reads the same', () => {
    // Preserving typeset math means refusing to patch the element that holds it, so what counts as
    // "unchanged" decides what the reader is allowed to see. Text alone cannot: emphasis, links,
    // footnotes and cross-references all leave the words exactly as they were. Judged on text, this
    // paragraph would keep its old markup for as long as the author left the expression alone.
    const { container } = mount(inlineMathBesideEmphasis(typesetMath(INLINE_EXPRESSION), 'strong'));

    const outcome = morphPreview(container, incomingFragment(inlineMathBesideEmphasis(INLINE_EXPRESSION, 'em')));

    expect(container.querySelector('em')).not.toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(outcome.mathSkipped).toBe(0);
  });

  it('publishes a link whose target changed under unchanged link text', () => {
    const { container } = mount(inlineMathBesideLink(typesetMath(INLINE_EXPRESSION), '#appendix-a'));

    const outcome = morphPreview(container, incomingFragment(inlineMathBesideLink(INLINE_EXPRESSION, '#appendix-b')));

    expect(container.querySelector('a')?.getAttribute('href')).toBe('#appendix-b');
    expect(outcome.mathSkipped).toBe(0);
  });

  it('replaces typeset math whose expression changed so it is typeset again', () => {
    const { container } = mount(stemBlock(typesetMath(BLOCK_EXPRESSION)));

    const outcome = morphPreview(container, incomingFragment(stemBlock(EDITED_BLOCK_EXPRESSION)));

    expect(outcome.mathSkipped).toBe(0);
    expect(container.querySelector('mjx-container')).toBeNull();
    expect(container.textContent).toBe(EDITED_BLOCK_EXPRESSION);
  });

  it('leaves the scroll position of the scrolling ancestor where the reader put it', () => {
    const { scroller, container } = mount(paragraph(1, 'one') + paragraph(3, 'two'));
    // jsdom has no layout, so scrolling is modelled explicitly: the writes are recorded to show the
    // position is read before the patch and written back after it, rather than merely never disturbed.
    let position = 0;
    const writes: number[] = [];
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => position,
      set: (value: number) => {
        position = value;
        writes.push(value);
      },
      configurable: true,
    });
    scroller.scrollTop = 420;
    writes.length = 0;

    morphPreview(container, incomingFragment(paragraph(1, 'one edited') + paragraph(3, 'two')));

    expect(writes).toEqual([420]);
    expect(scroller.scrollTop).toBe(420);
  });

  it('commits normally when nothing around the preview scrolls', () => {
    // The preview is not always inside a scrolling pane — a short document, or a host that scrolls the
    // window instead. There is then no position to hold on to, and the commit must proceed regardless.
    const container = document.createElement('div');
    container.innerHTML = paragraph(1, 'one');
    document.body.append(container);

    const outcome = morphPreview(container, incomingFragment(paragraph(1, 'one edited')));

    expect(container.textContent).toBe('one edited');
    expect(outcome).toEqual({ diagramsSkipped: 0, mathSkipped: 0, focusRestored: false });
  });

  it('keeps the keyboard focus on an element the refresh did not remove', () => {
    const { container } = mount(`${paragraph(1, 'one')}<div class="paragraph" id="__src_main_3"><p><a href="#target">link</a></p></div>`);
    const link = container.querySelector('a');
    link?.focus();

    const outcome = morphPreview(
      container,
      incomingFragment(`${paragraph(1, 'one edited')}<div class="paragraph" id="__src_main_3"><p><a href="#target">link</a></p></div>`),
    );

    expect(outcome.focusRestored).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it('falls back to the preview itself when the focused element is gone from the new render', () => {
    const { container } = mount(`${paragraph(1, 'one')}<div class="paragraph" id="__src_main_3"><p><a href="#target">link</a></p></div>`);
    container.querySelector('a')?.focus();

    const outcome = morphPreview(container, incomingFragment(paragraph(1, 'one')));

    // Focus would otherwise land on the document body, dropping the reader out of the preview.
    expect(outcome.focusRestored).toBe(true);
    expect(document.activeElement).toBe(container);
  });

  it('gives the borrowed tabindex back once focus leaves the preview', () => {
    const { container } = mount(`${paragraph(1, 'one')}<div class="paragraph" id="__src_main_3"><p><a href="#target">link</a></p></div>`);
    container.querySelector('a')?.focus();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);

    morphPreview(container, incomingFragment(paragraph(1, 'one')));
    expect(container.getAttribute('tabindex')).toBe('-1');

    elsewhere.focus();

    // This element belongs to React, which knows nothing about an attribute written behind its back
    // and would never take it off again. Left on, one refresh where one reader's focused block did
    // not survive would leave the preview programmatically focusable for the rest of the session.
    expect(container.hasAttribute('tabindex')).toBe(false);
  });

  it('leaves a tabindex it did not write alone', () => {
    const { container } = mount(`${paragraph(1, 'one')}<div class="paragraph" id="__src_main_3"><p><a href="#target">link</a></p></div>`);
    container.setAttribute('tabindex', '0');
    container.querySelector('a')?.focus();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);

    morphPreview(container, incomingFragment(paragraph(1, 'one')));
    elsewhere.focus();

    // Nothing was borrowed here, so there is nothing to give back — and taking this one away would be
    // removing a tab stop its owner put there.
    expect(container.getAttribute('tabindex')).toBe('0');
  });

  it('reports no focus restore when nothing inside the preview was focused', () => {
    const { container } = mount(paragraph(1, 'one'));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    const outcome = morphPreview(container, incomingFragment(paragraph(1, 'one edited')));

    expect(outcome.focusRestored).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});
