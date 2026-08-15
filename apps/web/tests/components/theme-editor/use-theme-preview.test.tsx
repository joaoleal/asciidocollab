import { renderHook } from '@testing-library/react';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import {
  THEME_PREVIEW_THEME_PATH,
  themeParseProblem,
  unavailableCalloutGlyphs,
  useThemePreview,
} from '@/components/theme-editor/use-theme-preview';
import {
  THEME_PREVIEW_FIGURE_PATH,
  THEME_PREVIEW_SAMPLE_PATH,
} from '@/lib/pdf/theme-preview-sample';
import { themeSeedContent } from '@/lib/pdf/theme-seed';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import type { SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import type { ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import type { PreviewSnapshotSource } from '@/hooks/use-pdf-preview';

jest.mock('@/hooks/use-pdf-preview', () => ({ usePdfPreview: jest.fn() }));

const mockPreview = usePdfPreview as jest.MockedFunction<typeof usePdfPreview>;

/** The snapshots handed to usePdfPreview, in call order. */
function snapshots(): (ProjectSnapshot | null)[] {
  // The hook accepts either a snapshot or a thunk returning one; resolve it the same way so the
  // assertions read the snapshot itself rather than the union.
  return mockPreview.mock.calls.map((call) => {
    const source: PreviewSnapshotSource | null = call[0].snapshot;
    if (source === null) return null;
    return typeof source === 'function' ? source() : source;
  });
}

beforeEach(() => {
  mockPreview.mockReset();
  mockPreview.mockReturnValue({ isRendering: false, diagnostics: [] });
});

describe('themeParseProblem', () => {
  it('accepts a well-formed theme', () => {
    expect(themeParseProblem('page:\n  layout: landscape')).toBeNull();
  });

  it('accepts an empty theme', () => {
    expect(themeParseProblem('')).toBeNull();
  });

  it('accepts a theme full of keys the renderer will ignore', () => {
    // Unknown keys are the linter's business. Blocking the preview on them would stop an author
    // seeing their work over a warning.
    expect(themeParseProblem('made-up:\n  nonsense: 1')).toBeNull();
  });

  it('reports structurally broken YAML', () => {
    const problem = themeParseProblem('page:\n  layout: "unterminated');
    expect(problem).not.toBeNull();
    expect(problem?.message.length).toBeGreaterThan(0);
  });

  it('locates the problem when the parser can', () => {
    const problem = themeParseProblem('page:\n\tlayout: landscape');
    expect(problem?.line).toBeGreaterThan(0);
  });

  it('rejects a theme that is not a set of settings', () => {
    expect(themeParseProblem('just a string')?.message).toMatch(/not a single value/);
    expect(themeParseProblem('- one\n- two')?.message).toMatch(/not a list/);
  });
});

describe('useThemePreview — snapshot', () => {
  it('renders the sample document under the edited theme', () => {
    renderHook(() => useThemePreview('page:\n  layout: landscape', true));
    const [snapshot] = snapshots();
    expect(snapshot?.rootPath).toBe(THEME_PREVIEW_SAMPLE_PATH);
    expect(snapshot?.themePath).toBe(THEME_PREVIEW_THEME_PATH);
    expect(snapshot?.files[THEME_PREVIEW_THEME_PATH]).toBe('page:\n  layout: landscape');
  });

  it('mounts only its own constants and the theme, so the project cannot perturb the preview', () => {
    // The exact set, not a subset: the point of the assertion is that nothing from the PROJECT can
    // reach the preview, which a subset check would not catch.
    renderHook(() => useThemePreview('page:', true));
    expect(Object.keys(snapshots()[0]?.files ?? {}).toSorted()).toEqual(
      [THEME_PREVIEW_SAMPLE_PATH, THEME_PREVIEW_FIGURE_PATH, THEME_PREVIEW_THEME_PATH].toSorted(),
    );
    expect(snapshots()[0]?.binaryAssets).toEqual({});
  });

  it('mounts the figure the sample references, at the path it references', () => {
    // The sample names this path in an `image::` macro; a mismatch renders a missing-image box that
    // the author would read as a broken theme.
    renderHook(() => useThemePreview('page:', true));
    expect(snapshots()[0]?.files[THEME_PREVIEW_FIGURE_PATH]).toMatch(/^<svg /);
  });

  it('never asks for a warm re-render, which would omit the sample from the VFS', () => {
    // Regression: passing `changedPaths` made the FIRST render rewrite only the theme, so the sample
    // document was never written and the engine reported the root document as missing.
    renderHook(() => useThemePreview('page:', true));
    expect(mockPreview.mock.calls[0][0].changedPaths).toBeUndefined();
  });

  it('passes the enabled flag through so a closed pane cancels rendering', () => {
    renderHook(() => useThemePreview('page:', false));
    expect(mockPreview.mock.calls[0][0].isEnabled).toBe(false);
  });

  it('leaves the sample its declared doctype instead of forcing one', () => {
    // Regression, and a visible one. The snapshot's attributes reach the engine as API attributes,
    // which OVERRIDE the document header. This seeded the html5 intrinsic set — including
    // `doctype: article` — so the sample's `:doctype: book` was overridden and the preview had no
    // title page and no chapters. The two extensions that hook exactly that furniture,
    // `title-block-document-details` and `per-chapter-contents`, therefore appeared to do nothing
    // at all when an author switched them on.
    //
    // Invisible to the parity suite: the `theme-editing` fixture renders this same sample text from
    // a manifest declaring `attributes: {}`, so the fixture rendered a book and matched its
    // reference while the app's own preview rendered an article.
    renderHook(() => useThemePreview('page:', true));
    const [snapshot] = snapshots();
    expect(snapshot?.attributes.doctype).toBeUndefined();
    expect(snapshot?.attributes.backend).toBe('pdf');
    expect(snapshot?.attributes['backend-html5']).toBeUndefined();
  });
});

describe('useThemePreview — coalescing', () => {
  it('hands the same snapshot object back for unchanged text', () => {
    // Snapshot identity is what schedules a render, so a re-render for an unrelated reason must not
    // queue one.
    const { result, rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: landscape' },
    });
    expect(result.current.isRendering).toBe(false);
    rerender({ text: 'page:\n  layout: landscape' });
    const [first, second] = snapshots();
    expect(second).toBe(first);
  });

  it('builds a new snapshot when the theme changes', () => {
    const { rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: portrait' },
    });
    rerender({ text: 'page:\n  layout: landscape' });
    const captured = snapshots();
    expect(captured.at(-1)).not.toBe(captured[0]);
    expect(captured.at(-1)?.files[THEME_PREVIEW_THEME_PATH]).toContain('landscape');
  });
});

