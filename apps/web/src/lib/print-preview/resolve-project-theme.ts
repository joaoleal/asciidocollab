/**
 * @file Which theme document the Print preview dresses the page in.
 *
 * The answer must be the PDF export's answer. If the preview picked its theme by a rule of its own,
 * the two would agree until the day a project had two theme files or declared one explicitly — and
 * then the preview would confidently show an appearance the export does not produce, which is worse
 * than showing no appearance at all. So the choice is made by `resolveThemePath`, the same function
 * the export's snapshot builder calls, and nothing here re-implements any part of it.
 *
 * The content comes from the file snapshot the preview already holds. That snapshot merges the live
 * editor buffers over the auxiliary text cache, so an author editing their theme sees the page they
 * are typing rather than the last-saved one — a theme is never `include`-reachable, which is exactly
 * why that cache exists.
 */

import { resolveThemePath } from '@asciidocollab/shared';

/** What to resolve a theme from. */
export interface ProjectThemeInput {
  /** Project-relative path → text content, for every text file the preview holds. */
  readonly files: Readonly<Record<string, string>>;
  /** The project's explicit `pdf-theme` selection, if it made one. */
  readonly declaredThemePath?: string;
}

/** The theme document the preview applies, or nothing when the project has none. */
export interface ProjectTheme {
  /** The theme's project-relative path, for attributing a diagnostic to a file. */
  readonly themePath?: string;
  /** The theme document's text. */
  readonly themeText?: string;
}

/** Nothing to apply. A shared constant, so a project with no theme keeps one stable result. */
const NO_THEME: ProjectTheme = {};

/**
 * Resolve the theme document the Print preview applies.
 *
 * @param input - The files the preview holds and the project's declared selection.
 * @returns The theme's path and text, or an empty result when the project has no theme to apply.
 */
export function resolveProjectTheme(input: ProjectThemeInput): ProjectTheme {
  const declared = input.declaredThemePath?.trim();
  const resolved = resolveThemePath(declared, Object.keys(input.files));
  if (resolved === undefined) return NO_THEME;

  // A declared path is untrusted, and is only ever read out of the snapshot the preview holds — so
  // requiring it to BE one of those files is the whole check. A project that names a theme it does
  // not contain has no theme, rather than a path with nothing behind it: the export decides the same
  // way, and a preview that decided otherwise would show a themed page for an unthemed export.
  const text = Object.hasOwn(input.files, resolved) ? input.files[resolved] : undefined;
  if (text === undefined) return NO_THEME;

  return { themePath: resolved, themeText: text };
}
