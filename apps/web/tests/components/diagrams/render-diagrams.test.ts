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
//   - re-running is idempotent (one <svg>, never nested),
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

  it('is idempotent — a second pass yields one <svg>, not nested output', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));

    await renderDiagrams(container, { renderMermaid });
    await renderDiagrams(container, { renderMermaid });

    const placeholder = container.querySelector('.adc-diagram')!;
    expect(placeholder.querySelectorAll('svg')).toHaveLength(1);
    expect(placeholder.querySelectorAll('.adc-diagram-source')).toHaveLength(1);
    // The source drove the re-derive, so the engine ran once per pass over the same source.
    expect(renderMermaid).toHaveBeenNthCalledWith(2, 'graph TD; A-->B');
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

  it('routes the injected sanitizeSvg seam (a separate call from the shared preview sanitizer)', async () => {
    const container = makePlaceholder('mermaid', 'graph TD; A-->B');
    const renderMermaid = jest.fn().mockResolvedValue(okSvg('mermaid'));
    const sanitizeSvg = jest.fn().mockReturnValue('<svg xmlns="http://www.w3.org/2000/svg"><g>clean</g></svg>');

    await renderDiagrams(container, { renderMermaid, sanitizeSvg });

    expect(sanitizeSvg).toHaveBeenCalledWith(okSvg('mermaid'));
  });
});
