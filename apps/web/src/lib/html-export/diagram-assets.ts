/**
 * @file Lifts rendered diagrams out of the document and into files beside it.
 *
 * A rendered diagram arrives as an inline `<svg>` element — the same one the preview showed. That is
 * the right shape for a single-file export, where everything has to live in one document. It is the
 * wrong shape for a zip: a page-long tangle of vector markup sits in the middle of the prose, making
 * the HTML unreadable to anyone who opens it, and the same diagram used twice is stored twice.
 *
 * So a zip export writes each diagram as its own `.svg` and leaves an `<img>` pointing at it, exactly
 * as it already does for the document's images and fonts. This is not a second export path: it is the
 * same packaging decision those assets make, applied to one more kind of content.
 */

import type { ExportAsset } from './inline-assets';
import { assetPath, EXPORT_ASSET_ATTRIBUTE } from './inline-assets';

/** The wrapper the render worker emits for a native-diagram block. */
const DIAGRAM_SELECTOR = '.adc-diagram';

/** The child holding the rendered vector output (its sibling holds the preserved source). */
const OUTPUT_SELECTOR = '.adc-diagram-output';

/** SVG's namespace, which a standalone `.svg` file must declare to be rendered at all. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The MIME type an extracted diagram is written and served as. */
const SVG_TYPE = 'image/svg+xml';

/**
 * The pixel size an `<img>` should reserve for this SVG.
 *
 * An `<svg>` inline in a page can size itself against its container; the same markup loaded through
 * an `<img>` cannot. If its `width`/`height` are percentages, or missing, the image has no intrinsic
 * size and browsers fall back to a 300×150 box that has nothing to do with the diagram — mermaid in
 * particular emits `width="100%"` with the real proportions only in the `viewBox`. Reading the
 * viewBox recovers them.
 *
 * @param svg - The rendered diagram root.
 * @returns The width and height in pixels, or null when the markup declares neither usable.
 */
function intrinsicSize(svg: SVGElement): { width: number; height: number } | null {
  const declared = {
    width: absoluteLength(svg.getAttribute('width')),
    height: absoluteLength(svg.getAttribute('height')),
  };
  if (declared.width !== null && declared.height !== null) {
    return { width: declared.width, height: declared.height };
  }

  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/);
  if (viewBox.length !== 4) return null;
  const width = Number(viewBox[2]);
  const height = Number(viewBox[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Read a length that is a plain number of pixels, rejecting percentages and other units.
 *
 * @param value - The attribute value, or null when it is absent.
 * @returns The length in pixels, or null when it is not an absolute one.
 */
function absoluteLength(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.endsWith('%')) return null;
  const number = Number.parseFloat(trimmed.endsWith('px') ? trimmed.slice(0, -2) : trimmed);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Serialize one diagram as the bytes of a standalone `.svg` file.
 *
 * The element is cloned before being adjusted, so the copy that stays on screen (the preview's own
 * DOM, when this runs over a live container) is never modified.
 *
 * @param svg - The rendered diagram root.
 * @param size - Its intrinsic size, when one could be determined.
 * @returns The file's bytes.
 */
function serializeSvg(svg: SVGElement, size: { width: number; height: number } | null): Uint8Array {
  // `importNode` rather than `cloneNode`: it preserves the element's type, where `cloneNode` widens to
  // `Node` and would need an assertion to get back what we already know it is.
  const copy = svg.ownerDocument.importNode(svg, true);
  copy.setAttribute('xmlns', SVG_NAMESPACE);
  // A percentage width means "fill my container", which a standalone file has none of. Pinning the
  // real numbers makes the file open at its own size in a viewer as well as in the `<img>`.
  if (size !== null) {
    copy.setAttribute('width', String(size.width));
    copy.setAttribute('height', String(size.height));
  }
  const markup = new XMLSerializer().serializeToString(copy);
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${markup}\n`);
}

/**
 * Replace every rendered diagram in `container` with a reference to a file, and return those files.
 *
 * Mutates the container in place, which is what lets the caller run it over the same detached element
 * the renderers just finished with — no re-parse of the serialized HTML, and so no risk of a
 * round-trip changing markup that has nothing to do with diagrams.
 *
 * A diagram that failed to render has no `<svg>` (it was left showing its source instead) and is
 * skipped: there is nothing to extract, and its block stays exactly as the preview left it.
 *
 * @param container - The element holding the rendered diagrams.
 * @returns One asset per extracted diagram, in document order.
 */
export function extractDiagramSvgs(container: HTMLElement): ExportAsset[] {
  const assets: ExportAsset[] = [];

  for (const diagram of container.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)) {
    const output = diagram.querySelector<HTMLElement>(OUTPUT_SELECTOR);
    const svg = output?.querySelector('svg');
    if (!output || !svg) continue;

    const engine = diagram.dataset['diagramEngine'] ?? 'diagram';
    const size = intrinsicSize(svg);
    const path = assetPath('diagrams', engine, assets.length, 'svg', 'diagram');
    assets.push({ path, bytes: serializeSvg(svg, size), contentType: SVG_TYPE });

    const image = diagram.ownerDocument.createElement('img');
    image.setAttribute('src', path);
    image.setAttribute(EXPORT_ASSET_ATTRIBUTE, 'diagram');
    image.setAttribute('alt', `${engine} diagram`);
    if (size !== null) {
      image.setAttribute('width', String(size.width));
      image.setAttribute('height', String(size.height));
    }
    // The diagram keeps the on-screen behaviour it had inline: never wider than its column, and
    // scaled proportionally when the column is narrower than it is.
    image.setAttribute('style', 'max-width:100%;height:auto');

    output.replaceChildren(image);
  }

  return assets;
}
