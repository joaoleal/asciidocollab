'use client';

import { cn } from '@/lib/utilities';

/**
 * One measured figure: what it is, what it was, and whether it is a duration.
 *
 * Deliberately a plain label/value pair rather than a field of a known stats shape. The two preview
 * formats report structurally different things — the web path has four durations, the page path has
 * four counters plus nine stages, several of which are absent on any given render — and an overlay
 * built around either one's field names has to be retrofitted for the other. Being told what to show
 * costs the callers one mapping each and leaves this component with nothing to know.
 */
export interface RenderStatRow {
  /** What was measured, in the caller's own words. */
  readonly label: string;
  /** The figure. Rounded to a whole number for display; the caller keeps the precise value. */
  readonly value: number;
  /** The unit shown after the figure. Omit for a count, which is not measured in anything. */
  readonly unit?: string;
}

/** Bindings for the development-only render-cost overlay. */
export interface RenderStatsOverlayProperties {
  /** Names which render these figures describe, so two overlays on screen stay distinguishable. */
  readonly title: string;
  /** The figures to show, in the order they should read. An empty list renders nothing. */
  readonly rows: readonly RenderStatRow[];
}

/**
 * A small, development-only panel reporting what the last render cost.
 *
 * Gated on `process.env.NODE_ENV !== 'production'` so the bundler eliminates it from the production
 * bundle: it exists to make the renderer's cost visible to whoever is working on the renderer, and an
 * author has no use for it. The gate is a plain comparison rather than a runtime flag precisely so
 * that elimination can happen.
 *
 * Rendered OUTSIDE the preview's own content container by every caller, so the document-rendering
 * styles stay scoped to the document and this chrome cannot be mistaken for part of it.
 */
export function RenderStatsOverlay({ title, rows }: RenderStatsOverlayProperties) {
  if (process.env.NODE_ENV === 'production' || rows.length === 0) {
    return null;
  }
  return (
    <aside
      aria-label={`${title} render cost`}
      className={cn(
        'pointer-events-none absolute bottom-2 right-2 z-10 rounded-md border border-border',
        'bg-background/90 px-2 py-1.5 font-mono text-[10px] leading-tight text-muted-foreground shadow-sm',
      )}
    >
      <p className="pb-1 font-sans font-medium text-foreground">{title}</p>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt>{row.label}</dt>
            <dd className="justify-self-end tabular-nums text-foreground">{formatValue(row)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/**
 * Render one figure: whole numbers only, with the unit when there is one.
 *
 * Sub-millisecond precision is noise at this size — the figures exist to show where the time goes,
 * and three decimal places on a 3 ms parse says nothing a reader can act on.
 */
function formatValue(row: RenderStatRow): string {
  const rounded = Math.round(row.value);
  return row.unit === undefined ? String(rounded) : `${rounded} ${row.unit}`;
}
