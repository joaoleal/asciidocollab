import * as Y from 'yjs';
import type { AnchorDto, AnchorQuoteDto, AnchorState, CreateAnchorInput } from '@asciidocollab/shared';
import { packRelativePositionPair, unpackRelativePositionPair } from '@asciidocollab/shared';

/**
 * The primary anchor core for feature 038 review comments: encode/decode the Yjs
 * relative-position pair that pins a review item to a passage, capture the text-quote
 * selector at creation, and resolve a stored anchor back to live document offsets.
 *
 * This module implements ONLY the primary relative-position path plus quote capture. The
 * section/detached degradation fallbacks (using {@link AnchorDto.sectionId} /
 * {@link AnchorDto.lineHint} when the relpos no longer resolves) are a LATER task and live
 * elsewhere; here {@link resolveAnchor} simply returns `null` when the relpos fails so the
 * caller can decide how to degrade.
 *
 * The pure helpers (quote extraction, base64) are exported so they stay independently
 * unit-testable, and every string operation is linear-time (no user-controlled regex).
 */

/** Characters of context captured before/after the quoted passage for durable re-anchoring. */
export const QUOTE_CONTEXT_LEN = 32;
/** Upper bound on a captured anchor's `exact` passage, in characters. */
export const MAX_ANCHOR_LEN = 2000;

/**
 * Encodes a `Uint8Array` to a base64 string without relying on Node's `Buffer` (browser-safe).
 * Builds the binary string in bounded chunks so a large array never overflows the argument stack.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 32_768;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    // Byte values (0–255) sit in the BMP, so fromCodePoint matches the round-trip in base64ToUint8Array.
    binary += String.fromCodePoint(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Decodes a base64 string back to a `Uint8Array` (inverse of {@link uint8ArrayToBase64}). */
export function base64ToUint8Array(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
}

/**
 * Encodes the (start, end) relative-position PAIR into a single base64 string. The two byte runs are
 * packed by {@link packRelativePositionPair} — the shared authority for that layout, because the
 * collaboration server reads the very same blob when it refreshes an anchor's line hint at
 * write-back.
 */
export function encodeRelativePositions(start: Y.RelativePosition, end: Y.RelativePosition): string {
  const packed = packRelativePositionPair(
    Y.encodeRelativePosition(start),
    Y.encodeRelativePosition(end),
  );
  return uint8ArrayToBase64(packed);
}

/**
 * Decodes a base64 relative-position pair produced by {@link encodeRelativePositions}. Returns
 * `null` — never throws — on any malformed input (bad base64, truncated buffer, corrupt length).
 */
