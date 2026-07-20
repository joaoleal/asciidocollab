/**
 * @file Syntax highlighting for the theme editor's YAML, in the app's own light/dark palette.
 *
 * The theme editor mounted CodeMirror's `defaultHighlightStyle`, which is a LIGHT-BACKGROUND style:
 * its colours are fixed hex values chosen against white. On the app's dark surface that left YAML
 * keys as dark blue on near-black — legible only if you already knew what they said.
 *
 * The AsciiDoc editor solved this once already, by reading every colour from the `--syntax-*` CSS
 * variables in globals.css, which carry a light value and a dark value. So the fix here is not a
 * second dark theme but the SAME tokens applied to YAML's tag set: light and dark follow the app with
 * no JavaScript switching and no second palette to keep in sync.
 *
 * The mapping leans on what a theme author is actually scanning for. Keys are the structure they
 * navigate by, so they take the heading token; values are what they are changing, so strings, numbers
 * and booleans stay distinguishable from each other; and `$base-font-size`-style references are
 * variables rather than prose, so they take the attribute token that the AsciiDoc editor already uses
 * for the same idea.
 */
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Builds an `hsl(var(--name))` colour string — the same helper shape the AsciiDoc theme uses. */
const c = (name: string) => `hsl(var(${name}))`;

/**
 * The theme editor's YAML highlight style.
 *
 * Every colour is a CSS variable that globals.css defines twice, once per scheme, so this single
 * definition is correct on both. Nothing here hard-codes a colour.
 */
export const themeYamlHighlightStyle = HighlightStyle.define([
  // Mapping keys: the structure of a theme, and what an author scans to find their way.
  { tag: [t.definition(t.propertyName), t.propertyName], color: c('--syntax-heading'), fontWeight: '600' },

  // Values, kept distinct from one another so a mistyped kind is visible as a colour change.
  { tag: [t.string, t.special(t.string)], color: c('--syntax-string') },
  { tag: [t.number, t.integer, t.float], color: c('--syntax-link') },
  { tag: [t.bool, t.null, t.atom], color: c('--syntax-keyword') },

  // `$base-line-height-length / $base-font-size` — a reference to another setting, not prose.
  { tag: [t.variableName, t.attributeValue], color: c('--syntax-attr') },

  // Structural punctuation stays quiet: the colons and dashes are scaffolding, not content.
  { tag: [t.punctuation, t.separator, t.bracket, t.brace], color: c('--syntax-punct') },

  // Anchors, aliases and tags (`&base`, `*base`, `!!str`).
  { tag: [t.labelName, t.typeName, t.meta], color: c('--syntax-keyword') },

  { tag: [t.comment, t.lineComment, t.blockComment], color: c('--syntax-comment'), fontStyle: 'italic' },

  // A malformed document still highlights; the invalid run is simply marked.
  { tag: t.invalid, color: c('--destructive')},
]);
