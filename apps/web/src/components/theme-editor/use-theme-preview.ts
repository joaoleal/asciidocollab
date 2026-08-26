'use client';

/**
 * @file Drives the theme editor's sample preview from the theme text being edited.
 *
 * Two behaviours make this its own hook rather than a call to {@link usePdfPreview}.
 *
 * **A broken theme must not blank the preview.** Half of every keystroke sequence leaves YAML
 * momentarily invalid — typing `font-color:` produces a line with no value, deleting a quote leaves
 * an unterminated string. If each of those reached the renderer, the preview would spend most of its
 * time showing an error for a document the author is in the middle of writing correctly. So the
 * snapshot is only rebuilt from text that PARSES, and the last good one is held otherwise (FR-015).
 * The parse failure is still reported — it is surfaced beside the preview, not instead of it.
 *
 * **Continuous typing must not queue one render per keystroke.** `usePdfPreview` already debounces
 * on snapshot identity, so the coalescing here is to avoid handing it a NEW snapshot object for text
 * that is semantically unchanged: the snapshot is memoised on the last theme text that parsed, which
 * means a burst of keystrokes ending where it started schedules no render at all (Principle XIII).
 */
import { useMemo, useRef } from 'react';
import type {
  PdfExtensionBundle,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderError,
} from '@asciidocollab/asciidoc-pdf';
import { parse as parseYaml } from 'yaml';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import { useReferencedAssets } from '@/hooks/use-referenced-assets';
import type { ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import type { SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';
import { PDF_RENDER_INTRINSIC_ATTRIBUTES } from '@/lib/asciidoc/render-intrinsics';
import {
  THEME_PREVIEW_FIGURE,
  THEME_PREVIEW_FIGURE_PATH,
  THEME_PREVIEW_SAMPLE,
  THEME_PREVIEW_SAMPLE_PATH,
} from '@/lib/pdf/theme-preview-sample';

/** The path the edited theme is mounted at for the preview render. */
export const THEME_PREVIEW_THEME_PATH = 'preview-theme.yml';

/**
 * What the callout-glyph warning names as its subject.
 *
 * `resource` is normally a file path, but this warning is about a SETTING rather than a file — the
 * theme's inherited font catalogue — and naming the theme file would read as "this file is missing",
 * which it is not.
 */
const THEME_CONUM_RESOURCE = 'callout numbers';

/** No converter extensions. A shared constant so the default keeps a stable snapshot identity. */
const NO_EXTENSIONS: readonly string[] = [];

/**
 * No project render attributes — a theme opened outside a project, which has no configuration to
 * apply. A shared constant for the same reason as above: the snapshot is memoised on this object's
 * identity, so a fresh `{}` per render would rebuild it and schedule a render for nothing.
 */
const NO_PROJECT_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Project attributes that name a location inside the PROJECT, which this sample is not part of.
 *
 * The sample and its figure are constants from this module, mounted at the snapshot root; the project's
 * files are not in this snapshot at all. So an attribute that redirects resolution into the project
 * points at nothing here. `imagesdir` is the one that shows: a project that sets an images directory —
 * an ordinary render-config option — sent all three of the sample's `image::` targets to
 * `<dir>/theme-preview-figure.svg`, and the whole Figures section came out as missing-image
 * placeholders. That is the part of the sample whose only job is to let a figure and its caption be
 * judged, so the setting silently disabled a section of the preview for exactly the projects that use
 * it. Verified against the engine both ways: with `imagesdir` set the pages carry
 * `[A diagram of three linked stages]` where the drawing should be, and without it they carry the
 * drawing and its caption.
 *
 * `bibtex-file` is here for the same reason rather than for an observed failure — it names a project
 * file, and the sample cites nothing. It happens to be inert today only because the citations stage
 * gates on the snapshot's own `bibPath`, which is a coincidence and not a promise.
 *
 * Everything else the project sets is deliberately kept: page size, layout, media, folio placement,
 * hyphenation and the document options are the CONDITIONS a theme is judged under, which is the whole
 * reason the project's map is layered here. The distinction is setup versus paths.
 */
const PROJECT_PATH_ATTRIBUTES: ReadonlySet<string> = new Set(['imagesdir', 'bibtex-file']);

/**
 * The project's attributes with {@link PROJECT_PATH_ATTRIBUTES} removed.
 *
 * Removed rather than blanked: unset is what the engine already does for a project that names no
 * images directory, and it is what makes the sample's figure resolve at the root it is mounted at.
 *
 * @param projectAttributes - The project's resolved render attributes.
 * @returns The same map without the attributes that resolve into the project.
 */
function withoutProjectPaths(
  projectAttributes: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(projectAttributes).filter(([key]) => !PROJECT_PATH_ATTRIBUTES.has(key)),
  );
}

/**
 * Separator for the extension-list cache key below.
 *
 * A NUL, because it is the one character an extension id can never contain, so two different lists
 * can never join to the same key. Written as an escape and named here rather than inlined as a raw
 * byte, which is what it used to be: a literal NUL in the source made this file BINARY to `grep`,
 * `ripgrep`, `file` and every diff tool — searches for text plainly present in it silently returned
 * nothing, which is a bad way to lose an afternoon.
 */
const EXTENSION_KEY_SEPARATOR = '\0';

/** Why the preview is showing older output than the editor's current text. */
export interface ThemeParseProblem {
  /** The parser's message, as shown to the author. */
  readonly message: string;
  /** 1-based line the problem was reported against, when the parser located one. */
  readonly line?: number;
}

/** The theme preview's state, shaped for the preview panel. */
export interface UseThemePreviewResult {
  /** The most recent successfully rendered sample, or undefined before the first render. */
  pdf?: Blob;
  /** True while a render is in flight. */
  isRendering: boolean;
  /** Non-fatal per-resource diagnostics from the latest render (a missing font, say). */
  diagnostics: readonly RenderDiagnostic[];
  /** The last whole-render failure, or undefined when the latest render succeeded. */
  error?: RenderError;
  /**
   * Set when the CURRENT editor text does not parse. The preview below it is the last one that did,
   * so this is the signal that what is on screen is behind the editor — not that rendering failed.
   */
  parseProblem?: ThemeParseProblem;
}

/** A YAML parse error carrying the position the parser located, when it managed to locate one. */
interface LocatedYamlError extends Error {
  readonly linePos?: readonly { readonly line: number }[];
}

/** Whether a caught value is a parse error the `yaml` package located a line for. */
function isLocatedYamlError(error: unknown): error is LocatedYamlError {
  return error instanceof Error && Array.isArray(Reflect.get(error, 'linePos'));
}

/**
 * Extract a readable message, and a line where one is available, from whatever the parser threw.
 *
 * @param error - The value caught while parsing.
 * @returns The problem as it will be shown to the author.
 */
function describeParseFailure(error: unknown): ThemeParseProblem {
  if (isLocatedYamlError(error)) {
    const line = error.linePos?.[0]?.line;
    return { message: error.message, ...(line === undefined ? {} : { line }) };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: 'The theme could not be parsed.' };
}

/**
 * Build the snapshot that renders the sample document under a theme.
 *
 * The DOCUMENT is self-contained — the sample and its figure are constants from this module, so every
 * participant previews the same pages and the preview cannot be perturbed by what the project happens
 * to contain (FR-026b). The figure is SVG, and so is carried in `files` as text rather than as a
 * binary asset.
 *
 * The THEME's own resources are not, and must not be: a theme whose whole purpose is to apply a brand
 * typeface is unjudgeable if the one thing it does cannot be seen. Any font the theme names is
 * fetched from the project and mounted here, so the preview shows the typeface the export will embed.
 *
 * The theme is mounted at its REAL project path, which is load-bearing rather than tidy. A theme's
 * font references resolve relative to the theme file's own directory, so a theme at
 * `branding/house.yml` naming `fonts/brand.ttf` means `branding/fonts/brand.ttf`. Mounting the theme
 * at a synthetic root path would resolve that to `fonts/brand.ttf` — a different file, or no file —
 * and the preview would silently fall back to a built-in face while the export used the real one.
 */
function buildThemeSnapshot(
  themeText: string,
  themePath: string,
  enabledExtensions: readonly string[],
  fontAssets: readonly SnapshotFile[],
  projectAttributes: Readonly<Record<string, string>>,
): ProjectSnapshot {
  const binaryAssets: Record<string, Uint8Array> = {};
  const fontPaths: string[] = [];
  for (const asset of fontAssets) {
    if (asset.kind !== 'binary') continue;
    binaryAssets[asset.path] = asset.bytes;
    fontPaths.push(asset.path);
  }

  return {
    files: {
      [THEME_PREVIEW_SAMPLE_PATH]: THEME_PREVIEW_SAMPLE,
      [THEME_PREVIEW_FIGURE_PATH]: THEME_PREVIEW_FIGURE,
      [themePath]: themeText,
    },
    binaryAssets,
    rootPath: THEME_PREVIEW_SAMPLE_PATH,
    openPath: THEME_PREVIEW_SAMPLE_PATH,
    themePath,
    fontPaths,
    // The PDF intrinsics, not the html5 ones. These reach the engine as API attributes, which
    // override the document header — and the sample declares `:doctype: book`. Seeding
    // `doctype: article` here rendered the sample as an article, so the preview had no title page
    // and no chapters, and the two extensions that hook that furniture
    // (`title-block-document-details`, `per-chapter-contents`) appeared to do nothing when switched
    // on. The parity fixture renders this same text from a manifest with `attributes: {}`, so it
    // rendered a book and passed while the app's own preview did not.
    //
    // The PROJECT's own render attributes are layered over them, in the same order
    // `buildProjectSnapshot` uses, because the preview's whole claim is to show what this project's
    // export will produce. Seeded with only the intrinsics, a project configured for A4 previewed its
    // theme on the engine's default Letter page while the export produced A4 — and page size and
    // layout set the measure every other theme setting is judged against, so the preview and the PDF
    // disagreed about exactly the thing a theme is read on.
    //
    // The sample's own header still wins over both: every project attribute carries the soft-default
    // marker (`@`), which is what keeps `:doctype: book` above a project configured for articles.
    // `pdf-theme` is the one exception, and it is handled below the app entirely — `invokeConvert`
    // derives it from `themePath` after the attribute map is built, so the theme being edited is
    // applied whatever the project has selected.
    //
    // What is layered is the project's SETUP, never its paths: see {@link PROJECT_PATH_ATTRIBUTES}.
    attributes: {
      ...Object.fromEntries(PDF_RENDER_INTRINSIC_ATTRIBUTES),
      ...withoutProjectPaths(projectAttributes),
    },
    enabledExtensions,
  };
}

/**
 * Whether a theme document is well-formed enough to hand to the renderer.
 *
 * Only STRUCTURE is judged here. Whether a key exists or a value is a legal colour is the linter's
 * question (`theme-diagnostics.ts`), and a theme full of unknown keys still renders — the renderer
 * ignores them. Blocking the preview on those would stop an author seeing their work over a warning.
 *
 * @param themeText - The theme document as currently written.
 * @returns Null when it parses, or the problem when it does not.
 */
export function themeParseProblem(themeText: string): ThemeParseProblem | null {
  try {
    const parsed: unknown = parseYaml(themeText);
    // A theme must be a mapping. A bare scalar parses but would silently render as no theme at all.
    if (parsed !== null && parsed !== undefined && typeof parsed !== 'object') {
      return { message: 'A theme must be a set of settings, not a single value.' };
    }
    if (Array.isArray(parsed)) {
      return { message: 'A theme must be a set of settings, not a list.' };
    }
    return null;
  } catch (error) {
    return describeParseFailure(error);
  }
}

/**
 * The project-relative paths of every resource the theme names, resolved against the theme's own
 * location.
 *
 * Resolved against the REAL theme path, not a synthetic one: a theme's font references are relative
 * to the directory the theme lives in, so `branding/house.yml` naming `fonts/brand.ttf` means
 * `branding/fonts/brand.ttf`. Resolving against a root-mounted stand-in would name a different file.
 *
 * A reference the sandbox refuses never reaches here: `collectReferencedAssetPaths` drops remote and
 * project-escaping targets, so this can only ever name paths inside the project.
 *
 * @param themeText - The theme document as currently written.
 * @param themePath - The theme's project-relative path.
 * @returns The referenced paths, sorted.
 */
export function themeResourcePaths(themeText: string, themePath: string): string[] {
  return collectReferencedAssetPaths({
    files: { [themePath]: themeText },
    attributes: new Map([['pdf-theme', themePath]]),
  });
}

/**
 * Non-fatal warnings for resources the theme names that could not be fetched from the project.
 *
 * The preview DOES load the project's fonts, so this now reports a genuine gap — a theme naming a
 * file the project does not have, or one that has not arrived yet — rather than a standing
 * limitation. That distinction matters: the old blanket message said the preview never loads project
 * files, which trained an author to ignore it, and would now be simply untrue.
 *
 * @param referenced - Every resource path the theme names.
 * @param availablePaths - The paths actually mounted into the preview snapshot.
 * @returns One warning per resource still missing, in path order.
 */
export function unresolvedThemeResources(
  referenced: readonly string[],
  availablePaths: ReadonlySet<string>,
): RenderDiagnostic[] {
  return referenced
    .filter((resource) => !availablePaths.has(resource))
    .map((resource) => ({
      severity: 'warning' as const,
      code: 'font-unavailable' as const,
      resource,
      message:
        `${resource} is named by this theme but is not in the project, so the sample is rendered ` +
        'with a built-in font. Add the file to the project to see it applied.',
    }));
}

/**
 * Whether `extends` names the `base` theme, in any of the forms it may be written.
 *
 * `extends` accepts a scalar or a list, and a name may carry a `!`/`-` prefix (which controls
 * whether the extension is applied relative to the current theme, not WHICH theme is named), so the
 * marker is stripped before comparing.
 */
/** One key's value from a parsed-YAML mapping, without asserting a shape onto `unknown`. */
function entryOf(source: object, key: string): unknown {
  return Object.entries(source).find(([name]) => name === key)?.[1];
}

function extendsBase(value: unknown): boolean {
  const names = Array.isArray(value) ? value : [value];
  return names.some(
    (name) => typeof name === 'string' && name.trim().replace(/^[!-]/, '') === 'base',
  );
}

/**
 * Warn when the theme's callout numbers will render as `¬` instead of the circled digits.
 *
 * MEASURED, not predicted. Rendering the sample's callouts through the real engine gives:
 * `extends: default` → `①②`; `extends: base` → `¬¬`; no `extends` key at all → `¬`. The cause is the
 * font catalogue, not the callouts: `base` supplies the built-in AFM faces (Times-Roman, Courier),
 * which have no circled digits, and a theme that extends nothing inherits no catalogue either. The
 * engine reports NOTHING for this — it renders happily — so without this the author sees only the
 * strange character and has no way to find out why.
 *
 * Both callouts collapse to the SAME `¬`, which is why this is worth a warning rather than being
 * cosmetic: `<1>` and `<2>` become indistinguishable, so the list below the block can no longer be
 * matched to the lines it annotates.
 *
 * Deliberately silent when the theme declares its own `font_catalog`: it may well name a font that
 * has the glyphs, and this cannot know without reading the font file. Under-warning is the correct
 * failure here — see `theme-diagnostics.ts`, which is built around not crying wolf.
 *
 * The advice is `extends: default` and NOT "point `conum.font-family` at a font that has them",
 * which reads as the obvious fix and is wrong: on a base-extending theme there is no catalogue to
 * name a font from, so it fails the whole render with `Prawn::Errors::UnknownFont`.
 *
 * @param themeText - The theme document actually being previewed.
 * @returns A single warning, or nothing when the theme inherits a real font catalogue.
 */
export function unavailableCalloutGlyphs(themeText: string): RenderDiagnostic[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(themeText);
  } catch {
    // Unparseable text is the parse problem's story to tell, and the preview is showing the last
    // good version anyway.
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  // A catalogue of its own may carry the glyphs; only an inherited-nothing theme is a certainty.
  // Both spellings count — the renderer flattens `font: {catalog: …}` and `font_catalog:` to one key.
  const font = entryOf(parsed, 'font');
  const declaresCatalogue =
    entryOf(parsed, 'font_catalog') !== undefined ||
    (typeof font === 'object' && font !== null && entryOf(font, 'catalog') !== undefined);
  if (declaresCatalogue) return [];

  const inherited = entryOf(parsed, 'extends');
  if (inherited !== undefined && !extendsBase(inherited)) return [];

  return [
    {
      severity: 'warning' as const,
      code: 'missing-glyph' as const,
      resource: THEME_CONUM_RESOURCE,
      message:
        'Callout numbers render as ¬ under this theme, and every callout gets the same character, ' +
        'so they cannot be told apart. Its fonts are the built-in AFM faces, which have no circled ' +
        'digits. Use `extends: default`, or declare a font catalogue with a font that has them.',
    },
  ];
}

/**
 * Render the built-in sample document under the theme currently being edited.
 *
 * @param themeText - The live theme document text from the editor.
 * @param isEnabled - False while the preview pane is closed; cancels pending renders.
 * @param enabledExtensions - Converter extensions to load, already with any held-out one removed by
 *   the comparison control. Defaults to none, which is what a theme opened outside a project gets.
 * @param extensions - The catalogue and Ruby source backing those ids.
 * @param themePath - The theme's project-relative path, which its font references resolve against.
 *   Defaults to a root-mounted stand-in for a theme opened outside a project.
 * @param assets - The project's asset cache, so fonts the theme names are fetched and embedded.
 *   Omitted outside a project, where the preview falls back to built-in faces.
 * @param projectAttributes - The project's resolved render attributes (page size, layout, media and
 *   the rest), so the sample is previewed on the page the export will actually produce. Must keep a
 *   stable identity across renders, since the snapshot is memoised on it. Empty outside a project.
 * @returns The preview state, including the last good render when the current text does not parse.
 */
export function useThemePreview(
  themeText: string,
  isEnabled: boolean,
  enabledExtensions: readonly string[] = NO_EXTENSIONS,
  extensions?: PdfExtensionBundle,
  themePath: string = THEME_PREVIEW_THEME_PATH,
  assets?: ProjectAssetCache,
  projectAttributes: Readonly<Record<string, string>> = NO_PROJECT_ATTRIBUTES,
): UseThemePreviewResult {
  const problem = themeParseProblem(themeText);

  // The last text that parsed. A ref rather than state: updating it must not itself cause a render,
  // and it is only ever read while computing the snapshot below.
  const lastGoodText = useRef<string>(problem === null ? themeText : '');
  if (problem === null) lastGoodText.current = themeText;
  const renderedText = lastGoodText.current;

  // Keyed on the CONTENTS of the extension list, not its identity: the caller derives it per render
  // (filtering the held-out one out), so a fresh array with the same ids must not schedule a render.
  const extensionKey = enabledExtensions.join(EXTENSION_KEY_SEPARATOR);

  // Memoised on the text that will actually be rendered, so keystrokes that leave the theme
  // unparseable — or that undo each other — hand `usePdfPreview` the SAME object and schedule nothing.
  // The fonts this theme names, fetched from the project through the SAME cache the document preview
  // and the export use — so a font already fetched for one is not fetched again for the other.
  const referenced = useMemo(
    () => themeResourcePaths(renderedText, themePath),
    [renderedText, themePath],
  );
  const fontAssets = useReferencedAssets(assets, referenced, isEnabled);

  const snapshot = useMemo(
    () =>
      buildThemeSnapshot(
        renderedText,
        themePath,
        extensionKey === '' ? NO_EXTENSIONS : extensionKey.split(EXTENSION_KEY_SEPARATOR),
        fontAssets,
        projectAttributes,
      ),
    [renderedText, themePath, extensionKey, fontAssets, projectAttributes],
  );

  // No `changedPaths`: that is the WARM re-render path, which rewrites only the named files. On the
  // first render it would leave the sample document out of the VFS entirely and the engine would
  // report the root document as missing. The snapshot is two files, so repopulating both costs
  // nothing worth risking that for.
  const preview = usePdfPreview({
    snapshot,
    isEnabled,
    ...(extensions === undefined ? {} : { extensions }),
  });

  // Derived from the text that is actually ON SCREEN in the preview, not the editor's latest — a
  // warning about a font in a version the author cannot see would be unattributable.
  const available = useMemo(
    () => new Set(fontAssets.map((asset: SnapshotFile) => asset.path)),
    [fontAssets],
  );
  const unresolved = useMemo(
    () => unresolvedThemeResources(referenced, available),
    [referenced, available],
  );
  // Same principle as the font warning above: derived from `renderedText`, the version actually on
  // screen, so it always describes the PDF the author is looking at.
  const calloutGlyphs = useMemo(() => unavailableCalloutGlyphs(renderedText), [renderedText]);
  const diagnostics = useMemo(
    () => [...unresolved, ...calloutGlyphs, ...preview.diagnostics],
    [unresolved, calloutGlyphs, preview.diagnostics],
  );

  return {
    pdf: preview.pdf,
    isRendering: preview.isRendering,
    diagnostics,
    error: preview.error,
    ...(problem === null ? {} : { parseProblem: problem }),
  };
}
