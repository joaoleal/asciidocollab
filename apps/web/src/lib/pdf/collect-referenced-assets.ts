/**
 * Enumerate the binary assets an AsciiDoc project references, so the in-browser PDF pipeline can fetch
 * their bytes and mount them for embedding. This is a PURE function over the reachable text files plus
 * the render attribute seed (no React, no I/O), so it is unit-testable in isolation.
 *
 * Two kinds of asset are collected:
 *  - IMAGES: every block (`image::`) and inline (`image:`) macro target across the reachable sources,
 *    resolved through {@link resolveImageTarget} so the returned project-relative path is IDENTICAL to
 *    the one Asciidoctor-PDF resolves the macro to (`:imagesdir:` + target, normalized). Mounting the
 *    fetched bytes at that exact key is what makes the engine find the picture instead of rendering its
 *    not-found placeholder.
 *  - FONTS: the font files a custom `:pdf-theme:` names in its font catalog, resolved relative to the
 *    theme file's own directory (asciidoctor-pdf's default). This is a targeted scan of the theme YAML,
 *    not a whole-tree sweep: any token that does not name a real font simply 404s on fetch and is
 *    skipped, so the scan is a safe superset.
 *
 * Remote/absolute/traversal targets are never returned — {@link resolveImageTarget} and the sandbox
 * guard reject them — so nothing outside the project is ever fetched (the no-egress invariant); the
 * render pipeline's own image-guard stage warns about those references separately.
 */

import { resolveThemePath } from '@asciidocollab/shared';
import { resolveImageTarget } from '@/lib/asciidoc/include-path';
import { resolveSandboxedPath } from '@/lib/asciidoc/sandbox-path';

/**
 * Matches an AsciiDoc block (`image::`) or inline (`image:`) macro, capturing the raw target. Mirrors
 * the render pipeline's image-guard scan so enumeration and the engine agree on what is referenced: the
 * target run excludes `[` and line breaks and is tempered with `(?!image:)` (so it halts at the next
 * macro and stays linear-time), and the attribute run excludes both brackets so it halts at the next `[`.
 */
const IMAGE_MACRO_PATTERN = /image:(:)?((?:(?!image:)[^[\n\r])+)\[[^\][]*\]/g;

/** A word character preceding `image:` means it is part of a larger token, not a macro. */
const WORD_CHARACTER = /\w/;

/**
 * A path-like token (no whitespace, quotes, colons, or brackets) as a theme font catalog names a font
 * file. A single character class keeps the scan linear-time; the font-extension test is done in code.
 */
const FONT_TOKEN_PATTERN = /[^\s'":\][]+/g;

/** Embeddable font-file extensions a theme catalog entry may point at. */
const FONT_FILE_EXTENSIONS: readonly string[] = ['.ttf', '.otf', '.woff', '.woff2'];

/**
 * Placeholders the RENDERER expands to a directory inside itself, which the project therefore never
 * contains and must never be asked for.
 *
 * `GEM_FONTS_DIR/notoserif-regular-subset.ttf` looks exactly like a project-relative font path — no
 * scheme, no `..` — so the sandbox check accepts it and it is reported as a font the project is
 * missing. The gem's own default theme names eight of them, and a newly created theme is a copy of
 * that file, so without this the first thing an author sees after creating a theme is eight
 * warnings about fonts that are in fact applied correctly.
 */
const RENDERER_FONT_DIR_PLACEHOLDERS: readonly string[] = ['GEM_FONTS_DIR'];

/** Plain, React-free inputs to {@link collectReferencedAssetPaths}. */
export interface CollectReferencedAssetsInput {
  /** The reachable project text files (project-relative path → content) to scan for asset references. */
  readonly files: Readonly<Record<string, string>>;
  /** The render attribute seed (lowercase name → value); supplies `:imagesdir:` and `:pdf-theme:`. */
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * The project-relative path of the theme file, so its named fonts can be resolved relative to its own
 * directory. An explicit `:pdf-theme:` wins; otherwise the first `*-theme.<yml|yaml>` in sorted order.
 */
function discoverThemePath(input: CollectReferencedAssetsInput): string | null {
  const explicit = input.attributes.get('pdf-theme')?.trim();
  const declared = explicit !== undefined && explicit !== '';
  const resolved = resolveThemePath(explicit, Object.keys(input.files));
  if (resolved === undefined) return null;
  // Only a DECLARED path is untrusted: a discovered one came from the project's own file list.
  if (!declared) return resolved;
  const sandboxed = resolveSandboxedPath('', resolved);
  return sandboxed.ok && input.files[sandboxed.path] !== undefined ? sandboxed.path : null;
}

/** Add every image macro target in `content`, resolved to its project-relative path, into `paths`. */
function collectImagePaths(
  content: string,
  attributes: ReadonlyMap<string, string>,
  paths: Set<string>,
): void {
  IMAGE_MACRO_PATTERN.lastIndex = 0;
  let match = IMAGE_MACRO_PATTERN.exec(content);
  while (match !== null) {
    const start = match.index;
    const precededByWord = start > 0 && WORD_CHARACTER.test(content.charAt(start - 1));
    const target = match[2].trim();
    if (!precededByWord && target.length > 0) {
      // resolveImageTarget applies `{attr}` substitution + `:imagesdir:` and yields the SAME normalized
      // path the engine resolves the macro to; remote/absolute/escaping targets return ok:false and are
      // dropped here so they are never fetched.
      const resolved = resolveImageTarget(target, attributes);
      if (resolved.ok) paths.add(resolved.path);
    }
    match = IMAGE_MACRO_PATTERN.exec(content);
  }
}

/** Add the font files the theme YAML names, resolved relative to the theme file's directory, into `paths`. */
function collectFontPaths(themePath: string, themeContent: string, paths: Set<string>): void {
  const tokens = themeContent.match(FONT_TOKEN_PATTERN);
  if (tokens === null) return;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!FONT_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue;
    // The renderer resolves these itself, out of its own bundle; the project has no such file and
    // asking for one produces a warning about a font that is actually working.
    if (RENDERER_FONT_DIR_PLACEHOLDERS.some((placeholder) => token.startsWith(placeholder))) continue;
    const resolved = resolveSandboxedPath(themePath, token);
    if (resolved.ok) paths.add(resolved.path);
  }
}

/**
 * Collect the project-relative paths of every binary asset the reachable document references.
 *
 * @param input - The reachable text files and the render attribute seed.
 * @returns The de-duplicated asset paths, sorted for deterministic fetch order.
 */
export function collectReferencedAssetPaths(input: CollectReferencedAssetsInput): string[] {
  const paths = new Set<string>();
  for (const content of Object.values(input.files)) {
    collectImagePaths(content, input.attributes, paths);
  }
  const themePath = discoverThemePath(input);
  if (themePath !== null) {
    const themeContent = input.files[themePath];
    if (themeContent !== undefined) collectFontPaths(themePath, themeContent, paths);
  }
  return [...paths].toSorted();
}
