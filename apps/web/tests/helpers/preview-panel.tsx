// Test double for what `useAsciidocPreview` hands the AsciiDoc preview panel.
//
// The panel no longer publishes the rendered document itself. The hook patches each render into an
// element the panel supplies, and reports that it did so by bumping a nonce; the panel's own work is
// to supply that element, to key its post-commit passes (typesetting, diagram drawing, delegated
// listeners) on that report, and to say whether a render is in flight.
//
// A suite that mocks the hook therefore has to play the hook's part when it wants a document on
// screen: put the markup in the element the panel handed over, and only then announce the commit. The
// order matters and is the hook's own — a pass that runs off the announcement must find the document
// already in place, exactly as it does in the app.

import { act } from '@testing-library/react';
import type React from 'react';

import type { PreviewState } from '@/hooks/use-asciidoc-preview';
import type { RenderTimings } from '@/workers/render-protocol';

/** The fields of the preview hook's result that the panel reads. */
export interface PreviewHookDouble {
  /** Markup of the latest successful render — the render's identity, not what the panel displays. */
  html: string | null;
  /** Where the preview is in its render cycle; drives the indicator and the busy marking. */
  state: PreviewState;
  /** Message from the last failed render, or null. */
  error: string | null;
  /** The scroll container the hook owns. */
  previewRef: React.RefObject<HTMLDivElement | null>;
  /** The element the panel hands over for renders to be committed into. */
  outputRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the latest render carries STEM math to typeset. */
  mathPresent: boolean;
  /** Whether the latest render carries diagram placeholders to draw. */
  diagramsPresent: boolean;
  /** What the last successful render cost, by stage, or null before one completes. */
  timings: RenderTimings | null;
  /** Whether supervision has given up rebuilding the render engine. */
  engineFailed: boolean;
  /** Ask for another engine after {@link PreviewHookDouble.engineFailed}. */
  retryEngine: () => void;
  /** Bumped once per render committed to the output element. */
  renderNonce: number;
}

/** The scroll container the hook would own. Nothing the panel does reads it. */
export const previewScrollReference: React.RefObject<HTMLDivElement | null> = { current: null };

/**
 * The element the panel hands over for the render to be committed into. Shared and mutable because it
 * is a ref: React fills `current` while the panel is mounted and clears it on unmount, so a suite can
 * reach the live output element through it without the panel exposing one.
 */
export const previewOutputReference: React.RefObject<HTMLDivElement | null> = { current: null };

/**
 * A preview-hook result carrying whatever a test cares about and sane defaults for the rest — a panel
 * with nothing rendered yet, which is what it looks like the moment it mounts.
 *
 * @param overrides - The fields this test is about.
 * @returns The full result the panel destructures.
 */
export function previewHookResult(overrides: Partial<PreviewHookDouble> = {}): PreviewHookDouble {
  return {
    html: null,
    state: 'idle',
    error: null,
    previewRef: previewScrollReference,
    outputRef: previewOutputReference,
    mathPresent: false,
    diagramsPresent: false,
    timings: null,
    engineFailed: false,
    retryEngine: () => {},
    renderNonce: 0,
    ...overrides,
  };
}

/**
 * Put a rendered document where the hook would have patched it.
 *
 * Assigning markup is the test's shortcut, not the hook's method: what is being stood in for here is
 * only that the element's contents arrive from somewhere other than React, which is the whole reason
 * the panel must not reconcile them.
 *
 * @param markup - The already-sanitized document to display.
 */
export function commitToPreviewOutput(markup: string): void {
  const output = previewOutputReference.current;
  if (output === null) {
    throw new Error('the preview panel has not handed over an output element to commit into');
  }
  act(() => {
    output.innerHTML = markup;
  });
}