export function decodeRelativePositions(
  encoded: string,
): { start: Y.RelativePosition; end: Y.RelativePosition } | null {
  try {
    const unpacked = unpackRelativePositionPair(base64ToUint8Array(encoded));
    if (!unpacked) return null;
    return {
      start: Y.decodeRelativePosition(unpacked.start),
      end: Y.decodeRelativePosition(unpacked.end),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts the text-quote selector for the passage `[start, end)` from `docText`, bounding the
 * `prefix`/`suffix` context to `contextLen` characters. Pure and linear-time.
 */
export function extractQuote(
  documentText: string,
  start: number,
  end: number,
  contextLength: number,
): AnchorQuoteDto {
  return {
    prefix: documentText.slice(Math.max(0, start - contextLength), start),
    exact: documentText.slice(start, end),
    suffix: documentText.slice(end, Math.min(documentText.length, end + contextLength)),
  };
}

/**
 * Clamps an arbitrary `[from, to)` request to a valid, bounded passage: normalises order, expands
 * an empty selection to a single adjacent character so `exact` is never empty, and caps the length
 * at {@link MAX_ANCHOR_LEN}. Returns the resolved half-open `[start, end)` offsets.
 */
function boundedSelection(from: number, to: number, documentLength: number): { start: number; end: number } {
  let start = Math.max(0, Math.min(from, to));
  let end = Math.min(documentLength, Math.max(from, to));
  if (end <= start) {
    // Empty selection: expand forward by one character, or backward at end-of-document.
    if (start < documentLength) end = start + 1;
    else if (start > 0) start -= 1;
  }
  if (end - start > MAX_ANCHOR_LEN) end = start + MAX_ANCHOR_LEN;
  return { start, end };
}

/**
 * Builds a {@link CreateAnchorInput} for the selection `[from, to)`: the encoded relative-position
 * pair (from the two absolute offsets on `ytext`) plus the bounded text-quote selector. Empty and
 * oversized selections are clamped by {@link boundedSelection} so the anchor stays valid — `exact`
 * is non-empty whenever the document has any content.
 */
export function captureAnchor(
  ytext: Y.Text,
  from: number,
  to: number,
  documentText: string,
  lineHint: number,
): CreateAnchorInput {
  const { start, end } = boundedSelection(from, to, documentText.length);
  const relativeStart = Y.createRelativePositionFromTypeIndex(ytext, start);
  const relativeEnd = Y.createRelativePositionFromTypeIndex(ytext, end);
  return {
    relPos: encodeRelativePositions(relativeStart, relativeEnd),
    quote: extractQuote(documentText, start, end, QUOTE_CONTEXT_LEN),
    lineHint,
  };
}

/**
 * Resolves a stored {@link AnchorDto} to live document offsets by decoding its relative-position
 * pair and mapping BOTH endpoints through the current `ydoc` state. Returns order-correct
 * `{ from, to }` (from ≤ to), or `null` when the anchor has no relpos, the relpos is malformed, or
 * either endpoint no longer resolves — leaving degradation to the caller.
 */
export function resolveAnchor(
  anchor: AnchorDto,
  ytext: Y.Text,
  ydoc: Y.Doc,
): { from: number; to: number } | null {
  void ytext;
  if (!anchor.relPos) return null;
  const decoded = decodeRelativePositions(anchor.relPos);
  if (!decoded) return null;
  const absStart = Y.createAbsolutePositionFromRelativePosition(decoded.start, ydoc);
  const absEnd = Y.createAbsolutePositionFromRelativePosition(decoded.end, ydoc);
  if (!absStart || !absEnd) return null;
  return { from: Math.min(absStart.index, absEnd.index), to: Math.max(absStart.index, absEnd.index) };
}

/** A resolved review-item location together with the degradation {@link AnchorState} that produced it. */
export interface AnchorResolution {
  /** The live offset range, or null when the item is detached (neither passage nor section resolves). */
  range: { from: number; to: number } | null;
  /** How the range was obtained: `located` (relpos or quote), `section` (structural), `detached` (lost). */
  state: AnchorState;
}

/** Optional inputs enabling the quote and section degradation tiers. */
export interface DegradationOptions {
  /** The current document text; enables text-quote re-anchoring when the relpos fails. */
  documentText?: string;
  /**
   * Resolves a section symbol id to its live offset range; enables the structural fallback.
   *
   * @param sectionId - The enclosing section symbol id to locate.
   * @returns The section's live offset range, or null when it no longer exists.
   */
  findSectionRange?: (sectionId: string) => { from: number; to: number } | null;
}

/** Length of the common suffix shared by `a` and `b` (bounded by the shorter string). Linear-time. */
function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  const max = Math.min(a.length, b.length);
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
  return count;
}

/** Length of the common prefix shared by `a` and `b`. Linear-time. */
function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  const max = Math.min(a.length, b.length);
  while (count < max && a[count] === b[count]) count++;
  return count;
}

/**
 * Re-anchors by text quote: finds the occurrence of `quote.exact` in `documentText` whose
 * surrounding context best matches the stored `prefix`/`suffix`, disambiguating repeated passages.
 * Pure and linear-time — plain `indexOf` scanning plus context comparison bounded by the context
 * length (no user-controlled regex, Constitution IX). Returns the half-open `{from,to}` or null.
 */
export function findQuoteRange(
  documentText: string,
  quote: AnchorQuoteDto,
): { from: number; to: number } | null {
  const { prefix, exact, suffix } = quote;
  if (exact.length === 0) return null;
  let best = -1;
  let bestScore = -1;
  for (let index = documentText.indexOf(exact); index !== -1; index = documentText.indexOf(exact, index + 1)) {
    const actualPrefix = documentText.slice(Math.max(0, index - prefix.length), index);
    const after = index + exact.length;
    const actualSuffix = documentText.slice(after, Math.min(documentText.length, after + suffix.length));
    const score = commonSuffixLength(actualPrefix, prefix) + commonPrefixLength(actualSuffix, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best === -1 ? null : { from: best, to: best + exact.length };
}

/**
 * Resolves a stored anchor with graceful degradation: (1) the relative-position pair, else (2) the
 * text quote against `documentText`, else (3) the enclosing section via `findSectionRange`, else
 * (4) detached. Tiers 1–2 are `located`, tier 3 is `section`, tier 4 is `detached` — mapping the
 * spec's LOCATED → SECTION → DETACHED ladder onto a single call the UI can render directly.
 */
export function resolveAnchorWithDegradation(
  anchor: AnchorDto,
  ytext: Y.Text,
  ydoc: Y.Doc,
  options: DegradationOptions = {},
): AnchorResolution {
  const located = resolveAnchor(anchor, ytext, ydoc);
  if (located) return { range: located, state: 'located' };

  if (options.documentText !== undefined && anchor.quote) {
    const byQuote = findQuoteRange(options.documentText, anchor.quote);
    if (byQuote) return { range: byQuote, state: 'located' };
  }

  if (anchor.sectionId && options.findSectionRange) {
    const bySection = options.findSectionRange(anchor.sectionId);
    if (bySection) return { range: bySection, state: 'section' };
  }

  return { range: null, state: 'detached' };
}
