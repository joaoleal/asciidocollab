/* @jest-environment jsdom */

// Tests for render-diagrams.ts.
//
// The render worker emits an inert diagram placeholder per native diagram block:
//   <div class="adc-diagram" data-diagram-engine="mermaid|graphviz|vega|vegalite"
//        data-source-line="N">…escaped source text…</div>
// render-diagrams locates those placeholders and renders each engine's native on-screen SVG output,
// entirely client-side. The real engines (mermaid, vega, @hpcc-js/wasm graphviz) are DOM/WASM-bound
// and non-deterministic under jsdom, so they sit behind injectable seams (`deps`); these tests drive
// fakes and assert the contract:
//   - the placeholder ends up holding a SANITIZED <svg>, with the inert source PRESERVED for re-render,
//   - a spec that references a REMOTE data url is SKIPPED WITH A WARNING and never fetched (zero egress),
//   - re-running is INCREMENTAL: an already-drawn placeholder keeps the very node it had and the
//     engine is not run over it again (one <svg>, never nested),
//   - a malformed/failing diagram fails soft (a warning, no throw) while its neighbours still render,
//   - the SVG sanitize is a SEPARATE svg-profile call that strips a crafted <script>.

import { renderDiagrams } from '@/components/diagrams/render-diagrams';

/** Build a worker-style inert placeholder (source as escaped text content, like the real worker). */
function makePlaceholder(engine: string, source: string, line = 1): HTMLElement {
  const container = document.createElement('div');
  const placeholder = document.createElement('div');
  placeholder.className = 'adc-diagram';
  placeholder.dataset.diagramEngine = engine;
  placeholder.dataset.sourceLine = String(line);
  placeholder.textContent = source; // textContent auto-escapes, mirroring the sanitized worker HTML
  container.append(placeholder);
  return container;
}

const okSvg = (label: string): string => `<svg xmlns="http://www.w3.org/2000/svg"><g>${label}</g></svg>`;

