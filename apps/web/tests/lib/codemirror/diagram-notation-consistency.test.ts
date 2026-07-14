import {
  DIAGRAM_NOTATIONS as RENDERER_DIAGRAM_NOTATIONS,
  UNSUPPORTED_DIAGRAM_NOTATIONS as RENDERER_UNSUPPORTED_DIAGRAM_NOTATIONS,
} from '@asciidocollab/asciidoc-pdf';
import {
  DIAGRAM_NOTATIONS as EDITOR_DIAGRAM_NOTATIONS,
  normalizeDiagramNotation,
} from '@/lib/codemirror/diagram-notations';

// ---------------------------------------------------------------------------
// The editor highlights a diagram declaration (`[mermaid]`, `[vega]`, …) only
// for notations the PDF renderer can actually render offline. That is a
// consistency requirement across two independently-owned modules: the editor's
// diagram-name set and the renderer's PUBLISHED notation sets. This test pins
// the seam — importing ONLY the renderer's public package entry, never a deep
// internal path — so a drift on either side fails here instead of shipping an
// editor that colours a block the exporter will silently skip.
// ---------------------------------------------------------------------------

describe('editor / renderer diagram notation consistency', () => {
  it('the editor recognises exactly the notations the renderer publishes as supported', () => {
    // Normalise both sides through the editor's shared normalization before comparing, so a raw
    // `vega-lite` alias on either side can never register as a spurious mismatch.
    const editorCanonical = new Set(
      EDITOR_DIAGRAM_NOTATIONS.map((name) => normalizeDiagramNotation(name)),
    );
    const rendererCanonical = new Set(
      [...RENDERER_DIAGRAM_NOTATIONS].map((name) => normalizeDiagramNotation(name)),
    );

    // No published renderer notation is unrecognised by the editor's normalization.
    expect(rendererCanonical.has(null)).toBe(false);
    expect(editorCanonical).toEqual(rendererCanonical);
  });

  it('the editor treats every renderer-unsupported engine as a non-diagram notation', () => {
    // plantuml / ditaa have no offline renderer: the editor must NOT recognise them as diagram
    // notations, and they must never overlap the editor's highlighted set.
    for (const notation of RENDERER_UNSUPPORTED_DIAGRAM_NOTATIONS) {
      expect(normalizeDiagramNotation(notation)).toBeNull();
      expect((EDITOR_DIAGRAM_NOTATIONS as readonly string[]).includes(notation)).toBe(false);
    }
  });

  it('the supported and unsupported renderer sets never overlap', () => {
    for (const notation of RENDERER_UNSUPPORTED_DIAGRAM_NOTATIONS) {
      expect(RENDERER_DIAGRAM_NOTATIONS.has(notation)).toBe(false);
    }
  });
});
