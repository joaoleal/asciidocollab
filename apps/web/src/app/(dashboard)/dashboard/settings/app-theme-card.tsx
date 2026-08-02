'use client';

import type { ComponentType } from 'react';
import { Moon, MonitorCog, Sun } from 'lucide-react';
import { useTheme, type Theme } from '@/hooks/use-theme';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const THEME_OPTIONS: { value: Theme; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Auto', icon: MonitorCog },
];

/** Card allowing the user to choose between light, dark, and system application themes. */
export function AppThemeCard() {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application Theme</CardTitle>
        <CardDescription>Choose how AsciiDoCollab looks to you.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3" role="group" aria-label="Application theme">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md border text-sm transition-colors ${
                theme === value
                  ? 'border-primary bg-accent'
                  : 'border-border hover:bg-accent'
              }`}
            >
              {/* Decorative: the label beside it already names the choice. */}
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
