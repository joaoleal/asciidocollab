/**
 * @file The theme-setting descriptor shape: what the theme editor knows about one Asciidoctor-PDF
 * theme key.
 *
 * Split across two producers on purpose. The STRUCTURAL facts — which keys exist, what kind of value
 * each takes, what the renderer's default is — are generated from the gem's own theme files, because
 * a hand-written list would drift out of agreement with the renderer at the first version bump and
 * start offering keys that do nothing. The PROSE — what a key means, and which words a keyword
 * setting accepts — cannot be derived from YAML that carries no documentation, so it is
 * hand-maintained and merged in.
 *
 * The types live here rather than in the generated module so the generator's output can be replaced
 * wholesale without disturbing anything that imports the shape.
 */

/** What kind of value a theme setting takes, which decides how the editor renders and validates it. */
export type ThemeValueKind =
  | 'colour'
  | 'font'
  | 'measurement'
  | 'keyword'
  | 'number'
  | 'boolean'
  | 'string';

/** The machine-derived half of a descriptor: everything the gem's theme files can tell us. */
export interface GeneratedThemeDescriptor {
  /** Dotted, hyphenated key as the theming guide writes it, e.g. `heading.h2.font-color`. */
  readonly key: string;
  /** The key's first segment, used to group completions, e.g. `heading`. */
  readonly category: string;
  /** How the editor should preview and validate this setting's value. */
  readonly valueKind: ThemeValueKind;
  /** For a keyword setting, the words the renderer accepts. */
  readonly permittedValues?: readonly string[];
  /** The default theme's value, as an author would type it. */
  readonly defaultValue?: string;
}

/** A descriptor as the editor consumes it: the derived facts plus the hand-written description. */
export interface ThemeSettingDescriptor extends GeneratedThemeDescriptor {
  /** One line explaining what the setting does. Empty when no description has been written yet. */
  readonly description: string;
  /**
   * The extension that contributes this setting, when it is not a renderer built-in. Present only
   * while that extension is enabled, so a theme cannot be completed with keys nothing will read.
   */
  readonly contributedBy?: string;
}
