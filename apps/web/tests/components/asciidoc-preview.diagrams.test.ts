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
import {
  commitToPreviewOutput,
  previewHookResult,
  type PreviewHookDouble,
} from '../helpers/preview-panel';
const mockUsePreview = useAsciidocPreview as jest.Mock;

/** Flush the microtasks the preview's dynamic `import().then(...)` schedules. */
const flushAsync = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** A worker-style inert placeholder, as it arrives in a committed render. */
const diagramHtml = (label = 'graph TD; A--&gt;B') =>
  `<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="2">${label}</div>`;

const panel = (properties: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {}) =>
  React.createElement(AsciiDocPreview, {
    content: '[mermaid]\n----\ngraph TD; A-->B\n----',
    isEnabled: true,
    projectId: 'proj-1',
    scrollToLine: null,
    ...properties,
  });

const mount = (properties: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {}) =>
  render(panel(properties));

/**
 * Mount the panel with a document already on screen, in the order the hook puts it there: the markup
 * is committed into the element the panel hands over, and only then is the commit announced — which is
 * what the diagram pass runs off, and it must find the placeholders already in place.
 *
 * @param markup - The rendered document to display.
 * @param result - Anything else about the hook's state this test is asserting on.
 * @param properties - Panel props this test needs.
 * @returns The render harness, plus a re-render that commits nothing new.
 */
function mountShowing(
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
    /** Re-render with unrelated props changed and nothing newly committed. */
    rerenderUncommitted: (next: Partial<React.ComponentProps<typeof AsciiDocPreview>> = {}) =>
      harness.rerender(panel({ ...properties, ...next })),
  };
}

beforeEach(() => {
  mockUsePreview.mockReset();
  renderDiagramsMock.mockClear();
  renderDiagramsMock.mockImplementation(() => Promise.resolve({ rendered: 0, warnings: [] }));
});

describe('AsciiDocPreview diagram rendering', () => {
  it('lazy-loads the diagram renderer only when diagramsPresent and runs on the scoped output', async () => {
    mountShowing(diagramHtml(), { diagramsPresent: true });
    await flushAsync();

    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);
    // Driven over the element the render was committed into, and nowhere else: the placeholders it
    // hydrates are inside it, and so is everything the client is allowed to touch.
    const container = renderDiagramsMock.mock.calls[0][0];
    expect(container).toBe(screen.getByTestId('asciidoc-output'));
    expect(container.classList.contains('asciidoc-preview-content')).toBe(true);
    expect(container.querySelector('.adc-diagram')).not.toBeNull();
  });

  it('never loads the diagram renderer when diagramsPresent is false', async () => {
    mountShowing('<div class="paragraph"><p>no diagrams here</p></div>', { diagramsPresent: false });
    await flushAsync();

    expect(renderDiagramsMock).not.toHaveBeenCalled();
  });

  it('does not load the diagram renderer before anything has been committed', async () => {
    mockUsePreview.mockReturnValue(
      previewHookResult({ html: null, state: 'rendering', diagramsPresent: true, renderNonce: 0 }),
    );

    mount();
    await flushAsync();

    // Nothing is on screen to hydrate, and the engines are the heaviest bundles the preview can pull.
    expect(renderDiagramsMock).not.toHaveBeenCalled();
  });

  it('re-runs when a new render is committed while diagrams stay present', async () => {
    const { rerenderUncommitted } = mountShowing(diagramHtml('graph TD; A--&gt;B'), {
      diagramsPresent: true,
    });
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);

    const changed = diagramHtml('graph TD; B--&gt;C');
    commitToPreviewOutput(changed);
    mockUsePreview.mockReturnValue(
      previewHookResult({ html: changed, state: 'up-to-date', diagramsPresent: true, renderNonce: 2 }),
    );
    rerenderUncommitted({ content: '[mermaid]\n----\ngraph TD; B-->C\n----' });
    await flushAsync();

    expect(renderDiagramsMock).toHaveBeenCalledTimes(2);
  });

  it('re-runs on a commit whose markup happens to be unchanged', async () => {
    const unchanged = diagramHtml();
    const { rerenderUncommitted } = mountShowing(unchanged, { diagramsPresent: true });
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);

    // Reopening the same file commits the same markup into an element that no longer holds the
    // drawing. Keyed on the markup, this pass would read "nothing changed" and skip it, leaving an
    // undrawn placeholder on screen with nothing left to trigger a retry.
    commitToPreviewOutput(unchanged);
    mockUsePreview.mockReturnValue(
      previewHookResult({ html: unchanged, state: 'up-to-date', diagramsPresent: true, renderNonce: 2 }),
    );
    rerenderUncommitted();
    await flushAsync();

    expect(renderDiagramsMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-run on a re-render that commits nothing (stable output)', async () => {
    const { rerenderUncommitted } = mountShowing(diagramHtml(), { diagramsPresent: true });
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);

    // An unrelated prop changed and no render landed — redrawing every diagram on an editor click
    // would spend the engines' cost on a document that has not moved.
    rerenderUncommitted({ scrollToLine: { line: 3 } });
    await flushAsync();
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);
  });

  it('fails soft: a warning is surfaced in the diagnostics panel and the rest still renders', async () => {
    renderDiagramsMock.mockResolvedValue({
      rendered: 0,
      warnings: [{ engine: 'plantuml', sourceLine: 2, code: 'unsupported-engine', message: 'unsupported diagram engine: plantuml' }],
    });

    mountShowing(`<h1>Doc</h1>${diagramHtml()}`, { diagramsPresent: true });
    await flushAsync();

    // Preview still shows its content; the warning is surfaced in the diagnostics panel (what + where),
    // not thrown and not swallowed by a console log.
    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
    expect(screen.getByText('Doc')).toBeInTheDocument();
    expect(screen.getByText('Preview diagnostics')).toBeInTheDocument();
    expect(screen.getByText(/unsupported diagram engine: plantuml/)).toBeInTheDocument();
  });

  it('fails soft: a rejected renderer promise does not crash the preview', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderDiagramsMock.mockRejectedValue(new Error('engine blew up'));

    mountShowing(`<h1>Doc</h1>${diagramHtml()}`, { diagramsPresent: true });
    await flushAsync();

    expect(screen.getByTestId('asciidoc-output')).toBeInTheDocument();
    expect(screen.getByText('Doc')).toBeInTheDocument();
    warnSpy.mockRestore();
  });
});
