/**
 * @file The theme settings that enabled converter extensions contribute to the editor's catalogue.
 *
 * An extension may add theme keys of its own — `narrow-contents.left`, `license-page.font-color` —
 * and the theme editor should complete and describe those exactly as it does the renderer's built-in
 * settings. But ONLY while that extension is enabled (FR-031b, invariant D5): a key contributed by a
 * disabled extension is read by nothing, so offering it would invite an author to write a line that
 * silently does nothing.
 *
 * That gating is the whole reason this is a function of the project's selection rather than a static
 * table. The built-in catalogue is generated once from the gem; this half is recomputed whenever the
 * selection changes.
 */

import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';
import type { ThemeSettingDescriptor } from './theme-descriptor-types';

/**
 * The category a contributed key is grouped under in completion.
 *
 * The renderer's own keys group by first segment (`heading.h2.font-color` → `heading`), and a
 * contributed key is grouped the same way so the two halves of the catalogue sort together rather
 * than an extension's settings appearing in a category of their own.
 *
 * @param key - The contributed key, dotted.
 * @returns Its first segment, or the whole key when it has only one.
 */
function categoryOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * The theme settings contributed by the extensions a project currently has enabled.
 *
 * @param entries - The catalogue as the server assembled it.
 * @param enabledIds - The ids the project has enabled.
 * @returns One descriptor per contributed key, each tagged with the extension that supplies it.
 */
export function extensionThemeSettings(
  entries: readonly PdfExtensionCatalogueEntry[],
  enabledIds: readonly string[],
): readonly ThemeSettingDescriptor[] {
  const enabled = new Set(enabledIds);
  const settings: ThemeSettingDescriptor[] = [];

  for (const entry of entries) {
    // An entry the deployment no longer offers contributes nothing even if the project still lists
    // it: its Ruby is not loaded, so its keys would be read by nothing.
    if (!entry.available || !enabled.has(entry.manifest.id)) continue;

    for (const contributed of entry.manifest.themeKeys) {
      settings.push({
        key: contributed.key,
        category: categoryOf(contributed.key),
        valueKind: contributed.valueKind,
        // An empty `default` in a manifest means "no value unless the theme sets one" — carrying it
        // through as an empty string would show the author a default of nothing at all.
        ...(contributed.default !== undefined && contributed.default !== ''
          ? { defaultValue: contributed.default }
          : {}),
        description: contributed.description,
        contributedBy: entry.manifest.displayName,
      });
    }
  }

  return settings;
}
