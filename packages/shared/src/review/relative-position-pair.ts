/**
 * @file The byte layout of a review anchor's Yjs relative-position PAIR. A root review item pins
 * itself to a passage with two Yjs relative positions (the passage's start and end), and both are
 * stored as ONE opaque blob (`ReviewComment.anchorRelPos`, base64 on the wire). Two independent
 * processes now read that blob — the browser, which resolves it against the live shared document to
 * paint highlights, and the collaboration server, which resolves it at write-back to refresh each
 * anchor's stored line hint — so the layout is a cross-process contract and lives here, in one
 * place, rather than being restated on each side where the two could silently drift.
 *
 * The layout is `[startLength: uint32 little-endian][startBytes][endBytes]`: the prefix makes the
 * boundary exact and the end run is simply the remainder. These helpers are deliberately free of any
 * Yjs dependency — they move bytes only. Each side pairs them with its own
 * `Y.encodeRelativePosition` / `Y.decodeRelativePosition` calls.
 */

/** Bytes reserved for the little-endian length prefix of the start relative-position. */
export const RELPOS_LENGTH_PREFIX_BYTES = 4;

/** A relative-position pair's two encoded byte runs, unpacked from a single stored blob. */
export interface RelativePositionPairBytes {
  /** The encoded start relative-position. */
  start: Uint8Array;
  /** The encoded end relative-position. */
  end: Uint8Array;
}

/**
 * Packs the two encoded relative-position byte runs into one blob.
 *
 * @param start - The encoded start relative-position.
 * @param end - The encoded end relative-position.
 * @returns The packed blob, `[startLength: uint32 LE][start][end]`.
 */
export function packRelativePositionPair(start: Uint8Array, end: Uint8Array): Uint8Array {
  const packed = new Uint8Array(RELPOS_LENGTH_PREFIX_BYTES + start.length + end.length);
  new DataView(packed.buffer).setUint32(0, start.length, true);
  packed.set(start, RELPOS_LENGTH_PREFIX_BYTES);
  packed.set(end, RELPOS_LENGTH_PREFIX_BYTES + start.length);
  return packed;
}

/**
 * Unpacks a blob produced by {@link packRelativePositionPair}. Returns null — never throws — for any
 * malformed input (too short to hold the prefix, or a length prefix that overruns the buffer), so a
 * corrupt stored anchor degrades to "unresolvable" instead of failing the caller.
 *
 * @param packed - The stored blob.
 * @returns The two byte runs, or null when the blob is malformed.
 */
export function unpackRelativePositionPair(packed: Uint8Array): RelativePositionPairBytes | null {
  if (packed.length < RELPOS_LENGTH_PREFIX_BYTES) return null;
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const startLength = view.getUint32(0, true);
  const startEnd = RELPOS_LENGTH_PREFIX_BYTES + startLength;
  if (startEnd > packed.length) return null;
  return {
    start: packed.subarray(RELPOS_LENGTH_PREFIX_BYTES, startEnd),
    end: packed.subarray(startEnd),
  };
}
