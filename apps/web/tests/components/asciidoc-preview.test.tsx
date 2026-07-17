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
const mockUsePreview = useAsciidocPreview as jest.Mock;

/** Flush the microtasks the preview's dynamic `import().then(...)` schedules. */
const flushAsync = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const fakeReference: React.RefObject<HTMLDivElement> = { current: null };

// The exact DOMPurify config used by the preview boundary in `useAsciidocPreview.ts`. Replicated here
// so the tests below guard the real sanitization the rendered HTML undergoes before display.
const sanitizePreviewHtml = (html: string) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

const withHtml = () =>
  mockUsePreview.mockReturnValue({ html: '<h1>Doc</h1>', state: 'up-to-date', error: null, previewRef: fakeReference });

beforeEach(() => {
  mockUsePreview.mockReset();
  renderMathMock.mockClear();
  mockUsePreview.mockReturnValue({
    html: null,
    state: 'idle',
    error: null,
    previewRef: fakeReference,
  });
});

// ── Component tests ──────────────────────────────────────────────────────────

describe('AsciiDocPreview', () => {
  // (a) renders HTML inside .asciidoc-preview-content when html is non-null
  it('renders HTML output inside .asciidoc-preview-content when html is non-null', () => {
    mockUsePreview.mockReturnValue({
      html: '<h1>Hello</h1>',
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
    });

    const { container } = render(
      <AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />,
    );

    const wrapper = container.querySelector('.asciidoc-preview-content');
    expect(wrapper).toBeInTheDocument();
    expect(wrapper?.innerHTML).toContain('<h1>Hello</h1>');
  });

  it('shows the "not part of the main document" notice only when outsideMainTree is set', () => {
    mockUsePreview.mockReturnValue({
      html: '<h1>Hello</h1>',
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
    });

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
    mockUsePreview.mockReturnValue({ html: null, state: 'pending', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByTestId('sync-indicator')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('shows rendering indicator when state is rendering', () => {
    mockUsePreview.mockReturnValue({ html: '<h1>A</h1>', state: 'rendering', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByTestId('sync-indicator')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  // (c) shows "✓" indicator when state is up-to-date
  it('shows ✓ indicator when state is up-to-date', () => {
    mockUsePreview.mockReturnValue({ html: '<h1>A</h1>', state: 'up-to-date', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  // (d) shows "Preview not available" when isEnabled is false
  it('shows "Preview not available" message when isEnabled is false', () => {
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="" isEnabled={false} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText(/preview not available/i)).toBeInTheDocument();
  });

  // (e) data-testid="asciidoc-output" present when html is rendered
  it('renders data-testid="asciidoc-output" when HTML is present', () => {
    mockUsePreview.mockReturnValue({ html: '<p>Hello</p>', state: 'up-to-date', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
  });

  // Phase 5: full sync indicator — error, idle file-type, recovery

  // (a) error state: shows "⚠ Preview error" and error message; previous html still visible
  it('shows error indicator and message when state is error', () => {
    mockUsePreview.mockReturnValue({
      html: '<h1>Previous</h1>',
      state: 'error',
      error: 'Asciidoctor parse error',
      previewRef: fakeReference,
    });
    render(<AsciiDocPreview content="bad" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText(/preview error/i)).toBeInTheDocument();
    expect(screen.getByText(/Asciidoctor parse error/)).toBeInTheDocument();
    // Previous HTML still rendered
    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
  });

  // (b) isEnabled=false: indicator shows "–" and content shows neutral message
  it('shows – indicator and file-type message when isEnabled is false', () => {
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="" isEnabled={false} projectId="proj-1" scrollToLine={null} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText(/preview not available for this file type/i)).toBeInTheDocument();
  });

  // (c) error indicator hides when state transitions back to pending
  it('hides error indicator when state is pending', () => {
    mockUsePreview.mockReturnValue({ html: null, state: 'pending', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="= Hello" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.queryByText(/preview error/i)).not.toBeInTheDocument();
  });

  // scroll sync toggle
  it('renders scroll sync toggle when onToggleScrollSync is provided', () => {
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
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
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
    render(<AsciiDocPreview content="" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
    expect(screen.queryByTestId('scroll-sync-toggle')).not.toBeInTheDocument();
  });

  it('scroll sync toggle has aria-pressed=false when scrollSyncEnabled is false', () => {
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
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
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
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
    mockUsePreview.mockReturnValue({ html: null, state: 'idle', error: null, previewRef: fakeReference });
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
      withHtml();
      const { rerender } = render(
        <AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} previewStyle="asciidocollab" onPreviewStyleChange={jest.fn()} />,
      );
      expect(screen.getByTestId('asciidoc-output').innerHTML).toContain('<h1>Doc</h1>');
      rerender(
        <AsciiDocPreview content="= Doc" isEnabled={true} projectId="proj-1" scrollToLine={null} previewStyle="asciidoctor" onPreviewStyleChange={jest.fn()} />,
      );
      // Same sanitized HTML; only the style attribute flipped.
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
    it('lazy-loads MathJax (renderMath) only when mathPresent and renders post-sanitize, scoped', async () => {
      mockUsePreview.mockReturnValue({
        html: String.raw`<div class="stemblock"><div class="content">\$x^2\$</div></div>`,
        state: 'up-to-date',
        error: null,
        previewRef: fakeReference,
        mathPresent: true,
      });
      render(<AsciiDocPreview content=":stem:" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      await flushAsync();

      expect(renderMathMock).toHaveBeenCalledTimes(1);
      // Called on the scoped, sanitized output container — the same node holding the rendered HTML.
      const container = renderMathMock.mock.calls[0][0];
      expect(container).toBe(screen.getByTestId('asciidoc-output'));
      expect(container.classList.contains('asciidoc-preview-content')).toBe(true);
      expect(container.innerHTML).toContain('stemblock');
    });

    it('never loads MathJax when mathPresent is false (no stem in effect)', async () => {
      mockUsePreview.mockReturnValue({
        // delimiters present in source but `:stem:` absent ⇒ worker flags mathPresent=false
        html: String.raw`<div class="paragraph"><p>\$x^2\$</p></div>`,
        state: 'up-to-date',
        error: null,
        previewRef: fakeReference,
        mathPresent: false,
      });
      render(<AsciiDocPreview content="stem:[x^2]" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      await flushAsync();

      expect(renderMathMock).not.toHaveBeenCalled();
    });

    it('does not load MathJax when there is no rendered html yet', async () => {
      mockUsePreview.mockReturnValue({
        html: null,
        state: 'rendering',
        error: null,
        previewRef: fakeReference,
        mathPresent: true,
      });
      render(<AsciiDocPreview content=":stem:" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      await flushAsync();

      expect(renderMathMock).not.toHaveBeenCalled();
    });

    it('re-typesets when the rendered html changes while math stays present', async () => {
      mockUsePreview.mockReturnValue({
        html: String.raw`<div class="stemblock"><div class="content">\$a\$</div></div>`,
        state: 'up-to-date',
        error: null,
        previewRef: fakeReference,
        mathPresent: true,
      });
      const { rerender } = render(
        <AsciiDocPreview content=":stem:" isEnabled={true} projectId="proj-1" scrollToLine={null} />,
      );
      await flushAsync();
      expect(renderMathMock).toHaveBeenCalledTimes(1);

      mockUsePreview.mockReturnValue({
        html: String.raw`<div class="stemblock"><div class="content">\$b\$</div></div>`,
        state: 'up-to-date',
        error: null,
        previewRef: fakeReference,
        mathPresent: true,
      });
      rerender(<AsciiDocPreview content=":stem:\n\nstem:[b]" isEnabled={true} projectId="proj-1" scrollToLine={null} />);
      await flushAsync();
      expect(renderMathMock).toHaveBeenCalledTimes(2);
    });

    it('preserves client-typeset math across a re-render that does NOT change the html (on-click revert bug)', async () => {
      // The worker HTML carries the raw `\$x\$` delimiters; the client (renderMath) replaces them with
      // a typeset node in the live DOM. A later re-render with the SAME html (e.g. an editor click that
      // only updates an unrelated prop like scrollToLine) must NOT reset the output's innerHTML — else
      // React's `dangerouslySetInnerHTML` wipes the typeset math and, because [html, mathPresent] are
      // unchanged, the typeset effect never re-runs, leaving the raw `\$x\$` on screen.
      const stableHtml = String.raw`<div class="paragraph"><p>\$x\$</p></div>`;
      mockUsePreview.mockReturnValue({
        html: stableHtml, state: 'up-to-date', error: null, previewRef: fakeReference, mathPresent: true,
      });
      const { rerender } = render(
        <AsciiDocPreview content=":stem:" isEnabled={true} projectId="proj-1" scrollToLine={null} />,
      );
      await flushAsync();

      // Simulate renderMath: swap the delimiter text for a typeset node in the live output container.
      const output = screen.getByTestId('asciidoc-output');
      const typeset = document.createElement('math');
      typeset.dataset['stemSource'] = String.raw`\$x\$`;
      output.replaceChildren(typeset);
      expect(output.querySelector('math')).not.toBeNull();

      // Re-render with unchanged html but a changed unrelated prop. The typeset node must survive.
      rerender(<AsciiDocPreview content=":stem:" isEnabled={true} projectId="proj-1" scrollToLine={{ line: 3 }} />);
      await flushAsync();

      expect(output.querySelector('math')).not.toBeNull();
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
