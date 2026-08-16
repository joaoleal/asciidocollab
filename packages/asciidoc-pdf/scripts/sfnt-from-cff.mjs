/**
 * Wrap a bare CFF font program in an OpenType sfnt, so a browser can be handed it.
 *
 * ## Why this is needed at all
 *
 * The two symbolic base-14 faces — Symbol and ZapfDingbats — are substituted here by pdf.js's
 * FoxitSymbol and FoxitDingbats. Those ship with a `.pfb` extension, which says Type 1, and are not:
 * their first four bytes are `01 00 04 02`, a CFF header, and their Name INDEX reads
 * `ChromSymbolOTF` / `ChromDingbatsOTF`. A bare CFF is a font PROGRAM with no sfnt around it — no
 * table directory, no `head`, no `cmap`, no `hmtx` — so nothing that expects an OpenType file will
 * read it. `fonteditor-core` rejects them outright ("otf file damaged"), and so would a browser.
 *
 * The outlines are already exactly what is wanted (see the generator's header for the width
 * measurement); what is missing is the container. So this builds one: the CFF bytes go in verbatim as
 * the `CFF ` table, and the nine tables an OpenType/CFF font must carry are synthesised around them.
 *
 * ## Where each synthesised number comes from
 *
 * Every number that any consumer of this file reads is derived, and the derivation is named at the
 * line that writes it. The advances come from the AFM the renderer itself measures with, so the file
 * a browser is handed advances exactly as the export does; the left side bearings come from the
 * charstrings, which is where a glyph's own `xMin` is (see {@link glyphLeftSideBearings}); the
 * vertical metrics come from the AFM's `FontBBox`, for the reason set out on {@link buildSfnt}'s
 * `ascender` parameter; the underline pair comes from the AFM's own two attributes. The glyph order
 * and the glyph names come from the CFF's own charset, read back out of the file rather than assumed
 * — see {@link glyphNamesOf}.
 *
 * A handful of `OS/2` fields have no source anywhere — an AFM states no subscript size and no
 * strikeout position, and a symbolic face has no x-height and no cap height to state. Those are
 * INVENTED, and each is written as a named constant below whose comment says so, says why the
 * invention is safe here, and says what would stop it being safe. This paragraph used to read
 * "Nothing here invents a metric", which was the trap: fifteen fabricated values sat beside a
 * meticulous derivation of the ascender and the descender, and the silence about them read as
 * sourcing.
 *
 * ## How it is verified
 *
 * By round trip, in `tests/fonts/base14-fonts.test.ts`: the committed WOFF2 is decoded back to an
 * sfnt, its `cmap` is walked for every byte a PDF content stream can carry, and the advance found
 * there is compared against the AFM's own. A wrapper that mis-orders `hmtx`, mis-builds the `cmap` or
 * loses the glyph order fails that comparison at the first character.
 *
 * The charstring reader is verified against the font's own declaration: the union of the per-glyph
 * bounds it computes has to reproduce the Top DICT's `FontBBox` horizontally, or nothing is written
 * (see {@link glyphLeftSideBearings}).
 */

/** Every OpenType/CFF font must carry these nine tables; the directory is sorted by tag. */
const TABLE_ORDER = ['CFF ', 'OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post'];

/**
 * A fixed timestamp for `head`'s created and modified fields.
 *
 * Zero rather than the wall clock: the generator's `--check` mode compares the committed bytes
 * against a fresh conversion, and a timestamp would make every run differ from every other. Font
 * dates are metadata no consumer of this file reads.
 */
const EPOCH = 0n;

/** `head.magicNumber`, which a reader uses to confirm it is looking at a real `head` table. */
const HEAD_MAGIC = 0x5F_0F_3C_F5;

/** The constant `head.checkSumAdjustment` is derived from, per the OpenType specification. */
const CHECKSUM_ADJUSTMENT_BASE = 0xB1_B0_AF_BA;

/** Truncating 32-bit addition, which is the arithmetic every sfnt checksum is defined in. */
function addU32(a, b) {
  return (a + b) >>> 0;
}

/**
 * The sfnt checksum of a table: the sum of its bytes read as big-endian 32-bit words.
 *
 * @param bytes - The table, already padded to a multiple of four.
 * @returns The checksum.
 */
function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    sum = addU32(sum, bytes.readUInt32BE(offset));
  }
  return sum;
}

/** A table padded to the four-byte boundary the table directory's offsets are defined on. */
function pad4(bytes) {
  const remainder = bytes.length % 4;
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(4 - remainder)]);
}

/**
 * Read one CFF INDEX.
 *
 * An INDEX is the CFF's only container: a count, an offset size, `count + 1` offsets and then the
 * data those offsets cut up. Every structure this module needs to reach sits behind one or more of
 * them.
 *
 * @param bytes - The whole CFF.
 * @param start - Where the INDEX begins.
 * @returns The items, and the offset just past the INDEX.
 */
function readIndex(bytes, start) {
  const count = bytes.readUInt16BE(start);
  if (count === 0) return { items: [], end: start + 2 };
  const offSize = bytes[start + 2];
  if (offSize < 1 || offSize > 4) throw new Error(`CFF INDEX at ${start} declares offSize ${offSize}.`);
  const offsets = [];
  for (let index = 0; index <= count; index += 1) {
    let value = 0;
    for (let byte = 0; byte < offSize; byte += 1) {
      value = value * 256 + bytes[start + 3 + index * offSize + byte];
    }
    offsets.push(value);
  }
  // Offsets are one-based from the byte before the data, which is where the `- 1` comes from.
  const data = start + 3 + (count + 1) * offSize - 1;
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push(bytes.subarray(data + offsets[index], data + offsets[index + 1]));
  }
  return { items, end: data + offsets[count] };
}

/**
 * Read a CFF DICT into operator → operands.
 *
 * Only the integer operand forms are decoded. A real number operand (operator 30) is skipped rather
 * than parsed: the only DICT entries this module reads are offsets and counts, all of them integers,
 * and the one real-valued entry a Top DICT may carry — `FontMatrix` — is deliberately not consulted
 * (see {@link buildSfnt}'s `unitsPerEm`).
 *
 * @param bytes - The DICT's own bytes.
 * @returns Operator (two-byte operators keyed as `12 <n>`) to its operand list.
 */