describe('renderDiagrams', () => {
  it('renders a mermaid placeholder to sanitized SVG and preserves the inert source', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));

    const result = await renderDiagrams(container, { renderMermaid });

    expect(renderMermaid).toHaveBeenCalledWith('graph TD; A-->B');
    expect(result.rendered).toBe(1);
    expect(result.warnings).toHaveLength(0);

    const placeholder = container.querySelector('.adc-diagram')!;
    expect(placeholder.querySelector('svg')).not.toBeNull();
    // The inert source survives so a later pass re-derives rather than nesting.
    expect(placeholder.querySelector('.adc-diagram-source')?.textContent).toBe('graph TD; A-->B');
  });

  it('renders a graphviz placeholder to SVG', async () => {
    const container = makePlaceholder('graphviz', 'digraph { a -> b }');
    const renderGraphviz = jest.fn().mockResolvedValue(okSvg('graphviz'));

    const result = await renderDiagrams(container, { renderGraphviz });

    expect(renderGraphviz).toHaveBeenCalledWith('digraph { a -> b }');
    expect(result.rendered).toBe(1);
    expect(container.querySelector('.adc-diagram svg')).not.toBeNull();
  });

  it('skips a vega spec with a remote data url — warns, never renders, never fetches', async () => {
    const spec = JSON.stringify({ data: { url: 'https://example.com/data.json' }, mark: 'bar' });
    const container = makePlaceholder('vega', spec, 7);
    const renderVega = jest.fn().mockResolvedValue(okSvg('vega'));
    // Install a fetch spy (jsdom has none) so we can prove NO network request is ever attempted.
    const fetchSpy = jest.fn();
    const priorFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const result = await renderDiagrams(container, { renderVega });

    expect(renderVega).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.rendered).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ engine: 'vega', code: 'remote-resource-blocked', sourceLine: 7 });
    // The placeholder is left showing its inert source (no SVG injected).
    expect(container.querySelector('.adc-diagram svg')).toBeNull();

    (globalThis as { fetch?: unknown }).fetch = priorFetch;
  });

  it('leaves an already-drawn diagram alone — the same node, and no second engine run', async () => {
    // The preview refreshes on a keystroke, and the pass that draws diagrams runs after every one of
    // them. Re-deriving each drawing from its source would be correct output at an absurd price: the
    // engine re-run for every diagram in the document on every refresh, and the node the reader is
    // looking at swapped for an identical one each time. A drawing and the source it came from can
    // never drift apart here — the only thing that puts a placeholder back to bare source is the
    // preview's DOM patch, and it does that exactly when the source changed — so a placeholder that
    // still has its drawing is one with nothing left to do.
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));

    await renderDiagrams(container, { renderMermaid });
    const drawn = container.querySelector('.adc-diagram svg');
    const second = await renderDiagrams(container, { renderMermaid });

    const placeholder = container.querySelector('.adc-diagram')!;
    expect(placeholder.querySelectorAll('svg')).toHaveLength(1);
    expect(placeholder.querySelectorAll('.adc-diagram-source')).toHaveLength(1);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ rendered: 0, preserved: 1 });
    // Identity, not equality: an identical replacement would still have been a redraw.
    expect(container.querySelector('.adc-diagram svg')).toBe(drawn);
  });

  it('draws a diagram again once the DOM patch has put it back to bare source', async () => {
    // The counterpart to the check above, and what stops it being a way to freeze the first drawing on
    // screen forever: a changed diagram reaches this pass as a placeholder holding only text again.
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));

    await renderDiagrams(container, { renderMermaid });
    const placeholder = container.querySelector<HTMLElement>('.adc-diagram')!;
    placeholder.textContent = 'graph TD; A-->C'; // what patching an edited diagram leaves behind
    const second = await renderDiagrams(container, { renderMermaid });

    expect(renderMermaid).toHaveBeenNthCalledWith(2, 'graph TD; A-->C');
    expect(second).toMatchObject({ rendered: 1, preserved: 0 });
    expect(placeholder.querySelectorAll('svg')).toHaveLength(1);
  });

  it('fails soft on a malformed diagram — warns, does not throw, neighbours still render', async () => {
    const container = document.createElement('div');
    container.append(makePlaceholder('mermaid', 'boom', 2).firstElementChild!);
    container.append(makePlaceholder('graphviz', 'digraph { a }', 3).firstElementChild!);

    const renderMermaid = jest.fn().mockRejectedValue(new Error('parse error'));
    const renderGraphviz = jest.fn().mockResolvedValue(okSvg('graphviz'));

    const result = await renderDiagrams(container, { renderMermaid, renderGraphviz });

    expect(result.rendered).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ engine: 'mermaid', code: 'render-failed', sourceLine: 2 });
    const placeholders = container.querySelectorAll('.adc-diagram');
    expect(placeholders[0].querySelector('svg')).toBeNull(); // failed one
    expect(placeholders[1].querySelector('svg')).not.toBeNull(); // neighbour rendered
  });

  it('warns on an unsupported engine and renders nothing for it', async () => {
    const container = makePlaceholder('plantuml', '@startuml\n@enduml');

    const result = await renderDiagrams(container, {});

    expect(result.rendered).toBe(0);
    expect(result.warnings[0]).toMatchObject({ engine: 'plantuml', code: 'unsupported-engine' });
  });

  it('sanitizes the rendered SVG through a separate svg-profile pass that strips <script>', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    // A crafted engine output smuggling a script inside the SVG — the svg-profile sanitize must strip it.
    const renderMermaid = jest
      .fn()
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g/></svg>');

    // Default sanitizeSvg seam (real DOMPurify svg profile) is used — no injected sanitizer.
    await renderDiagrams(container, { renderMermaid });

    const placeholder = container.querySelector('.adc-diagram')!;
    expect(placeholder.querySelector('svg')).not.toBeNull();
    expect(placeholder.querySelector('script')).toBeNull();
    expect(placeholder.innerHTML).not.toContain('alert(1)');
  });

  it('records on the placeholder that it holds no drawing, and why', async () => {
    // A placeholder that failed still carries exactly the source it was asked to draw, so nothing in
    // the DOM would otherwise separate "could not be drawn" from "drawn and still current". A refresh
    // that leaves unchanged diagrams alone needs that stated explicitly, or a diagram that failed once
    // stays on screen untouched forever and is never offered to the renderer again.
    const container = document.createElement('div');
    container.append(makePlaceholder('mermaid', 'boom', 2).firstElementChild!);
    container.append(makePlaceholder('plantuml', '@startuml\n@enduml', 4).firstElementChild!);

    await renderDiagrams(container, { renderMermaid: jest.fn().mockRejectedValue(new Error('parse error')) });

    const placeholders = container.querySelectorAll<HTMLElement>('.adc-diagram');
    expect(placeholders[0].dataset.diagramFailed).toBe('render-failed');
    expect(placeholders[1].dataset.diagramFailed).toBe('unsupported-engine');
  });

  it('clears the failure record once a later pass draws the diagram', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const failing = jest.fn().mockRejectedValue(new Error('transient engine failure'));
    const succeeding = jest.fn().mockResolvedValue(okSvg('mermaid'));

    await renderDiagrams(container, { renderMermaid: failing });
    const afterFailure = container.querySelector<HTMLElement>('.adc-diagram')!.dataset.diagramFailed;
    await renderDiagrams(container, { renderMermaid: succeeding });

    expect(afterFailure).toBe('render-failed');
    const placeholder = container.querySelector<HTMLElement>('.adc-diagram')!;
    expect(placeholder.dataset.diagramFailed).toBeUndefined();
    expect(placeholder.querySelector('svg')).not.toBeNull();
  });

  it('routes the injected sanitizeSvg seam (a separate call from the shared preview sanitizer)', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));
    const sanitizeSvg = jest.fn().mockReturnValue('<svg xmlns="http://www.w3.org/2000/svg"><g>clean</g></svg>');

    await renderDiagrams(container, { renderMermaid, sanitizeSvg });

    expect(sanitizeSvg).toHaveBeenCalledWith(okSvg('mermaid'));
  });

  it('renders a vega spec whose data is an inline data: uri — no network reference to block', async () => {
    const spec = JSON.stringify({ data: { url: 'data:text/csv;base64,YQ==' }, marks: [] });
    const container = makePlaceholder('vega', spec);
    const renderVega = jest.fn().mockResolvedValue(okSvg('vega'));

    const result = await renderDiagrams(container, { renderVega });

    expect(result.rendered).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(renderVega).toHaveBeenCalledTimes(1);
  });

  it('blocks a protocol-relative data reference the same as a fully qualified one', async () => {
    const spec = JSON.stringify({ data: { url: '//cdn.example.com/rows.json' }, marks: [] });
    const container = makePlaceholder('vegalite', spec);
    const renderVega = jest.fn();

    const result = await renderDiagrams(container, { renderVega });

    expect(renderVega).not.toHaveBeenCalled();
    expect(result.warnings[0].code).toBe('remote-resource-blocked');
    expect(result.warnings[0].message).toContain('//cdn.example.com/rows.json');
  });

  it('finds a remote reference nested inside an array of layers', async () => {
    const spec = JSON.stringify({
      layer: [{ mark: 'point' }, { data: { url: 'https://example.com/rows.json' } }],
    });
    const container = makePlaceholder('vegalite', spec);
    const renderVega = jest.fn();

    const result = await renderDiagrams(container, { renderVega });

    expect(renderVega).not.toHaveBeenCalled();
    expect(result.warnings[0].message).toContain('https://example.com/rows.json');
  });

  it('leaves a vega spec that is not valid JSON for the engine to reject', async () => {
    const container = makePlaceholder('vega', '{ this is not json');
    const renderVega = jest.fn().mockRejectedValue(new Error('spec is not JSON'));

    const result = await renderDiagrams(container, { renderVega });

    expect(renderVega).toHaveBeenCalledTimes(1);
    expect(result.warnings[0].code).toBe('render-failed');
    expect(result.warnings[0].message).toBe('spec is not JSON');
  });

  it('reports a null source line for a placeholder that carries none', async () => {
    const container = document.createElement('div');
    const placeholder = document.createElement('div');
    placeholder.className = 'adc-diagram';
    placeholder.dataset.diagramEngine = 'mermaid';
    placeholder.textContent = 'graph TD; A-->B';
    container.append(placeholder);

    const result = await renderDiagrams(container, {
      renderMermaid: jest.fn().mockRejectedValue(new Error('nope')),
    });

    expect(result.warnings[0].sourceLine).toBeNull();
  });

  it('reports a null source line for a placeholder whose line is not a number', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const placeholder = container.querySelector('.adc-diagram');
    placeholder?.setAttribute('data-source-line', 'not-a-line');

    const result = await renderDiagrams(container, {
      renderMermaid: jest.fn().mockRejectedValue(new Error('nope')),
    });

    expect(result.warnings[0].sourceLine).toBeNull();
  });

  it('treats a placeholder with no engine attribute as an unsupported engine', async () => {
    const container = document.createElement('div');
    const placeholder = document.createElement('div');
    placeholder.className = 'adc-diagram';
    placeholder.textContent = 'graph TD; A-->B';
    container.append(placeholder);

    const result = await renderDiagrams(container, {});

    expect(result.warnings).toEqual([
      { engine: '', sourceLine: null, code: 'unsupported-engine', message: 'unsupported diagram engine: ' },
    ]);
  });

  it('reports a non-Error render rejection by its string form', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');

    const result = await renderDiagrams(container, {
      renderMermaid: jest.fn().mockRejectedValue('the engine gave up'),
    });

    expect(result.warnings[0].message).toBe('the engine gave up');
  });

  it('redraws a previously failed placeholder from its preserved source, not its visible text', async () => {
    const container = document.createElement('div');
    const placeholder = document.createElement('div');
    placeholder.className = 'adc-diagram';
    placeholder.dataset.diagramEngine = 'mermaid';
    placeholder.dataset.sourceLine = '7';
    placeholder.dataset.diagramFailed = 'render-failed';
    const preserved = document.createElement('div');
    preserved.className = 'adc-diagram-source';
    preserved.hidden = true;
    preserved.textContent = 'graph TD; A-->B';
    placeholder.append(preserved);
    container.append(placeholder);
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));

    const result = await renderDiagrams(container, { renderMermaid });

    expect(renderMermaid).toHaveBeenCalledWith('graph TD; A-->B');
    expect(result.rendered).toBe(1);
    expect(placeholder.dataset.diagramFailed).toBeUndefined();
  });
});

