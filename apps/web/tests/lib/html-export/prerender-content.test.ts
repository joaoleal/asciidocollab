/* @jest-environment jsdom */

/**
 * The worker leaves diagrams as placeholders and maths as delimited text, both finished in the
 * browser. These pin that the export finishes them the same way the preview does, that it does so
 * under conditions where measurement actually works, and that one failing block never costs the
 * whole export.
 */
import { prerenderContent, type PrerenderDeps } from '@/lib/html-export/prerender-content';
import { EXPORT_CONTENT_CLASS } from '@/lib/html-export/build-standalone-html';

/** Records the container each renderer was handed, so the test can inspect its live state. */
function capturingDeps(overrides: Partial<PrerenderDeps> = {}) {
  const seen: { container?: HTMLElement; attached?: boolean; display?: string; style?: string } = {};
  const deps: PrerenderDeps = {
    renderDiagrams: async (container) => {
      seen.container = container;
      seen.attached = container.isConnected;
      seen.display = container.style.display;
      seen.style = container.dataset.previewStyle;
    },
    renderMath: async () => {},
    readMathStyles: () => '',
    ...overrides,
  };
  return { deps, seen };
}

describe('prerenderContent', () => {
  test('hands the rendered body to both renderers and returns the result', async () => {
    const deps: PrerenderDeps = {
      renderDiagrams: async (container) => {
        container.querySelector('.diagram')?.replaceChildren(document.createTextNode('SVG'));
      },
      renderMath: async (container) => {
        container.querySelector('.math')?.replaceChildren(document.createTextNode('TYPESET'));
      },
      readMathStyles: () => 'mjx-container { display: inline; }',
    };
    const result = await prerenderContent(
      String.raw`<div class="diagram">placeholder</div><div class="math">\(x\)</div>`,
      'asciidocollab',
      deps,
    );
    expect(result.html).toContain('SVG');
    expect(result.html).toContain('TYPESET');
    expect(result.extraCss).toBe('mjx-container { display: inline; }');
  });

  test('renders inside a container that is attached and laid out', async () => {
    // mermaid measures text and MathJax resolves font metrics; neither works in a fragment that has
    // never been laid out, so a detached or display:none container silently yields broken output.
    const { deps, seen } = capturingDeps();
    await prerenderContent('<p>x</p>', 'asciidocollab', deps);
    expect(seen.attached).toBe(true);
    expect(seen.display).not.toBe('none');
  });

  test('applies the export style so measurement happens under the CSS that will ship', async () => {
    const { deps, seen } = capturingDeps();
    await prerenderContent('<p>x</p>', 'asciidoctor', deps);
    expect(seen.style).toBe('asciidoctor');
    expect(seen.container?.className).toBe(EXPORT_CONTENT_CLASS);
  });

  test('leaves no scratch container behind in the page', async () => {
    const before = document.body.children.length;
    await prerenderContent('<p>x</p>', 'asciidocollab', capturingDeps().deps);
    expect(document.body.children).toHaveLength(before);
  });

  test('a failing diagram engine costs its own block, not the export', async () => {
    const result = await prerenderContent('<p>kept</p>', 'asciidocollab', {
      renderDiagrams: async () => {
        throw new Error('mermaid exploded');
      },
      renderMath: async () => {},
      readMathStyles: () => '',
    });
    expect(result.html).toContain('kept');
  });

  test('maths that will not typeset still leaves its source behind', async () => {
    const result = await prerenderContent(String.raw`<p>\(x^2\)</p>`, 'asciidocollab', {
      renderDiagrams: async () => {},
      renderMath: async () => {
        throw new Error('MathJax unavailable');
      },
      readMathStyles: () => '',
    });
    expect(result.html).toContain('x^2');
  });

  test('skips the engines the document has no use for', async () => {
    // Both are heavy, lazily-loaded imports. A document with no diagrams and no maths must not pay
    // for either — the render worker already knows which are present, so it is not a guess.
    const calls: string[] = [];
    await prerenderContent('<p>plain</p>', 'asciidocollab', {
      diagrams: false,
      math: false,
      renderDiagrams: async () => {
        calls.push('diagrams');
      },
      renderMath: async () => {
        calls.push('math');
      },
      readMathStyles: () => '',
    });
    expect(calls).toEqual([]);
  });

  test('runs only the engine the document does need', async () => {
    const calls: string[] = [];
    await prerenderContent('<p>x</p>', 'asciidocollab', {
      diagrams: false,
      math: true,
      renderDiagrams: async () => {
        calls.push('diagrams');
      },
      renderMath: async () => {
        calls.push('math');
      },
      readMathStyles: () => '',
    });
    expect(calls).toEqual(['math']);
  });

  test('carries no stylesheet when the document needed no typesetting', async () => {
    const result = await prerenderContent('<p>plain</p>', 'asciidocollab', capturingDeps().deps);
    expect(result.extraCss).toBe('');
  });
  // Where a rendered diagram ends up is the packaging's decision, taken here, so both export shapes go
  // through this one pass instead of a zip getting a post-processing step of its own.
  describe('diagram packaging', () => {
    /** Deps whose diagram renderer produces what a real engine produces: an inline `<svg>`. */
    const renderingDeps: PrerenderDeps = {
      renderDiagrams: async (container) => {
        const output = container.querySelector('.adc-diagram-output');
        if (output) output.innerHTML = '<svg width="120" height="60"><rect/></svg>';
      },
      renderMath: async () => {},
      readMathStyles: () => '',
    };

    const BODY =
      '<div class="adc-diagram" data-diagram-engine="mermaid">' +
      '<div class="adc-diagram-output"></div></div>';

    test('keeps diagrams inline by default, carrying no files', async () => {
      const result = await prerenderContent(BODY, 'asciidocollab', renderingDeps);
      expect(result.html).toContain('<svg');
      expect(result.assets).toEqual([]);
    });

    test('writes diagrams out as files when asked to extract them', async () => {
      const result = await prerenderContent(BODY, 'asciidocollab', {
        ...renderingDeps,
        diagramPackaging: 'extract',
      });
      expect(result.html).not.toContain('<svg');
      expect(result.html).toContain('src="diagrams/001-mermaid.svg"');
      expect(result.assets.map((asset) => asset.path)).toEqual(['diagrams/001-mermaid.svg']);
    });
  });
});
