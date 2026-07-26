/* @jest-environment jsdom */

/**
 * A zip export writes each rendered diagram as its own `.svg` and references it, the way it already
 * writes the document's images and fonts. These pin the parts that are easy to get subtly wrong: the
 * file has to be openable on its own (namespace, real dimensions), the `<img>` has to reserve the right
 * box, and the pass must leave alone anything that is not a rendered diagram.
 */
import { extractDiagramSvgs } from '@/lib/html-export/diagram-assets';
import { collectImageSources, EXPORT_ASSET_ATTRIBUTE } from '@/lib/html-export/inline-assets';

/** The markup `renderDiagrams` leaves behind: preserved source beside the rendered output. */
function rendered(engine: string, svg: string): string {
  return (
    `<div class="adc-diagram" data-diagram-engine="${engine}" data-source-line="4">` +
    `<div class="adc-diagram-source" hidden>graph TD; a-->b;</div>` +
    `<div class="adc-diagram-output">${svg}</div>` +
    `</div>`
  );
}

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.replaceChildren(container);
  return container;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('extractDiagramSvgs', () => {
  test('replaces each diagram with a reference to a file it hands back', () => {
    const container = mount(
      rendered('mermaid', '<svg width="200" height="100"><rect/></svg>') +
        rendered('graphviz', '<svg width="40" height="20"><circle/></svg>'),
    );

    const assets = extractDiagramSvgs(container);

    expect(assets.map((asset) => asset.path)).toEqual([
      'diagrams/001-mermaid.svg',
      'diagrams/002-graphviz.svg',
    ]);
    expect(assets.every((asset) => asset.contentType === 'image/svg+xml')).toBe(true);
    // The vector markup is gone from the document and now lives in the files.
    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(text(assets[0].bytes)).toContain('<rect');
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('diagrams/001-mermaid.svg');
  });

  test('writes a file that stands on its own', () => {
    const assets = extractDiagramSvgs(mount(rendered('mermaid', '<svg width="200" height="100"><rect/></svg>')));

    const file = text(assets[0].bytes);
    // Without the namespace the file is not SVG to anything that opens it outside a HTML document.
    expect(file).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(file.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  test('recovers real dimensions from the viewBox when the width is a percentage', () => {
    // What mermaid emits: `width="100%"` with the proportions only in the viewBox. Left as-is, the
    // `<img>` has no intrinsic size and the browser invents a 300x150 box.
    const container = mount(
      rendered('mermaid', '<svg width="100%" viewBox="0 0 320 240"><rect/></svg>'),
    );

    const assets = extractDiagramSvgs(container);

    const image = container.querySelector('img');
    expect(image?.getAttribute('width')).toBe('320');
    expect(image?.getAttribute('height')).toBe('240');
    expect(text(assets[0].bytes)).toContain('width="320"');
  });

  test('still references a diagram whose size cannot be determined', () => {
    // No usable width and no viewBox: the reference must not be dropped, it just carries no dimensions.
    const container = mount(rendered('vega', '<svg><rect/></svg>'));

    expect(extractDiagramSvgs(container)).toHaveLength(1);
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('diagrams/001-vega.svg');
    expect(image?.hasAttribute('width')).toBe(false);
  });

  test('keeps the diagram scaled to its column, as it was inline', () => {
    const container = mount(rendered('mermaid', '<svg width="2000" height="100"><rect/></svg>'));
    extractDiagramSvgs(container);
    expect(container.querySelector('img')?.getAttribute('style')).toBe('max-width:100%;height:auto');
  });

  test('leaves a diagram that failed to render exactly as it was', () => {
    // A failed diagram shows its source instead of an `<svg>`; there is nothing to extract.
    const container = mount(
      '<div class="adc-diagram" data-diagram-engine="mermaid">graph TD; broken</div>',
    );
    const before = container.innerHTML;

    expect(extractDiagramSvgs(container)).toEqual([]);
    expect(container.innerHTML).toBe(before);
  });

  test('ignores an SVG that is not a rendered diagram', () => {
    // An author's own inline SVG, or a MathJax glyph — neither is ours to move into a file.
    const container = mount('<div class="paragraph"><svg id="mine"><rect/></svg></div>');

    expect(extractDiagramSvgs(container)).toEqual([]);
    expect(container.querySelector('#mine')).not.toBeNull();
  });

  test('preserves the diagram source the block was carrying', () => {
    // It is what makes re-rendering idempotent in the preview, and it is hidden either way.
    const container = mount(rendered('mermaid', '<svg width="10" height="10"><rect/></svg>'));
    extractDiagramSvgs(container);
    expect(container.querySelector('.adc-diagram-source')?.textContent).toBe('graph TD; a-->b;');
  });

  test('marks its images so the image pass does not try to fetch them from the server', () => {
    // The regression this prevents: `diagrams/001-mermaid.svg` requested from the project's asset
    // endpoint, failing, and being reported to the author as a missing image they never referenced.
    const container = mount(rendered('mermaid', '<svg width="10" height="10"><rect/></svg>'));
    extractDiagramSvgs(container);

    expect(container.querySelector('img')?.getAttribute(EXPORT_ASSET_ATTRIBUTE)).toBe('diagram');
    expect(collectImageSources(container.innerHTML)).toEqual([]);
  });
});
