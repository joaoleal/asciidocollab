'use client';

/**
 * @file What the theme editor needs to know about one project's converter extensions: the theme
 * settings they contribute, and which of them are enabled.
 *
 * Both facts come from the same two fetches — the catalogue and the project's render config — so they
 * are derived together rather than by two hooks that would each fetch both.
 *
 * The settings gating is the point (FR-031b, invariant D5). An extension's theme keys are read by
 * that extension's Ruby, so a key belonging to a disabled extension is read by nothing. Offering it
 * would complete an author into writing a line that silently does nothing, and — worse — the theme
 * validator would then have to either accept every such key (making the check useless) or warn on it
 * (making the completion a trap). Both halves therefore come from here, so completion and validation
 * cannot disagree about which keys exist.
 */

import { useMemo } from 'react';
import {
  extensionThemeSettings,
  themeSettingsFor,
  THEME_SETTINGS,
  type ThemeSettingDescriptor,
} from '@asciidocollab/shared';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';

/** One extension a project has switched on, named as the author sees it. */
export interface EnabledExtension {
  /** The extension's id, as the renderer loads it. */
  readonly id: string;
  /** The name shown to the author. */
  readonly displayName: string;
}

/** What the theme editor needs about a project's extensions. */
export interface ThemeEditorExtensions {
  /** Built-in theme settings merged with those the enabled extensions contribute. */
  readonly settings: readonly ThemeSettingDescriptor[];
  /**
   * The extensions actually in force, in catalogue order.
   *
   * A stale selection — an id the project still names but no source offers any more — is NOT here.
   * It contributes no settings and cannot be compared against, because there is nothing to load.
   */
  readonly enabledExtensions: readonly EnabledExtension[];
}

/** Nothing enabled. A shared constant so an unchanged result keeps a stable identity. */
const NONE: readonly EnabledExtension[] = [];

/**
 * The theme settings and enabled extensions for a project.
 *
 * @param projectId - The project whose extension selection decides both. When absent, only the
 *   renderer's built-ins are offered — a theme opened outside a project context has no selection.
 * @returns The settings to offer and the extensions in force.
 */
export function useThemeSettings(projectId?: string): ThemeEditorExtensions {
  const { catalogue } = usePdfExtensions(projectId ?? '');
  const { config } = useProjectRenderConfig(projectId ?? '');

  const entries = catalogue?.entries;
  const enabled = config.extensions?.enabled;

  return useMemo(() => {
    if (projectId === undefined || entries === undefined || enabled === undefined) {
      return { settings: THEME_SETTINGS, enabledExtensions: NONE };
    }
    const contributed = extensionThemeSettings(entries, enabled);
    const selected = new Set(enabled);
    const enabledExtensions = entries
      .filter((entry) => entry.available && selected.has(entry.manifest.id))
      .map((entry) => ({ id: entry.manifest.id, displayName: entry.manifest.displayName }));
    return {
      // `themeSettingsFor` returns the built-in list unchanged when nothing is contributed, so a
      // project with no extensions enabled pays no allocation and gets a stable reference.
      settings: themeSettingsFor(contributed),
      enabledExtensions: enabledExtensions.length === 0 ? NONE : enabledExtensions,
    };
  }, [projectId, entries, enabled]);
}
