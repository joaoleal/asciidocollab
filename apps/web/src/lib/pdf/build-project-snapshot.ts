/**
 * Capture an immutable {@link ProjectSnapshot} of the editor's project state for the in-browser PDF
 * pipeline. This is a PURE function: it takes the already-collected file records, the resolved
 * main/open file paths, and the project attribute seed as plain parameters (no React, no hooks), so
 * it is unit-testable in isolation. The hook wiring that gathers `getFiles()` + fetches binary asset
 * bytes + resolves the main/selected file ids to paths lives at the composition root.
 *
 * Every path is validated with the app's client-side sandbox guard: remote-looking or project-
 * escaping targets are excluded from the snapshot and surfaced in `excluded` (never silently
 * dropped), matching the constitution's no-egress / sandbox invariants.
 */

import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import { resolveThemePath, stripSoftDefault } from '@asciidocollab/shared';
import { imagesDirectory } from '@/lib/asciidoc/include-path';
import { PDF_RENDER_INTRINSIC_ATTRIBUTES } from '@/lib/asciidoc/render-intrinsics';
import { resolveSandboxedPath, type SandboxedPathResult } from '@/lib/asciidoc/sandbox-path';

/** Why a referenced path was rejected by the sandbox guard. */
export type SnapshotPathRejection = Extract<SandboxedPathResult, { ok: false }>['reason'];

/**
 * A single project file captured for the snapshot: either editor-live text (AsciiDoc / YAML theme /
 * `.bib`) or an opaque binary asset (image / font). The producer classifies each record; this
 * function trusts that classification for the text/binary partition of the snapshot.
 */
export type SnapshotFile =
  | { readonly path: string; readonly kind: 'text'; readonly content: string }
  | { readonly path: string; readonly kind: 'binary'; readonly bytes: Uint8Array };

/** A path excluded from the snapshot because it failed sandbox validation. */
export interface ExcludedPath {
  /** The offending raw path as supplied. */
  readonly path: string;
  /** The sandbox rejection reason. */
  readonly reason: SnapshotPathRejection;
}

/** Plain, React-free inputs to {@link buildProjectSnapshot}. */
export interface BuildProjectSnapshotInput {
  /** All captured project files, text and binary, keyed by their project-relative paths. */
  readonly files: readonly SnapshotFile[];
  /** The configured main-file path (root of the render), or null when none is set. */
  readonly mainPath: string | null;
  /** The currently-open file path (preview focus, and the root fallback when no main file). */
  readonly openPath: string;
  /** The project attribute seed (lowercase name → value) inherited at the render root. */
  readonly attributes: ReadonlyMap<string, string>;
  /**
   * Extra project-relative font directories from the project render config, to APPEND to the PDF font
   * search path. Each is sandbox-validated here; escaping entries are dropped into `excluded`.
   */
  readonly extraFontDirs?: readonly string[];
  /**
   * The converter extensions the project has enabled, as ids.
   *
   * Ids only, never code and never paths — the renderer resolves each one against the deployment's
   * own catalogue, so a snapshot travelling from the browser to the worker carries nothing executable
   * however the project is configured (FR-034, FR-035).
   */
  readonly enabledExtensions?: readonly string[];
}

/** The captured snapshot plus every path the sandbox refused. */
export interface BuildProjectSnapshotResult {
  /** The immutable snapshot handed to the render pipeline. */
  readonly snapshot: ProjectSnapshot;
  /** Paths dropped because they were remote/absolute/escaping — surfaced for diagnostics. */
  readonly excluded: readonly ExcludedPath[];
}

/**
 * The synthetic referencing path used to validate a project-relative path against the project root:
 * an empty base makes the root directory itself the resolution base, so any `..`/absolute/remote
 * target is rejected.
 */
const PROJECT_ROOT_BASE = '';

/** Asciidoctor-PDF's theme selector attribute. */
const THEME_ATTRIBUTE = 'pdf-theme';
/** Asciidoctor-bibtex's bibliography-source attribute. */
const BIBTEX_ATTRIBUTE = 'bibtex-file';

/**
 * File extensions mounted as custom fonts. TTF/OTF embed directly; WOFF2 is converted to TTF by the
 * render pipeline's asset-mount stage, so a fetched WOFF2 theme font is derived here as a font too.
 */
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['ttf', 'otf', 'woff2']);
/** The bibliography source extension. */
const BIBTEX_EXTENSION = 'bib';

/** The lowercase extension of a path (without the dot), or `''` when it has none. */
function extensionOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The final path segment. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Build a {@link ProjectSnapshot} from captured editor state.
 *
 * @param input - The project files, main/open paths, and attribute seed.
 * @returns The snapshot and any sandbox-excluded paths.
 */
