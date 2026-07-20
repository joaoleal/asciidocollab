import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  THEME_PREVIEW_FIGURE,
  THEME_PREVIEW_FIGURE_PATH,
  THEME_PREVIEW_SAMPLE,
  THEME_PREVIEW_SAMPLE_PATH,
} from '@/lib/pdf/theme-preview-sample';

const FIXTURE_SOURCE = path.join(
  __dirname,
  '../../../e2e/pdf-parity/fixtures/theme-editing/source',
);
const FIXTURE_MAIN = path.join(FIXTURE_SOURCE, 'main.adoc');

describe('the theme preview sample document', () => {
  it('is the same document the parity fixture renders', () => {
    // The fixture's reference PDF was produced by the canonical toolchain from this exact text. If
    // the two drift, the parity test still passes — while comparing a document nobody previews
    // against a reference nobody sees. That is worse than no test, so the drift is caught here.
    expect(readFileSync(FIXTURE_MAIN, 'utf8').trimEnd()).toBe(THEME_PREVIEW_SAMPLE.trimEnd());
  });

  it('is mounted at the path the preview snapshot names', () => {
    expect(THEME_PREVIEW_SAMPLE_PATH).toMatch(/\.adoc$/);
  });

  it('ships the figure the fixture renders, byte for byte', () => {
    // Same reasoning as the document above: a fixture whose figure had drifted from the previewed
    // one would compare a picture nobody sees against a reference nobody previews.
    expect(readFileSync(path.join(FIXTURE_SOURCE, THEME_PREVIEW_FIGURE_PATH), 'utf8')).toBe(
      THEME_PREVIEW_FIGURE,
    );
  });
});

