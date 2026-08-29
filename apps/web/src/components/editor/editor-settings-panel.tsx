import * as Select from '@radix-ui/react-select';
import { ALargeSmall, Palette, WrapText, Map as MapIcon, UserRoundSearch } from 'lucide-react';
import type { EditorThemeValue } from '@/hooks/use-editor-preferences';
import { isEditorThemeValue } from '@/hooks/use-editor-preferences';
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from '@/lib/editor-config';

interface EditorSettingsPanelProperties {
  fontSize: number;
  theme: EditorThemeValue;
  softWrap?: boolean;
  minimapEnabled?: boolean;
  blameEnabled?: boolean;
  setFontSize: (size: number) => void;
  setTheme: (theme: EditorThemeValue) => void;
  setSoftWrap?: (enabled: boolean) => void;
  setMinimapEnabled?: (enabled: boolean) => void;
  setBlameEnabled?: (enabled: boolean) => void;
}

const THEME_OPTIONS: { value: EditorThemeValue; label: string }[] = [
  { value: 'default',       label: 'Default' },
  { value: 'tomorrow',      label: 'Tomorrow' },
  { value: 'dracula',       label: 'Dracula' },
  { value: 'espresso',      label: 'Espresso' },
  { value: 'high-contrast', label: 'High Contrast' },
];

/**
 * Compact editor-settings popover for the toolbar. Each option is marked with a leading icon and laid
 * out as a single icon→control row; the boolean toggles share one row. Kept short so opening it
 * doesn't push the editor canvas down.
 */
export function EditorSettingsPanel({
  fontSize,
  theme,
  softWrap = true,
  minimapEnabled = false,
  blameEnabled = false,
  setFontSize,
  setTheme,
  setSoftWrap,
  setMinimapEnabled,
  setBlameEnabled,
}: EditorSettingsPanelProperties) {
  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2">
        <ALargeSmall className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true">
          <title>Font size</title>
        </ALargeSmall>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Decrease font size"
            className="h-6 w-6 rounded border flex items-center justify-center hover:bg-muted"
            onClick={() => setFontSize(Math.max(FONT_SIZE_MIN, fontSize - 1))}
            disabled={fontSize <= FONT_SIZE_MIN}
          >
            -
          </button>
          <input
            type="number"
            value={fontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            aria-label="Font size"
            className="h-6 w-11 text-center text-sm border rounded"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX) setFontSize(value);
            }}
          />
          <button
            type="button"
            aria-label="Increase font size"
            className="h-6 w-6 rounded border flex items-center justify-center hover:bg-muted"
            onClick={() => setFontSize(Math.min(FONT_SIZE_MAX, fontSize + 1))}
            disabled={fontSize >= FONT_SIZE_MAX}
          >
            +
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Palette className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true">
          <title>Theme</title>
        </Palette>
        <Select.Root
          value={theme}
          onValueChange={(value) => {
            if (isEditorThemeValue(value)) setTheme(value);
          }}
        >
          <Select.Trigger aria-label="Theme" className="flex h-7 w-40 items-center justify-between rounded border px-2 text-sm">
            <Select.Value />
            <Select.Icon>▾</Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="rounded border bg-popover shadow-md z-50">
              <Select.Viewport>
                {THEME_OPTIONS.map(({ value, label }) => (
                  <Select.Item
                    key={value}
                    value={value}
                    className="px-2 py-1 text-sm cursor-pointer hover:bg-muted flex items-center gap-1"
                  >
                    <Select.ItemText>{label}</Select.ItemText>
                    <Select.ItemIndicator>✓</Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      {(setSoftWrap !== undefined || setMinimapEnabled !== undefined || setBlameEnabled !== undefined) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {setSoftWrap !== undefined && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={softWrap}
                onChange={(event) => setSoftWrap(event.target.checked)}
                className="h-4 w-4 rounded border"
              />
              <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
              Soft Wrap
            </label>
          )}
          {setMinimapEnabled !== undefined && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={minimapEnabled}
                onChange={(event) => setMinimapEnabled(event.target.checked)}
                className="h-4 w-4 rounded border"
              />
              <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Text preview
            </label>
          )}
          {setBlameEnabled !== undefined && (
            <button
              type="button"
              aria-pressed={blameEnabled}
              onClick={() => setBlameEnabled(!blameEnabled)}
              className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 cursor-pointer ${
                blameEnabled ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted'
              }`}
            >
              <UserRoundSearch className="h-3.5 w-3.5" aria-hidden="true" />
              Blame
            </button>
          )}
        </div>
      )}
    </div>
  );
}
