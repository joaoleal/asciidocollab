/**
 * @file What went wrong while resolving a theme into an appearance.
 *
 * This is the resolver's OWN diagnostic type, with its own code vocabulary. It is deliberately not a
 * restatement of the PDF pipeline's `RenderDiagnostic`, which is that package's wire protocol with
 * its wasm worker: the same type defined in two packages is the duplication this repository has
 * already been bitten by, and unifying them is not available either — the PDF package may depend
 * inward only on the AsciiDoc language kernel, so it cannot import from here.
 *
 * The two genuinely differ. This one carries the theme key a value was rejected for, which has no
 * counterpart in a render pipeline, and none of the render pipeline's codes describes a theme that
 * would not parse. They meet in the delivery layer, which already imports both, through an explicit
 * adapter onto the diagnostics component's structural minimum.
 */

/** What kind of appearance problem was found. */
export type AppearanceDiagnosticCode =
  /** The theme document could not be read at all, so none of it was applied. */
  | 'theme-unparseable'
  /** One value did not match what its key accepts, so that key alone fell back to its default. */
  | 'theme-value-rejected'
  /**
   * One value was APPLIED, and not whole — the renderer cut it to reach the shape the key takes.
   *
   * A distinct code rather than a rejection because it is the opposite claim: the value is on the
   * page, and what is worth saying is that some of what the author wrote is not. `to_color` sizes
   * anything to six characters (`theme_loader.rb:313-321`), so `font-color: "FF0000 /* x"` inks pure
   * red in the exported page and everything after the sixth character is gone in silence.
   */
  | 'theme-value-truncated'
  /** A font the theme asks for could not be obtained, so an approximation is being shown. */
  | 'theme-font-unavailable';

/** Where in a document a problem was found. */
export interface AppearanceLocation {
  /** Project-relative path of the document. */
  readonly path: string;
  /** 1-based line, where one could be attributed. */
  readonly line?: number;
}

/**
 * One appearance problem, in the form the diagnostics surface presents.
 *
 * ## Nothing here is the document's text
 *
 * Every string field is built from this package's own sentences and its own closed vocabulary — the
 * theme keys the model claims, the resource the caller named — and never from the theme document.
 * That is what lets the delivery layer render a diagnostic as ordinary copy in its own warning list
 * rather than as content from an untrusted source.
 *
 * It is a rule about the SOURCE of the text, not about escaping it. A theme is an ordinary project
 * file any collaborator can write, and a flat theme key is up to a thousand characters of whatever
 * its author chose: interpolating one put a stranger's sentence, addressed to whoever the project
 * was shared with, into the application's own warning about that project. Escaped, so never markup,
 * and still the stranger's sentence. Held by `hostile-theme.test.ts`, which plants a marker in every
 * position a document's text can enter and reads back every field of every diagnostic produced.
 */
export interface AppearanceDiagnostic {
  /** Errors sort before warnings. */
  readonly severity: 'error' | 'warning';
  /** What kind of problem this is. */
  readonly code: AppearanceDiagnosticCode;
  /** Human-readable explanation. Carries none of the theme document's own text — see above. */
  readonly message: string;
  /**
   * Why it went wrong, in the words of whatever found it — the parser's own complaint, say.
   *
   * Carried apart from {@link message} because the message states what is being SHOWN as a result,
   * and only the caller knows that: the preview may be holding the last theme that worked rather than
   * falling back to the default. A caller that restates the message needs the reason to keep.
   */
  readonly detail?: string;
  /**
   * The theme key a problem was found in.
   *
   * Only ever one of `NAMED_THEME_KEYS`, which is this package's own vocabulary: the keys the model
   * reads, plus the handful it names without reading — `extends`, the page-image settings — written
   * down beside them. A problem found in a key the model does NOT have a word for carries its
   * location instead, because the document's own name for it is the document's own text.
   *
   * The list is what the invariant is stated over rather than the claimed keys alone, because it was
   * once stated over the claimed keys and `extends` was reported anyway. A rule with one known
   * exception cannot tell a second exception from a leak.
   */
  readonly themeKey?: string;
  /** What the problem is about: the theme document's path, or a font family name. */
  readonly resource: string;
  /** Where it was found, where that is known — this is what a reveal-in-editor control needs. */
  readonly location?: AppearanceLocation;
}