describe('the sample exercises every element a theme can style', () => {
  // A theme setting the author cannot see is a setting they cannot judge. Each of these corresponds
  // to a family of theme settings; losing one silently narrows what the preview can demonstrate.
  it.each([
    ['a document title, for the title page', /^= /m],
    ['an author line', /Sample Author/],
    // Levels are asserted one per case below, NOT as an alternation here — see that test for why.
    ['body prose long enough to wrap', /measure everything else is judged against/],
    ['an unordered list', /^\* First item/m],
    ['an ordered list', /^\. Prepare the document/m],
    ['a description list', /^Theme:: /m],
    ['a table with a header and a footer', /options="header,footer"/],
    ['every admonition kind', /^NOTE: |^TIP: |^WARNING: |^CAUTION: |^IMPORTANT: /m],
    ['a block quote with an attribution', /^\[quote, /m],
    ['a verse', /^\[verse, /m],
    ['a source block', /^\[source,ruby]/m],
    ['callouts', /<1>/],
    ['a sidebar', /^\*{4}$/m],
    ['an example block', /^={4}$/m],
    ['a footnote', /footnote:\[/],
    ['a link', /https:\/\/asciidoctor\.org\[/],
    ['inline text styles', /\*Bold\*, _italic_/],
    ['a thematic break', /^'{3}$/m],
    ['a table of contents', /^:toc:$/m],
  ])('contains %s', (_label, pattern) => {
    expect(THEME_PREVIEW_SAMPLE).toMatch(pattern);
  });

  // One case PER LEVEL, deliberately. This used to be a single alternation —
  // `/^====== |^===== |^==== |^=== |^== /m` — which passes when ANY one branch matches, so it
  // reported "all six heading levels" while the sample had five: the line captioned "Sixth-level
  // heading" carried five `=`, making it a second h5. `heading.h6-font-size` is a real key the editor
  // offers, and its default (`$base_font_size_small`) is SMALLER than h5's, so an author editing it
  // watched the preview not change and had no way to tell that from a theme key that does nothing.
  it.each([
    ['h1', /^= [A-Z]/m],
    ['h2', /^== [A-Z]/m],
    ['h3', /^=== [A-Z]/m],
    ['h4', /^==== [A-Z]/m],
    ['h5', /^===== [A-Z]/m],
    ['h6', /^====== [A-Z]/m],
  ])('exercises %s, the level that theme key styles', (_level, pattern) => {
    expect(THEME_PREVIEW_SAMPLE).toMatch(pattern);
  });

  it('gives every heading below the chapter level something to be spaced against', () => {
    // The space above and below a heading is as much a theme setting as its size, and it can only be
    // judged against prose. The two deepest headings previously sat back to back with nothing
    // between them, so their margins were invisible even once both levels existed.
    const lines = THEME_PREVIEW_SAMPLE.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/^={3,6} [A-Z]/.test(line)) continue;
      const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
      expect(next).toBeDefined();
      expect(next).not.toMatch(/^=+ /);
    }
  });

  it('reads as a document rather than a grid of specimens', () => {
    // A theme is judged by how a document READS under it — line spacing against heading margins,
    // quote indentation against body measure — and a specimen sheet shows every element while
    // showing none of those relationships (FR-011b).
    expect(THEME_PREVIEW_SAMPLE).toMatch(/== Headings and prose/);
    const prose = THEME_PREVIEW_SAMPLE.split('\n').filter((line) => line.length > 60);
    expect(prose.length).toBeGreaterThan(5);
  });

  it('is self-contained, so it renders identically for every project', () => {
    // Anything reaching outside this module would make the preview depend on what the project
    // happens to contain, and two co-editors could see different results for the same theme. Images
    // are allowed because the one figure's source is a constant here and is mounted into the
    // snapshot alongside the document — so this checks every target, rather than banning images.
    expect(THEME_PREVIEW_SAMPLE).not.toMatch(/^include::/m);
    const imageTargets = [...THEME_PREVIEW_SAMPLE.matchAll(/^image::([^[]+)\[/gm)].map(
      (match) => match[1],
    );
    expect(imageTargets.length).toBeGreaterThan(0);
    expect([...new Set(imageTargets)]).toEqual([THEME_PREVIEW_FIGURE_PATH]);
  });
});

describe('the sample carries every shipped extension’s targeting markup (T058, FR-011a)', () => {
  // Enabling one extension must produce a visible difference in the preview, or the author has no
  // way to see what they just switched on (SC-014b). That requires the markup each one acts on to be
  // present here — including for the extensions whose targeting is a document attribute, which is
  // easy to drop by accident because the document still renders perfectly without it.
  it.each([
    ['additional-contents-entries', /^:list-of-figures:$/m],
    ['additional-contents-entries', /^:list-of-tables:$/m],
    ['auto-license-page', /^:license: /m],
    ['colophon-placement', /^\[colophon]$/m],
    ['large-table-page-size', /^\[\.wide-page,/m],
    ['multi-column-sections', /^\[\.multi-column]$/m],
    ['per-chapter-contents', /^:per-chapter-toc:$/m],
    ['title-block-document-details', /^:title-block-details: /m],
  ])('carries what %s acts on', (_extension, pattern) => {
    expect(THEME_PREVIEW_SAMPLE).toMatch(pattern);
  });

  it('gives the figure and table lists several entries each', () => {
    // Both lists are OMITTED rather than drawn empty when nothing captioned exists, so the markup
    // above only produces a visible difference if there is also a captioned figure and table.
    //
    // SEVERAL of each, not one: a one-line list shows dot leaders and a page number but says nothing
    // about the spacing BETWEEN entries, which is the thing that most visibly disagrees with the
    // contents list if it ever regresses. Three of each makes that pitch measurable.
    const captions = [...THEME_PREVIEW_SAMPLE.matchAll(/^\.[A-Z].*$/gm)].map((match) => match[0]);
    expect(captions.length).toBeGreaterThanOrEqual(6);
    expect(THEME_PREVIEW_SAMPLE).toMatch(/^\.A three-stage process$/m);
    expect(THEME_PREVIEW_SAMPLE).toMatch(/^\.Quarterly totals$/m);
  });

  it('carries a caption long enough to wrap in the list of figures', () => {
    // A wrapped caption is where an entry and its page number are most likely to drift apart: the
    // dots must run from the end of the LAST line, not the first. Nothing else in the sample
    // exercises that path.
    const captions = [...THEME_PREVIEW_SAMPLE.matchAll(/^\.[A-Z].*$/gm)].map((match) => match[0]);
    expect(captions.some((caption) => caption.length > 90)).toBe(true);
  });

  it('gives the per-chapter contents lists a chapter with subsections', () => {
    // The list is skipped for a chapter with no subsections, so a sample of flat chapters would
    // enable the extension and show nothing.
    const chapters = THEME_PREVIEW_SAMPLE.split(/^== /m).slice(1);
    expect(chapters.some((chapter) => /^=== /m.test(chapter))).toBe(true);
  });

  it('needs no markup for the two extensions that target nothing', () => {
    // `paragraph-numbering` acts on body paragraphs and `narrow-contents` on the contents list, so
    // both are already visible here. Pinned so that removing `:toc:` or the prose does not silently
    // make one of them undemonstrable.
    expect(THEME_PREVIEW_SAMPLE).toMatch(/^:toc:$/m);
    expect(THEME_PREVIEW_SAMPLE).toMatch(/^Body text sets the measure/m);
  });
});
