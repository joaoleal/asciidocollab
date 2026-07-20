/**
 * @file The theme-setting catalogue the editor consults: generated structure merged with
 * hand-written prose, plus the lookup rules that make a key written one way match a descriptor
 * recorded another.
 *
 * Asciidoctor-PDF flattens a theme to underscore-joined keys before it reads anything, which means
 * `heading: {h1: {font-size: 24}}`, `heading: {h1-font-size: 24}` and `heading_h1_font_size: 24` are
 * the SAME setting to the renderer. An editor that compared keys literally would mark two of those
 * three as unknown and refuse to complete them, so every lookup here goes through
 * {@link canonicalThemeKey} — the same normalisation the renderer performs.
 */

import { GENERATED_THEME_DESCRIPTORS } from './theme-descriptors.generated';
import { THEME_DESCRIPTIONS } from './theme-descriptions';
import type {
  GeneratedThemeDescriptor,
  ThemeSettingDescriptor,
} from './theme-descriptor-types';

/**
 * Reduce a theme key to the form the renderer compares on: lowercase, with every nesting dot and
 * every hyphen collapsed to an underscore.
 *
 * @param key - A key in any of the forms an author may write, dotted or already flat.
 * @returns The canonical flat key.
 */
export function canonicalThemeKey(key: string): string {
  return key.toLowerCase().replaceAll('.', '_').replaceAll('-', '_');
}

/**
 * Settings the renderer honours that the generator cannot see, because NO theme file sets them.
 *
 * `extends` is the load-bearing one: it is how a theme inherits, it opens most documented themes,
 * and neither `base-theme.yml` nor `default-theme.yml` uses it — because they ARE the things being
 * extended. Carrying it here rather than only as a "known key" is what makes completion offer it and
 * hover explain it, which matters because choosing wrongly is not cosmetic: a theme that inherits
 * nothing gets the built-in AFM fonts and renders callouts as `¬`.
 *
 * `string`, deliberately, NOT `keyword`: `extends` also takes a path (`extends: ./house.yml`), so
 * enumerating `default`/`base` would flag a legitimate theme as an error.
 */
const EXTRA_DESCRIPTORS: readonly GeneratedThemeDescriptor[] = [
  { key: 'extends', category: 'extends', valueKind: 'string' },
];

/** Every theme setting the renderer recognises, with its description merged in. */
export const THEME_SETTINGS: readonly ThemeSettingDescriptor[] = [
  ...GENERATED_THEME_DESCRIPTORS,
  ...EXTRA_DESCRIPTORS,
].map((generated) => ({
  ...generated,
  description: THEME_DESCRIPTIONS[generated.key] ?? '',
}));

/** Canonical key → descriptor, for the lookups completion and validation do per keystroke. */
const BY_CANONICAL_KEY: ReadonlyMap<string, ThemeSettingDescriptor> = new Map(
  THEME_SETTINGS.map((descriptor) => [canonicalThemeKey(descriptor.key), descriptor]),
);

/**
 * The descriptor for a theme key, however the author wrote it.
 *
 * @param key - The key as written in the document, dotted or flat, in any case.
 * @param contributed - Descriptors contributed by the project's enabled extensions, searched first
 *   so an extension's own description wins for its own key.
 * @returns The descriptor, or undefined when the renderer would not recognise the key either.
 */
export function themeSetting(
  key: string,
  contributed: readonly ThemeSettingDescriptor[] = [],
): ThemeSettingDescriptor | undefined {
  const canonical = canonicalThemeKey(key);
  const fromExtension = contributed.find(
    (descriptor) => canonicalThemeKey(descriptor.key) === canonical,
  );
  return fromExtension ?? BY_CANONICAL_KEY.get(canonical);
}

/** Whether this key is one the catalogue carries a descriptor for. Drives completion and widgets. */
export function isKnownThemeKey(key: string): boolean {
  return BY_CANONICAL_KEY.has(canonicalThemeKey(key));
}

/**
 * Top-level keys the renderer honours that no theme file sets, so the generator cannot see them.
 *
 * `extends` is the load-bearing one: it is how a theme inherits from `base` or `default`, it appears
 * in the first line of most documented themes, and neither `base-theme.yml` nor `default-theme.yml`
 * uses it — because they ARE the things being extended.
 */
const EXTRA_KNOWN_KEYS: ReadonlySet<string> = new Set(['extends']);

/**
 * Namespaces whose second segment is a name the AUTHOR invents, not one the renderer defines.
 *
 * `role.removed.font-style` is a perfectly good setting — `removed` is a custom role the document
 * applies with `[.removed]#…#`. The catalogue can only ever contain the handful of roles the default
 * theme happens to define, so anything under these prefixes is judged on its property leaf alone.
 */
const OPEN_NAMESPACES: readonly string[] = [
  'role',
  'font_catalog',
  'font_fallbacks',
  // `admonition.icon.<type>.<property>` — the gem reads this whole subtree through a dedicated
  // `admonition_icon_` branch (theme_loader.rb), so the catalogue only ever carries whichever
  // admonition types the shipped themes happen to style.
  'admonition_icon',
];

/**
 * Leaves that name a font FACE rather than a property, legal only under an open namespace.
 *
 * A font catalogue entry is `font.catalog.<Family the author names>.<face>` — the shipped default
 * theme's own `font.catalog.Noto Serif.bold_italic` is one. The face is the leaf, and none of these
 * words is a property, so without this the renderer's own default theme fails its own plausibility
 * check. They are kept out of {@link PROPERTY_WORDS} because `heading.bold` is not a setting: it is
 * only under a namespace whose second segment is author-chosen that a face can be the leaf.
 */
