/**
 * @file The asset-mount pre-processing stage. The project's theme YAML, images, and TTF/OTF fonts are
 * already written to the in-memory `/project` VFS by {@link populateProject} (they mount byte-for-byte),
 * and the convert points `pdf-themesdir`/`pdf-fontsdir`/`imagesdir` at their original directories. So
 * this stage's ONLY job is the one thing populate cannot do: make a CUSTOM WOFF2 font embeddable.
 *
 * Asciidoctor-PDF/prawn embeds TTF and OTF only — WOFF2 is unsupported (it is not even mentioned in the
 * font-support manual). WOFF2 is a compressed wrapper around exactly such an sfnt, so a custom WOFF2
 * font is DECOMPRESSED (via the injected {@link FontConverter}) back to the original TTF/OTF bytes the
 * font author prepared — losslessly, preserving its glyphs and `kern` table.
 *
 * Crucially, the decoded bytes are NOT written back to the `.woff2` name: prawn dispatches font loading
 * by FILE EXTENSION, so a `.woff2`-named file — even one holding valid TTF bytes — hits prawn's AFM
 * branch and fails to embed (the convert can even abort with "…`.woff2`… is not a known font"). The
 * decoded sfnt is therefore materialized under a `.ttf` BASE NAME in the same directory, and the stale
 * `.woff2` asset is dropped. The project theme's font catalogue — which names each font by base name
 * within `pdf-fontsdir` — is repointed from the `.woff2` name to the `.ttf` in the already-mounted VFS
 * copy the convert reads; that repoint is what makes the font embed.
 *
 * The snapshot's `fontPaths` deliberately stays untouched (the pipeline never mutates its immutable
 * input snapshot): the convert derives `pdf-fontsdir` from each font's DIRECTORY, which is unchanged
 * when the decode swaps only the extension in place, so the `.ttf` resolves from the same search dir.
 *
 * The converter is supplied at the worker composition root (kept out of this package so the stage stays
 * unit-testable with a fake). An unavailable font, or one that cannot be decoded, becomes a non-fatal
 * `font-unavailable` warning with a predictable fallback to the default font — the stage never aborts.
 */

import type { PipelineStage, StageContext, StageResult } from '../orchestrator';
import type { DiagnosticCode, PipelineStageKind, ProjectSnapshot, RenderDiagnostic } from '../../protocol';
import { PROJECT_ROOT } from '../../vfs/populate';

/**
 * Losslessly decompresses a WOFF2 font back to the embeddable TTF/OTF sfnt it wraps. The concrete
 * converter is supplied at the worker composition root; the stage depends only on this narrow port so
 * it stays testable with a fake.
 */
