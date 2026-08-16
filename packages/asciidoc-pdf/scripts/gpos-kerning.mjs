/**
 * Build the one OpenType layout table the base-14 stand-ins carry: a `GPOS` holding the AFM's kerning.
 *
 * ## Why it is a module of its own
 *
 * It was a private function inside `generate-base14-fonts.mjs`, and one consequence of that was a
 * guard nothing could reach: the subtable's 16-bit-offset limit is a condition no committed AFM comes
 * within a fifth of, so the only way to see the named failure is to hand the builder a pair list that
 * is not any font's. A test cannot import the generator to do that — the generator ends in `await
 * main()`, so importing it converts fourteen typefaces and writes an asset directory — which left the
 * limit stated, unexercised, and (as it turned out) unreachable, the write that overflows coming
 * before the check that names it.
 *
 * So the builder lives here, beside `sfnt-from-cff.mjs`, for the same reason that one does: it is the
 * part of the conversion that can be given inputs of its own and held to an answer. Nothing else
 * changes — the generator imports it and is its only caller in the build.
 *
 * ## What is built, and what is deliberately not
 *
 * Only kerning, and only in the one shape a browser reads a kern out of. The published faces carry no
 * `GSUB` at all and none of the stand-in's own `GPOS`; the reasoning for both — prawn substitutes no
 * ligature, and TeX Gyre's own pair adjustments disagree with Adobe's `KPX` list — is on `convertText`
 * in the generator, next to the measurements that decided it.
 */

/**
 * A `GPOS` table carrying the AFM's own kerning, and nothing else.
 *
 * One `DFLT` script, one `kern` feature, one pair-adjustment lookup, one `PairPos` format-1 subtable
 * whose only value record is an `XAdvance` on the first glyph of the pair. That is the shape a
 * browser reads a kern out of, and it is the smallest one that says what the AFM says.
 *
 * Format 1 rather than the class-based format 2 because the AFM's pairs are an explicit list, not a
 * cross-product: writing them as classes would be a compression of data that is already small, and
 * would put a derivation between the AFM and the file where there is currently a transcription.
 *
 * @param pairs - `[firstGlyphId, secondGlyphId, xAdvance]`, in any order.
 * @returns The table's bytes.
 * @throws {Error} When the subtable outgrows the 16-bit offsets its own records are addressed by.
 */
export function gposKerning(pairs) {
  const byFirst = new Map();
  for (const [first, second, adjustment] of pairs) {
    const seconds = byFirst.get(first);
    if (seconds === undefined) byFirst.set(first, [[second, adjustment]]);
    else seconds.push([second, adjustment]);
  }
  // Coverage and every PairSet are read by binary search, so both orders are load-bearing.
  const firsts = [...byFirst.keys()].toSorted((left, right) => left - right);

  const pairSets = firsts.map((first) => {
    const seconds = byFirst.get(first).toSorted((left, right) => left[0] - right[0]);
    const set = Buffer.alloc(2 + 4 * seconds.length);
    set.writeUInt16BE(seconds.length, 0);
    seconds.forEach(([glyph, adjustment], index) => {
      set.writeUInt16BE(glyph, 2 + index * 4);
      set.writeInt16BE(adjustment, 4 + index * 4);
    });
    return set;
  });

  const coverage = Buffer.alloc(4 + 2 * firsts.length);
  coverage.writeUInt16BE(1, 0);
  coverage.writeUInt16BE(firsts.length, 2);
  firsts.forEach((glyph, index) => coverage.writeUInt16BE(glyph, 4 + index * 2));

  const pairPos = Buffer.alloc(10 + 2 * firsts.length);
  // Every offset inside the subtable is 16-bit and relative to the subtable's own start, so the
  // subtable's whole extent has to fit in 16 bits. Measured BEFORE anything is written, because
  // `writeUInt16BE` refuses a value above 65535 itself: with this check sitting after the loop that
  // writes the PairSet offsets, the first offset past the limit died inside Node with an
  // `ERR_OUT_OF_RANGE` naming a buffer and no face, and the message below could not be produced at
  // all. Helvetica's subtable is the largest today at 11 KB of the 64 KB available, so this is a
  // guard against a future AFM rather than a live limit — which is exactly the kind that has to be
  // tested rather than trusted.
  const extent =
    pairPos.length + coverage.length + pairSets.reduce((total, set) => total + set.length, 0);
  if (extent > 0xFF_FF) {
    throw new Error(`A PairPos subtable of ${extent} bytes cannot be addressed by 16-bit offsets.`);
  }
  pairPos.writeUInt16BE(1, 0);
  pairPos.writeUInt16BE(0x00_04, 4); // valueFormat1: an XAdvance and nothing else.
  pairPos.writeUInt16BE(0, 6); // valueFormat2: the second glyph is not adjusted.
  pairPos.writeUInt16BE(firsts.length, 8);
  let at = pairPos.length;
  pairPos.writeUInt16BE(at, 2);
  at += coverage.length;
  pairSets.forEach((set, index) => {
    pairPos.writeUInt16BE(at, 10 + index * 2);
    at += set.length;
  });
  const subtable = Buffer.concat([pairPos, coverage, ...pairSets]);

  const u16 = (...values) => {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeUInt16BE(value, index * 2));
    return buffer;
  };
  // lookupType 2 (pair adjustment), no flags, one subtable, which starts right after the header.
  const lookupList = Buffer.concat([u16(1, 4), u16(2, 0, 1, 8), subtable]);
  const featureTag = Buffer.alloc(4);
  featureTag.write('kern', 0, 4, 'latin1');
  const featureList = Buffer.concat([u16(1), featureTag, u16(8), u16(0, 1, 0)]);
  const scriptTag = Buffer.alloc(4);
  scriptTag.write('DFLT', 0, 4, 'latin1');
  // A script whose default LangSys requires no feature and lists this one, and no other LangSys.
  const scriptList = Buffer.concat([u16(1), scriptTag, u16(8), u16(4, 0), u16(0, 0xFF_FF, 1, 0)]);
  const header = u16(1, 0, 10, 10 + scriptList.length, 10 + scriptList.length + featureList.length);
  return Buffer.concat([header, scriptList, featureList, lookupList]);
}