const FONT_FACE_WORDS: ReadonlySet<string> = new Set([
  'normal',
  'bold',
  'italic',
  'bold_italic',
  'regular',
]);

/** Every property leaf the catalogue knows, canonicalised — the vocabulary a real setting ends in. */
const KNOWN_LEAVES: ReadonlySet<string> = new Set(
  THEME_SETTINGS.map((descriptor) =>
    canonicalThemeKey(descriptor.key.slice(descriptor.key.lastIndexOf('.') + 1)),
  ),
);

/**
 * The final words a theme property may end in, beyond the leaves the catalogue already carries.
 *
 * This exists because Asciidoctor-PDF's keys are COMPOSITIONAL — a category plus a property — and the
 * two shipped theme files demonstrate only a fraction of the legal compositions.
 * `text-decoration-color` is real, and is not in either file. Enumerating the property vocabulary is
 * something we can actually do correctly; enumerating the key space is not.
 */
const PROPERTY_WORDS: ReadonlySet<string> = new Set([
  'color',
  'colour',
  'size',
  'style',
  'family',
  'weight',
  'width',
  'height',
  'align',
  'valign',
  'transform',
  'decoration',
  'content',
  'spacing',
  'indent',
  'radius',
  'offset',
  'padding',
  'margin',
  'gap',
  'rhythm',
  'zoom',
  'layout',
  'mode',
  'background',
  'border',
  'glyphs',
  'separator',
  'catalog',
  'fallbacks',
  'top',
  'bottom',
  'left',
  'right',
  'length',
  'leader',
  'levels',
  'after',
  'before',
  'visible',
  'scale',
  'title',
  'text',
  'font',
  'line',
  'stripe',
  'position',
  // The icon FACE an admonition uses — `admonition.icon.tip.name: fa-lightbulb-o`, the standard
  // custom-icon snippet from the theming guide. Without it that documented, working line was
  // reported as a setting that "will have no effect".
  'name',
]);

/**
 * Whether a key is one the renderer could plausibly honour.
 *
 * Deliberately WEAKER than {@link isKnownThemeKey}. The catalogue is derived from two example themes,
 * not from a schema — no machine-readable schema exists upstream — so treating "absent from the
 * catalogue" as "invalid" reports documented, working themes as broken. That is the worse failure:
 * an author who is told their correct theme is wrong learns to ignore the validation entirely.
 *
 * So this checks the property VOCABULARY rather than the key space. A typo like `colour-scheme` ends
 * in a word no theme property ends in and is still caught; a legitimate composition the example
 * themes never used, or a setting on an author-invented role, is not.
 *
 * @param key - The dotted key as written in the document.
 * @param contributed - Descriptors contributed by the project's enabled extensions. A key one of
 *   them declares is honoured by definition — that extension is what reads it — so it is accepted
 *   outright rather than being put to the vocabulary test, which knows nothing of extension keys.
 * @returns True when the key should be accepted without complaint.
 */
export function isPlausibleThemeKey(
  key: string,
  contributed: readonly ThemeSettingDescriptor[] = [],
): boolean {
  const canonical = canonicalThemeKey(key);
  if (contributed.some((descriptor) => canonicalThemeKey(descriptor.key) === canonical)) return true;
  if (BY_CANONICAL_KEY.has(canonical) || EXTRA_KNOWN_KEYS.has(canonical)) return true;

  const leaf = canonical.slice(canonical.lastIndexOf('_') + 1);
  const leafFull = canonical.slice(
    (canonical.includes('_') ? canonical.indexOf('_') : -1) + 1,
  );
  if (KNOWN_LEAVES.has(leafFull) || KNOWN_LEAVES.has(leaf)) return true;

  // Under an open namespace the second segment is author-chosen, so only the property is judged.
  const underOpenNamespace = OPEN_NAMESPACES.some((prefix) => canonical.startsWith(`${prefix}_`));
  if (underOpenNamespace && (PROPERTY_WORDS.has(leaf) || FONT_FACE_WORDS.has(leaf))) return true;

  return PROPERTY_WORDS.has(leaf);
}

/** Every distinct category, sorted — the top-level groupings completion offers first. */
export const THEME_CATEGORIES: readonly string[] = [
  ...new Set(THEME_SETTINGS.map((descriptor) => descriptor.category)),
].toSorted();

/**
 * The settings offered for completion, optionally including those contributed by enabled extensions.
 *
 * Extension-contributed settings appear ONLY while their extension is enabled: completing a key that
 * nothing will read is worse than not offering it, because the author gets no feedback that their
 * setting is inert.
 *
 * @param contributed - Descriptors contributed by the project's currently enabled extensions.
 * @returns Built-in settings followed by the contributed ones, each key appearing once.
 */
export function themeSettingsFor(
  contributed: readonly ThemeSettingDescriptor[] = [],
): readonly ThemeSettingDescriptor[] {
  if (contributed.length === 0) return THEME_SETTINGS;
  const merged = new Map(THEME_SETTINGS.map((d) => [canonicalThemeKey(d.key), d]));
  for (const descriptor of contributed) {
    merged.set(canonicalThemeKey(descriptor.key), descriptor);
  }
  return [...merged.values()].toSorted((a, b) => a.key.localeCompare(b.key));
}
