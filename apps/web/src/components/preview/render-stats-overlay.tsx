'use client';

import { useState } from 'react';
import { Gauge, X } from 'lucide-react';

import { cn } from '@/lib/utilities';

/**
 * One measured figure: what it is, what it was, whether it is a duration, and what it sits inside.
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
  /**
   * How far inside another figure this one sits: 0 for a total, 1 for a figure inside it, 2 for a
   * figure inside THAT. Omitted is 0.
   *
   * Worth stating rather than leaving to the reader, because these breakdowns are not a flat list and
   * read as nonsense when shown like one: a page render's `convert` is most of `render`, and `parse`,
   * `converter walk` and the rest are most of `convert`, so a flat column appears to report far more
   * time than the render took. The caller knows the containment; nothing here can infer it.
   */
  readonly depth?: number;
}

/** Bindings for the development-only render-cost overlay. */
export interface RenderStatsOverlayProperties {
  /** Names which render these figures describe, so two overlays on screen stay distinguishable. */
  readonly title: string;
  /** The figures to show, in the order they should read. An empty list renders nothing. */
  readonly rows: readonly RenderStatRow[];
}

/** Left inset per level of nesting. Indexed by depth; anything deeper reads at the deepest level. */
const DEPTH_INDENT: readonly string[] = ['', 'pl-3', 'pl-6'];

/**
 * A small, development-only panel reporting what the last render cost.
 *
 * Gated on `process.env.NODE_ENV !== 'production'` so the bundler eliminates it from the production
 * bundle: it exists to make the renderer's cost visible to whoever is working on the renderer, and an
 * author has no use for it. The gate is a plain comparison rather than a runtime flag precisely so
 * that elimination can happen.
 *
 * Collapsed to a single small button until someone asks for it. Even in development this sits on top
 * of the document being previewed, and a panel of figures nobody asked to see covers the corner of
 * the page they are reading at every refresh. The button is the whole of what is shown by default.
 *
 * Rendered OUTSIDE the preview's own content container by every caller, so the document-rendering
 * styles stay scoped to the document and this chrome cannot be mistaken for part of it.
 */
export function RenderStatsOverlay({ title, rows }: RenderStatsOverlayProperties) {
  const [isOpen, setIsOpen] = useState(false);

  if (process.env.NODE_ENV === 'production' || rows.length === 0) {
    return null;
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={`Show ${title} render cost`}
        aria-expanded={false}
        title={`${title} render cost`}
        className={cn(
          'absolute bottom-2 right-2 z-10 rounded-md border border-border bg-background/80 p-1',
          'text-muted-foreground opacity-40 shadow-sm transition-opacity hover:opacity-100',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      aria-label={`${title} render cost`}
      className={cn(
        'absolute bottom-2 right-2 z-10 rounded-md border border-border',
        'bg-background/90 px-2 py-1.5 font-mono text-[10px] leading-tight text-muted-foreground shadow-sm',
      )}
    >
      <div className="flex items-center justify-between gap-4 pb-1">
        <p className="font-sans font-medium text-foreground">{title}</p>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          aria-label={`Hide ${title} render cost`}
          aria-expanded
          className={cn(
            'rounded text-muted-foreground hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className={DEPTH_INDENT[Math.min(row.depth ?? 0, DEPTH_INDENT.length - 1)]}>
              {row.label}
            </dt>
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