function readDict(bytes) {
  const dict = new Map();
  let operands = [];
  let offset = 0;
  while (offset < bytes.length) {
    const b0 = bytes[offset];
    if (b0 <= 21) {
      const key = b0 === 12 ? `12 ${bytes[offset + 1]}` : String(b0);
      offset += b0 === 12 ? 2 : 1;
      dict.set(key, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(bytes.readInt16BE(offset + 1));
      offset += 3;
    } else if (b0 === 29) {
      operands.push(bytes.readInt32BE(offset + 1));
      offset += 5;
    } else if (b0 === 30) {
      // A real number, run-length nibbles terminated by 0xf. Skipped, not decoded.
      offset += 1;
      while (offset < bytes.length) {
        const byte = bytes[offset];
        offset += 1;
        if ((byte & 0x0F) === 0x0F || (byte >> 4) === 0x0F) break;
      }
      operands.push(Number.NaN);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      offset += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + bytes[offset + 1] + 108);
      offset += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - bytes[offset + 1] - 108);
      offset += 2;
    } else {
      throw new Error(`CFF DICT carries reserved byte ${b0}.`);
    }
  }
  return dict;
}

/**
 * The CFF standard strings, which are string identifiers 0 to 390 and are not stored in the file.
 *
 * Appendix A of the CFF specification, in its own order — the index into this list IS the SID. It is
 * here because a charset names its glyphs by SID and the base-14 symbolic faces use both halves of
 * the space: `space`, `bullet` and the arithmetic signs are standard strings, while `alpha` and
 * ZapfDingbats' `a1`..`a191` are not and come from the file's own String INDEX.
 */
const CFF_STANDARD_STRINGS = [
  '.notdef', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
  'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon',
  'semicolon', 'less', 'equal', 'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H',
  'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'quoteleft', 'a', 'b',
  'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u',
  'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde', 'exclamdown', 'cent',
  'sterling', 'fraction', 'yen', 'florin', 'section', 'currency', 'quotesingle', 'quotedblleft',
  'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', 'endash', 'dagger', 'daggerdbl',
  'periodcentered', 'paragraph', 'bullet', 'quotesinglbase', 'quotedblbase', 'quotedblright',
  'guillemotright', 'ellipsis', 'perthousand', 'questiondown', 'grave', 'acute', 'circumflex',
  'tilde', 'macron', 'breve', 'dotaccent', 'dieresis', 'ring', 'cedilla', 'hungarumlaut', 'ogonek',
  'caron', 'emdash', 'AE', 'ordfeminine', 'Lslash', 'Oslash', 'OE', 'ordmasculine', 'ae',
  'dotlessi', 'lslash', 'oslash', 'oe', 'germandbls', 'onesuperior', 'logicalnot', 'mu',
  'trademark', 'Eth', 'onehalf', 'plusminus', 'Thorn', 'onequarter', 'divide', 'brokenbar',
  'degree', 'thorn', 'threequarters', 'twosuperior', 'registered', 'minus', 'eth', 'multiply',
  'threesuperior', 'copyright', 'Aacute', 'Acircumflex', 'Adieresis', 'Agrave', 'Aring', 'Atilde',
  'Ccedilla', 'Eacute', 'Ecircumflex', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis',
  'Igrave', 'Ntilde', 'Oacute', 'Ocircumflex', 'Odieresis', 'Ograve', 'Otilde', 'Scaron', 'Uacute',
  'Ucircumflex', 'Udieresis', 'Ugrave', 'Yacute', 'Ydieresis', 'Zcaron', 'aacute', 'acircumflex',
  'adieresis', 'agrave', 'aring', 'atilde', 'ccedilla', 'eacute', 'ecircumflex', 'edieresis',
  'egrave', 'iacute', 'icircumflex', 'idieresis', 'igrave', 'ntilde', 'oacute', 'ocircumflex',
  'odieresis', 'ograve', 'otilde', 'scaron', 'uacute', 'ucircumflex', 'udieresis', 'ugrave',
  'yacute', 'ydieresis', 'zcaron', 'exclamsmall', 'Hungarumlautsmall', 'dollaroldstyle',
  'dollarsuperior', 'ampersandsmall', 'Acutesmall', 'parenleftsuperior', 'parenrightsuperior',
  'twodotenleader', 'onedotenleader', 'zerooldstyle', 'oneoldstyle', 'twooldstyle',
  'threeoldstyle', 'fouroldstyle', 'fiveoldstyle', 'sixoldstyle', 'sevenoldstyle', 'eightoldstyle',
  'nineoldstyle', 'commasuperior', 'threequartersemdash', 'periodsuperior', 'questionsmall',
  'asuperior', 'bsuperior', 'centsuperior', 'dsuperior', 'esuperior', 'isuperior', 'lsuperior',
  'msuperior', 'nsuperior', 'osuperior', 'rsuperior', 'ssuperior', 'tsuperior', 'ff', 'ffi', 'ffl',
  'parenleftinferior', 'parenrightinferior', 'Circumflexsmall', 'hyphensuperior', 'Gravesmall',
  'Asmall', 'Bsmall', 'Csmall', 'Dsmall', 'Esmall', 'Fsmall', 'Gsmall', 'Hsmall', 'Ismall',
  'Jsmall', 'Ksmall', 'Lsmall', 'Msmall', 'Nsmall', 'Osmall', 'Psmall', 'Qsmall', 'Rsmall',
  'Ssmall', 'Tsmall', 'Usmall', 'Vsmall', 'Wsmall', 'Xsmall', 'Ysmall', 'Zsmall', 'colonmonetary',
  'onefitted', 'rupiah', 'Tildesmall', 'exclamdownsmall', 'centoldstyle', 'Lslashsmall',
  'Scaronsmall', 'Zcaronsmall', 'Dieresissmall', 'Brevesmall', 'Caronsmall', 'Dotaccentsmall',
  'Macronsmall', 'figuredash', 'hypheninferior', 'Ogoneksmall', 'Ringsmall', 'Cedillasmall',
  'questiondownsmall', 'oneeighth', 'threeeighths', 'fiveeighths', 'seveneighths', 'onethird',
  'twothirds', 'zerosuperior', 'foursuperior', 'fivesuperior', 'sixsuperior', 'sevensuperior',
  'eightsuperior', 'ninesuperior', 'zeroinferior', 'oneinferior', 'twoinferior', 'threeinferior',
  'fourinferior', 'fiveinferior', 'sixinferior', 'seveninferior', 'eightinferior', 'nineinferior',
  'centinferior', 'dollarinferior', 'periodinferior', 'commainferior', 'Agravesmall',
  'Aacutesmall', 'Acircumflexsmall', 'Atildesmall', 'Adieresissmall', 'Aringsmall', 'AEsmall',
  'Ccedillasmall', 'Egravesmall', 'Eacutesmall', 'Ecircumflexsmall', 'Edieresissmall',
  'Igravesmall', 'Iacutesmall', 'Icircumflexsmall', 'Idieresissmall', 'Ethsmall', 'Ntildesmall',
  'Ogravesmall', 'Oacutesmall', 'Ocircumflexsmall', 'Otildesmall', 'Odieresissmall',
  'OEsmall', 'Oslashsmall', 'Ugravesmall', 'Uacutesmall', 'Ucircumflexsmall', 'Udieresissmall',
  'Yacutesmall', 'Thornsmall', 'Ydieresissmall', '001.000', '001.001', '001.002', '001.003',
  'Black', 'Bold', 'Book', 'Light', 'Medium', 'Regular', 'Roman', 'Semibold',
];