describe('useThemePreview — a broken theme keeps the last good preview', () => {
  it('does not send unparseable text to the renderer', () => {
    // Half of every keystroke sequence leaves YAML momentarily invalid; rendering each one would
    // make the preview show an error for a document being written correctly.
    const { rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: landscape' },
    });
    rerender({ text: 'page:\n  layout: "unterminated' });

    const captured = snapshots();
    expect(captured.at(-1)?.files[THEME_PREVIEW_THEME_PATH]).toBe('page:\n  layout: landscape');
  });

  it('holds the same snapshot object, so no render is even scheduled', () => {
    const { rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: landscape' },
    });
    rerender({ text: 'page:\n  layout: "unterminated' });
    const captured = snapshots();
    expect(captured.at(-1)).toBe(captured[0]);
  });

  it('reports the parse problem alongside the older preview', () => {
    const { result, rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: landscape' },
    });
    expect(result.current.parseProblem).toBeUndefined();

    rerender({ text: 'page:\n  layout: "unterminated' });
    // The preview is stale, not failed — and the author is told which.
    expect(result.current.parseProblem?.message.length).toBeGreaterThan(0);
    expect(result.current.error).toBeUndefined();
  });

  it('resumes rendering once the theme parses again', () => {
    const { result, rerender } = renderHook(({ text }) => useThemePreview(text, true), {
      initialProps: { text: 'page:\n  layout: landscape' },
    });
    rerender({ text: 'page:\n  layout: "unterminated' });
    rerender({ text: 'page:\n  layout: portrait' });

    expect(result.current.parseProblem).toBeUndefined();
    expect(snapshots().at(-1)?.files[THEME_PREVIEW_THEME_PATH]).toContain('portrait');
  });

  it('surfaces the render outcome untouched', () => {
    const pdf = new Blob(['%PDF']);
    mockPreview.mockReturnValue({
      pdf,
      isRendering: true,
      diagnostics: [{ severity: 'warning', message: 'font missing' } as never],
    });
    const { result } = renderHook(() => useThemePreview('page:', true));
    expect(result.current.pdf).toBe(pdf);
    expect(result.current.isRendering).toBe(true);
    // The engine's own diagnostic passes through unmodified. Asserted by CONTENT rather than by
    // counting: this theme inherits no font catalogue, so it legitimately contributes a callout-glyph
    // warning of its own, and a length check would read as a regression every time the hook learns to
    // derive another warning.
    expect(result.current.diagnostics).toContainEqual({ severity: 'warning', message: 'font missing' });
  });
});

