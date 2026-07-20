/**
 * @file The single rule deciding whether a project file is an Asciidoctor-PDF theme.
 *
 * Three surfaces ask this question and MUST agree: the editor (which opens a theme in the YAML theme
 * editor and marks it in the file tree), the renderer (which discovers the theme to apply when no
 * `:pdf-theme:` is declared), and the server (which decides an uploaded theme is a co-editable
 * document rather than an opaque asset). Before this module the first two each carried their own copy
 * of the rule, and the copies had already drifted — one lowercased the extension but not the `-theme`
 * suffix, so `Corporate-Theme.yml` was a theme to one and an ordinary YAML file to the other. The
 * result was a file the editor treated as a theme whose styling never reached the exported PDF.
 *
 * It lives in this zero-dependency leaf for the reason the package exists: the server ring and the
 * browser ring both need it, and `domain` may not import outward into `shared`. One copy, imported by
 * both, is the only arrangement in which they cannot disagree.
 *
 * Recognition is by FILENAME ALONE. Contents are never sniffed: a file becomes a theme, or stops
 * being one, purely by rename, and an author can predict which files are themes by looking at the
 * tree.
 */

/** Filename extensions a theme document may carry, compared case-insensitively. */
const THEME_EXTENSIONS: readonly string[] = ['yml', 'yaml'];

/** The suffix a theme's name carries before its extension, compared case-insensitively. */
const THEME_NAME_SUFFIX = '-theme';

/**
 * The naming convention, in the form shown to authors (for example when explaining why a file is not
 * offered as a theme, or what to name a new one).
 */
export const THEME_FILENAME_CONVENTION = `*${THEME_NAME_SUFFIX}.${THEME_EXTENSIONS[0]}`;

/**
 * Whether a project-relative path names an Asciidoctor-PDF theme document.
 *
 * @param path - A project-relative file path, for example `branding/corporate-theme.yml`.
 * @returns `true` when the path's final segment matches the `*-theme.<yml|yaml>` convention.
 */
export function isThemeFilePath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = basename.lastIndexOf('.');
  // `dot <= 0` covers both "no extension" and a leading-dot dotfile, neither of which is a theme.
  if (dot <= 0) return false;
  if (!THEME_EXTENSIONS.includes(basename.slice(dot + 1))) return false;
  return basename.slice(0, dot).endsWith(THEME_NAME_SUFFIX);
}

/** Every theme document among a project's text files, in the deterministic order resolution uses. */
export function themeFilePaths(textPaths: readonly string[]): string[] {
  return textPaths.filter(isThemeFilePath).toSorted();
}

/**
 * Which theme document a project renders with: the declared selection if it made one, otherwise the
 * first theme file in sorted order.
 *
 * The renderer needs this to build a snapshot and the options page needs it to tell an owner which
 * file their project currently resolves to (FR-025). Those two answers being computed separately is
 * exactly how a settings page comes to advertise a theme the export does not apply, so both call this.
 *
 * Sorting — rather than tree order — is what makes the automatic choice deterministic: adding an
 * unrelated file must not silently change which theme a project renders with.
 *
 * @param declared - The project's explicit theme selection (`pdf-theme`), if any.
 * @param textPaths - Every text file in the project, as project-relative paths.
 * @returns The resolved theme path, or undefined when the project has no theme at all.
 */
export function resolveThemePath(
  declared: string | undefined,
  textPaths: readonly string[],
): string | undefined {
  const trimmed = declared?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  return themeFilePaths(textPaths)[0];
}