export interface FontConverter {
  /**
   * Decompress WOFF2 bytes to the original TTF/OTF sfnt prawn/ttfunk can embed.
   *
   * @param bytes - The source WOFF2 font bytes to decode.
   * @returns The embeddable TTF/OTF (sfnt) bytes the WOFF2 wraps.
   */
  woff2ToTtf(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Dependencies injected into the asset-mount stage at construction time. */
export interface MountAssetsDeps {
  /** The WOFF2→TTF/OTF decoder used for custom WOFF2 project fonts. */
  readonly fontConverter: FontConverter;
}

/** This stage's fixed position in the pipeline order. */
const STAGE_KIND: PipelineStageKind = 'mount-assets';

const PATH_SEPARATOR = '/';
const EXTENSION_SEPARATOR = '.';

const TTF_EXTENSION = 'ttf';
const OTF_EXTENSION = 'otf';
const WOFF2_EXTENSION = 'woff2';

/** Font formats prawn/ttfunk embeds directly; populate already mounted these byte-for-byte. */
const EMBEDDABLE_FONT_EXTENSIONS: ReadonlySet<string> = new Set([TTF_EXTENSION, OTF_EXTENSION]);

const FONT_UNAVAILABLE: DiagnosticCode = 'font-unavailable';

/** The lowercased file extension of a path's last segment, or `''` when it has none. */
function extensionOf(path: string): string {
  const lastSegment = path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
  const dot = lastSegment.lastIndexOf(EXTENSION_SEPARATOR);
  return dot === -1 ? '' : lastSegment.slice(dot + 1).toLowerCase();
}

/** The last path segment (file name) of a project-relative path. */
function leafName(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
}

/** Swap a path's file extension for `.ttf`, preserving its directory and base name. */
function withTtfExtension(path: string): string {
  const dot = path.lastIndexOf(EXTENSION_SEPARATOR);
  const stem = dot === -1 ? path : path.slice(0, dot);
  return `${stem}${EXTENSION_SEPARATOR}${TTF_EXTENSION}`;
}

/** The absolute `/project` path a project-relative asset was mounted at by {@link populateProject}. */
function projectMountPath(assetPath: string): string {
  return `${PROJECT_ROOT}${PATH_SEPARATOR}${assetPath}`;
}

/** Build a non-fatal font warning that falls back to the default font. */
function fontWarn(resource: string, message: string): RenderDiagnostic {
  return { severity: 'warning', code: FONT_UNAVAILABLE, resource, message };
}

/** A decoded WOFF2 font's mapping from its original `.woff2` name to the `.ttf` it now embeds as. */
interface FontRepoint {
  /** The source `.woff2` project-relative font path. */
  readonly woff2Path: string;
  /** The `.ttf` project-relative path the decoded sfnt was materialized at. */
  readonly ttfPath: string;
}

/** The outcome of mounting one custom font: an optional warning and/or a `.woff2`→`.ttf` repoint. */
interface FontMountResult {
  /** A non-fatal warning when the font was unavailable, undecodable, or an unsupported format. */
  readonly diagnostic: RenderDiagnostic | null;
  /** The repoint to apply when a WOFF2 font was decoded to an embeddable `.ttf`. */
  readonly repoint: FontRepoint | null;
}

/**
 * Make one custom font embeddable. TTF/OTF are already embeddable (populate mounted them) so this is a
 * no-op; a WOFF2 font is decoded to its TTF/OTF sfnt, written under a `.ttf` base name, and its `.woff2`
 * asset dropped — returning the repoint the caller applies to `fontPaths` and the theme. Returns a
 * diagnostic when the font is unavailable, cannot be decoded, or is an unsupported format — never throws.
 */
async function mountFont(
  context: StageContext,
  deps: MountAssetsDeps,
  snapshot: ProjectSnapshot,
  fontPath: string,
): Promise<FontMountResult> {
  const extension = extensionOf(fontPath);
  if (EMBEDDABLE_FONT_EXTENSIONS.has(extension)) {
    return { diagnostic: null, repoint: null };
  }
  if (extension !== WOFF2_EXTENSION) {
    return {
      diagnostic: fontWarn(
        fontPath,
        `Custom font "${fontPath}" has an unsupported format and was skipped; the default font is used instead.`,
      ),
      repoint: null,
    };
  }
  const bytes = snapshot.binaryAssets[fontPath];
  if (bytes === undefined) {
    return {
      diagnostic: fontWarn(
        fontPath,
        `Custom font "${fontPath}" was unavailable and skipped; the default font is used instead.`,
      ),
      repoint: null,
    };
  }
  try {
    const ttf = await deps.fontConverter.woff2ToTtf(bytes);
    const ttfPath = withTtfExtension(fontPath);
    // Materialize the decoded sfnt under a `.ttf` name prawn will actually load, then drop the `.woff2`
    // asset — a `.woff2`-named file (even holding TTF bytes) fails prawn's extension dispatch.
    context.vfs.writeFile(projectMountPath(ttfPath), ttf);
    context.vfs.remove(projectMountPath(fontPath));
    return { diagnostic: null, repoint: { woff2Path: fontPath, ttfPath } };
  } catch {
    return {
      diagnostic: fontWarn(
        fontPath,
        `Custom WOFF2 font "${fontPath}" could not be decoded to an embeddable format and was skipped; the default font is used instead.`,
      ),
      repoint: null,
    };
  }
}

/**
 * Repoint the project theme's font catalogue from each decoded font's `.woff2` file name to the `.ttf`
 * it now embeds. The theme names each font by base name within `pdf-fontsdir`, and prawn dispatches by
 * extension, so a stale `.woff2` catalogue entry would fail to embed even though the mounted bytes are
 * TTF. The theme is rewritten in the already-mounted `/project` VFS copy the convert reads.
 */
function repointThemeCatalogue(
  context: StageContext,
  snapshot: ProjectSnapshot,
  repoints: readonly FontRepoint[],
): void {
  const { themePath } = snapshot;
  if (themePath === undefined) {
    return;
  }
  const themeVfsPath = projectMountPath(themePath);
  const original = context.vfs.readText(themeVfsPath);
  if (original === null) {
    return;
  }
  let updated = original;
  for (const { woff2Path, ttfPath } of repoints) {
    updated = updated.split(leafName(woff2Path)).join(leafName(ttfPath));
  }
  if (updated !== original) {
    context.vfs.writeText(themeVfsPath, updated);
  }
}

/**
 * Build the asset-mount stage. Theme, images, and TTF/OTF fonts are already mounted by populate; this
 * stage decodes each custom WOFF2 font to its embeddable `.ttf` sfnt, drops the `.woff2`, repoints the
 * theme catalogue to the `.ttf`, and warns — without aborting — on any font that is unavailable or
 * cannot be decoded. The immutable input snapshot is never mutated; every rewrite lands in the VFS.
 */
export function createMountAssetsStage(deps: MountAssetsDeps): PipelineStage {
  return {
    kind: STAGE_KIND,
    run: async (context: StageContext): Promise<StageResult> => {
      const { snapshot } = context.request;
      const diagnostics: RenderDiagnostic[] = [];
      const repoints: FontRepoint[] = [];
      for (const fontPath of snapshot.fontPaths) {
        const { diagnostic, repoint } = await mountFont(context, deps, snapshot, fontPath);
        if (diagnostic !== null) {
          diagnostics.push(diagnostic);
        }
        if (repoint !== null) {
          repoints.push(repoint);
        }
      }
      if (repoints.length > 0) {
        repointThemeCatalogue(context, snapshot, repoints);
      }
      return { diagnostics };
    },
  };
}