/** A stand-in project asset cache reporting the given paths as already fetched. */
function cacheWith(paths: readonly string[]): { cache: ProjectAssetCache; ensureAssets: jest.Mock } {
  const ensureAssets = jest.fn();
  return {
    cache: {
      ensureAssets,
      getAssets: (): SnapshotFile[] =>
        paths.map((path) => ({ path, kind: 'binary' as const, bytes: new Uint8Array([1, 2, 3]) })),
      getAssetBytes: (path: string) =>
        paths.includes(path) ? new Uint8Array([1, 2, 3]) : undefined,
      loadAssets: jest.fn(),
      assetsSettled: () => true,
      assetVersion: 1,
    },
    ensureAssets,
  };
}

describe('useThemePreview — project fonts', () => {
  const THEME_PATH = 'branding/house.yml';
  const BRAND_FONT = 'branding/fonts/brand.ttf';
  const THEME_TEXT = [
    'font:',
    '  catalog:',
    '    Brand:',
    '      normal: fonts/brand.ttf',
  ].join('\n');

  it('resolves a font reference against the theme’s own directory, not the project root', () => {
    // The load-bearing case. A theme at `branding/house.yml` naming `fonts/brand.ttf` means
    // `branding/fonts/brand.ttf`. Resolved against a root-mounted stand-in it would name
    // `fonts/brand.ttf` — a different file — and the preview would quietly use a built-in face
    // while the export embedded the real one.
    const { cache, ensureAssets } = cacheWith([]);
    renderHook(() => useThemePreview(THEME_TEXT, true, [], undefined, THEME_PATH, cache));
    expect(ensureAssets).toHaveBeenCalledWith([BRAND_FONT]);
  });

  it('mounts a fetched font as a binary asset the engine can embed', () => {
    const { cache } = cacheWith([BRAND_FONT]);
    renderHook(() => useThemePreview(THEME_TEXT, true, [], undefined, THEME_PATH, cache));
    const [snapshot] = snapshots();
    expect(Object.keys(snapshot?.binaryAssets ?? {})).toEqual([BRAND_FONT]);
    expect(snapshot?.fontPaths).toEqual([BRAND_FONT]);
    // The theme itself is mounted at its real path, which is what makes the reference resolve.
    expect(snapshot?.themePath).toBe(THEME_PATH);
    expect(snapshot?.files[THEME_PATH]).toBe(THEME_TEXT);
  });

  it('warns only about a font the project does not have', () => {
    const { cache } = cacheWith([]);
    const { result } = renderHook(() =>
      useThemePreview(THEME_TEXT, true, [], undefined, THEME_PATH, cache),
    );
    const codes = result.current.diagnostics.map((diagnostic) => diagnostic.resource);
    expect(codes).toEqual([BRAND_FONT]);
    // The old message said the preview never loads project files. It does now, so a warning that
    // still said otherwise would be untrue — and the blanket version trained authors to ignore it.
    expect(result.current.diagnostics[0]?.message).toContain('not in the project');
  });

  it('says nothing once the font is available', () => {
    const { cache } = cacheWith([BRAND_FONT]);
    const { result } = renderHook(() =>
      useThemePreview(THEME_TEXT, true, [], undefined, THEME_PATH, cache),
    );
    expect(result.current.diagnostics).toEqual([]);
  });

  it('renders without a cache, for a theme opened outside a project', () => {
    renderHook(() => useThemePreview(THEME_TEXT, true));
    const [snapshot] = snapshots();
    expect(snapshot?.fontPaths).toEqual([]);
    expect(snapshot?.themePath).toBe(THEME_PREVIEW_THEME_PATH);
  });
});

