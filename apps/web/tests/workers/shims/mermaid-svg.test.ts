/* @jest-environment jsdom */
import { flattenMermaidLabelTspans } from '@/workers/shims/mermaid-svg';

/** Wrap fragment markup in a minimal SVG document so DOMParser accepts it as image/svg+xml. */
const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

/** The nested per-word tspan shape mermaid emits for a wrapped label (one row, two words). */
const nestedRow = svg(
  '<g class="label"><text text-anchor="middle">' +
    '<tspan class="text-outer-tspan row" x="0" y="-0.1em" dy="1.1em" text-anchor="middle">' +
    '<tspan class="text-inner-tspan">Square</tspan>' +
    ' ' +
    '<tspan class="text-inner-tspan">Rect</tspan>' +
    '</tspan></text></g>',
);

describe('flattenMermaidLabelTspans', () => {
  it('collapses a row of per-word inner tspans into a single spaced text run', () => {
    const out = flattenMermaidLabelTspans(nestedRow);

    // No inner per-word tspans survive — prawn-svg would have stacked them at the same x.
    expect(out).not.toContain('text-inner-tspan');
    // The row tspan remains and now carries the full label text, spaces intact.
    expect(out).toContain('Square Rect');
    // Exactly one tspan remains inside the <text> (the row), not three.
    const parsed = new DOMParser().parseFromString(out, 'image/svg+xml');
    const tspans = parsed.querySelectorAll('text tspan');
    expect(tspans).toHaveLength(1);
    expect(tspans[0].textContent).toBe('Square Rect');
  });

  it('preserves the row tspan positioning attributes', () => {
    const parsed = new DOMParser().parseFromString(
      flattenMermaidLabelTspans(nestedRow),
      'image/svg+xml',
    );
    const row = parsed.querySelector('text tspan');
    expect(row?.getAttribute('x')).toBe('0');
    expect(row?.getAttribute('dy')).toBe('1.1em');
    expect(row?.getAttribute('text-anchor')).toBe('middle');
  });

  it('keeps separate row tspans for a multi-line (wrapped) label so lines still stack', () => {
    const twoRows = svg(
      '<text>' +
        '<tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan class="text-inner-tspan">Do</tspan> <tspan class="text-inner-tspan">the</tspan></tspan>' +
        '<tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan class="text-inner-tspan">thing</tspan></tspan>' +
        '</text>',
    );
    const parsed = new DOMParser().parseFromString(
      flattenMermaidLabelTspans(twoRows),
      'image/svg+xml',
    );
    const rows = parsed.querySelectorAll('text > tspan');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('Do the');
    expect(rows[1].textContent).toBe('thing');
    expect(parsed.querySelectorAll('.text-inner-tspan')).toHaveLength(0);
  });

  it('leaves an already-flat single-run label untouched', () => {
    const flat = svg('<text><tspan class="text-outer-tspan row" x="0">Circle</tspan></text>');
    expect(flattenMermaidLabelTspans(flat)).toContain('Circle');
    const parsed = new DOMParser().parseFromString(flattenMermaidLabelTspans(flat), 'image/svg+xml');
    expect(parsed.querySelectorAll('text tspan')).toHaveLength(1);
  });

  it('is a no-op for an SVG with no label tspans', () => {
    const plain = svg('<rect width="10" height="10"/><path d="M0 0L10 10"/>');
    expect(flattenMermaidLabelTspans(plain)).toContain('<rect');
  });

  it('returns the input unchanged when it cannot be parsed as SVG', () => {
    const broken = '<svg><text><tspan class="text-outer-tspan"';
    expect(flattenMermaidLabelTspans(broken)).toBe(broken);
  });
});