/** Top DICT operators, by the key {@link readDict} gives them. */
const TOP_DICT_FONT_BBOX = '5';
const TOP_DICT_CHARSET = '15';
const TOP_DICT_CHAR_STRINGS = '17';
const TOP_DICT_PRIVATE = '18';
const TOP_DICT_CHARSTRING_TYPE = '12 6';

/** The Private DICT operator naming the local Subrs INDEX, at an offset from the Private DICT itself. */
const PRIVATE_DICT_SUBRS = '19';

/** The three charsets a font may name by number instead of storing one. */
const PREDEFINED_CHARSETS = new Set([0, 1, 2]);

/**
 * The four INDEXes a CFF opens with, and the Top DICT they lead to.
 *
 * Shared by the two readers below because the header walk is positional — every INDEX begins where
 * the one before it ended — so a second copy of it is a second place for the same off-by-one.
 *
 * @param cff - The bare CFF font program.
 * @returns The Top DICT, the String INDEX its SIDs index into, and the global Subrs INDEX.
 * @throws {Error} When the file is not a CFF this reader can follow.
 */
function readCffTop(cff) {
  if (cff.length < 4 || cff[0] !== 1) {
    throw new Error('Not a CFF font program: the major version is not 1.');
  }
  const names = readIndex(cff, cff[2]);
  const topDicts = readIndex(cff, names.end);
  const strings = readIndex(cff, topDicts.end);
  const globalSubrs = readIndex(cff, strings.end);
  if (topDicts.items.length !== 1) {
    throw new Error(`Expected one Top DICT, found ${topDicts.items.length}.`);
  }
  return { top: readDict(topDicts.items[0]), strings, globalSubrs };
}

/**
 * The glyph names of a bare CFF, in glyph order.
 *
 * Read out of the file rather than assumed: the whole point of the wrapper is that `hmtx` entry *n*
 * is the advance of glyph *n*, and the only thing that says which glyph that is, is the charset.
 *
 * @param cff - The bare CFF font program.
 * @returns One name per glyph, index by glyph id, `.notdef` first.
 * @throws {Error} When the file is not a CFF this reader can follow, or names a predefined charset —
 *   which no base-14 symbolic face does, and which would silently mean the Latin glyph order.
 */
export function glyphNamesOf(cff) {
  const { top, strings } = readCffTop(cff);

  const charStringsOffset = top.get(TOP_DICT_CHAR_STRINGS)?.[0];
  if (charStringsOffset === undefined) throw new Error('The Top DICT names no CharStrings INDEX.');
  const glyphCount = readIndex(cff, charStringsOffset).items.length;

  const charsetOffset = top.get(TOP_DICT_CHARSET)?.[0] ?? 0;
  if (PREDEFINED_CHARSETS.has(charsetOffset)) {
    throw new Error(
      `The font uses predefined charset ${charsetOffset}, whose glyph order is Latin — a symbolic ` +
        'face cannot be wrapped from it.',
    );
  }

  // SIDs for glyphs 1..n-1; glyph 0 is `.notdef` and is never listed.
  const sids = [0];
  const format = cff[charsetOffset];
  let cursor = charsetOffset + 1;
  if (format === 0) {
    while (sids.length < glyphCount) {
      sids.push(cff.readUInt16BE(cursor));
      cursor += 2;
    }
  } else if (format === 1 || format === 2) {
    // Ranges of consecutive SIDs: a first SID and how many FOLLOW it, one byte wide in format 1 and
    // two in format 2.
    while (sids.length < glyphCount) {
      const first = cff.readUInt16BE(cursor);
      const left = format === 1 ? cff[cursor + 2] : cff.readUInt16BE(cursor + 2);
      cursor += format === 1 ? 3 : 4;
      for (let step = 0; step <= left && sids.length < glyphCount; step += 1) sids.push(first + step);
    }
  } else {
    throw new Error(`Unsupported CFF charset format ${format}.`);
  }

  return sids.map((sid) => {
    if (sid < CFF_STANDARD_STRINGS.length) return CFF_STANDARD_STRINGS[sid];
    const custom = strings.items[sid - CFF_STANDARD_STRINGS.length];
    if (custom === undefined) throw new Error(`The charset names string ${sid}, which is not there.`);
    return custom.toString('latin1');
  });
}

/**
 * The bias a Type 2 charstring's subroutine numbers are stated relative to, from the count of them.
 *
 * The CFF specification's own table (`Type 2 Charstring Format`, §4.7). Not a tuning constant.
 *
 * @param count - How many subroutines the INDEX holds.
 * @returns The number added to a `callsubr` or `callgsubr` operand to get the index.
 */
function subroutineBias(count) {
  if (count < 1240) return 107;
  return count < 33_900 ? 1131 : 32_768;
}

/** How deep a charstring may call subroutines, which the CFF specification itself caps at 10. */
const MAX_SUBROUTINE_DEPTH = 10;

/**
 * The x extremes of one cubic Bézier, the control points included only where the curve reaches them.
 *
 * A Bézier does not pass through its control points, so a bound taken from the convex hull is wider
 * than the outline and would put every left side bearing a unit or two too far left. The true extreme
 * is at an end point or where the derivative vanishes: `B'(t)/3` is `(a - 2b + c)t² + 2(b - a)t + a`
 * for `a = x1 - x0`, `b = x2 - x1`, `c = x3 - x2`, so the interior candidates are that quadratic's
 * roots inside `(0, 1)`.
 *
 * @param x0 - The start point's x.
 * @param x1 - The first control point's x.
 * @param x2 - The second control point's x.
 * @param x3 - The end point's x.
 * @returns Every x the curve is known to reach: its ends, and any interior extreme.
 */
