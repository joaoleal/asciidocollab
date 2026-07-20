'use client';

/**
 * @file The preview comparison control: render the sample with one extension held out, and with it
 * back in, changing nothing else (FR-031b1, FR-031b2).
 *
 * Why a comparison is needed at all. An extension's effect is often a DIFFERENCE rather than a mark —
 * a contents list that is narrower, paragraphs that carry numbers, a table that moved to its own
 * page. Seen once, none of those announce which extension produced them, and an author judging
 * whether an extension earns its place has no baseline to judge against. Switching it off and on in
 * the project settings would work, but it changes what the project RENDERS, and the round trip is
 * slow enough that the two states are never on screen close enough together to compare.
 *
 * The control is deliberately narrow in three ways:
 *
 *  - **One extension at a time.** Holding out several at once produces a difference that cannot be
 *    attributed to any one of them, which is the thing the control exists to make possible.
 *  - **The preview only.** Nothing here writes to the project's selection. What the project renders
 *    is unchanged by anything an author does with this.
 *  - **Nothing else changes.** The held-out extension is removed from the load list and the theme,
 *    document and every other extension stay exactly as they were, so the difference on screen is
 *    attributable to that extension and nothing else (FR-031b2).
 *
 * With no extensions enabled there is nothing to compare, so the control renders nothing at all
 * rather than an inert dropdown the author would try to use (FR-031b3).
 */

import type { EnabledExtension } from '@/hooks/use-theme-settings';

/** What the comparison control shows and reports. */
export interface ExtensionComparisonToggleProperties {
  /** The extensions in force for this project, in catalogue order. */
  readonly extensions: readonly EnabledExtension[];
  /**
   * The extension currently held out of the preview, or null when the preview shows all of them.
   *
   * Controlled rather than internal: the parent has to know which extension is held out in order to
   * build the preview's load list, so keeping a second copy here could only ever disagree with it.
   */
  readonly withheldId: string | null;
  /**
   * Reports the extension to hold out of the preview.
   *
   * @param id - The extension to hold out, or null to show the preview with all of them.
   */
  readonly onWithhold: (id: string | null) => void;
}

/** The value the select uses for "nothing held out"; empty is not a legal extension id. */
const NONE_VALUE = '';

/**
 * A control for previewing the sample without one of the project's enabled extensions.
 *
 * @param properties - The enabled extensions, which is held out, and how to change that.
 * @returns The control, or nothing when the project has no extensions enabled.
 */
export function ExtensionComparisonToggle({
  extensions,
  withheldId,
  onWithhold,
}: ExtensionComparisonToggleProperties): React.JSX.Element | null {
  if (extensions.length === 0) return null;

  // A stale `withheldId` — an extension disabled in settings while it was held out here — would leave
  // the control showing a name that is no longer on offer while the preview quietly showed
  // everything. Falling back to "nothing held out" keeps the label and the preview in agreement.
  const selected = extensions.some((extension) => extension.id === withheldId)
    ? (withheldId ?? NONE_VALUE)
    : NONE_VALUE;

  return (
    // No row of its own: this sits inline in the editor toolbar, beside the file path. As its own
    // full-width bar it cost a line of the panel permanently — on a control most authors touch once,
    // in a panel whose whole job is to show as much of the rendered sample as it can.
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <label htmlFor="extension-comparison" className="shrink-0 text-muted-foreground">
        Preview
      </label>
      <select
        id="extension-comparison"
        data-testid="extension-comparison-toggle"
        // The options are phrased to read as a continuation of the label — "Preview: with all
        // extensions" / "Preview: without Paragraph numbering" — so the control explains itself in
        // place. It used to be labelled "Compare without", above options that named a bare extension,
        // which left the reader to work out what was being compared against what.
        title="Leave one extension out of the preview to see what it contributes. Only the preview changes — the project's own extensions are not affected."
        className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
        value={selected}
        onChange={(event) => {
          const { value } = event.target;
          onWithhold(value === NONE_VALUE ? null : value);
        }}
      >
        <option value={NONE_VALUE}>with all extensions</option>
        {extensions.map((extension) => (
          <option key={extension.id} value={extension.id}>
            without {extension.displayName}
          </option>
        ))}
      </select>
      {selected !== NONE_VALUE && (
        <span
          role="status"
          data-testid="extension-comparison-state"
          className="shrink-0 rounded bg-[hsl(var(--warning-bg))] px-2 py-0.5 text-[hsl(var(--warning))]"
        >
          Preview only
        </span>
      )}
    </div>
  );
}
