import { AnchorState } from '../../constants/review';

/** The text-quote selector captured at anchor creation. */
export interface AnchorQuote {
  /** Up to N characters immediately before the quoted passage. */
  readonly prefix: string;
  /** The quoted passage itself. */
  readonly exact: string;
  /** Up to N characters immediately after the quoted passage. */
  readonly suffix: string;
}

/**
 * Immutable value object describing where a root review item is attached in a
 * document. Holds the primary Yjs relative-position pair plus the durability
 * fallbacks (text quote, line hint, enclosing section) and the current
 * resolution {@link AnchorState}. State transitions return a new anchor.
 *
 * @invariant `quote.exact` must be non-empty (the passage that was selected).
 */
export class ReviewAnchor {
  private readonly _relPos: Uint8Array | null;
  private readonly _quote: AnchorQuote | null;
  private readonly _lineHint: number | null;
  private readonly _sectionId: string | null;
  private readonly _state: AnchorState;

  /**
   * @throws {Error} If a quote is provided with an empty `exact` passage.
   */
  constructor(
    relativePos: Uint8Array | null,
    quote: AnchorQuote | null,
    lineHint: number | null,
    sectionId: string | null,
    state: AnchorState = 'located',
  ) {
    if (quote !== null && quote.exact.length === 0) {
      throw new Error('anchor quote.exact must be non-empty');
    }
    this._relPos = relativePos === null ? null : new Uint8Array(relativePos);
    this._quote = quote === null ? null : { ...quote };
    this._lineHint = lineHint;
    this._sectionId = sectionId;
    this._state = state;
  }

  /** @returns A defensive copy of the encoded relative-position pair, or null. */
  get relPos(): Uint8Array | null {
    return this._relPos === null ? null : new Uint8Array(this._relPos);
  }

  /** @returns A defensive copy of the text-quote selector, or null. */
  get quote(): AnchorQuote | null {
    return this._quote === null ? null : { ...this._quote };
  }

  /** @returns The 1-based line hint (captured at creation, re-measured on write-back), or null. */
  get lineHint(): number | null {
    return this._lineHint;
  }

  /** @returns The enclosing section symbol id, or null. */
  get sectionId(): string | null {
    return this._sectionId;
  }

  /** @returns The current anchor resolution state. */
  get state(): AnchorState {
    return this._state;
  }

  /** @returns A copy of this anchor with its state set to `located`. */
  located(): ReviewAnchor {
    return this.withState('located');
  }

  /**
   * @param sectionId - The enclosing section the item degraded to.
   * @returns A copy of this anchor pinned to a section (`section` state).
   */
  toSection(sectionId: string): ReviewAnchor {
    return new ReviewAnchor(this._relPos, this._quote, this._lineHint, sectionId, 'section');
  }

  /** @returns A copy of this anchor marked `detached`. */
  detached(): ReviewAnchor {
    return this.withState('detached');
  }

  /** @returns A copy of this anchor with the given state, other fields unchanged. */
  withState(state: AnchorState): ReviewAnchor {
    return new ReviewAnchor(this._relPos, this._quote, this._lineHint, this._sectionId, state);
  }

  /**
   * Returns a copy of this anchor carrying a freshly measured line hint, leaving the primary
   * relative-position pair, the quote, the section and the resolution state untouched. The hint is
   * derived data — where the anchor's relative position currently resolves to in the document — so
   * re-measuring it changes nothing about WHERE the item is attached, only what a reader without a
   * loaded document is told about it.
   *
   * @param lineHint - The newly measured 1-based line number, or null when unknown.
   * @returns A copy of this anchor with the new hint.
   */
  withLineHint(lineHint: number | null): ReviewAnchor {
    return new ReviewAnchor(this._relPos, this._quote, lineHint, this._sectionId, this._state);
  }
}
