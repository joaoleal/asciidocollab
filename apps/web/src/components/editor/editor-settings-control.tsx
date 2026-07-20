'use client';

/**
 * @file The editor-settings affordance: the toolbar button and the panel it toggles.
 *
 * Extracted from `EditorToolbar` because the settings are NOT AsciiDoc-specific. Font size, editor
 * theme, soft wrap and the minimap apply to any text the editor shows, but they used to live inside
 * a toolbar that is rendered only for AsciiDoc files — so opening a YAML theme left an author with
 * no way to reach their own editor settings, and no indication that the settings they had set
 * elsewhere still applied.
 *
 * The alternative was to give the theme editor its own copy, which is how two settings panels come
 * to disagree about what a font size means. One component, two hosts.
 */
import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Settings } from 'lucide-react';
import { EditorSettingsPanel } from './editor-settings-panel';
import { EditorToolbarButton } from './editor-toolbar-button';
import type { EditorThemeValue } from '@/hooks/use-editor-preferences';

/** The preference values and setters the panel reads and writes. */
export interface EditorSettingsControlProperties {
  /** Editor font size in pixels. */
  fontSize: number;
  /** The editor colour theme. */
  theme: EditorThemeValue;
  /** Whether long lines wrap. Optional, mirroring the panel it wraps. */
  softWrap?: boolean;
  /** Whether the document text-preview (minimap) is shown. */
  minimapEnabled?: boolean;
  /**
   * Sets the editor font size.
   *
   * @param size - The new size in pixels.
   */
  setFontSize: (size: number) => void;
  /**
   * Sets the editor colour theme.
   *
   * @param theme - The new theme.
   */
  setTheme: (theme: EditorThemeValue) => void;
  /**
   * Toggles soft wrap. Optional, mirroring the panel it wraps.
   *
   * @param enabled - Whether long lines wrap.
   */
  setSoftWrap?: (enabled: boolean) => void;
  /**
   * Toggles the document text-preview (minimap). Optional, mirroring the panel it wraps.
   *
   * @param enabled - Whether the minimap is shown.
   */
  setMinimapEnabled?: (enabled: boolean) => void;
}

/** Properties of the standalone control: the settings, plus optional content for the row's left. */
interface StandaloneProperties extends EditorSettingsControlProperties {
  /** Rendered at the left of the settings row, opposite the button. */
  leading?: React.ReactNode;
}

/** The settings toggle button, rendered inline in a toolbar row. */
export function EditorSettingsButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <EditorToolbarButton
      icon={<Settings className="h-4 w-4" />}
      label="Editor settings"
      shortcut=""
      active={open}
      onClick={onToggle}
    />
  );
}

/** The expanded settings panel, styled for sitting directly beneath a toolbar row. */
export function EditorSettingsSurface(properties: EditorSettingsControlProperties): React.JSX.Element {
  return (
    <div className="border-b bg-background shadow-lg">
      <EditorSettingsPanel {...properties} />
    </div>
  );
}

/**
 * The button and its panel together, for a host with no toolbar row of its own to place them in.
 *
 * @param properties - The preference values and setters.
 * @returns A self-contained settings control.
 */
export function EditorSettingsControl({
  leading,
  ...properties
}: StandaloneProperties): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    // The button carries a tooltip, and Radix requires a provider in scope. `EditorToolbar` supplies
    // one around its whole row; this standalone host has no such row, so it brings its own.
    <Tooltip.Provider>
      <div className="flex min-w-0 items-center justify-between gap-2 border-b px-2 py-1">
        <span className="min-w-0 truncate">{leading}</span>
        <EditorSettingsButton open={open} onToggle={() => setOpen((previous) => !previous)} />
      </div>
      {open && <EditorSettingsSurface {...properties} />}
    </Tooltip.Provider>
  );
}
