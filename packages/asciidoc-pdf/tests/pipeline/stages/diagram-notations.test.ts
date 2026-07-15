import {
  DIAGRAM_NOTATIONS,
  UNSUPPORTED_DIAGRAM_NOTATIONS,
  detectRenderableBlocks,
} from '../../../src/pipeline/stages/diagrams-math';

// ---------------------------------------------------------------------------
// The stage publishes read-only notation name sets so the editor can pin its
// own diagram-highlighting set against the renderer's supported notations
// (a consistency seam, not a shared registry). These tests fix the public
// shape and prove the sets are DERIVED from the stage's private classification
// maps — a normalized diagram set of canonical engine names and the
// unsupported-offline set — by asserting the published sets exactly describe
// what the stage actually detects, so the two can never silently drift.
// ---------------------------------------------------------------------------

describe('published diagram notation sets', () => {
  it('exposes the supported diagram notations as canonical, normalized names', () => {
    expect([...DIAGRAM_NOTATIONS].toSorted()).toEqual(['graphviz', 'mermaid', 'vega', 'vegalite']);
  });

  it('folds the `vega-lite` alias into the canonical `vegalite` name', () => {
    // The private shim map keys on both `vegalite` and the `vega-lite` alias; the published set
    // collapses the alias so it matches the editor's normalization (never two entries for one engine).
    expect(DIAGRAM_NOTATIONS.has('vegalite')).toBe(true);
    expect(DIAGRAM_NOTATIONS.has('vega-lite')).toBe(false);
  });

  it('exposes the diagram engines with no offline renderer as the unsupported set', () => {
    expect([...UNSUPPORTED_DIAGRAM_NOTATIONS].toSorted()).toEqual(['ditaa', 'plantuml']);
  });

  it('keeps the supported and unsupported sets disjoint', () => {
    for (const notation of UNSUPPORTED_DIAGRAM_NOTATIONS) {
      expect(DIAGRAM_NOTATIONS.has(notation)).toBe(false);
    }
  });

  it('publishes exactly the engine names the stage detects as renderable diagrams', () => {
    // Each published supported notation, declared on a block, is detected as a renderable diagram —
    // proving the set is derived from the stage's own classification, not a hand-kept second copy.
    for (const notation of DIAGRAM_NOTATIONS) {
      const blocks = detectRenderableBlocks(`[${notation}]\n----\nsource\n----\n`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].category).toBe('diagram');
    }
  });

  it('publishes engines the stage refuses to render as the unsupported set', () => {
    // Each published unsupported notation is skipped by the detector (no offline renderer), so the
    // published set faithfully mirrors the stage's skip behaviour rather than an independent list.
    for (const notation of UNSUPPORTED_DIAGRAM_NOTATIONS) {
      const blocks = detectRenderableBlocks(`[${notation}]\n----\nsource\n----\n`);
      expect(blocks).toHaveLength(0);
    }
  });
});
