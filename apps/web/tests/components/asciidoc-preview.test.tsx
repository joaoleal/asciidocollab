import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { AsciiDocPreview, isAsciiDocFile } from '@/components/asciidoc-preview';

// ── Mock useAsciidocPreview ──────────────────────────────────────────────────

jest.mock('@/hooks/use-asciidoc-preview', () => ({
  useAsciidocPreview: jest.fn(),
}));

// ── Mock the lazy-loaded client math renderer ─────────────────────────
// The preview dynamic-imports this module only when the worker flags in-effect STEM. Mocking it
// lets us assert MathJax is loaded (via renderMath) exactly when math is present, post-sanitize,
// scoped to the output container — without running MathJax (which cannot execute in jsdom).
const renderMathMock = jest.fn<Promise<void>, [HTMLElement]>(() => Promise.resolve());
jest.mock('@/components/math/render-math', () => ({
  renderMath: (element: HTMLElement) => renderMathMock(element),
}));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import {
  commitToPreviewOutput,
  previewHookResult,
  previewOutputReference,
  type PreviewHookDouble,
} from '../helpers/preview-panel';
const mockUsePreview = useAsciidocPreview as jest.Mock;

/** Flush the microtasks the preview's dynamic `import().then(...)` schedules. */
const flushAsync = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** The panel under test, with the props every test here shares. */
const panel = (properties: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {}) => (
  <AsciiDocPreview content="= Doc" isEnabled projectId="proj-1" scrollToLine={null} {...properties} />
);

/**
 * Mount the panel with a document already on screen — the hook's commit, played out in the order the
 * hook performs it: the markup goes into the element the panel hands over, and the commit is announced
 * afterwards, so the panel's post-commit passes find the document already there.
 *
 * @param markup - The rendered document to display.
 * @param result - Anything else about the hook's state this test is asserting on.
 * @param properties - Panel props this test needs.
 * @returns The render harness, plus a re-render that keeps the same committed document on screen.
 */
function renderShowing(
  markup: string,
  result: Partial<PreviewHookDouble> = {},
  properties: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {},
) {
  const showing = (renderNonce: number) =>
    previewHookResult({ html: markup, state: 'up-to-date', renderNonce, ...result });
  mockUsePreview.mockReturnValue(showing(0));
  const harness = render(panel(properties));
  commitToPreviewOutput(markup);
  mockUsePreview.mockReturnValue(showing(1));
  harness.rerender(panel(properties));
  return {
    ...harness,
    /** Re-render with unrelated props changed, the commit unchanged — no second commit happens. */
    rerenderUncommitted: (next: Partial<React.ComponentProps<typeof AsciiDocPreview>>) =>
      harness.rerender(panel({ ...properties, ...next })),
  };
}

/** A stem block as the worker emits it — the expression still as delimited source text. */
const stemMarkup = (expression: string) =>
  String.raw`<div class="stemblock"><div class="content">\$${expression}\$</div></div>`;

/** A panel whose latest render has landed. What that render said is beside the point for its callers. */
const withHtml = () =>
  mockUsePreview.mockReturnValue(
    previewHookResult({ html: '<h1>Doc</h1>', state: 'up-to-date', renderNonce: 1 }),
  );

// The DOMPurify configuration the preview boundary applies, in the shape the boundary asks for it:
// nodes, read back as markup so these allow-list expectations can be stated as text. That the two
// shapes reach the same verdict is proved separately, against payloads, in the hook's sanitizer suite.
const sanitizePreviewHtml = (html: string) => {
  const holder = document.createElement('div');
  holder.append(DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true }));
  return holder.innerHTML;
};

beforeEach(() => {
  mockUsePreview.mockReset();
  renderMathMock.mockClear();
  mockUsePreview.mockReturnValue(previewHookResult({
    html: null,
    state: 'idle',
    error: null,
  }));
});

// ── Component tests ──────────────────────────────────────────────────────────