function curveXExtremes(x0, x1, x2, x3) {
  const reached = [x0, x3];
  const a = x1 - x0;
  const b = x2 - x1;
  const c = x3 - x2;
  const quadratic = a - 2 * b + c;
  const linear = 2 * (b - a);
  const roots = [];
  if (quadratic === 0) {
    if (linear !== 0) roots.push(-a / linear);
  } else {
    const discriminant = linear * linear - 4 * quadratic * a;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-linear + root) / (2 * quadratic), (-linear - root) / (2 * quadratic));
    }
  }
  for (const t of roots) {
    if (!(t > 0 && t < 1)) continue;
    const s = 1 - t;
    reached.push(s * s * s * x0 + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * x3);
  }
  return reached;
}

/**
 * Walk one Type 2 charstring, reporting every x its outline reaches.
 *
 * Only the path is followed; the hints are counted and discarded, because the one thing wanted from
 * here is the horizontal extent. Every operator the two vendored faces use is implemented and
 * everything else throws — `flex`, `seac` and the arithmetic operators included. That is deliberate:
 * a generator that skipped an operator it did not know would carry on with a current point that had
 * silently stopped tracking the outline, and would write a plausible wrong number. Neither
 * `FoxitSymbol.cff` nor `FoxitDingbats.cff` uses any of them (measured: every one of their 191 and
 * 203 charstrings runs to `endchar` through the set below), so a face that did is a new stand-in and
 * wants looking at rather than absorbing.
 *
 * @param code - The charstring's bytes.
 * @param subrs - The local Subrs INDEX's items.
 * @param globalSubrs - The global Subrs INDEX's items.
 * @param onX - Called with every x the outline reaches.
 * @throws {Error} On an operator this does not implement, or a subroutine nest deeper than the
 *   specification allows.
 */
