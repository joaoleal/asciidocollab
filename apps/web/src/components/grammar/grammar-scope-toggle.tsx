'use client';

import { cn } from '@/lib/utilities';
import type { LintScope } from '@/lib/codemirror/harper/harper-linter-source';

/** Props for {@link GrammarScopeToggle}. */
export interface GrammarScopeToggleProperties {
  /** The current lint scope. */
  scope: LintScope;
  /**
   * Change the lint scope.
   *
   * @param next - The new scope.
   */
  onScopeChange: (next: LintScope) => void;
  /** Extra class names. */
  className?: string;
}

const OPTIONS: readonly { value: LintScope; label: string }[] = [
  { value: 'this-file', label: 'This file' },
  { value: 'whole-document', label: 'Whole document' },
];

/**
 * A two-way toggle for how much of the writing the panel reports on, using the same vocabulary as the
 * review rail's this-file / everything pair.
 *
 * "This file" lists the issues in the file open in the editor. "Whole document" adds the issues in the
 * other files the document pulls in with `include::` — those live in files this editor is not showing,
 * so they are listed with their file and line rather than underlined. It is a per-view preference: it
 * never changes what other collaborators check, and it is not persisted between sessions.
 *
 * @param properties - The current scope and change handler.
 * @returns The toggle element.
 */
export function GrammarScopeToggle({ scope, onScopeChange, className }: GrammarScopeToggleProperties): React.JSX.Element {
  return (
    <div className={cn('inline-flex rounded-md border', className)} role="radiogroup" aria-label="Grammar check scope">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={scope === option.value}
          onClick={() => onScopeChange(option.value)}
          className={cn(
            'px-2 py-0.5 text-xs transition-colors first:rounded-l-md last:rounded-r-md',
            scope === option.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
