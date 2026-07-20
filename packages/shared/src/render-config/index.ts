/** @file Barrel for the project-level render-configuration model, validation, and resolver. */

export {
  renderConfigSchema,
  normalizeRenderConfig,
  safeNormalizeRenderConfig,
  PINNED_ATTRIBUTE_KEYS,
  PDF_PAGE_SIZES,
  EMPTY_RENDER_CONFIG,
  type RenderConfig,
} from './config';
// The theme-recognition rule itself lives in the zero-dependency `asciidoc-core` leaf, because the
// server ring needs it too and `domain` may not import outward into this package. Re-exported here so
// render-config consumers reach it alongside the settings it governs.
export { isThemeFilePath, resolveThemePath, themeFilePaths, THEME_FILENAME_CONVENTION } from '@asciidocollab/asciidoc-core';
export {
  resolveRenderAttributes,
  stripSoftDefault,
  SOFT_DEFAULT_SUFFIX,
  RENDER_OPTION_CATALOG,
  type ResolvedRenderConfig,
} from './resolve';
// The theme-setting catalogue driving completion, inline widgets and validation in the theme editor.
// Structure is GENERATED from the vendored gem; prose is hand-maintained and merged in.
export {
  THEME_SETTINGS,
  THEME_CATEGORIES,
  themeSetting,
  themeSettingsFor,
  isKnownThemeKey,
  isPlausibleThemeKey,
  canonicalThemeKey,
} from './theme-catalogue';
export { extensionThemeSettings } from './extension-theme-keys';
export { THEME_DESCRIPTOR_GEM_VERSION } from './theme-descriptors.generated';
export type { ThemeSettingDescriptor, ThemeValueKind, GeneratedThemeDescriptor } from './theme-descriptor-types';
// A verbatim copy of the gem's default theme, the starting point a newly created theme is seeded from.
export { DEFAULT_THEME_YAML, DEFAULT_THEME_GEM_VERSION } from './default-theme.generated';
