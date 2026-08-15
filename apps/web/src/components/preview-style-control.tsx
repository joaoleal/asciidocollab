'use client';

import { PREVIEW_STYLE_VALUES } from '@asciidocollab/primitives';
import type { PreviewStyleValue } from '@asciidocollab/primitives';
import { cn } from '@/lib/utilities';

// Re-exported so existing call sites keep importing the guard from the control they render.
export { isPreviewStyleValue } from '@asciidocollab/primitives';
export type { PreviewStyleValue } from '@asciidocollab/primitives';

/** Display labels for each token. Labels are display-only and never stored. */
export const PREVIEW_STYLE_LABELS: Record<PreviewStyleValue, string> = {
  asciidocollab: 'Asciidocollab',
  asciidoctor: 'Asciidoctor',
  print: 'Print',
};

/**
 * What each style is for, offered to a screen reader and as a pointer hint.
 *
 * The Print option needs one in particular: its name says what it looks like, not that it is still
 * the live HTML preview rather than the PDF. It carries the boundary too — an approximation that
 * never says so is one an author will eventually trust for a question it cannot answer, and this
 * description is where that is said, rather than in a banner over the page it describes.
 */
export const PREVIEW_STYLE_DESCRIPTIONS: Record<PreviewStyleValue, string> = {
  asciidocollab: 'The application’s own preview styling.',
  asciidoctor: 'Asciidoctor’s default HTML styling.',
  print:
    'The live preview dressed in the PDF export’s page geometry, typography and colours. Not paginated — the PDF preview and the export remain the authority on page breaks, headers, footers and page numbers.',
};

interface PreviewStyleControlProperties {
  /** Currently active style token. */
  value: PreviewStyleValue;
  /**
   * Called when the user picks an option.
   *
   * @param value - The newly selected style token.
   */
  onChange: (value: PreviewStyleValue) => void;
  /** Renders a denser variant for the preview header row. */
  compact?: boolean;
  /** Optional id-friendly label for the surrounding group (accessibility). */
  ariaLabel?: string;
}

/** Segmented control for choosing the preview rendering style. */
export function PreviewStyleControl({
  value,
  onChange,
  compact = false,
  ariaLabel = 'Preview style',
}: PreviewStyleControlProperties) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('inline-flex rounded-md border border-border', compact ? 'h-6' : 'h-9')}
    >
      {PREVIEW_STYLE_VALUES.map((option, index) => {
        const isActive = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(option)}
            data-testid={`preview-style-${option}`}
            title={PREVIEW_STYLE_DESCRIPTIONS[option]}
            aria-description={PREVIEW_STYLE_DESCRIPTIONS[option]}
            className={cn(
              'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              compact ? 'px-2 text-xs' : 'px-3 text-sm',
              // Rounded on the ends only. Keyed off position rather than a two-option assumption, so
              // a middle option is square on both sides instead of inheriting the last one's corner.
              index === 0 && 'rounded-l-[5px]',
              index === PREVIEW_STYLE_VALUES.length - 1 && 'rounded-r-[5px]',
              index > 0 && 'border-l border-border',
              isActive
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            {PREVIEW_STYLE_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
