'use client';
import { useState, type ComponentType } from 'react';
import {
  Bold,
  ChevronsDownUp,
  ChevronsUpDown,
  Code,
  FilePlus,
  FolderPlus,
  Italic,
  Keyboard,
  ListTree,
  MessageSquarePlus,
  Pencil,
  Search,
  SquareSlash,
  Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useKeyBindingSettings } from '@/hooks/use-key-binding-settings';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * The icon shown beside each shortcut, by action id.
 *
 * Keyed by action rather than by label so that renaming a label — which is presentation — cannot
 * silently drop an icon. An action with no entry falls back to a generic keyboard glyph, so a
 * shortcut added to the registry appears in this list with or without someone remembering to pick a
 * picture for it.
 */
const ACTION_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  'file-tree:rename': Pencil,
  'file-tree:delete': Trash2,
  'file-tree:new-file': FilePlus,
  'file-tree:new-folder': FolderPlus,
  'file-tree:find': Search,
  'editor:bold': Bold,
  'editor:italic': Italic,
  'editor:code': Code,
  'editor:toggle-comment': SquareSlash,
  'editor:fold-all': ChevronsDownUp,
  'editor:unfold-all': ChevronsUpDown,
  'editor:fold-level-1': ListTree,
  'editor:fold-level-2': ListTree,
  'editor:review-comment': MessageSquarePlus,
};

function canonicalCombo(event: React.KeyboardEvent): string {
  if (MODIFIER_KEYS.has(event.key)) return '';
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Meta');
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join('+');
}

/** Displays the user's key binding settings and allows remapping or resetting each shortcut. */
export function KeyboardShortcutsCard() {
  const { groups, updateBinding, resetBinding } = useKeyBindingSettings();
  const [capturingAction, setCapturingAction] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleBindingClick = (action: string) => {
    setCapturingAction(action);
    setErrors((previous) => ({ ...previous, [action]: '' }));
  };

  const handleCapture = async (event: React.KeyboardEvent, action: string) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setCapturingAction(null);
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) return;

    const combo = canonicalCombo(event);
    if (!combo) return;

    try {
      await updateBinding(action, combo);
      setCapturingAction(null);
    } catch (error) {
      setErrors((previous) => ({ ...previous, [action]: error instanceof Error ? error.message : 'Error' }));
      setCapturingAction(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyboard Shortcuts</CardTitle>
      </CardHeader>
      <CardContent>
        {groups.map((group) => (
          <div key={group.namespace} className="mb-6">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">{group.label}</h3>
            <div className="space-y-2">
              {group.bindings.map((binding) => {
                const isCapturing = capturingAction === binding.action;
                const Icon = ACTION_ICONS[binding.action] ?? Keyboard;
                return (
                  <div key={binding.action} className="flex items-center gap-3">
                    {/* Decorative: the label beside it already names the action, so announcing the
                        glyph too would read every row twice to a screen reader. */}
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1 text-sm">{binding.label}</span>
                    {isCapturing ? (
                      <input
                        autoFocus
                        readOnly
                        placeholder="Press a key…"
                        className="w-32 rounded border px-2 py-1 text-sm text-center border-primary outline-none"
                        onKeyDown={(event) => handleCapture(event, binding.action)}
                        onBlur={() => setCapturingAction(null)}
                      />
                    ) : (
                      <button
                        className="w-32 rounded border px-2 py-1 text-sm text-center hover:bg-accent"
                        onClick={() => handleBindingClick(binding.action)}
                      >
                        {binding.keyCombo}
                      </button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="reset"
                      disabled={binding.isDefault}
                      onClick={() => resetBinding(binding.action)}
                    >
                      Reset
                    </Button>
                    {errors[binding.action] && (
                      <span className="text-xs text-destructive">{errors[binding.action]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
