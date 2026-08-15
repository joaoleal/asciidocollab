'use client';

import { useEffect, useMemo, useRef } from 'react';
import { defaultAppearance, resolveAppearance } from '@asciidocollab/shared';
import type { AppearanceDiagnostic, AppearanceModel } from '@asciidocollab/shared';

/**
 * The appearance the Print preview presents, resolved from the project's theme document.
 *
 * Resolution is pure and cheap — parsing a YAML document and reading about a hundred keys out of it
 * — and it is memoised on the theme text's identity, so the thing that actually changes constantly
 * (the document being typed) schedules no work here at all. A keystroke burst reuses one resolution.
 *
 * Nothing on this path boots a wasm VM or renders a PDF. The preview's appearance is decided by
 * reading a theme, not by running the renderer: that is what lets the Print style meet the same
 * keystroke-to-refresh budget the other two preview styles are held to.
 *
 * ## Holding the last interpretable appearance
 *
 * A theme being edited is unreadable for most of the time it is being typed — a key with no value
 * yet, a half-written mapping. Falling back to the default appearance on each of those keystrokes
 * would throw the page between the author's theme and the renderer's default, moving the page column
 * as the margins changed underneath it, and would make the theme editor unusable for the one thing
 * it exists for. So the last interpretable appearance is held while the current text cannot be read,
 * and the problem is reported rather than performed.
 *
 * The resolver stays pure and knows nothing of this: it is given text and returns what that text
 * means. Remembering what the last text meant is the caller's job, which is this hook.
 */

/** What to resolve an appearance from. */
export interface PrintAppearanceInput {
  /** Whether the Print style is the selected one. Resolution is skipped entirely when it is not. */
  readonly enabled: boolean;
  /** The project theme document's text, or undefined when the project has no theme. */
  readonly themeText?: string;
  /** The theme document's path, used only to attribute a diagnostic to a file. */
  readonly themePath?: string;
  /**
   * The project the theme belongs to. What was last interpretable is remembered per project, so
   * opening another one starts from its own theme rather than from the previous project's.
   */
  readonly projectId?: string;
}

/**
 * The resolved appearance and everything the preview needs to present and explain it.
 *
 * No CSS: the projection onto custom properties needs the font metrics of the faces the appearance
 * names, and those are only knowable once the appearance has said which faces they are. Resolving
 * here and projecting after the fonts is what keeps that one-directional.
 */
export interface PrintAppearance {
  /** The appearance model. Always present — a theme that cannot be read costs the theme, not the page. */
  readonly appearance: AppearanceModel;
  /**
   * Problems found while reading the theme. Empty when nothing is wrong.
   *
   * This is the whole account of what the page is showing and why: whether a theme was applied is
   * visible in the appearance itself, and a page holding the last readable theme says so in the
   * diagnostic {@link describeHeldTheme} restates. Both facts were also published as flags of their
   * own, which nothing ever read — and a second way to say something is a second thing to keep true.
   */
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

/** The result for a preview that is not showing the Print style, built once and shared. */
const NOT_APPLICABLE: PrintAppearance = {
  appearance: defaultAppearance(),
  diagnostics: [],
};

/**
 * Restate an unreadable-theme diagnostic for a page that is holding the last theme that worked.
 *
 * Only the message changes, and only for that one code: the code, the location and the severity are
 * the resolver's and stay its.
 *
 * @param diagnostic - As the resolver reported it.
 * @returns The same diagnostic, saying what is actually on screen.
 */
function describeHeldTheme(diagnostic: AppearanceDiagnostic): AppearanceDiagnostic {
  if (diagnostic.code !== 'theme-unparseable') return diagnostic;
  const reason = diagnostic.detail ?? diagnostic.message;
  return {
    ...diagnostic,
    severity: 'warning',
    message: `The theme document cannot be read at the moment, so the last version that could be read is still shown: ${reason}`,
  };
}

/** An appearance that was interpretable, and the project it was read for. */
interface LastInterpretable {
  /** The project it belongs to; another project's theme never inherits it. */
  readonly projectId?: string;
  /** The appearance itself. */
  readonly appearance: AppearanceModel;
}

/**
 * Resolve the Print style's appearance for a project.
 *
 * @param input - Whether the style is active, and the theme document to resolve.
 * @returns The appearance, its CSS projection, and any problems found reading the theme.
 */
export function usePrintAppearance(input: PrintAppearanceInput): PrintAppearance {
  const { enabled, themeText, themePath, projectId } = input;
  const lastInterpretable = useRef<LastInterpretable | null>(null);

  // Resolution itself: pure, and memoised on the text it reads. Nothing here decides anything about
  // what came before.
  const resolved = useMemo(
    () =>
      enabled
        ? resolveAppearance({
            ...(themeText === undefined ? {} : { themeText }),
            ...(themePath === undefined ? {} : { themePath }),
          })
        : null,
    [enabled, themeText, themePath],
  );

  const result = useMemo<PrintAppearance>(() => {
    if (resolved === null) return NOT_APPLICABLE;

    const held =
      lastInterpretable.current?.projectId === projectId ? lastInterpretable.current : null;

    // Only an UNREADABLE theme holds. A project whose theme was deleted, or which never had one, is
    // showing the default because the default is now correct — holding there would leave the page
    // dressed in a theme the project no longer has.
    const unreadable = resolved.diagnostics.some(
      (diagnostic) => diagnostic.code === 'theme-unparseable',
    );
    if (unreadable && held !== null) {
      return {
        appearance: held.appearance,
        // The resolver says the default is being shown, because from where it stands that is what it
        // returned. It is not what the page is showing. Reporting its wording unchanged would tell an
        // author mid-keystroke that their theme had been dropped while they were looking straight at
        // it — so the one diagnostic whose claim this hook contradicts is restated.
        diagnostics: resolved.diagnostics.map(describeHeldTheme),
      };
    }

    return { appearance: resolved.appearance, diagnostics: resolved.diagnostics };
  }, [resolved, projectId]);

  // Remembering is a side effect, so it happens after the render is committed rather than inside the
  // memo above. A memo may run for a render React then throws away — under StrictMode it runs twice,
  // and a concurrent render may never commit at all — and a hold recorded from a render nobody saw is
  // a page dressed in a theme that was never on screen. This is also the shape of a defect this
  // codebase has shipped before: a value and the claim about it derived a commit apart.
  //
  // The one-commit lag is what this wants, not something it tolerates: the held appearance is only
  // ever read when the CURRENT text cannot be read, and a text that cannot be read never records.
  useEffect(() => {
    if (resolved === null) return;
    // A project that no longer has a theme has nothing to hold: forget it, so a theme added later and
    // mistyped holds nothing rather than the appearance of a file that has since been deleted.
    if (themeText === undefined || themeText.trim() === '') {
      lastInterpretable.current = null;
      return;
    }
    if (!resolved.themeApplied) return;
    lastInterpretable.current = {
      ...(projectId === undefined ? {} : { projectId }),
      appearance: resolved.appearance,
    };
  }, [resolved, themeText, projectId]);

  return result;
}
