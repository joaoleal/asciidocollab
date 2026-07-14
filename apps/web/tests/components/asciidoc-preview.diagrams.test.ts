/* @jest-environment jsdom */

// Post-render diagram hydration in the preview, mirroring the STEM-math post-render effect.
//
// The render worker emits an inert `.adc-diagram` placeholder per native diagram block and never
// draws it; the preview lazy-imports `renderDiagrams` and drives each engine's native on-screen
// renderer AFTER the sanitized HTML is committed — but only when the worker flagged a diagram is
// present (`diagramsPresent`). These tests mock `renderDiagrams` (its real engines are DOM/WASM-bound
// and cannot run under jsdom) and assert the gating, scoping, idempotency-on-re-render, and fail-soft
// contract — the diagram counterpart of the STEM-math suite in asciidoc-preview.test.tsx.

import React from 'react';
import { render, screen, act } from '@testing-library/react';

jest.mock('@/hooks/use-asciidoc-preview', () => ({
  useAsciidocPreview: jest.fn(),
}));

// Mock the lazy-loaded client diagram renderer. Asserting it is imported (and with which node) lets us
// verify the engines load exactly when a diagram is present, post-sanitize, scoped to the output —
// without running mermaid/vega/graphviz (which cannot execute in jsdom).
const renderDiagramsMock = jest.fn<
  Promise<{ rendered: number; warnings: unknown[] }>,
  [HTMLElement]
>(() => Promise.resolve({ rendered: 0, warnings: [] }));
jest.mock('@/components/diagrams/render-diagrams', () => ({
  renderDiagrams: (element: HTMLElement) => renderDiagramsMock(element),
}));

import { AsciiDocPreview } from '@/components/asciidoc-preview';
import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
const mockUsePreview = useAsciidocPreview as jest.Mock;

/** Flush the microtasks the preview's dynamic `import().then(...)` schedules. */
const flushAsync = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const fakeReference: React.RefObject<HTMLDivElement> = { current: null };

/** A worker-style inert placeholder embedded in the rendered (sanitized) HTML. */
const diagramHtml = (label = 'graph TD; A--&gt;B') =>
  `<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="2">${label}</div>`;

const mount = (props: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {}) =>
  render(
    React.createElement(AsciiDocPreview, {
      content: '[mermaid]\n----\ngraph TD; A-->B\n----',
      isEnabled: true,
      projectId: 'proj-1',
      scrollToLine: null,
      ...props,
    }),
  );

beforeEach(() => {
  mockUsePreview.mockReset();
  renderDiagramsMock.mockClear();
  renderDiagramsMock.mockImplementation(() => Promise.resolve({ rendered: 0, warnings: [] }));
});

describe('AsciiDocPreview diagram rendering', () => {
  it('lazy-loads the diagram renderer only when diagramsPresent and runs post-sanitize, scoped', async () => {
    mockUsePreview.mockReturnValue({
      html: diagramHtml(),
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });

    mount();
    await flushAsync();

    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);
    // Called on the scoped, sanitized output container — the same node holding the rendered HTML.
    const container = renderDiagramsMock.mock.calls[0][0];
    expect(container).toBe(screen.getByTestId('asciidoc-output'));
    expect(container.classList.contains('asciidoc-preview-content')).toBe(true);
    expect(container.querySelector('.adc-diagram')).not.toBeNull();
  });

  it('never loads the diagram renderer when diagramsPresent is false', async () => {
    mockUsePreview.mockReturnValue({
      html: '<div class="paragraph"><p>no diagrams here</p></div>',
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: false,
    });

    mount();
    await flushAsync();

    expect(renderDiagramsMock).not.toHaveBeenCalled();
  });

  it('does not load the diagram renderer when there is no rendered html yet', async () => {
    mockUsePreview.mockReturnValue({
      html: null,
      state: 'rendering',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });

    mount();
    await flushAsync();

    expect(renderDiagramsMock).not.toHaveBeenCalled();
  });

  it('re-runs when the rendered html changes while diagrams stay present', async () => {
    mockUsePreview.mockReturnValue({
      html: diagramHtml('graph TD; A--&gt;B'),
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });
    const { rerender } = mount();
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);

    mockUsePreview.mockReturnValue({
      html: diagramHtml('graph TD; B--&gt;C'),
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });
    rerender(
      React.createElement(AsciiDocPreview, {
        content: '[mermaid]\n----\ngraph TD; B-->C\n----',
        isEnabled: true,
        projectId: 'proj-1',
        scrollToLine: null,
      }),
    );
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-run on a re-render that does not change the html (stable output)', async () => {
    mockUsePreview.mockReturnValue({
      html: diagramHtml(),
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });
    const { rerender } = mount();
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);

    // Re-render with unchanged html but a changed unrelated prop — the effect must not re-run.
    rerender(
      React.createElement(AsciiDocPreview, {
        content: '[mermaid]\n----\ngraph TD; A-->B\n----',
        isEnabled: true,
        projectId: 'proj-1',
        scrollToLine: { line: 3 },
      }),
    );
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);
  });

  it('fails soft: warnings from the renderer do not crash the preview and the rest still renders', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderDiagramsMock.mockResolvedValue({
      rendered: 0,
      warnings: [{ engine: 'plantuml', sourceLine: 2, code: 'unsupported-engine', message: 'unsupported diagram engine: plantuml' }],
    });
    mockUsePreview.mockReturnValue({
      html: `<h1>Doc</h1>${diagramHtml()}`,
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });

    mount();
    await flushAsync();

    // Preview still shows its content; the warning was surfaced (logged) rather than thrown.
    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
    expect(screen.getByText('Doc')).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails soft: a rejected renderer promise does not crash the preview', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderDiagramsMock.mockRejectedValue(new Error('engine blew up'));
    mockUsePreview.mockReturnValue({
      html: `<h1>Doc</h1>${diagramHtml()}`,
      state: 'up-to-date',
      error: null,
      previewRef: fakeReference,
      diagramsPresent: true,
    });

    mount();
    await flushAsync();

    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
    expect(screen.getByText('Doc')).toBeInTheDocument();
    warnSpy.mockRestore();
  });
});