describe('AsciiDocPreview', () => {
  // (a) the panel supplies the element the render is committed into
  it('hands the scoped output element to the hook to commit renders into', () => {
    const { container } = render(panel());

    // The panel does not put the document on screen any more — it provides the element the hook
    // patches each render into, and stays out of what is inside it. Handing over the element scoped by
    // `.asciidoc-preview-content` is what keeps the author's document styled as a document.
    const output = container.querySelector('.asciidoc-preview-content');
    expect(output).toBeInTheDocument();
    expect(previewOutputReference.current).toBe(output);
  });

  it('offers the output element before anything has been rendered', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'pending', renderNonce: 0 }));

    render(panel());

    // Waiting for something to show before offering somewhere to show it is circular: the very first
    // render would have nowhere to be committed, so nothing would ever appear.
    expect(previewOutputReference.current).not.toBeNull();
    expect(previewOutputReference.current?.innerHTML).toBe('');
  });

  it('leaves a committed document alone across an unrelated re-render', () => {
    const { rerenderUncommitted } = renderShowing('<h1>Hello</h1>');
    const output = screen.getByTestId('asciidoc-output');

    // The contents belong to the hook. If React were given a say in them — a `dangerouslySetInnerHTML`
    // payload, or children in the panel's own markup — an unrelated re-render such as an editor click
    // would re-apply them and wipe whatever the client had drawn or typeset in the meantime.
    rerenderUncommitted({ scrollToLine: { line: 3 } });

    expect(output.innerHTML).toBe('<h1>Hello</h1>');
    expect(screen.getByTestId('asciidoc-output')).toBe(output);
  });

  it('shows the "not part of the main document" notice only when outsideMainTree is set', () => {
    mockUsePreview.mockReturnValue(previewHookResult({
      html: '<h1>Hello</h1>',
      state: 'up-to-date',
      error: null,
    }));

    const { queryByTestId, rerender } = render(
      <AsciiDocPreview content="= Hello" isEnabled projectId="proj-1" scrollToLine={null} />,
    );
    expect(queryByTestId('outside-main-tree-notice')).not.toBeInTheDocument();

    rerender(
      <AsciiDocPreview content="= Hello" isEnabled projectId="proj-1" scrollToLine={null} outsideMainTree />,
    );
    expect(queryByTestId('outside-main-tree-notice')).toBeInTheDocument();
    expect(queryByTestId('outside-main-tree-notice')).toHaveTextContent(/part of the main document/i);
  });

  // (b) shows rendering indicator when state is pending or rendering
  it('shows rendering indicator when state is pending', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'pending', error: null }));
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByTestId('sync-indicator')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('shows rendering indicator when state is rendering', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: '<h1>A</h1>', state: 'rendering', error: null }));
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByTestId('sync-indicator')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  // (c) shows "✓" indicator when state is up-to-date
  it('shows ✓ indicator when state is up-to-date', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: '<h1>A</h1>', state: 'up-to-date', error: null }));
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  // (d) shows "Preview not available" when isEnabled is false
  it('shows "Preview not available" message when isEnabled is false', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(<AsciiDocPreview content="" isEnabled={false} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText(/preview not available/i)).toBeInTheDocument();
  });

  // The message is about the FILE, not about the panel's momentary state. It used to appear whenever
  // the panel was idle, and because the panel was remounted (and so reset to idle) on every file
  // switch, opening any file announced that its preview was unavailable before rendering it anyway.
  it('does not claim the preview is unavailable for a previewable file with nothing rendered yet', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));

    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);

    expect(screen.queryByText(/preview not available/i)).not.toBeInTheDocument();
  });

  it('keeps the previous document on screen, and says nothing about availability, while the newly opened file renders', () => {
    const { rerenderUncommitted } = renderShowing('<h1>Previously opened</h1>');

    // The newly opened file is being rendered; nothing has been committed for it yet.
    mockUsePreview.mockReturnValue(
      previewHookResult({ html: '<h1>Previously opened</h1>', state: 'rendering', renderNonce: 1 }),
    );
    rerenderUncommitted({ content: '= Newly opened' });

    expect(screen.queryByText(/preview not available/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('asciidoc-output').innerHTML).toContain('<h1>Previously opened</h1>');
  });

  it('marks the output as busy while a render is in flight and clears it when one lands', () => {
    const { rerenderUncommitted } = renderShowing('<h1>Hello</h1>');
    // A render that has landed is not in flight, so nothing is announced as changing.
    expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('aria-busy', 'false');

    mockUsePreview.mockReturnValue(
      previewHookResult({ html: '<h1>Hello</h1>', state: 'rendering', renderNonce: 1 }),
    );
    rerenderUncommitted({ content: '= Hello edited' });

    // A reader who cannot see the panel is otherwise given a document that is about to change under
    // them, with nothing saying so.
    expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('aria-busy', 'true');
  });

  it('marks the output as busy from the moment an edit is waiting to be rendered', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'pending' }));

    render(panel());

    // The wait before a render starts is part of the same "the document is out of date" span; ending
    // it at the debounce boundary would clear and re-set the flag mid-edit for no reason a reader
    // could act on.
    expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('aria-busy', 'true');
  });

  // (e) data-testid="asciidoc-output" present for any previewable file
  it('renders data-testid="asciidoc-output" for a previewable file', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: '<p>Hello</p>', state: 'up-to-date' }));
    render(panel({ content: '= Hello' }));
    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
  });

  // Phase 5: full sync indicator — error, idle file-type, recovery

  // (a) error state: shows "⚠ Preview error" and error message; previous html still visible
  it('shows error indicator and message when state is error', () => {
    const { rerenderUncommitted } = renderShowing('<h1>Previous</h1>');

    mockUsePreview.mockReturnValue(
      previewHookResult({
        html: '<h1>Previous</h1>',
        state: 'error',
        error: 'Asciidoctor parse error',
        renderNonce: 1,
      }),
    );
    rerenderUncommitted({ content: 'bad' });

    expect(screen.getByText(/preview error/i)).toBeInTheDocument();
    expect(screen.getByText(/Asciidoctor parse error/)).toBeInTheDocument();
    // The last document that did render stays on screen. A failed render has nothing to replace it
    // with, and blanking the panel would lose the reader's place over a typo they are mid-way through.
    expect(screen.getByTestId('asciidoc-output').innerHTML).toBe('<h1>Previous</h1>');
  });

  // (b) isEnabled=false: indicator shows "–" and content shows neutral message
  it('shows – indicator and file-type message when isEnabled is false', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(<AsciiDocPreview content="" isEnabled={false} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText(/preview not available for this file type/i)).toBeInTheDocument();
  });

  // (c) error indicator hides when state transitions back to pending
  it('hides error indicator when state is pending', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'pending', error: null }));
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.queryByText(/preview error/i)).not.toBeInTheDocument();
  });

  // scroll sync toggle
  it('renders scroll sync toggle when onToggleScrollSync is provided', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(
      <AsciiDocPreview
        content=""
        isEnabled={true}
        scrollToLine={null}
        scrollSyncEnabled={false}
        onToggleScrollSync={jest.fn()}
      />,
    );
    expect(screen.getByTestId('scroll-sync-toggle')).toBeInTheDocument();
  });

  it('does not render scroll sync toggle when onToggleScrollSync is not provided', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(<AsciiDocPreview content="" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.queryByTestId('scroll-sync-toggle')).not.toBeInTheDocument();
  });

  it('scroll sync toggle has aria-pressed=false when scrollSyncEnabled is false', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(
      <AsciiDocPreview
        content=""
        isEnabled={true}
        scrollToLine={null}
        scrollSyncEnabled={false}
        onToggleScrollSync={jest.fn()}
      />,
    );
    expect(screen.getByTestId('scroll-sync-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('scroll sync toggle has aria-pressed=true when scrollSyncEnabled is true', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(
      <AsciiDocPreview
        content=""
        isEnabled={true}
        scrollToLine={null}
        scrollSyncEnabled={true}
        onToggleScrollSync={jest.fn()}
      />,
    );
    expect(screen.getByTestId('scroll-sync-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggleScrollSync when scroll sync toggle is clicked', () => {
    const onToggle = jest.fn();
    mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle', error: null }));
    render(
      <AsciiDocPreview
        content=""
        isEnabled={true}
        scrollToLine={null}
        scrollSyncEnabled={false}
        onToggleScrollSync={onToggle}
      />,
    );
    fireEvent.click(screen.getByTestId('scroll-sync-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // Preview style control + style application
  describe('preview style', () => {
    it('renders the style control when onPreviewStyleChange is provided', () => {
      withHtml();
      render(
        <AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} previewStyle="asciidocollab" onPreviewStyleChange={jest.fn()} />,
      );
      expect(screen.getByTestId('preview-style-asciidocollab')).toBeInTheDocument();
      expect(screen.getByTestId('preview-style-asciidoctor')).toBeInTheDocument();
    });

    it('does not render the style control when onPreviewStyleChange is absent', () => {
      withHtml();
      render(<AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      expect(screen.queryByTestId('preview-style-asciidoctor')).not.toBeInTheDocument();
    });

    it('defaults the output data-preview-style to asciidocollab', () => {
      withHtml();
      render(<AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'asciidocollab');
    });

    it('applies data-preview-style="asciidoctor" to the output when selected', () => {
      withHtml();
      render(
        <AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} previewStyle="asciidoctor" onPreviewStyleChange={jest.fn()} />,
      );
      expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'asciidoctor');
    });

    it('calls onPreviewStyleChange with the picked token', () => {
      withHtml();
      const onChange = jest.fn();
      render(
        <AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} previewStyle="asciidocollab" onPreviewStyleChange={onChange} />,
      );
      fireEvent.click(screen.getByTestId('preview-style-asciidoctor'));
      expect(onChange).toHaveBeenCalledWith('asciidoctor');
    });

    it('does not alter the rendered HTML when the style changes', () => {
      const { rerenderUncommitted } = renderShowing('<h1>Doc</h1>', {}, {
        previewStyle: 'asciidocollab',
        onPreviewStyleChange: jest.fn(),
      });
      expect(screen.getByTestId('asciidoc-output').innerHTML).toContain('<h1>Doc</h1>');

      rerenderUncommitted({ previewStyle: 'asciidoctor' });

      // The style is an attribute on the element the hook commits into; changing it must not disturb
      // what is inside it — including whatever the client drew or typeset there after the commit.
      expect(screen.getByTestId('asciidoc-output').innerHTML).toContain('<h1>Doc</h1>');
      expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'asciidoctor');
    });
  });

  // ── sanitizer keeps remaining-completeness constructs ──────────
  // Bibliography/citations, index terms + the index listing, counters, and page breaks are NATIVE
  // Asciidoctor output (no special worker config). The single risk is the DOMPurify boundary in
  // `useAsciidocPreview` stripping a needed element/attribute (the page-break `<div>`'s inline
  // `page-break-after` style, anchor `id`s, etc.). These tests feed representative Asciidoctor HTML
  // for each construct through the SAME DOMPurify config the preview uses and assert it survives with
  // no raw markup left — proving they pass through the sanitizer unchanged (Constitution IX).
  describe('sanitizer preserves rendering-completeness constructs', () => {
    const sanitize = sanitizePreviewHtml;

    // A [bibliography] list with a `[[[ref]]]` entry anchor and an in-text `<<ref>>` citation
    // link survive — the entry's anchor `id` (the citation's link target) is preserved.
    it('keeps the bibliography list, entry anchor id, and citation link', () => {
      const biblio =
        '<div class="ulist bibliography"><ul class="bibliography">' +
        '<li><p><a id="ref"></a>[ref] Author. <em>Title</em>.</p></li></ul></div>';
      const citation = '<div class="paragraph"><p>See <a href="#ref">[ref]</a>.</p></div>';
      const cleanBiblio = sanitize(biblio);
      const cleanCitation = sanitize(citation);
      expect(cleanBiblio).toContain('class="bibliography"');
      expect(cleanBiblio).toContain('id="ref"'); // anchor target for the citation
      expect(cleanBiblio).toContain('[ref] Author.');
      expect(cleanCitation).toContain('<a href="#ref">'); // citation links to the entry
    });

    // Index-term anchors (from `indexterm:[]`/`((…))`) and the generated index listing
    // survive — the listing `<div id="index">` and the indexed-term headings are preserved.
    it('keeps index-term anchors and the generated index listing', () => {
      const term = '<div class="paragraph"><p><a id="_indexterm_1" class="indexterm"></a>Body.</p></div>';
      const listing = '<div id="index"><div class="paragraph"><p>T</p></div><h3 id="_t">T</h3></div>';
      const cleanTerm = sanitize(term);
      const cleanListing = sanitize(listing);
      expect(cleanTerm).toContain('class="indexterm"');
      expect(cleanTerm).toContain('id="_indexterm_1"');
      expect(cleanListing).toContain('id="index"'); // index section/listing preserved
      expect(cleanListing).toContain('id="_t"');
    });

    // Counter substitution (`{counter:name}`) is plain text in the native output, so the
    // incremented value passes through untouched (no raw `{counter:...}` markup remains).
    it('keeps substituted counter values as plain text', () => {
      const counter = '<div class="paragraph"><p>Figure 1 then 2.</p></div>';
      const clean = sanitize(counter);
      expect(clean).toContain('Figure 1 then 2.');
      expect(clean).not.toContain('{counter');
    });

    // The page-break `<div style="page-break-after: always">` (`<<<`) survives — crucially its
    // inline style is NOT stripped, so the scoped preview CSS can render a visible boundary from it.
    it('keeps the page-break div and its inline page-break style', () => {
      const pageBreak = '<div style="page-break-after: always"></div>';
      const clean = sanitize(pageBreak);
      expect(clean).toContain('page-break-after'); // inline style preserved → visible boundary CSS
      expect(clean).toMatch(/<div[^>]*style="[^"]*page-break-after/);
    });
  });

  // ── lazy MathJax load gated on mathPresent, post-sanitize, scoped ──────────
  describe('STEM math rendering', () => {
    it('lazy-loads MathJax (renderMath) only when mathPresent and typesets the scoped output', async () => {
      renderShowing(stemMarkup('x^2'), { mathPresent: true }, { content: ':stem:' });
      await flushAsync();

      expect(renderMathMock).toHaveBeenCalledTimes(1);
      // Typeset in the element the render was committed into, and nowhere else: the document's own
      // styles are scoped to it, and so is everything the client is allowed to touch.
      const container = renderMathMock.mock.calls[0][0];
      expect(container).toBe(screen.getByTestId('asciidoc-output'));
      expect(container.classList.contains('asciidoc-preview-content')).toBe(true);
      expect(container.innerHTML).toContain('stemblock');
    });

    it('never loads MathJax when mathPresent is false (no stem in effect)', async () => {
      // Delimiters present in the source but `:stem:` absent ⇒ the worker flags mathPresent=false.
      renderShowing(String.raw`<div class="paragraph"><p>\$x^2\$</p></div>`, { mathPresent: false }, {
        content: 'stem:[x^2]',
      });
      await flushAsync();

      expect(renderMathMock).not.toHaveBeenCalled();
    });

    it('does not load MathJax before anything has been committed', async () => {
      mockUsePreview.mockReturnValue(
        previewHookResult({ html: null, state: 'rendering', mathPresent: true, renderNonce: 0 }),
      );
      render(panel({ content: ':stem:' }));
      await flushAsync();

      // There is no document on screen yet, so there is nothing to typeset — and loading MathJax to
      // discover that would pay its whole bundle cost for no result.
      expect(renderMathMock).not.toHaveBeenCalled();
    });

    it('re-typesets when a new render is committed while math stays present', async () => {
      const { rerenderUncommitted } = renderShowing(stemMarkup('a'), { mathPresent: true }, {
        content: ':stem:',
      });
      await flushAsync();
      expect(renderMathMock).toHaveBeenCalledTimes(1);

      commitToPreviewOutput(stemMarkup('b'));
      mockUsePreview.mockReturnValue(
        previewHookResult({ html: stemMarkup('b'), state: 'up-to-date', mathPresent: true, renderNonce: 2 }),
      );
      rerenderUncommitted({ content: ':stem:\n\nstem:[b]' });
      await flushAsync();

      expect(renderMathMock).toHaveBeenCalledTimes(2);
    });

    it('re-typesets a commit whose markup happens to be unchanged', async () => {
      const unchanged = stemMarkup('x');
      const { rerenderUncommitted } = renderShowing(unchanged, { mathPresent: true }, { content: ':stem:' });
      await flushAsync();
      expect(renderMathMock).toHaveBeenCalledTimes(1);

      // Reopening the same file commits the same markup into an element that no longer holds the
      // typeset result. Keying this pass on the markup would read "nothing changed" and skip it,
      // leaving the raw delimiters on screen with nothing left to trigger a retry.
      commitToPreviewOutput(unchanged);
      mockUsePreview.mockReturnValue(
        previewHookResult({ html: unchanged, state: 'up-to-date', mathPresent: true, renderNonce: 2 }),
      );
      rerenderUncommitted({});
      await flushAsync();

      expect(renderMathMock).toHaveBeenCalledTimes(2);
    });

    it('preserves client-typeset math across a re-render that commits nothing (on-click revert bug)', async () => {
      // The rendered markup carries the raw `\$x\$` delimiters; the client replaces them with a typeset
      // node in the live DOM. A re-render that commits nothing — an editor click updating an unrelated
      // prop — must leave that node alone. Letting React own the element's contents is what used to
      // wipe it, and with nothing committed the typeset pass would not run again to put it back.
      const { rerenderUncommitted } = renderShowing(String.raw`<div class="paragraph"><p>\$x\$</p></div>`, {
        mathPresent: true,
      }, { content: ':stem:' });
      await flushAsync();

      const output = screen.getByTestId('asciidoc-output');
      const typeset = document.createElement('math');
      typeset.dataset['stemSource'] = String.raw`\$x\$`;
      output.replaceChildren(typeset);

      rerenderUncommitted({ scrollToLine: { line: 3 } });
      await flushAsync();

      expect(output.querySelector('math')).not.toBeNull();
      expect(renderMathMock).toHaveBeenCalledTimes(1);
    });
  });

  // isAsciiDocFile helper
  describe('isAsciiDocFile', () => {
    it.each([
      ['doc.adoc', true],
      ['doc.asciidoc', true],
      ['doc.asc', true],
      ['doc.ad', true],
      ['DOC.ADOC', true],
      ['doc.txt', false],
      ['doc.json', false],
      ['noextension', false],
      ['', false],
      ['.adoc', false],
      ['.asciidoc', false],
    ])('isAsciiDocFile(%s) === %s', (name, expected) => {
      expect(isAsciiDocFile(name)).toBe(expected);
    });
  });
});

