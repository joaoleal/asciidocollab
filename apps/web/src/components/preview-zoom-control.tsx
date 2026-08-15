'use client';

import { useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clamp } from '@/lib/utilities';

/**
 * The zoom model both preview panels share.
 *
 * It lives here rather than in either panel because the two are required to offer the same default,
 * the same presets and the same limits — and a second implementation of "the same numbers" starts
 * drifting from the first the moment one of them gains a preset. Sharing the model makes that
 * requirement structurally true instead of something a test has to keep checking.
 *
 * Only the state and the control are shared. The PDF panel additionally re-rasterises its pages at
 * the settled scale after a debounce, because pdf.js paints to a canvas; the Print preview scales
 * live DOM with a CSS transform, which is exact at any zoom and needs no repaint at all.
 */

/**
 * `fit` scales the page to the pane's width; `custom` pins it to an explicit factor.
 *
 * Internal to this module: what a pane needs is the resulting {@link PreviewZoom.targetScale}, and
 * a pane given the state itself would be free to decide the scale a second way.
 */
type ZoomState = { mode: 'fit' } | { mode: 'custom'; scale: number };

/** Smallest zoom factor the control allows (a quarter of the intrinsic point size). */
export const MIN_ZOOM = 0.25;

/** Largest zoom factor the control allows (four times the intrinsic point size). */
export const MAX_ZOOM = 4;

/** Multiplicative step each zoom-in/zoom-out press applies to the current scale. */
export const ZOOM_STEP = 1.25;

/** Sentinel `<select>` value the preset control uses for fit-to-width mode. */
export const FIT_PRESET_VALUE = 'fit';

/**
 * The zoom presets the selector offers, in display order. The `<option>` value is the stringified
 * factor so the selected preset round-trips through the native control without a lookup table.
 */
export const ZOOM_PRESETS: readonly { value: string; label: string; scale: number }[] = [
  { value: '0.75', label: '75%', scale: 0.75 },
  { value: '1', label: '100%', scale: 1 },
  { value: '1.25', label: '125%', scale: 1.25 },
  { value: '1.5', label: '150%', scale: 1.5 },
  { value: '2', label: '200%', scale: 2 },
];

/** Everything a panel needs to drive the zoom control and to know what scale to present at. */
export interface PreviewZoom {
  /** The scale the user is currently asking for, whether by fitting or by an explicit factor. */
  readonly targetScale: number;
  /** The `<select>` value that reflects the current state. */
  readonly presetValue: string;
  /** The current scale as a percentage, for the readout. */
  readonly livePercentLabel: string;
  /** The fit option's label, which carries the resulting percentage once a fit has been measured. */
  readonly fitOptionLabel: string;
  /** Whether a further step in is available within the range. */
  readonly canZoomIn: boolean;
  /** Whether a further step out is available within the range. */
  readonly canZoomOut: boolean;
  /** Step in one multiplicative step, clamped. */
  readonly zoomIn: () => void;
  /** Step out one multiplicative step, clamped. */
  readonly zoomOut: () => void;
  /**
   * Apply a preset selection.
   *
   * @param value - The selected `<option>` value.
   */
  readonly selectPreset: (value: string) => void;
}

/**
 * Own the zoom state for one preview pane.
 *
 * @param fitScale - The scale that fits the content to the pane, or undefined before it is measured.
 * @param fallbackScale - The scale to present at before a fit measurement exists.
 * @returns The zoom state and the derived values the control and the pane both read.
 */
export function usePreviewZoom(fitScale: number | undefined, fallbackScale: number): PreviewZoom {
  const [zoom, setZoom] = useState<ZoomState>({ mode: 'fit' });

  const effectiveFit = fitScale === undefined ? fallbackScale : clamp(fitScale, MIN_ZOOM, MAX_ZOOM);
  const targetScale = zoom.mode === 'custom' ? zoom.scale : effectiveFit;
  const isFit = zoom.mode === 'fit';
  const livePercentLabel = `${Math.round(targetScale * 100)}%`;

  // The Fit option shows the resulting live percentage once measured, e.g. "Fit (92%)". A custom
  // scale that matches a preset selects it; any other custom scale (from the +/- steps) surfaces as a
  // transient option so the native control always reflects the real state.
  const fitOptionLabel = isFit && fitScale !== undefined ? `Fit (${livePercentLabel})` : 'Fit';
  const matchedPreset =
    zoom.mode === 'custom'
      ? ZOOM_PRESETS.find((preset) => Math.abs(preset.scale - zoom.scale) < 1e-6)
      : undefined;

  return {
    targetScale,
    presetValue: isFit ? FIT_PRESET_VALUE : (matchedPreset?.value ?? 'custom'),
    livePercentLabel,
    fitOptionLabel,
    canZoomIn: targetScale < MAX_ZOOM,
    canZoomOut: targetScale > MIN_ZOOM,
    zoomIn: () => setZoom({ mode: 'custom', scale: clamp(targetScale * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) }),
    zoomOut: () => setZoom({ mode: 'custom', scale: clamp(targetScale / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) }),
    selectPreset: (value: string) => {
      if (value === FIT_PRESET_VALUE) {
        setZoom({ mode: 'fit' });
        return;
      }
      // The reflective "custom" entry exists only to show a stepped scale; picking it changes nothing.
      if (value === 'custom') return;
      setZoom({ mode: 'custom', scale: clamp(Number(value), MIN_ZOOM, MAX_ZOOM) });
    },
  };
}

interface PreviewZoomControlProperties {
  /** The zoom state this control drives. */
  zoom: PreviewZoom;
  /** Prefix for the control's test ids, so each pane's controls stay individually addressable. */
  testIdPrefix: string;
}

/** Zoom stepper, preset selector and stepper, in the order both preview panes present them. */
export function PreviewZoomControl({ zoom, testIdPrefix }: PreviewZoomControlProperties) {
  return (
    <>
      {/* A preset selector is the primary affordance; +/- fine-tune around it. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={zoom.zoomOut}
        disabled={!zoom.canZoomOut}
        className="h-6 w-6 text-muted-foreground"
        aria-label="zoom out"
        title="Zoom out"
        data-testid={`${testIdPrefix}-zoom-out`}
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <select
        value={zoom.presetValue}
        onChange={(event) => zoom.selectPreset(event.target.value)}
        aria-label="zoom level"
        title="Zoom level"
        data-testid={`${testIdPrefix}-zoom-preset`}
        // Snug fixed width sized for the widest label ("Fit (100%)"), right-aligned, so the control
        // stays compact next to the steppers and never shifts as the selection/percentage changes.
        className="h-6 min-w-[5.5rem] whitespace-nowrap rounded-md border border-border bg-transparent px-1 text-right text-xs tabular-nums text-muted-foreground"
      >
        <option value={FIT_PRESET_VALUE} data-testid={`${testIdPrefix}-zoom-fit`}>
          {zoom.fitOptionLabel}
        </option>
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        {zoom.presetValue === 'custom' && <option value="custom">{zoom.livePercentLabel}</option>}
      </select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={zoom.zoomIn}
        disabled={!zoom.canZoomIn}
        className="h-6 w-6 text-muted-foreground"
        aria-label="zoom in"
        title="Zoom in"
        data-testid={`${testIdPrefix}-zoom-in`}
      >
        <ZoomIn className="h-4 w-4" />
      </Button>
    </>
  );
}
