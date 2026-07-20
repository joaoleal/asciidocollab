/**
 * @file The starting content for a newly created theme file.
 *
 * A theme created empty is unusable as a starting point: an author faced with a blank YAML file has
 * no way to discover which of ~180 settings exist, and a theme that sets nothing renders identically
 * to no theme at all, so their first preview would show no evidence the file was doing anything.
 *
 * The seed is therefore a COPY of the gem's own `default-theme.yml` — the file the renderer actually
 * applies when a project defines no theme (FR-010). Copying rather than synthesising is what makes
 * "the effective default theme as your starting point" exact: the author's first preview is
 * byte-identical to what they saw before creating the file, so every subsequent difference is
 * something they did.
 */
import { DEFAULT_THEME_GEM_VERSION, DEFAULT_THEME_YAML } from '@asciidocollab/shared';

/**
 * A short header explaining where the content came from, prepended to the copy.
 *
 * The version matters: an author comparing their theme against the upstream default needs to know
 * which release it was taken from, and a theme outlives the gem version it was seeded from.
 */
const SEED_HEADER = `# Seeded from the Asciidoctor-PDF ${DEFAULT_THEME_GEM_VERSION} default theme.
# Every setting below is the renderer's own default, so this file renders exactly as no theme would
# until you change something. Delete anything you do not want to override.
`;

/**
 * The content a newly created theme file starts with.
 *
 * @returns The default theme, preceded by a header naming the release it was copied from.
 */
export function themeSeedContent(): string {
  return `${SEED_HEADER}\n${DEFAULT_THEME_YAML}`;
}