/** Whether the callout-glyph warning fires for a theme. */
function warns(themeText: string): boolean {
  return unavailableCalloutGlyphs(themeText).length > 0;
}

/**
 * The expectations below are pinned to a MEASURED rendering, not to a reading of the theme spec.
 * Rendering the sample's callouts through the real engine gives `①②` under `extends: default`, `¬¬`
 * under `extends: base`, and `¬` under a theme with no `extends` key. The engine reports nothing in
 * the failing cases, which is why this warning has to exist at all.
 */
describe('unavailableCalloutGlyphs', () => {
  it('warns for a theme extending base, the documented example’s own opening line', () => {
    expect(warns('extends: base\npage:\n  layout: portrait\n')).toBe(true);
  });

  it('warns for a theme that extends nothing, which inherits no catalogue either', () => {
    expect(warns('base:\n  font-size: 10\n')).toBe(true);
  });

  it('says nothing for a theme extending default', () => {
    expect(warns('extends: default\n')).toBe(false);
  });

  it('reads the list form of extends, and the relative-application marker', () => {
    // `extends` takes a list, and a name may carry a `!`/`-` prefix controlling how it is applied
    // rather than which theme is named — so the marker must be stripped before comparing.
    expect(warns('extends: [base]\n')).toBe(true);
    expect(warns('extends:\n  - -base\n')).toBe(true);
    expect(warns('extends: [default]\n')).toBe(false);
  });

  it('stays silent when the theme declares its own font catalogue', () => {
    // It may name a font that HAS the glyphs, and this cannot know without reading the font file.
    // Under-warning is the deliberate choice: a warning on a correct theme teaches authors to
    // ignore the validation, which is the failure `theme-diagnostics.ts` is built around avoiding.
    expect(warns('extends: base\nfont:\n  catalog:\n    Brand:\n      normal: brand.ttf\n')).toBe(
      false,
    );
    expect(warns('extends: base\nfont_catalog:\n  Brand:\n    normal: brand.ttf\n')).toBe(false);
  });

  it('says NOTHING about the content every new theme starts from', () => {
    // The guard that matters most. `themeSeedContent()` is a copy of the gem's default theme, which
    // declares its own font catalogue but has no `extends` key — so without the catalogue check this
    // would fire on the first thing every author ever sees, about callouts that render correctly.
    // That is precisely the cry-wolf failure this diagnostic is supposed to avoid.
    expect(warns(themeSeedContent())).toBe(false);
  });

  it('says nothing about text that does not parse', () => {
    // That is the parse problem's story, and the preview is showing the last good version anyway.
    expect(warns('extends: [base\n')).toBe(false);
    expect(warns('just a scalar')).toBe(false);
  });

  it('explains the consequence, not just the character', () => {
    const [diagnostic] = unavailableCalloutGlyphs('extends: base\n');
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.code).toBe('missing-glyph');
    // Every callout collapses to the SAME `¬`, so `<1>` and `<2>` cannot be told apart — that is
    // what makes this a defect rather than an odd-looking character.
    expect(diagnostic?.message).toContain('¬');
    expect(diagnostic?.message).toMatch(/told apart|same character/);
  });

  it('does NOT offer the fix that breaks the render', () => {
    // Pointing `conum.font-family` at a font reads as the obvious remedy and is wrong here: a
    // base-extending theme has no catalogue to name a font from, and the engine fails the whole
    // render with `Prawn::Errors::UnknownFont: Noto Serif (normal) is not a known font.` Measured.
    const [diagnostic] = unavailableCalloutGlyphs('extends: base\n');
    expect(diagnostic?.message).not.toMatch(/conum/i);
    expect(diagnostic?.message).toContain('extends: default');
  });

  it('reaches the preview panel’s notices for the theme on screen', () => {
    const { result } = renderHook(() => useThemePreview('extends: base\n', true));
    expect(result.current.diagnostics.map((entry) => entry.code)).toEqual(['missing-glyph']);
  });
});