/** Install a `@hpcc-js/wasm` whose Graphviz engine returns `svg`, or fails to load. */
function mockGraphvizWasm(svg: string | Error): void {
  jest.doMock('@hpcc-js/wasm', () => ({
    __esModule: true,
    Graphviz: {
      load: async () => {
        if (svg instanceof Error) throw svg;
        return { dot: () => svg };
      },
    },
  }));
}

describe('renderDiagrams — bundled engines', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('mermaid');
    jest.dontMock('vega');
    jest.dontMock('vega-lite');
    jest.dontMock('@hpcc-js/wasm');
  });

  it('drives the bundled mermaid engine and sanitizes its output with the svg profile', async () => {
    jest.doMock('mermaid', () => ({
      __esModule: true,
      default: {
        initialize: () => undefined,
        render: async () => ({
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g>drawn</g></svg>',
        }),
      },
    }));
    const { renderDiagrams: render } = await import('@/components/diagrams/render-diagrams');
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');

    const result = await render(container);

    expect(result.rendered).toBe(1);
    const placeholder = container.querySelector('.adc-diagram');
    expect(placeholder?.querySelector('script')).toBeNull();
    expect(placeholder?.querySelector('svg')).not.toBeNull();
  });

  it('drives the bundled vega engine through its offline shim', async () => {
    class FakeView {
      async toSVG(): Promise<string> {
        return '<svg xmlns="http://www.w3.org/2000/svg"><g>vega</g></svg>';
      }

      finalize(): void {
        // Nothing to release in the fake.
      }
    }
    jest.doMock('vega', () => ({ __esModule: true, parse: () => ({}), View: FakeView }));
    const { renderDiagrams: render } = await import('@/components/diagrams/render-diagrams');
    const container = makePlaceholder('vega', JSON.stringify({ marks: [] }));

    const result = await render(container);

    expect(result.rendered).toBe(1);
    expect(container.querySelector('.adc-diagram svg')).not.toBeNull();
  });

  it('drives the bundled graphviz engine through its shim', async () => {
    mockGraphvizWasm('<svg xmlns="http://www.w3.org/2000/svg"><g>dot</g></svg>');
    const { renderDiagrams: render } = await import('@/components/diagrams/render-diagrams');
    const container = makePlaceholder('graphviz', 'digraph { a -> b }');

    const result = await render(container);

    expect(result.rendered).toBe(1);
    expect(container.querySelector('.adc-diagram svg')).not.toBeNull();
  });

  it('turns a shim diagnostic into a fail-soft render warning', async () => {
    mockGraphvizWasm(new Error('wasm unavailable'));
    const { renderDiagrams: render } = await import('@/components/diagrams/render-diagrams');
    const container = makePlaceholder('graphviz', 'digraph { a -> b }');

    const result = await render(container);

    expect(result.rendered).toBe(0);
    expect(result.warnings).toEqual([
      { engine: 'graphviz', sourceLine: 1, code: 'render-failed', message: 'wasm unavailable' },
    ]);
  });
});