// ── The engine giving up ─────────────────────────────────────────────────────

/**
 * Report a preview whose engine has died for good: a last good render still on screen, and no further
 * rebuild coming.
 *
 * @param retryEngine - Stands in for the hook's manual retry.
 */
const previewWithFailedEngine = (retryEngine: () => void) =>
  mockUsePreview.mockReturnValue(previewHookResult({
    html: '<h1>Last good render</h1>',
    state: 'rendering',
    error: null,
    engineFailed: true,
    retryEngine,
  }));

describe('AsciiDocPreview engine failure', () => {
  it('says the engine stopped, and offers to start it again', () => {
    previewWithFailedEngine(jest.fn());

    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);

    // Nothing will restart it on its own, so a panel that says nothing looks exactly like a document
    // with nothing new to show.
    expect(screen.getByTestId('engine-failure-notice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restart preview engine/i })).toBeInTheDocument();
  });

  it('asks for a new engine when the reader clicks through', () => {
    const retryEngine = jest.fn();
    previewWithFailedEngine(retryEngine);

    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    fireEvent.click(screen.getByRole('button', { name: /restart preview engine/i }));

    expect(retryEngine).toHaveBeenCalledTimes(1);
  });

  it('says nothing while the engine is healthy, including on an ordinary render failure', () => {
    mockUsePreview.mockReturnValue(previewHookResult({
      html: '<h1>Doc</h1>',
      state: 'error',
      error: 'unterminated block',
      engineFailed: false,
    }));

    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);

    // A document that does not convert is not an engine that has died; offering to restart the engine
    // would point the author at the wrong problem.
    expect(screen.queryByTestId('engine-failure-notice')).not.toBeInTheDocument();
    expect(screen.getByText('unterminated block')).toBeInTheDocument();
  });

  it('keeps the failure notice out of the rendered document', () => {
    previewWithFailedEngine(jest.fn());

    const { container } = render(
      <AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />,
    );

    // `.asciidoc-preview-content` is scoped to the author's document; app chrome inside it would be
    // styled as though the document had written it.
    expect(container.querySelector('.asciidoc-preview-content')?.textContent).not.toContain(
      'Restart preview engine',
    );
  });
});

// ── Render-cost overlay ──────────────────────────────────────────────────────

describe('AsciiDocPreview render-cost overlay', () => {
  it('shows what the last render cost, outside the document content', () => {
    mockUsePreview.mockReturnValue(previewHookResult({
      html: '<h1>Hello</h1>',
      state: 'up-to-date',
      error: null,
      timings: { parseMs: 4, convertMs: 18, postProcessMs: 3, totalMs: 27 },
    }));

    const { container } = render(
      <AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />,
    );

    expect(screen.getByText('27 ms')).toBeInTheDocument();
    // Document-rendering styles are scoped to `.asciidoc-preview-content`; app chrome inside it would
    // be styled as though it were part of the author's document.
    expect(container.querySelector('.asciidoc-preview-content')?.textContent).not.toContain('27 ms');
  });

  it('shows no cost overlay before a render has been measured', () => {
    mockUsePreview.mockReturnValue(previewHookResult({
      html: '<h1>Hello</h1>',
      state: 'up-to-date',
      error: null,
      timings: null,
    }));

    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);

    expect(screen.queryByText(/render cost/i)).not.toBeInTheDocument();
  });
});