function walkCharstring(code, subrs, globalSubrs, onX) {
  const localBias = subroutineBias(subrs.length);
  const globalBias = subroutineBias(globalSubrs.length);
  const stack = [];
  let x = 0;
  let y = 0;
  let stems = 0;
  // The leading operand of the first stem, move or `endchar` operator is the glyph's width when there
  // is one more operand than that operator takes. Tracked because dropping it is what keeps the
  // remaining operands aligned; the width itself is not read here — `hmtx` carries the AFM's.
  let widthTaken = false;
  let depth = 0;

  const takeWidth = (expected) => {
    if (!widthTaken && stack.length > expected) stack.shift();
    widthTaken = true;
  };
  const takeStems = () => {
    if (!widthTaken && stack.length % 2 === 1) stack.shift();
    widthTaken = true;
    stems += stack.length >> 1;
    stack.length = 0;
  };
  const lineTo = (toX, toY) => {
    x = toX;
    y = toY;
    onX(x);
  };
  // Only the x of a curve's control points is taken, because only the horizontal extent is wanted;
  // the end point's y is carried so the current point keeps up with the outline.
  const curveTo = (x1, x2, x3, y3) => {
    for (const reached of curveXExtremes(x, x1, x2, x3)) onX(reached);
    x = x3;
    y = y3;
  };

  const run = (charstring) => {
    if (depth > MAX_SUBROUTINE_DEPTH) {
      throw new Error('A charstring nests subroutines deeper than the CFF specification allows.');
    }
    depth += 1;
    let at = 0;
    while (at < charstring.length) {
      const b0 = charstring[at];
      if (b0 === 28) {
        stack.push(charstring.readInt16BE(at + 1));
        at += 3;
        continue;
      }
      if (b0 >= 32) {
        if (b0 <= 246) {
          stack.push(b0 - 139);
          at += 1;
        } else if (b0 <= 250) {
          stack.push((b0 - 247) * 256 + charstring[at + 1] + 108);
          at += 2;
        } else if (b0 <= 254) {
          stack.push(-(b0 - 251) * 256 - charstring[at + 1] - 108);
          at += 2;
        } else {
          // 16.16 fixed point, the one operand form that is not an integer.
          stack.push(charstring.readInt32BE(at + 1) / 65_536);
          at += 5;
        }
        continue;
      }
      at += 1;
      switch (b0) {
        // hstem, vstem, hstemhm, vstemhm: counted only, for the hint mask's own size.
        case 1:
        case 3:
        case 18:
        case 23: {
          takeStems();
          break;
        }
        // hintmask and cntrmask, each followed by one bit per stem hinted so far. Operands still on
        // the stack are an implied vstem, which is why the count is taken before the mask is skipped.
        case 19:
        case 20: {
          takeStems();
          at += (stems + 7) >> 3;
          break;
        }
        case 21: {
          takeWidth(2);
          lineTo(x + stack[0], y + stack[1]);
          stack.length = 0;
          break;
        }
        case 22: {
          takeWidth(1);
          lineTo(x + stack[0], y);
          stack.length = 0;
          break;
        }
        case 4: {
          takeWidth(1);
          lineTo(x, y + stack[0]);
          stack.length = 0;
          break;
        }
        case 5: {
          for (let index = 0; index + 1 < stack.length; index += 2) {
            lineTo(x + stack[index], y + stack[index + 1]);
          }
          stack.length = 0;
          break;
        }
        // hlineto and vlineto: one coordinate each, alternating axis, starting on the operator's own.
        case 6:
        case 7: {
          let horizontal = b0 === 6;
          for (const delta of stack) {
            lineTo(horizontal ? x + delta : x, horizontal ? y : y + delta);
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 8: {
          for (let index = 0; index + 5 < stack.length; index += 6) {
            relativeCurve(stack, index, curveTo, x, y);
          }
          stack.length = 0;
          break;
        }
        // rcurveline: curves, then one closing line.
        case 24: {
          let index = 0;
          for (; index + 5 < stack.length - 2; index += 6) relativeCurve(stack, index, curveTo, x, y);
          lineTo(x + stack[index], y + stack[index + 1]);
          stack.length = 0;
          break;
        }
        // rlinecurve: lines, then one closing curve.
        case 25: {
          let index = 0;
          for (; index + 1 < stack.length - 6; index += 2) {
            lineTo(x + stack[index], y + stack[index + 1]);
          }
          relativeCurve(stack, index, curveTo, x, y);
          stack.length = 0;
          break;
        }
        // vvcurveto: vertical start and end tangents, with an optional dx on the first curve only.
        case 26: {
          let index = 0;
          let dx1 = 0;
          if (stack.length % 4 === 1) {
            dx1 = stack[0];
            index = 1;
          }
          for (; index + 3 < stack.length; index += 4) {
            const x1 = x + dx1;
            const y2 = y + stack[index] + stack[index + 2];
            curveTo(x1, x1 + stack[index + 1], x1 + stack[index + 1], y2 + stack[index + 3]);
            dx1 = 0;
          }
          stack.length = 0;
          break;
        }
        // hhcurveto: horizontal start and end tangents, with an optional dy on the first curve only.
        case 27: {
          let index = 0;
          let dy1 = 0;
          if (stack.length % 4 === 1) {
            dy1 = stack[0];
            index = 1;
          }
          for (; index + 3 < stack.length; index += 4) {
            const x1 = x + stack[index];
            const x2 = x1 + stack[index + 1];
            const y2 = y + dy1 + stack[index + 2];
            curveTo(x1, x2, x2 + stack[index + 3], y2);
            dy1 = 0;
          }
          stack.length = 0;
          break;
        }
        // vhcurveto and hvcurveto: quarter-turn curves alternating axis, the last one taking a fifth
        // operand for the coordinate the alternation would otherwise leave unchanged.
        case 30:
        case 31: {
          let horizontal = b0 === 31;
          let index = 0;
          while (stack.length - index >= 4) {
            // The fifth operand exists only on the final curve of the run, and gives it the
            // coordinate the alternation would otherwise hold fixed.
            const last = stack.length - index === 5;
            const x1 = horizontal ? x + stack[index] : x;
            const y1 = horizontal ? y : y + stack[index];
            const x2 = x1 + stack[index + 1];
            const y2 = y1 + stack[index + 2];
            let x3 = x2;
            let y3 = y2;
            if (horizontal) {
              y3 = y2 + stack[index + 3];
              if (last) x3 = x2 + stack[index + 4];
            } else {
              x3 = x2 + stack[index + 3];
              if (last) y3 = y2 + stack[index + 4];
            }
            curveTo(x1, x2, x3, y3);
            index += last ? 5 : 4;
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 10: {
          const subr = subrs[stack.pop() + localBias];
          if (subr === undefined) throw new Error('A charstring calls a local subroutine that is not there.');
          run(subr);
          break;
        }
        case 29: {
          const subr = globalSubrs[stack.pop() + globalBias];
          if (subr === undefined) throw new Error('A charstring calls a global subroutine that is not there.');
          run(subr);
          break;
        }
        case 11: {
          depth -= 1;
          return;
        }
        case 14: {
          // `endchar` takes no operands, or four for the deprecated accented-character composition.
          takeWidth(0);
          if (stack.length > 0) {
            throw new Error('A charstring ends with `seac` accent composition, which this cannot follow.');
          }
          depth -= 1;
          return;
        }
        default: {
          throw new Error(
            `A charstring uses Type 2 operator ${b0 === 12 ? `12 ${charstring[at]}` : b0}, ` +
              'which this reader does not implement.',
          );
        }
      }
    }
    depth -= 1;
  };

  run(code);
}

/**
 * One `rrcurveto`-shaped curve out of six operands at an offset, each relative to the one before it.
 *
 * @param stack - The operand stack.
 * @param index - Where the six operands begin.
 * @param curveTo - The walker's curve handler, which owns the current point.
 * @param x - The current point's x.
 * @param y - The current point's y.
 */
function relativeCurve(stack, index, curveTo, x, y) {
  const x1 = x + stack[index];
  const x2 = x1 + stack[index + 2];
  const y2 = y + stack[index + 1] + stack[index + 3];
  curveTo(x1, x2, x2 + stack[index + 4], y2 + stack[index + 5]);
}

/**
 * Every glyph's left side bearing, which for a glyph with PostScript outlines is its own `xMin`.
 *
 * The OpenType specification defines `hmtx`'s `lsb` as the glyph's `xMin`, and a CFF glyph carries no
 * bounding box of its own — the outline is a program, and the box is whatever running it draws. So
 * this runs them. Every `hmtx` entry here used to be written with an `lsb` of zero, which is a
 * different claim: that every glyph in Symbol and ZapfDingbats begins exactly on its origin, which
 * none of them does.
 *
 * Nothing in the pipeline reads it — an OpenType/CFF consumer takes the bearing from the charstring
 * as it draws — so this fixes no rendering. What it fixes is that the file now says something true.
 *
 * The reader is checked against the font's own declaration before a single value is used: the union
 * of the per-glyph bounds must reproduce the Top DICT's `FontBBox` horizontally. It does, exactly,
 * for both vendored faces. (Vertically it agrees for ZapfDingbats and is one unit inside Symbol's
 * declared `yMin` of -294, the deepest point any Symbol charstring reaches being -293 — the same -293
 * the AFM states. A font may declare a box wider than it draws; it may not declare one narrower, so
 * the check is that the outlines stay INSIDE the declaration, and that the axis these values are
 * taken from matches it exactly.)
 *
 * @param cff - The bare CFF font program.
 * @param glyphCount - How many glyphs the caller expects, from the advances it was given.
 * @returns One left side bearing per glyph, in design units, floored to the integer `hmtx` holds.
 * @throws {Error} When the charstrings cannot be followed, or do not agree with the declared box.
 */
function glyphLeftSideBearings(cff, glyphCount) {
  const { top, globalSubrs } = readCffTop(cff);
  const charstringType = top.get(TOP_DICT_CHARSTRING_TYPE)?.[0] ?? 2;
  if (charstringType !== 2) {
    throw new Error(`The font declares CharstringType ${charstringType}; only Type 2 is implemented.`);
  }
  const charStringsOffset = top.get(TOP_DICT_CHAR_STRINGS)?.[0];
  if (charStringsOffset === undefined) throw new Error('The Top DICT names no CharStrings INDEX.');
  const charStrings = readIndex(cff, charStringsOffset).items;
  if (charStrings.length !== glyphCount) {
    throw new Error(`The font holds ${charStrings.length} charstrings and ${glyphCount} advances.`);
  }

  // The local Subrs INDEX is named from inside the Private DICT and its offset is relative to that
  // DICT's own start, not to the file's — the one offset in a CFF that is not from the beginning.
  const privateEntry = top.get(TOP_DICT_PRIVATE);
  let subrs = [];
  if (privateEntry !== undefined && privateEntry.length === 2) {
    const [size, at] = privateEntry;
    const subrsOffset = readDict(cff.subarray(at, at + size)).get(PRIVATE_DICT_SUBRS)?.[0];
    if (subrsOffset !== undefined) subrs = readIndex(cff, at + subrsOffset).items;
  }

  const declared = top.get(TOP_DICT_FONT_BBOX);
  if (declared === undefined || declared.length !== 4) {
    throw new Error('The Top DICT declares no FontBBox to check the charstring reader against.');
  }

  let leftmost = Number.POSITIVE_INFINITY;
  let rightmost = Number.NEGATIVE_INFINITY;
  const bearings = charStrings.map((charstring) => {
    let glyphMin = Number.POSITIVE_INFINITY;
    walkCharstring(charstring, subrs, globalSubrs.items, (reached) => {
      if (reached < glyphMin) glyphMin = reached;
      if (reached < leftmost) leftmost = reached;
      if (reached > rightmost) rightmost = reached;
    });
    // A glyph that draws nothing — `space` is one — has no outline and so no bearing to state.
    return glyphMin === Number.POSITIVE_INFINITY ? 0 : Math.floor(glyphMin);
  });

  if (Math.floor(leftmost) !== declared[0] || Math.ceil(rightmost) !== declared[2]) {
    throw new Error(
      `The charstrings span x ${Math.floor(leftmost)}..${Math.ceil(rightmost)} while the Top DICT ` +
        `declares ${declared[0]}..${declared[2]}. The charstring reader and the font disagree; ` +
        'nothing here is trustworthy until they do not.',
    );
  }
  return bearings;
}

/** Write a `name` table string record set as Windows platform, Unicode BMP, US English. */
function buildName(records) {
  const strings = [];
  let stringOffset = 0;
  const header = Buffer.alloc(6 + records.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  records.forEach(([nameId, value], index) => {
    const encoded = Buffer.from(value, 'utf16le').swap16();
    const at = 6 + index * 12;
    header.writeUInt16BE(3, at);
    header.writeUInt16BE(1, at + 2);
    header.writeUInt16BE(0x04_09, at + 4);
    header.writeUInt16BE(nameId, at + 6);
    header.writeUInt16BE(encoded.length, at + 8);
    header.writeUInt16BE(stringOffset, at + 10);
    stringOffset += encoded.length;
    strings.push(encoded);
  });
  return Buffer.concat([header, ...strings]);
}

/**
 * A format 4 `cmap` subtable wrapped in a table, mapping the given code points.
 *
 * Format 4 rather than format 12 because every code point mapped here is below U+FFFF: the codes come
 * from a single byte of a PDF content stream, decoded through Windows-1252.
 *
 * @param mapping - Code point → glyph id, for code points below U+FFFF.
 * @returns The whole `cmap` table, with one Windows/Unicode-BMP encoding record.
 */
function buildCmap(mapping) {
  const codes = [...mapping.keys()].toSorted((a, b) => a - b);
  // Contiguous runs whose glyph ids also run consecutively become one segment with an idDelta; any
  // other run needs its own. Building one segment per run of consecutive CODES and using the glyph
  // id array for all of them is simpler and costs two bytes a glyph, on a table of at most 224.
  const segments = [];
  for (const code of codes) {
    const last = segments.at(-1);
    if (last !== undefined && code === last.end + 1) {
      last.end = code;
      last.glyphs.push(mapping.get(code));
    } else {
      segments.push({ start: code, end: code, glyphs: [mapping.get(code)] });
    }
  }
  // The specification requires a final segment ending at 0xFFFF that maps nothing.
  segments.push({ start: 0xFF_FF, end: 0xFF_FF, glyphs: [0] });

  const segCount = segments.length;
  const glyphIdArrayLength = segments.reduce((total, segment) => total + segment.glyphs.length, 0);
  const subtableLength = 16 + segCount * 8 + glyphIdArrayLength * 2;
  const subtable = Buffer.alloc(subtableLength);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtableLength, 2);
  subtable.writeUInt16BE(0, 4);
  subtable.writeUInt16BE(segCount * 2, 6);
  const entrySelector = Math.floor(Math.log2(segCount));
  subtable.writeUInt16BE(2 ** entrySelector * 2, 8);
  subtable.writeUInt16BE(entrySelector, 10);
  subtable.writeUInt16BE(segCount * 2 - 2 ** entrySelector * 2, 12);

  const endsAt = 14;
  const startsAt = endsAt + segCount * 2 + 2;
  const deltasAt = startsAt + segCount * 2;
  const rangesAt = deltasAt + segCount * 2;
  let glyphCursor = rangesAt + segCount * 2;

  segments.forEach((segment, index) => {
    subtable.writeUInt16BE(segment.end, endsAt + index * 2);
    subtable.writeUInt16BE(segment.start, startsAt + index * 2);
    subtable.writeUInt16BE(0, deltasAt + index * 2);
    if (segment.start === 0xFF_FF) {
      // The terminating segment maps to glyph 0 through an idDelta of 1, which is the conventional
      // spelling and keeps it out of the glyph id array.
      subtable.writeUInt16BE(1, deltasAt + index * 2);
      subtable.writeUInt16BE(0, rangesAt + index * 2);
      return;
    }
    subtable.writeUInt16BE(glyphCursor - (rangesAt + index * 2), rangesAt + index * 2);
    for (const glyph of segment.glyphs) {
      subtable.writeUInt16BE(glyph, glyphCursor);
      glyphCursor += 2;
    }
  });

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, subtable]);
}

/**
 * The `OS/2` sub- and superscript geometry, as fractions of the em. Every one of these is INVENTED.
 *
 * There is no source for them. An AFM states widths, a bounding box, an underline and — for a face
 * with Latin letters, which neither of these two is — an ascender, a descender, a cap height and an
 * x-height. It states nothing at all about how large a subscript should be drawn or how far a
 * superscript should be raised, and the CFF the outlines come from carries no such field either. So
 * these are conventional values for a 1000-unit em, and they are the values this file has always
 * written; they are named here so that a reader can see at a glance which of the `OS/2` numbers are
 * measurements and which are furniture.
 *
 * **Why inventing them is safe here.** Nothing in this preview reads them. A superscript or subscript
 * in the Print preview is sized and shifted by the stylesheet from `--face-ascender` and
 * `--face-descender`, which come from the manifest's own prawn-derived metrics; the renderer places
 * its own from prawn (`converter.rb`'s `sub`/`sup` handling), which has never seen an sfnt for these
 * fourteen. A PDF viewer drawing the real Symbol reads nothing here either — this file is not in the
 * PDF.
 *
 * **What would stop it being safe.** A stylesheet that asked the browser to synthesise the shift, via
 * `font-variant-position: sub | super` or `font-synthesis-position`, because that is the one CSS
 * feature that reads exactly these six fields; a preview that started drawing sub- and superscripts
 * as OpenType feature substitutions rather than as sized-and-shifted spans; or these files being
 * published for anything other than measuring the preview's own pages. Any of those turns a
 * convention into a claim, and then they want measuring against something.
 *
 * The two HORIZONTAL offsets are not in this list, because there is nothing to invent: a subscript is
 * not displaced sideways from the character it follows, and essentially every real font states zero
 * for both. This file used to write 0.14 and 0.05 em, which is a shift of an eighth of a character
 * width — nothing sourced that, and it was not conventional either.
 */
const SUBSCRIPT_X_SIZE = 0.65;
const SUBSCRIPT_Y_SIZE = 0.7;
const SUBSCRIPT_Y_OFFSET = 0.14;
const SUPERSCRIPT_X_SIZE = 0.53;
const SUPERSCRIPT_Y_SIZE = 0.53;
const SUPERSCRIPT_Y_OFFSET = 0.26;

/**
 * How far above the baseline a strike-through is drawn, as a fraction of the em. Also INVENTED.
 *
 * Kept apart from the six above because this one IS read: a browser draws `text-decoration:
 * line-through` at `yStrikeoutPosition` with `yStrikeoutSize` for its thickness, so a run of Symbol
 * marked up with a line-through in the Print preview is struck exactly here. There is no source for
 * it — the AFM states an underline and no strikeout — and roughly a quarter of the em is where every
 * face this was compared against puts it. Its thickness is not invented: see the `yStrikeoutSize`
 * line, which takes the AFM's own `UnderlineThickness`, the specification's own rule for a face that
 * states no strikeout of its own.
 */
const STRIKEOUT_POSITION = 0.26;

/**
 * Build an OpenType/CFF sfnt around a bare CFF font program.
 *
 * @param options - Everything the synthesised tables need.
 * @param options.cff - The bare CFF font program, embedded verbatim as the `CFF ` table.
 * @param options.postScriptName - The name the `name` table reports.
 * @param options.unitsPerEm - Design units per em. Passed in rather than read from the CFF's
 *   `FontMatrix`, because the AFM the widths come from states its own em and the two must be the same
 *   number or every advance is scaled wrong; taking it from the metrics source makes that a fact
 *   rather than a coincidence.
 * @param options.advances - Advance width per glyph id, in design units.
 * @param options.cmap - Code point → glyph id.
 * @param options.bbox - The AFM's `FontBBox` as `[xMin, yMin, xMax, yMax]`.
 * @param options.ascender - `hhea.ascender`. The AFM's `FontBBox` top, NOT its `Ascender` attribute:
 *   Symbol and ZapfDingbats declare no `Ascender` or `Descender` at all, so prawn reads 0 for both
 *   and puts the whole line into the line gap (`afm.rb:75-77`). A face whose `hhea` said 0 would have
 *   its baseline at the top of every line box in the browser. Taking the bbox instead places the
 *   baseline where the glyphs are and — because prawn's line gap is `bbox[3] - bbox[1] - (ascender -
 *   descender)` — leaves `ascender - descender + lineGap` at exactly the height prawn computes. The
 *   renderer's own numbers still reach the preview: they are recorded in the manifest, and the
 *   preview sets its line box from those.
 * @param options.descender - `hhea.descender`, the AFM's `FontBBox` bottom, negative.
 * @param options.underlinePosition - The AFM's `UnderlinePosition`, negative, for `post` and for the
 *   strikeout thickness the specification derives from the same measurement.
 * @param options.underlineThickness - The AFM's `UnderlineThickness`.
 * @returns The sfnt file.
 */
export function buildSfnt({
  cff,
  postScriptName,
  unitsPerEm,
  advances,
  cmap,
  bbox,
  ascender,
  descender,
  underlinePosition,
  underlineThickness,
}) {
  const glyphCount = advances.length;
  const [xMin, yMin, xMax, yMax] = bbox;

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00_01_00_00, 0);
  head.writeUInt32BE(0x00_01_00_00, 4);
  head.writeUInt32BE(0, 8); // checkSumAdjustment, filled in once the whole file exists.
  head.writeUInt32BE(HEAD_MAGIC, 12);
  head.writeUInt16BE(3, 16);
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeBigUInt64BE(EPOCH, 20);
  head.writeBigUInt64BE(EPOCH, 28);
  head.writeInt16BE(xMin, 36);
  head.writeInt16BE(yMin, 38);
  head.writeInt16BE(xMax, 40);
  head.writeInt16BE(yMax, 42);
  head.writeUInt16BE(0, 44); // macStyle: neither bold nor italic, which both symbolic faces are.
  head.writeUInt16BE(8, 46);
  head.writeInt16BE(2, 48);
  head.writeInt16BE(0, 50);
  head.writeInt16BE(0, 52);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00_01_00_00, 0);
  hhea.writeInt16BE(ascender, 4);
  hhea.writeInt16BE(descender, 6);
  hhea.writeInt16BE(0, 8);
  hhea.writeUInt16BE(Math.max(...advances), 10);
  hhea.writeInt16BE(0, 12);
  hhea.writeInt16BE(0, 14);
  hhea.writeInt16BE(xMax, 16);
  hhea.writeInt16BE(1, 18);
  hhea.writeInt16BE(0, 20);
  hhea.writeInt16BE(0, 22);
  // Offsets 24 to 31 are four reserved int16s and stay zero; 32 is metricDataFormat, also zero.
  hhea.writeUInt16BE(glyphCount, 34);

  // The advance is the AFM's, so that the file measures as the export does; the bearing beside it is
  // the glyph's own `xMin`, run out of the charstring — see {@link glyphLeftSideBearings}.
  const bearings = glyphLeftSideBearings(cff, glyphCount);
  const hmtx = Buffer.alloc(glyphCount * 4);
  advances.forEach((advance, glyph) => {
    hmtx.writeUInt16BE(advance, glyph * 4);
    hmtx.writeInt16BE(bearings[glyph], glyph * 4 + 2);
  });

  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00_00_50_00, 0);
  maxp.writeUInt16BE(glyphCount, 4);

  const codes = [...cmap.keys()].toSorted((a, b) => a - b);
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0);
  // xAvgCharWidth, to version 3's definition and not version 1's: the arithmetic mean of the advances
  // of the glyphs that HAVE one. Averaging over every glyph instead pulls the number down by whatever
  // share of the face draws nothing, and both of these carry such glyphs.
  const drawn = advances.filter((advance) => advance > 0);
  os2.writeInt16BE(Math.round(drawn.reduce((a, b) => a + b, 0) / drawn.length), 2);
  // usWeightClass 400 and usWidthClass 5: normal and medium, which is what both AFMs say of themselves
  // (`Weight Medium`, and no condensed or extended spelling anywhere in the fourteen).
  os2.writeUInt16BE(400, 4);
  os2.writeUInt16BE(5, 6);
  os2.writeUInt16BE(0, 8); // fsType 0: installable embedding, which both licences permit.
  // Offsets 10 to 24: the sub- and superscript box. Invented, and knowingly — see the constants.
  os2.writeInt16BE(Math.round(unitsPerEm * SUBSCRIPT_X_SIZE), 10);
  os2.writeInt16BE(Math.round(unitsPerEm * SUBSCRIPT_Y_SIZE), 12);
  os2.writeInt16BE(0, 14); // ySubscriptXOffset: a subscript is not displaced sideways.
  os2.writeInt16BE(Math.round(unitsPerEm * SUBSCRIPT_Y_OFFSET), 16);
  os2.writeInt16BE(Math.round(unitsPerEm * SUPERSCRIPT_X_SIZE), 18);
  os2.writeInt16BE(Math.round(unitsPerEm * SUPERSCRIPT_Y_SIZE), 20);
  os2.writeInt16BE(0, 22); // ySuperscriptXOffset: nor is a superscript.
  os2.writeInt16BE(Math.round(unitsPerEm * SUPERSCRIPT_Y_OFFSET), 24);
  // yStrikeoutSize is the AFM's own `UnderlineThickness`: the OpenType specification's rule for this
  // field is that it should match the thickness of the underscore, and the underscore's thickness is
  // one of the four things an AFM does state about a symbolic face. Its POSITION is not stated
  // anywhere and is invented — see {@link STRIKEOUT_POSITION}.
  os2.writeInt16BE(underlineThickness, 26);
  os2.writeInt16BE(Math.round(unitsPerEm * STRIKEOUT_POSITION), 28);
  // sFamilyClass 0, an all-zero PANOSE (offsets 32 to 41), all-zero Unicode ranges (42 to 57) and an
  // all-zero vendor id (58 to 61): "no classification", which is the honest answer for a face whose
  // glyph set is not letters and whose code points are a private byte encoding, not Unicode.
  os2.writeInt16BE(0, 30);
  os2.writeUInt16BE(0x00_40, 62); // fsSelection: REGULAR.
  os2.writeUInt16BE(codes[0], 64);
  os2.writeUInt16BE(codes.at(-1), 66);
  // The typographic trio is the same bbox-derived answer `hhea` carries, and for the same reason: a
  // reader that prefers OS/2 must not get a different line box from one that prefers `hhea`.
  os2.writeInt16BE(ascender, 68);
  os2.writeInt16BE(descender, 70);
  os2.writeInt16BE(0, 72);
  os2.writeUInt16BE(ascender, 74);
  os2.writeUInt16BE(-descender, 76);
  os2.writeUInt32BE(0, 78);
  os2.writeUInt32BE(0, 82);
  // sxHeight and sCapHeight, both zero and both meant. An x-height is the height of a lower-case `x`
  // and a cap height the height of a capital, and a face whose glyph set is Greek letters and
  // arithmetic signs, or is 202 ornaments, has neither — which is precisely why these two AFMs are the
  // only ones of the fourteen that declare no `XHeight` and no `CapHeight`. The same silence prawn
  // reads as a zero ascender is read as a zero here. They used to say 0.5 and 0.7 em, which is not a
  // number Symbol or ZapfDingbats has: both are readable, by CSS's `cap` unit and by a browser's
  // font-fallback size matching, and both would have been reading a made-up number about a face that
  // cannot have one. Zero is the sfnt's own spelling for "not applicable", and a consumer that meets
  // it falls back to measuring a glyph or to its own heuristic — which is the honest degradation.
  os2.writeInt16BE(0, 86);
  os2.writeInt16BE(0, 88);
  os2.writeUInt16BE(0, 90);
  os2.writeUInt16BE(0x00_20, 92);
  os2.writeUInt16BE(1, 94);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00_03_00_00, 0);
  // Offset 4 is italicAngle, zero because both AFMs say `ItalicAngle 0`. The underline pair at 8 and
  // 10 is the AFM's own `UnderlinePosition` and `UnderlineThickness`: a browser draws
  // `text-decoration: underline` from them, and they were both zero here — a zero thickness being a
  // line the browser has to invent a width for, and a zero position being a line through the
  // baseline rather than below it.
  post.writeInt16BE(underlinePosition, 8);
  post.writeInt16BE(underlineThickness, 10);

  const tables = {
    'CFF ': cff,
    'OS/2': os2,
    cmap: buildCmap(cmap),
    head,
    hhea,
    hmtx,
    maxp,
    name: buildName([
      [1, postScriptName],
      [2, 'Regular'],
      [3, postScriptName],
      [4, postScriptName],
      [6, postScriptName],
    ]),
    post,
  };

  const count = TABLE_ORDER.length;
  const entrySelector = Math.floor(Math.log2(count));
  const directory = Buffer.alloc(12 + count * 16);
  directory.write('OTTO', 0, 'latin1');
  directory.writeUInt16BE(count, 4);
  directory.writeUInt16BE(2 ** entrySelector * 16, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(count * 16 - 2 ** entrySelector * 16, 10);

  const parts = [directory];
  let offset = directory.length;
  TABLE_ORDER.forEach((tag, index) => {
    const raw = Buffer.from(tables[tag]);
    const padded = pad4(raw);
    const at = 12 + index * 16;
    directory.write(tag, at, 'latin1');
    directory.writeUInt32BE(checksum(padded), at + 4);
    directory.writeUInt32BE(offset, at + 8);
    // The LENGTH is the unpadded one; only the offsets are aligned.
    directory.writeUInt32BE(raw.length, at + 12);
    parts.push(padded);
    offset += padded.length;
  });

  const file = Buffer.concat(parts);
  // `head.checkSumAdjustment` is defined over the finished file with this field zero, which it still
  // is, so the sum can be taken now and written back.
  const headOffset = directory.readUInt32BE(12 + TABLE_ORDER.indexOf('head') * 16 + 8);
  file.writeUInt32BE(
    (CHECKSUM_ADJUSTMENT_BASE - checksum(file)) >>> 0,
    headOffset + 8,
  );
  return file;
}
