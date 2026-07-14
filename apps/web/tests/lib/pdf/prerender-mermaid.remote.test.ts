import { createMermaidPrerenderer, type IdleScheduler } from '@/lib/pdf/prerender-mermaid';
import type { MermaidRenderer } from '@/workers/shims/mermaid';

/** A deterministic, DOM-free stand-in for the real mermaid engine. */
const fakeRenderer: MermaidRenderer = async (_config, source) => `<svg data-source="${source}"></svg>`;

/** Run the scheduled callback immediately (a synchronous idle). */
const runNow: IdleScheduler = (callback) => callback();

/** A mermaid diagram whose node embeds a remote image the real engine would try to fetch. */
const REMOTE_MERMAID_DOCUMENT = [
  '= Title',
  '',
  '[mermaid]',
  '----',
  'flowchart TD',
  "  A[\"<img src='https://cdn.example.com/logo.png'>\"] --> B",
  '----',
  '',
].join('\n');

/** A plain mermaid diagram plus a remote one, to prove the clean block still renders (fail-soft). */
const MIXED_REMOTE_DOCUMENT = [
  '= Title',
  '',
  '[mermaid]',
  '----',
  'graph TD; A-->B',
  '----',
  '',
  '[mermaid]',
  '----',
  'flowchart TD',
  "  C[\"<img src='https://cdn.example.com/logo.png'>\"] --> D",
  '----',
  '',
].join('\n');

describe('createMermaidPrerenderer remote-resource skipping', () => {
  it('skips a mermaid block referencing a remote resource — a warning, no render, no fetch', async () => {
    const renderer = jest.fn(fakeRenderer);
    const fetchMock = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const prerenderer = createMermaidPrerenderer({ mermaidRenderer: renderer, scheduleIdle: runNow });

      const result = await prerenderer.prerender(REMOTE_MERMAID_DOCUMENT);

      expect(result.aborted).toBe(false);
      expect(result.assets).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      const diagnostic = result.diagnostics[0];
      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.code).toBe('remote-skipped');
      expect(diagnostic.line).toBe(3);
      expect(diagnostic.message).toMatch(/remote/i);
      // Zero source egress: the DOM-bound engine and the network were never reached.
      expect(renderer).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders a clean mermaid block while skipping a sibling remote one (fail-soft)', async () => {
    const renderer = jest.fn(fakeRenderer);
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: renderer, scheduleIdle: runNow });

    const result = await prerenderer.prerender(MIXED_REMOTE_DOCUMENT);

    expect(result.aborted).toBe(false);
    // Only the clean block rendered; the remote one was skipped.
    expect(result.assets).toHaveLength(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    const remote = result.diagnostics.filter((d) => d.code === 'remote-skipped');
    expect(remote).toHaveLength(1);
  });
});