export function buildProjectSnapshot(input: BuildProjectSnapshotInput): BuildProjectSnapshotResult {
  const excluded: ExcludedPath[] = [];
  // Sandbox-validate a project-relative path; on rejection, record it and return null so the caller
  // can skip it. The normalized (canonical) path is returned on success and used as the key.
  const sandbox = (path: string): string | null => {
    const result = resolveSandboxedPath(PROJECT_ROOT_BASE, path);
    if (result.ok) return result.path;
    excluded.push({ path, reason: result.reason });
    return null;
  };

  const files: Record<string, string> = {};
  const binaryAssets: Record<string, Uint8Array> = {};
  const textPaths: string[] = [];
  const binaryPaths: string[] = [];

  for (const file of input.files) {
    const safe = sandbox(file.path);
    if (safe === null) continue;
    if (file.kind === 'text') {
      files[safe] = file.content;
      textPaths.push(safe);
    } else {
      binaryAssets[safe] = file.bytes;
      binaryPaths.push(safe);
    }
  }

  // Seed the render attributes: the intrinsic defaults first, project attributes overriding. The
  // same merged map drives :imagesdir:/discovery so the snapshot's attributes and the paths derived
  // from them stay consistent.
  //
  // The PDF set, not the html5 one. These become API attributes, which OVERRIDE the document header,
  // so seeding `doctype: article` here silently demoted every book the app rendered — no title page,
  // no chapters, whatever the author declared. See PDF_RENDER_INTRINSIC_ATTRIBUTES.
  const merged = new Map<string, string>(PDF_RENDER_INTRINSIC_ATTRIBUTES);
  for (const [name, value] of input.attributes) merged.set(name, value);
  const attributes: Record<string, string> = Object.fromEntries(merged);

  const rootPath = input.mainPath ?? input.openPath;

  // Project-config values may carry the overridable soft-default `@` marker (kept in `attributes` for
  // the engine). Path DISCOVERY must read the raw value, so strip a trailing marker here.
  const rawAttribute = (name: string): string | undefined => {
    const value = merged.get(name);
    return value === undefined ? undefined : stripSoftDefault(value);
  };

  let imagesDirectoryPath: string | undefined;
  const rawImagesDirectory = stripSoftDefault(imagesDirectory(merged));
  if (rawImagesDirectory !== '') {
    const safeDirectory = sandbox(rawImagesDirectory);
    if (safeDirectory !== null) imagesDirectoryPath = safeDirectory;
  }

  const themePath = discoverThemePath(rawAttribute(THEME_ATTRIBUTE), textPaths, sandbox);
  const bibPath = discoverBibPath(rawAttribute(BIBTEX_ATTRIBUTE), textPaths, sandbox);
  const fontPaths = binaryPaths.filter((path) => FONT_EXTENSIONS.has(extensionOf(path))).toSorted();

  // Sandbox-validate each configured extra font directory; escaping entries are dropped into `excluded`.
  const extraFontDirectories: string[] = [];
  for (const directory of input.extraFontDirs ?? []) {
    const safe = sandbox(directory);
    if (safe !== null) extraFontDirectories.push(safe);
  }

  // Defence in depth: a configured path attribute the sandbox REJECTED must not reach the engine
  // either. Drop it from the attribute map so the converter falls back to its own default (the
  // intrinsic set never defines these three, so nothing masks the removal). The `/project`+`/out` VFS
  // already confines a stray value, but a rejected path should never be handed to the converter at all.
  if (rawImagesDirectory !== '' && imagesDirectoryPath === undefined) delete attributes.imagesdir;
  const rawTheme = rawAttribute(THEME_ATTRIBUTE)?.trim();
  if (rawTheme !== undefined && rawTheme !== '' && themePath === undefined) delete attributes[THEME_ATTRIBUTE];
  const rawBib = rawAttribute(BIBTEX_ATTRIBUTE)?.trim();
  if (rawBib !== undefined && rawBib !== '' && bibPath === undefined) delete attributes[BIBTEX_ATTRIBUTE];

  const snapshot: ProjectSnapshot = {
    files,
    binaryAssets,
    rootPath,
    openPath: input.openPath,
    ...(themePath === undefined ? {} : { themePath }),
    fontPaths,
    ...(extraFontDirectories.length === 0 ? {} : { extraFontDirs: extraFontDirectories }),
    ...(imagesDirectoryPath === undefined ? {} : { imagesDir: imagesDirectoryPath }),
    ...(bibPath === undefined ? {} : { bibPath }),
    attributes,
    ...((input.enabledExtensions ?? []).length === 0
      ? {}
      : { enabledExtensions: input.enabledExtensions }),
  };

  return { snapshot, excluded };
}

/**
 * Discover the PDF theme document: an explicit `:pdf-theme:` (sandbox-checked) wins; otherwise the
 * first project file (in sorted order, for determinism) matching the `<name>-theme.<yml|yaml>`
 * convention.
 */
function discoverThemePath(
  explicit: string | undefined,
  textPaths: readonly string[],
  sandbox: (path: string) => string | null,
): string | undefined {
  const declared = explicit?.trim();
  const resolved = resolveThemePath(explicit, textPaths);
  if (resolved === undefined) return undefined;
  // Only a DECLARED path is untrusted and needs the sandbox check; a discovered one is by
  // construction a path out of this project's own tree.
  if (declared === undefined || declared === '') return resolved;
  // A DECLARED path is untrusted: sandbox it, and require it to actually be one of the project's
  // files. A theme the config names but the project does not contain is "no theme", not a snapshot
  // carrying a themePath absent from `files` — which would skip the alias mount and silently fall
  // back to the default while the sibling collector (collect-referenced-assets) already treats it as
  // absent. Both must agree.
  const safe = sandbox(resolved);
  if (safe === null || !textPaths.includes(safe)) return undefined;
  return safe;
}

/**
 * Discover the bibliography source: an explicit `:bibtex-file:` (sandbox-checked) wins; otherwise the
 * first `.bib` project file (in sorted order, for determinism).
 */
function discoverBibPath(
  explicit: string | undefined,
  textPaths: readonly string[],
  sandbox: (path: string) => string | null,
): string | undefined {
  const declared = explicit?.trim();
  if (declared !== undefined && declared !== '') {
    return sandbox(declared) ?? undefined;
  }
  const candidates = textPaths.filter((path) => extensionOf(path) === BIBTEX_EXTENSION).toSorted();
  return candidates[0];
}
