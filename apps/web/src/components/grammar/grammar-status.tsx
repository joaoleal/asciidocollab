'use client';

import { cn } from '@/lib/utilities';
import { GRAMMAR_CATEGORIES, GRAMMAR_CATEGORY_DOT_CLASS, type GrammarCategory } from '@/lib/codemirror/harper/category-colors';

/** Per-category issue counts shown in the status bar. */
export interface GrammarStatusCounts {
  /** Spelling issue count. */
  spelling: number;
  /** Grammar issue count. */
  grammar: number;
  /** Style issue count. */
  style: number;
}

/** Props for {@link GrammarStatus}. */
export interface GrammarStatusProperties {
  /** Per-category issue counts. */
  counts: GrammarStatusCounts;
  /** Whether the on-device engine is active (shows the on-device indicator dot). */
  engineReady: boolean;
  /** Extra class names. */
  className?: string;
}

const CATEGORY_TITLES: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'Spelling issues',
  grammar: 'Grammar issues',
  style: 'Style issues',
};

/**
 * Compact status-bar readout of grammar issue counts per category, plus an on-device indicator so an
 * author can see checking is running locally. Renders nothing but the indicator when the engine is
 * active with no issues; renders nothing at all when the engine is not active.
 *
 * @param properties - The counts and engine state.
 * @returns The status element, or null when grammar checking is inactive.
 */
export function GrammarStatus({ counts, engineReady, className }: GrammarStatusProperties): React.JSX.Element | null {
  if (!engineReady) return null;
  return (
    <span className={cn('flex items-center gap-2', className)} aria-label="Grammar status">
      <span className="flex items-center gap-1 text-[hsl(var(--success))]" title="Checking on your device">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--success))]" aria-hidden="true" />
        On-device
      </span>
      {GRAMMAR_CATEGORIES.map((category) => (
        <span key={category} className="flex items-center gap-1 tabular-nums" title={CATEGORY_TITLES[category]}>
          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', GRAMMAR_CATEGORY_DOT_CLASS[category])} aria-hidden="true" />
          {counts[category]}
        </span>
      ))}
    </span>
  );
}
