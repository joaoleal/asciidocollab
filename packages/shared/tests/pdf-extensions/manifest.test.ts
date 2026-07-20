import type { PdfExtensionManifest as LeafManifest } from '@asciidocollab/asciidoc-core';
import {
  orderPdfExtensions,
  parsePdfExtensionManifest,
  pdfExtensionIdSchema,
  type PdfExtensionCatalogueEntry,
  type PdfExtensionManifest,
} from '../../src/pdf-extensions';

const VALID = {
  id: 'paragraph-numbering',
  displayName: 'Paragraph numbering',
  description: 'Numbers each paragraph sequentially in document order.',
  targeting: '[.numbered]',
  themeKeys: [
    {
      key: 'paragraph-numbering.font-color',
      valueKind: 'colour',
      description: 'Colour of the generated paragraph number.',
      default: '999999',
    },
  ],
  sampleContent: 'A numbered paragraph.',
};

/** Build an entry around a manifest, for the ordering tests. */
function entry(id: string, origin: 'shipped' | 'administrator-provided' = 'shipped'): PdfExtensionCatalogueEntry {
  return {
    manifest: { ...VALID, id } as PdfExtensionManifest,
    origin,
    available: true,
  };
}

describe('the contract is declared once', () => {
  it('produces exactly the shape the renderer consumes', () => {
    // The shape lives in the zero-dep leaf so the Web Worker bundle need not pull in the domain ring;
    // the zod schema lives here, at the trust boundary. Those are two files describing ONE contract,
    // so a field added to one and not the other must not compile.
    const result = parsePdfExtensionManifest(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asLeaf: LeafManifest = result.manifest;
    const asValidated: PdfExtensionManifest = asLeaf;
    expect(asValidated.id).toBe(VALID.id);
  });
});

describe('parsePdfExtensionManifest — accepting a well-formed manifest', () => {
  it('accepts a complete manifest', () => {
    const result = parsePdfExtensionManifest(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe('paragraph-numbering');
  });

  it('defaults the optional fields so a minimal manifest is still usable', () => {
    const result = parsePdfExtensionManifest({
      id: 'minimal',
      displayName: 'Minimal',
      description: 'Does one thing.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.targeting).toBe('');
      expect(result.manifest.themeKeys).toEqual([]);
      expect(result.manifest.sampleContent).toBe('');
    }
  });
});

describe('parsePdfExtensionManifest — rejecting untrusted input', () => {
  it('returns a reason rather than throwing', () => {
    // One malformed manifest in the administrator's folder must not deny every project its
    // catalogue: the caller excludes it, reports it, and carries on (FR-033d).
    const result = parsePdfExtensionManifest({ id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it('names which field was wrong', () => {
    const result = parsePdfExtensionManifest({ ...VALID, displayName: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('displayName');
  });

  it('rejects a value that is not an object at all', () => {
    for (const raw of [null, undefined, 'a string', 42, []]) {
      expect(parsePdfExtensionManifest(raw).ok).toBe(false);
    }
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    // A manifest carrying a field we do not understand is one written against a different contract;
    // accepting it would let its author believe a setting took effect.
    expect(parsePdfExtensionManifest({ ...VALID, loadPath: '/etc/passwd' }).ok).toBe(false);
  });

  it('bounds every string, so a malformed file cannot produce unbounded UI text', () => {
    expect(parsePdfExtensionManifest({ ...VALID, description: 'x'.repeat(5000) }).ok).toBe(false);
    expect(parsePdfExtensionManifest({ ...VALID, displayName: 'x'.repeat(500) }).ok).toBe(false);
  });

  it('bounds the number of contributed theme keys', () => {
    const themeKeys = Array.from({ length: 100 }, (_, index) => ({
      key: `k${index}`,
      valueKind: 'string',
      description: 'A key.',
    }));
    expect(parsePdfExtensionManifest({ ...VALID, themeKeys }).ok).toBe(false);
  });

  it('rejects a theme key whose kind is not one the editor can render', () => {
    expect(
      parsePdfExtensionManifest({
        ...VALID,
        themeKeys: [{ key: 'a.b', valueKind: 'hologram', description: 'x' }],
      }).ok,
    ).toBe(false);
  });
});

describe('pdfExtensionIdSchema — an id can never name a path', () => {
  it('accepts the documented form', () => {
    for (const id of ['paragraph-numbering', 'a', 'a1', 'multi-column-sections']) {
      expect(pdfExtensionIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects anything that could be read as a path', () => {
    // An id is resolved by catalogue lookup and never joined onto a filesystem path — but rejecting
    // separators here means it could not name one even if a future call site got that wrong.
    for (const id of [
      '../etc/passwd',
      'a/b',
      String.raw`a\b`,
      '.hidden',
      'a.b',
      'a b',
      '/absolute',
      'UPPER',
      'trailing-',
      '-leading',
      'double--dash',
      '',
    ]) {
      expect(pdfExtensionIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('rejects an id long enough to be a payload', () => {
    expect(pdfExtensionIdSchema.safeParse('a'.repeat(200)).success).toBe(false);
  });
});

describe('orderPdfExtensions — determinism', () => {
  it('orders by id, whatever order the entries arrive in', () => {
    // Load order can change output when two extensions touch the same hook, so it must not depend on
    // how an administrator's filesystem enumerated them or the order a project selected them
    // (FR-031c, Principle XII).
    const forwards = orderPdfExtensions([entry('alpha'), entry('beta'), entry('gamma')]);
    const backwards = orderPdfExtensions([entry('gamma'), entry('beta'), entry('alpha')]);
    expect(forwards.map((entry) => entry.manifest.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(backwards.map((entry) => entry.manifest.id)).toEqual(forwards.map((entry) => entry.manifest.id));
  });

  it('orders shipped and administrator entries together, not in separate blocks', () => {
    // Origin must not affect load order: an administrator adding an extension would otherwise
    // reorder the shipped ones relative to it and change existing output.
    const ordered = orderPdfExtensions([
      entry('zebra', 'shipped'),
      entry('alpha', 'administrator-provided'),
    ]);
    expect(ordered.map((entry) => entry.manifest.id)).toEqual(['alpha', 'zebra']);
  });

  it('does not mutate its input', () => {
    const input = [entry('b'), entry('a')];
    orderPdfExtensions(input);
    expect(input.map((entry) => entry.manifest.id)).toEqual(['b', 'a']);
  });

  it('handles an empty catalogue', () => {
    expect(orderPdfExtensions([])).toEqual([]);
  });
});
