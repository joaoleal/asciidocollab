'use client';

import type { ComponentType } from 'react';
import {
  ALargeSmall,
  ArrowUpDown,
  Map as MapIcon,
  FileText,
  Palette,
  SpellCheck,
  WrapText,
} from 'lucide-react';
import { useEditorPreferences, EditorThemeValue } from '@/hooks/use-editor-preferences';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PreviewStyleControl } from '@/components/preview-style-control';

const FONT_SIZES = [12, 13, 14, 16, 18, 20] as const;

/**
 * A preference's label with the glyph that stands for it.
 *
 * The icon is decorative in every case: the label beside it says what the setting is, so the glyph is
 * hidden from assistive technology rather than announced — read out, each row would name itself twice.
 *
 * @param properties - The icon component and the label text.
 * @param properties.icon - The glyph to show.
 * @param properties.children - The label text, and any `htmlFor` wiring the caller needs.
 * @returns The label with its icon.
 */
function SettingLabel({ icon: Icon, children }: { icon: ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {children}
    </span>
  );
}

const EDITOR_THEMES: { value: EditorThemeValue; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'high-contrast', label: 'High Contrast' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'espresso', label: 'Espresso' },
];

/** Card exposing editor font size, theme, scroll sync, and soft wrap preferences. */
export function EditorPreferencesCard() {
  const {
    fontSize, theme, scrollSyncEnabled, softWrap, previewStyle, spellcheckEnabled, minimapEnabled,
    setFontSize, setTheme, setScrollSyncEnabled, setSoftWrap, setPreviewStyle, setSpellcheckEnabled, setMinimapEnabled,
  } = useEditorPreferences();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Editor Preferences</CardTitle>
        <CardDescription>Customise the behaviour of the document editor.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1">
          <Label htmlFor="editorFontSize">
            <SettingLabel icon={ALargeSmall}>Font Size</SettingLabel>
          </Label>
          <select
            id="editorFontSize"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>{size}px</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label>
            <SettingLabel icon={Palette}>Editor Theme</SettingLabel>
          </Label>
          <div role="group" aria-label="Editor theme" className="flex flex-wrap gap-2">
            {EDITOR_THEMES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent ${
                  theme === value ? 'border-primary bg-accent font-medium' : 'border-border'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label>
            <SettingLabel icon={FileText}>Preview Style</SettingLabel>
          </Label>
          <CardDescription>How the AsciiDoc preview renders. Applies only to your view.</CardDescription>
          <PreviewStyleControl value={previewStyle} onChange={setPreviewStyle} ariaLabel="Preview style" />
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="scrollSyncEnabled"
              checked={scrollSyncEnabled}
              onChange={(event) => setScrollSyncEnabled(event.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <Label htmlFor="scrollSyncEnabled">
              <SettingLabel icon={ArrowUpDown}>Scroll Sync</SettingLabel>
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="softWrap"
              checked={softWrap}
              onChange={(event) => setSoftWrap(event.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <Label htmlFor="softWrap">
              <SettingLabel icon={WrapText}>Soft Wrap</SettingLabel>
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="spellcheckEnabled"
              checked={spellcheckEnabled}
              onChange={(event) => setSpellcheckEnabled(event.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <Label htmlFor="spellcheckEnabled">
              <SettingLabel icon={SpellCheck}>Spell Check</SettingLabel>
            </Label>
          </div>
          <CardDescription>
            The spell-check language is configured per project in its settings.
          </CardDescription>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="minimapEnabled"
              checked={minimapEnabled}
              onChange={(event) => setMinimapEnabled(event.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <Label htmlFor="minimapEnabled">
              <SettingLabel icon={MapIcon}>Text Preview</SettingLabel>
            </Label>
          </div>
          <CardDescription>
            Shows a scaled-down overview of the whole document down the editor&rsquo;s right edge.
          </CardDescription>
        </div>
      </CardContent>
    </Card>
  );
}
