/**
 * @file Theme YAML → the flat key space the renderer actually works in.
 *
 * The renderer does not keep a theme as the nested document an author writes. It flattens it, joining
 * nested keys with `_` and folding `-` into `_`, so `heading: { h2: { font-color: … } }` and
 * `$heading_h2_font_color` name the same thing. Every later stage — variable expansion, arithmetic,
 * descriptor lookup — works in that flat space, so the conversion happens once, here.
 *
 * Order is preserved deliberately. The renderer expands `$variable` references against values it has
 * already loaded, so a key can only refer backwards; a Map keyed by name with no order would resolve
 * forward references that the PDF leaves unresolved, and the preview would be more capable than the
 * document it is previewing.
 *
 * Spelling is not preserved. The loader RENAMES a handful of deprecated categories and keys on the
 * way in and says nothing about it (`theme_loader.rb:167-176`), so the export applies them; keeping
 * the written spelling here dropped the setting instead, silently. The tables are generated from the
 * gem — see `deprecated-keys.generated.ts`.
 */

import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  YAMLMap,
  YAMLSeq,
} from 'yaml';
import type { Alias, Node, Pair, Scalar } from 'yaml';
import {
  DEPRECATED_THEME_CATEGORIES,
  DEPRECATED_THEME_KEYS,
  ROLE_ALIGN_REPLACEMENT,
  ROLE_ALIGN_SUFFIX,
} from './deprecated-keys.generated';
import { RubyNumber, spelledFloat, spelledInteger } from './units';

/** One theme setting, in the flat key space, with its value exactly as the document wrote it. */
export interface ThemeEntry {
  /** Flat, underscore-joined key — `heading_h2_font_color`. */
  readonly key: string;
  /** The raw YAML value: a string, number, boolean, or an array of those. */
  readonly value: unknown;
  /** 1-based line in the source document, where the parser could attribute one. */
  readonly line?: number;
  /**
   * Whether the cascade evaluates arithmetic in this value, where the key alone does not decide it.
   *
   * The loader's deprecated-key branch stores its value with `math: false` (`theme_loader.rb:176`),
   * unlike the general branch two lines below it. It is the one place the answer depends on how the
   * key was SPELLED rather than on what it names.
   */
  readonly math?: boolean;
}

/** One font family the theme's catalogue declares, with a path per style. */
export interface ThemeFontFamily {
  /** The family name as the theme and its `font-family` keys spell it. */
  readonly name: string;
  /** Path per style, as written — `normal`, `bold`, `italic`, `bold_italic`. */
  readonly styles: Readonly<Record<string, string>>;
}

/** A theme document that parsed. */
export interface ParsedTheme {
  /** Every setting, in document order. */
  readonly entries: readonly ThemeEntry[];
  /** The `extends` targets the document declared, in order. */
  readonly extendsTargets: readonly string[];
  /** The families the document's `font.catalog` declares. */
  readonly fontFamilies: readonly ThemeFontFamily[];
  /**
   * The families the document's `font.fallbacks` names, in order.
   *
   * Kept apart from the settings for the same reason the catalogue is: `font.fallbacks` is a list of
   * author-chosen names, not a setting. It is read at all because it is the one other place a theme
   * names a face — the renderer loads every family in it (`theme_loader.rb:157`) — so a catalogue
   * entry that exists only to be a fallback is a face the page uses.
   */
  readonly fontFallbacks: readonly string[];
  /**
   * Whether the catalogue adds to the one it inherits or replaces it. The renderer replaces unless
   * the catalogue carries a truthy `merge`, so a theme that declares one family of its own and
   * forgets `merge` loses the built-in families entirely — which is a real appearance change, not a
   * detail.
   */
  readonly fontCatalogueMerges: boolean;
  /**
   * How many entries precede the document's font declarations in document order.
   *
   * The renderer expands the catalogue's paths against the values it has loaded up to the point the
   * catalogue appears (`theme_loader.rb:144`), exactly as it does for a setting. Resolving them
   * against the finished cascade instead would let a path find a setting written BELOW it, which the
   * export leaves as a dangling reference. Equal to the number of entries when the document declares
   * no fonts at all.
   *
   * Set by `font.fallbacks` as well as by `font.catalog`, and by the flat spellings of both, because
   * the loader expands the fallback NAMES the same way (`theme_loader.rb:157`). It used to be the
   * catalogue alone, so a document with fallbacks and no catalogue left the split at its end and
   * expanded those names against the finished cascade.
   */
  readonly fontCatalogueEntryIndex: number;
  /**
   * The flat keys the document wrote as a MAPPING rather than as a value.
   *
   * A mapping is a group of settings, so the loader descends into it and the key itself is never set
   * (`theme_loader.rb:171-173`). That is right for `heading:` and it is silent for
   * `heading:\n  font-size:\n    h1: 24`, where an author indented one level too far: `heading_font_size`
   * is not a setting in the export either, so the preview matches the page — and neither of them says
   * why the size the author wrote did nothing. Recorded here so the resolver can name the ones it
   * would otherwise have read.
   *
   * Keyed by the flat path the LOADER stores under, so it lines up with what the model looks a key up
   * by rather than with what the document happened to spell.
   */
  readonly mappingKeys: ReadonlySet<string>;
  /**
   * Strings the loader runs `expand_vars` over that nothing else in this module reads.
   *
   * The FLAT spellings of the font catalogue and the fallback list. `font_catalog:` and
   * `font_fallbacks:` written at the top level reach the same two branches of `process_entry` their
   * nested forms do (`theme_loader.rb:137-158`), and this module deliberately does not read the
   * families or names out of them — see the walk's `font_catalog` branch for why. What it cannot
   * decline to read is a refusal: expansion is where a `-$reference` throws the whole document away,
   * and a path nobody looked at is a document the preview would dress a page from and the export
   * would not.
   *
   * So they are carried as text with the position they were written at, and the resolver expands them
   * for that answer alone. Nothing else consumes them, and nothing here promotes them to a face.
   */
  readonly expandedOnlyStrings: readonly ExpandedOnlyString[];
}

/** One string that is expanded for its refusal alone. See {@link ParsedTheme.expandedOnlyStrings}. */
export interface ExpandedOnlyString {
  /** The path or name exactly as the document wrote it. */
  readonly text: string;
  /**
   * How many settings were emitted before it, so the resolver expands it against the same values the
   * loader had reached — which side of {@link ParsedTheme.fontCatalogueEntryIndex} it falls on is the
   * finest distinction the two-pass cascade can make, and it is the one that decides whether a
   * reference written above a definition finds it.
   */
  readonly index: number;
}

/** Why a theme document could not be read at all. */
export interface ThemeParseFailure {
  /**
   * Human-readable reason, safe to show.
   *
   * One of this module's own fixed sentences, chosen by the parser's error CODE. Never the parser's
   * own message, which embeds a code frame of the offending line — see {@link PARSE_FAILURE_REASONS}.
   */
  readonly message: string;
  /** 1-based line the parser blamed, where it named one. */
  readonly line?: number;
}

/** The outcome of reading one theme document. */
export type ParseThemeResult =
  | { readonly ok: true; readonly theme: ParsedTheme }
  | { readonly ok: false; readonly failure: ThemeParseFailure };

/**
 * Sub-trees whose children are author-chosen names rather than settings. Descending into
 * `font.catalog` would mint a setting per font file the theme happens to ship.
 */
const OPAQUE_SUBTREES = new Set(['font_catalog', 'font_fallbacks']);

/**
 * A `key: value` line the renderer's pre-parse substitution rewrites, ported from `HexColorEntryRx`
 * (`theme_loader.rb:23`), which reads
 * `^(?<k> *\p{Graph}+): +(?!null$)(?<q>["']?)(?<h>#)?(?<v>\h\h\h\h{0,3})\k<q> *(?:#.*)?$`.
 *
 * Matching it is not enough on its own — see {@link quoteHexColours} for what the loader does with a
 * match — so this is deliberately WIDER than "a colour": it is every line the loader rewrites, of
 * which the ones it quotes are a subset.
 *
 * Three details are the loader's rather than this file's. The key is one run of printable
 * non-space characters after optional SPACE indentation, so `my color: 333333` is not a key it sees
 * and neither is a tab-indented line. The separator is one or more spaces, never a tab. And the
 * value is three to SIX hexadecimal digits — `\h\h\h\h{0,3}`, which includes five — optionally
 * wrapped in matching quotes the author wrote, so an already-quoted value is rewritten too.
 *
 * The loader's `(?!null$)` guard is not ported because it cannot fire: everything after it must
 * begin with a quote, a `#`, or a hexadecimal digit, and `null` begins with none of those.
 */
const HEX_COLOUR_ENTRY =
  /^(?<key> *[^\s\p{C}]+): +(?<quote>["']?)(?<hash>#)?(?<hex>[\da-fA-F]{3,6})\k<quote> *(?<comment>#.*)?$/u;

/** Every break YAML counts as the end of a line, which is every break the loader's read normalises. */
const LINE_BREAK = /\r\n|[\n\r]/;

/** The largest theme document worth reading, so a pathological file cannot occupy the main thread. */
const MAX_THEME_BYTES = 512 * 1024;

/**
 * How much more content a document may DENOTE than it is written from, per byte.
 *
 * The real themes shipped with the renderer sit between 0.038 and 0.093 nodes per byte, densest
 * first (`base-theme.yml`, 2,983 bytes, 227 nodes). Sixteen is roughly two hundred times that, so a
 * document written by hand — however heavily it reuses an anchor — is nowhere near it, while a
 * document whose whole purpose is to denote more than it says is over it within a few lines.
 */
const MAX_EXPANSION_NODES_PER_BYTE = 16;

/**
 * The most expanded content any document may denote, whatever its size.
 *
 * The per-byte allowance alone is not a bound: at the 512 KB limit it permits eight million nodes,
 * which is a materialisation the tab does not survive. A theme with forty thousand settings under
 * `role` — the size the duplicate-key scan was written for — composes to roughly a hundred
 * thousand nodes, so this leaves that kind of document a comfortable margin and still caps the worst
 * case at something the render thread can absorb.
 */
const MAX_EXPANDED_NODES = 250 * 1000;

/**
 * How many characters of flat key a document may denote, per byte.
 *
 * Counting nodes is not counting the work. The flattening names every node it materialises by the
 * whole path down to it, so a document of N nodes nested D deep costs N × D CHARACTERS, and nesting
 * costs about four bytes a level to write in flow style while the parser accepts fifteen hundred of
 * them. One wide anchor merged at the bottom of twelve nine-hundred-level chains fits in 93 KB and
 * denotes 52,000 settings whose keys run to 1,809 characters: 87 million characters, 175 MB of
 * strings and 1.4 seconds, per keystroke, with the node count nowhere near its budget.
 *
 * The real themes sit between 0.13 and 1.38 characters per byte (`base-theme.yml` at 0.80,
 * `default-theme.yml` at 0.88), and the worst legitimate shape measured, a catalogue of thirteen
 * thousand font families, at 2.24. Sixty-four is twenty-eight times that, and a chain nested two
 * hundred levels is already at eighty-one.
 */
const MAX_EXPANSION_KEY_CHARS_PER_BYTE = 64;

/**
 * The most flat-key text any document may denote, whatever its size.
 *
 * Four million characters is about ten million built by {@link flatten} and sixty-five milliseconds
 * on the thread the preview renders on. The largest legitimate document measured — 485 KB declaring
 * thirteen thousand font families — denotes 1.08 million, and is charged for a subtree the flattening
 * never descends into, so the margin over anything an author writes is larger than it looks.
 *
 * It also caps DEPTH, which is what makes the recursion in {@link flatten} and {@link collectLines}
 * finite whatever the document is padded out to: a chain nested D levels denotes about 2D²
 * characters however few bytes it is written from, so nothing this bound admits nests past about
 * fourteen hundred levels — and the parser's own recursion gives out first, somewhere above a
 * thousand, which it reports as `RESOURCE_EXHAUSTION`.
 */
const MAX_EXPANDED_KEY_CHARS = 4 * 1000 * 1000;

/**
 * The most re-serialising of collection keys any document may ask for, whatever its size.
 *
 * A key that is a list or a mapping cannot key a JavaScript object, so the reader re-serialises it to
 * text — and rebuilds the set of anchor names it serialises against from scratch for EVERY such key,
 * walking every anchor the document has set so far (`addPairToJSMap.stringifyKey`, yaml 2.9.0). The
 * cost is therefore a PRODUCT that neither dimension above measures, and neither can: a collection key
 * denotes one node and a few characters of flat key, which is the truth about what it materialises and
 * says nothing about what naming it costs. 16,200 anchors beside 16,200 collection keys fit in 505 KB
 * and took 5.6 seconds, in the render-phase `useMemo` that reads the theme, per keystroke.
 *
 * Charged as a product because neither half is a cost on its own: 506 KB of nothing but anchors reads
 * in 0.35 seconds and 486 KB of nothing but collection keys in 0.45, while the 505 KB holding 16,200
 * of each takes better than twelve times either. A million of them is between 20 and 50 milliseconds
 * on the thread the preview renders on — the spread is the anchor list's length, since a longer one is
 * a larger set to rebuild for every key.
 *
 * Every figure above is measured on the keys NESTED one level, which is the only depth the question
 * arises at now: see {@link COLLECTION_KEY_FAILURE} for why a top-level collection key never reaches
 * the reader's stringification at all.
 *
 * Flat rather than per-byte, unlike the two dimensions above, because no theme anyone writes spends
 * anything here at all — a key is a setting's NAME, and every theme measured is at zero: the nine
 * shipped with the renderer, the demo project's `showcase-theme.yml`, and the fixture written to
 * exercise anchors. A per-byte allowance would be pricing a resource no real document buys.
 *
 * Refusing collection keys outright was the alternative, and the EXPORT is what decided against it.
 * `process_entry` reaches `key.start_with?` on a top-level collection key and raises `NoMethodError`,
 * so the export of such a theme fails — and this module refuses one too, under
 * {@link COLLECTION_KEY_FAILURE}. But a NESTED one it reads, interpolating the key's Ruby `to_s` into
 * the flat name, so `d0:\n  ? [1, 2]\n  : v` loads as `d0_[1, 2]`. That setting is inert, since no
 * descriptor claims a key with brackets in it; refusing the document over it would drop every OTHER
 * setting in a theme the export applies in full, and show the default page instead. So the nested key
 * is what this bound is for, and it is the only one it is ever charged for.
 */
const MAX_STRINGIFIED_KEY_CHARGE = 1000 * 1000;

/**
 * A key that a JavaScript object would enumerate BEFORE every other key it holds.
 *
 * An own string property whose name is a canonical non-negative integer below 2³²−1 is an array
 * INDEX, and `[[OwnPropertyKeys]]` lists every index in ascending numeric order ahead of the string
 * keys — whatever order they were inserted in. So a document ending `"10": 20` is enumerated first,
 * and everything this module does downstream of the materialisation reads that order as the
 * document's own.
 *
 * Canonical is the whole test: `010` and `1.5` and `-1` are ordinary string keys and keep their
 * position, so only this exact spelling reorders.
 */
const INDEX_LIKE_KEY = /^(?:0|[1-9]\d{0,9})$/;

/** The largest array index, above which a numeric key is an ordinary string key again. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * What an index-like key is materialised under, so that it is not an index and keeps its position.
 *
 * The prefix carries the key's own TYPE, because two index-like keys that differ only in QUOTING are
 * two keys and not one. `revive_hash` writes each into the same Ruby Hash under the value Psych typed
 * it as, so `10:` keys under the Integer and `"10":` under the String and the two do not collide —
 * while `String(node.value)` collapsed them, and the second mapping then replaced the first WHOLESALE.
 * Under `role`, which is the one parent a document can reach that from — everywhere else an Integer
 * key raises out of `process_entry`, see {@link isNonStringKey} — it silently dropped settings:
 * measured against the vendored gem under ruby 3.3.3,
 * `role: {10: {font_size: 5}, "10": {font_color: '333333'}}` loads as `role_10_font_size => 5` AND
 * `role_10_font_color => "333333"`, and only the second of those survived here.
 *
 * Tagging by TYPE rather than by position is what keeps the other half of the rule intact: a key the
 * document writes twice the same way is one key, the last write winning in the position of the first,
 * exactly as `Hash#[]=` leaves it. A counter would have made two keys of those as well.
 */
const INDEX_KEY_PREFIX = '\u0000';

/**
 * The type tag {@link INDEX_KEY_PREFIX} carries: whether the export's reader typed the key as a
 * String.
 *
 * `n` is every OTHER type it can build for a key — an Integer, a Float, a true, a false or a nil —
 * and not merely a number, because those are exactly the values `process_entry` cannot name a
 * setting with. See {@link isNonStringKey}.
 */
const NUMBER_KEY_TAG = 'n';
const STRING_KEY_TAG = 's';

/**
 * How far into a minted name its written part begins: past the NUL and past the type tag.
 *
 * Stripped WHOLE by {@link writtenKeyName}, which can be the exact inverse of the mint because the
 * mint's space is closed to the document. Neither half of that was true before.
 *
 * The looser test this replaces — "begins with a NUL" — was not the inverse of the rename, whatever
 * the comment beside it claimed: a document CAN put a NUL in a key, because `"\0base"` is a legal
 * double-quoted scalar and the parser decodes the escape. Stripping the NUL off that made it `base`,
 * so `"\0base":\n  font_size: 20` previewed body text at 20 pt, while the vendored gem under ruby
 * 3.3.3 stores the inert setting `:"\x00base_font_size"` and prints the page at 10.5.
 *
 * Requiring the minted SHAPE narrowed what a document could forge to the exact names the mint writes,
 * and stopped there. The reasoning that left those open ran in one direction only — a forged name
 * reaches no key the honest spelling does not, so `role:\n  "\0n10":\n    font_size: 5` reading as
 * `role_10_font_size` was a disagreement about a setting the document could have named outright. In
 * the other direction it is not a disagreement about a name, it is a REFUSAL: the honest
 * `base:\n  10: 5` raises `NoMethodError` in the loader and is refused here, while
 * `base:\n  "\0n10": 5` loads in the gem under ruby 3.3.3 as the inert `:"base_\x00n10" => 5` beside
 * every other setting — and the preview threw the whole document away over it, because
 * {@link isNonStringKey} read the forged name as the mint's own. A blank page and a sentence about a
 * key the author wrote as text.
 *
 * So the space is closed by ESCAPING into it: a key the document writes that already begins with the
 * prefix is given another, and the strip takes it back off. The rename is then injective — no
 * document key lands on a minted name — and the strip direction closes with it:
 * `role:\n  "\0n10":` now reads `role_\x00n10_font_size`, which is what the gem loads.
 *
 * Closed on every ROAD, too, which is the other half. `? *big` names a key from an anchored scalar
 * written elsewhere, and that scalar is not a key node for the rename to sit on — so the mint was
 * simply absent there, in both directions at once. See {@link installTypedAliasKeys}.
 *
 * The alternative, keys that are VALUES rather than strings — `toJS({ mapAsMap: true })` — is a
 * different materialisation for every reader downstream of here. Making the prefix unguessable
 * instead was measured and rejected: {@link keySegmentCost} charges a key its un-prefixed length and
 * charges it once per node beneath it, so every character added to the prefix multiplies the flat-key
 * text {@link MAX_EXPANDED_KEY_CHARS} actually admits, and the bound is the reason the deep-chain
 * shape is refused at all.
 */
const MINTED_INDEX_KEY_LENGTH = INDEX_KEY_PREFIX.length + 1;

/**
 * The name a key was written under, with any {@link installTypedKeys} rename taken back off.
 *
 * The ONE place the rename is undone, so that the object walk and the node walk cannot come to
 * disagree about what a key is called.
 *
 * The exact inverse of the mint, and it can be, because the mint's space is CLOSED: every road a key
 * takes into the materialised object goes through {@link typedKeyName}, which escapes a document's
 * own name out of that space rather than letting it land in one. This used to be a guess instead —
 * "does this look like a name the mint could have written" — and a guess is what it had to be while
 * a document could write the mint's spelling directly. Both halves of that were wrong: a forged name
 * was stripped like the mint's, and a forged NUMBER name refused the whole document.
 *
 * The roads, so that a new one is known to need the mint. A scalar key node is renamed in place; an
 * alias in key position answers with a minted name of its own (see {@link installTypedAliasKeys});
 * a merge source's keys are the same nodes, materialised through a `Map` and written back out by
 * {@link writeMergedEntry}; and a COLLECTION key is re-serialised by the reader into flow style or
 * `*name`, neither of which can begin with a NUL.
 *
 * @param key - A key as it is materialised: minted, escaped, or as the document wrote it.
 * @returns The name the document wrote.
 */
function writtenKeyName(key: string): string {
  if (!key.startsWith(INDEX_KEY_PREFIX)) return key;
  // The escape: a key the document wrote INTO the mint's space carries a prefix of its own, and
  // giving it back is what makes the name it is stored under the name the loader stores.
  if (key[INDEX_KEY_PREFIX.length] === INDEX_KEY_PREFIX) {
    return key.slice(INDEX_KEY_PREFIX.length);
  }
  return key.slice(MINTED_INDEX_KEY_LENGTH);
}

/**
 * Whether a materialised key is one the export's reader typed as something other than a String.
 *
 * The question `process_entry` asks of every key it is handed, and the one it asks by calling
 * `key.include? '-'` (`theme_loader.rb:132` and `:172`) — a method an Integer, a Float, a true, a
 * false and a nil all lack, so asking it of one raises `NoMethodError` and the whole theme fails to
 * load. See {@link NON_STRING_KEY_FAILURE} for where that lands and {@link flatten} for the one
 * position the loader never asks from.
 *
 * Answered from the MINT rather than from the parser, because the answer has to survive
 * materialisation: a JavaScript object's keys are strings whatever the document typed them as, and
 * the merge is what makes the written position the wrong place to ask — an anchored mapping written
 * under `role` may be merged into a mapping that is not `role`, where the same key raises.
 *
 * @param key - A key as it is materialised.
 * @returns Whether the export's reader would hand `process_entry` a non-String.
 */
function isNonStringKey(key: string): boolean {
  // The tag is the whole answer, because the mint's space is closed to the document — see
  // {@link writtenKeyName}. A key the document wrote carries the escape and reads as `\0\0…`, which
  // is not this tag, so it is not this question either.
  return key.startsWith(INDEX_KEY_PREFIX + NUMBER_KEY_TAG);
}

/** The key that merges another mapping's entries into this one, as YAML 1.1 spells it. */
const MERGE_KEY = '<<';

/**
 * Psych's own test for "this looks like prose, not a number", which is the FIRST thing it applies.
 *
 * `%r{^[^\d.:-]?[[:alpha:]_\s!@#$%\^&*(){}<>|/\\~;=]+}` (`psych/scalar_scanner.rb:39`), deliberately
 * unanchored at the end: it is a PREFIX test, so `NotARealSize` and `y!` take this branch and `1e9`
 * does not. Ruby's `[[:alpha:]]` is Unicode-aware on a UTF-8 string, which `\p{Alpha}` is the
 * JavaScript spelling of.
 */
const PSYCH_PROSE = /^[^\d.:-]?[\p{Alpha}_\s!@#$%^&*(){}<>|/\\~;=]+/u;

/** `^[^ytonf~]/i` — the one test that decides whether a short prose-shaped scalar is a keyword. */
const PSYCH_NOT_KEYWORD_START = /^[^ytonf~]/iu;

/** `^null$/i`, which is why `NuLL` is nothing at all and `Nul` is the three letters it looks like. */
const PSYCH_NULL = /^null$/iu;

/** `^(yes|true|on)$/i`. */
const PSYCH_TRUE = /^(?:yes|true|on)$/iu;

/** `^(no|false|off)$/i`. */
const PSYCH_FALSE = /^(?:no|false|off)$/iu;

/**
 * A timestamp, taken from `http://yaml.org/type/timestamp.html` (`psych/scalar_scanner.rb:8`).
 *
 * Psych builds a `Time` from a match, and the loader reads themes with `safe_load` and no
 * `permitted_classes` (`theme_loader.rb:104`), so the reader raises `Psych::DisallowedClass` instead
 * — see {@link DISALLOWED_CLASS}.
 */
const PSYCH_TIME =
  /^-?\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|\s+)\d{1,2}:\d\d:\d\d(?:\.\d*)?(?:\s*(?:Z|[-+]\d{1,2}:?(?:\d\d)?))?$/u;

/** A bare date (`psych/scalar_scanner.rb:63`), which Psych builds a `Date` from. */
const PSYCH_DATE = /^\d{4}-(?:1[012]|0\d|\d)-(?:[12]\d|3[01]|0\d|\d)$/u;

/** `^:./`, which Psych turns into a `Symbol` (`psych/scalar_scanner.rb:73`). */
const PSYCH_SYMBOL = /^:./u;

/** `^\+?\.inf$/i`, `^-\.inf$/i` and `^\.nan$/i`, which are the three floats with no digits in them. */
const PSYCH_POSITIVE_INFINITY = /^\+?\.inf$/iu;
const PSYCH_NEGATIVE_INFINITY = /^-\.inf$/iu;
const PSYCH_NAN = /^\.nan$/iu;

/**
 * Base-60, as Psych matches it: `^[-+]?[0-9][0-9_]*(:[0-5]?[0-9]){1,2}$` and the same with a trailing
 * `\.[0-9_]*` (`psych/scalar_scanner.rb:80` and `:86`). At most three components, and every component
 * after the first is a two-digit minute.
 */
const PSYCH_BASE_60_INTEGER = /^[-+]?\d[\d_]*(?::[0-5]?\d){1,2}$/u;
const PSYCH_BASE_60_FLOAT = /^[-+]?\d[\d_]*(?::[0-5]?\d){1,2}\.[\d_]*$/u;

/**
 * Psych's float, taken from `http://yaml.org/type/float.html` (`psych/scalar_scanner.rb:12`).
 *
 * `^(?:[-+]?([0-9][0-9_,]*)?\.[0-9]*([eE][-+][0-9]+)?)$`. The DOT is mandatory and the exponent's
 * SIGN is mandatory, which together are the whole of why `1e9`, `1.0e9` and `1e+9` are strings in the
 * export and `1.0e+9` is a number. Commas are Psych's own extension, not the spec's.
 */
const PSYCH_FLOAT = /^[-+]?(?:\d[\d_,]*)?\.\d*(?:[eE][-+]\d+)?$/u;

/** `\A[-+]?\.\Z`, the one float-shaped scalar Psych hands back as text (`scalar_scanner.rb:93`). */
const PSYCH_BARE_POINT = /^[-+]?\.$/u;

/**
 * Psych's integer, in the LEGACY spelling — the one `safe_load` uses, since `strict_integer` defaults
 * to false (`psych/scalar_scanner.rb:20`). Base 2, base 8, base 10 and base 16, and a comma is a
 * digit separator in each of them.
 */
const PSYCH_INTEGER =
  /^(?:[-+]?0b[01_,]+|[-+]?0[0-7_,]+|[-+]?(?:0|[1-9](?:\d|,\d|_\d)*)|[-+]?0x[\da-fA-F_,]+)$/u;

/** The digit separators Psych deletes before handing a numeric literal to `Integer()` or `Float()`. */
const PSYCH_SEPARATORS = /[,_]/gu;

/** `\.([Ee]|$)` — how `Float()` is given `5.` and `1.e+9`, which Ruby's own parser would refuse. */
const PSYCH_TRAILING_POINT = /\.([Ee]|$)/u;

/**
 * An exponent with no mantissa in front of it, which is what `.e+1` becomes once Psych has rewritten
 * it — and which is the one thing {@link PSYCH_FLOAT} admits that `Float()` will not read.
 */
const RUBY_FLOAT_WITHOUT_MANTISSA = /^[-+]?[eE]/u;

/** The sign and the base prefixes `Integer()` dispatches on. A leading zero is octal, so `010` is 8. */
const RUBY_INTEGER_SIGN = /^[-+]/u;
const RUBY_BINARY_PREFIX = /^0[bB]/u;
const RUBY_HEX_PREFIX = /^0[xX]/u;
const RUBY_OCTAL_PREFIX = /^0\d/u;

/** The leading integer `String#to_i` reads, which is what the base-60 branches sum over. */
const RUBY_LEADING_INTEGER = /^[-+]?\d[\d_]*/u;

/** The leading float `String#to_f` reads, for the base-60 branch that has a fractional component. */
const RUBY_LEADING_FLOAT = /^[-+]?\d[\d_]*(?:\.\d*)?/u;

/**
 * What a scalar the export refuses to READ AT ALL types as.
 *
 * Psych builds a `Date`, a `Time` or a `Symbol` for three shapes of plain scalar, and the loader's
 * `safe_load` permits none of the three, so the reader raises `Psych::DisallowedClass` before any key
 * is looked at. Measured against the vendored gem under ruby 3.3.3 and a real conversion: a theme
 * holding `base:\n  font_size: 2001-12-14` — or the same date under a key nothing reads — logs
 * `could not locate or load the pdf theme … because of Psych::DisallowedClass` and prints the page
 * with the DEFAULT theme, MediaBox `595.28 841.89`. So it is the whole document that is refused, not
 * the value, and {@link DISALLOWED_CLASS_FAILURE} is the preview's counterpart of reverting.
 */
const DISALLOWED_CLASS = Symbol('disallowed');

/**
 * What a scalar the export's reader RAISES ON types as, which is the same outcome by another road.
 *
 * Psych's number patterns are wider than the conversions it then performs. `INTEGER_LEGACY` treats a
 * comma as a digit separator, so `0x,` and `0b_` match a base prefix with nothing but separators
 * after it, and `parse_int` deletes those before calling `Integer()` — which is handed `0x` and
 * raises `ArgumentError`. `FLOAT` makes both the integer part and the fraction optional, so `.e+1`
 * matches, and the `\.([Ee]|$)` rewrite takes the dot out before `Float()` is handed `e+1` and raises
 * the same way. Measured against ruby 3.3.3, the whole set is `[-+]?0b[_,]+`, `[-+]?0x[_,]+` and
 * `[-+]?\.[eE][-+]\d+`, over every string of length four or less across an alphabet holding every
 * character those patterns can use.
 *
 * The raise leaves `safe_load` exactly as `Psych::DisallowedClass` does, and `load_theme`'s rescue
 * (`converter.rb:556`) is BARE — it names no exception class at all — so the two are indistinguishable
 * to the export: it logs `could not locate or load the pdf theme …; reverting to default theme` and
 * prints the document with the default theme. Measured: `some_unread_key: 0x_` above a
 * `base: font_size: 20` prints at 10.5 pt, and every other setting in the document is thrown away
 * with it.
 *
 * Read as a NUMBER instead, this was `parseInt('', 16)` — `NaN`, assigned to the key and read on past.
 * The document above previewed at 20 pt with nothing to report, for a page the export prints at 10.5.
 */
const UNREADABLE_NUMBER = Symbol('unreadable-number');

/**
 * Ruby's `String#to_i`, over the leading integer alone.
 *
 * @param text - One base-60 component, as the document wrote it.
 * @returns The leading integer, or zero where there is none.
 */
function rubyToInteger(text: string): number {
  const match = RUBY_LEADING_INTEGER.exec(text);
  return match === null ? 0 : Number(match[0].replaceAll('_', ''));
}

/**
 * Ruby's `String#to_f`, over the leading float alone.
 *
 * @param text - One base-60 component, as the document wrote it.
 * @returns The leading float, or zero where there is none.
 */
function rubyToFloat(text: string): number {
  const match = RUBY_LEADING_FLOAT.exec(text);
  return match === null ? 0 : Number(match[0].replaceAll('_', ''));
}

/**
 * Sum a base-60 literal the way Psych sums one, quirk included.
 *
 * `i += n.to_i * 60 ** (e - 2).abs` (`psych/scalar_scanner.rb:83`) weights the components by their
 * DISTANCE FROM THE THIRD one rather than by their distance from the last, so a two-component literal
 * is weighted as hours and minutes: `1:30` is 5,400 and not the 90 the YAML 1.1 type specifies.
 * Reproduced rather than corrected, because 5,400 is the number the export lays the page out with —
 * `page: size: [1:30, 1:30]` prints MediaBox `5400 5400`, measured.
 *
 * @param text - The literal, which has already matched one of the base-60 patterns.
 * @param component - How to read one component, which is `to_i` or `to_f`.
 * @returns The sum.
 */
function psychBase60(text: string, component: (part: string) => number): number {
  let total = 0;
  const parts = text.split(':');
  for (const [index, part] of parts.entries()) total += component(part) * 60 ** Math.abs(index - 2);
  return total;
}

/**
 * Ruby's `Integer()`, over the shapes {@link PSYCH_INTEGER} admits.
 *
 * The base is chosen by the PREFIX, so a leading zero is octal — `010` is 8 — and `0x` and `0b` are
 * the other two.
 *
 * Matching {@link PSYCH_INTEGER} is NOT enough to make `Integer()` succeed, which is the whole reason
 * this answers `undefined` at all. Both separator-bearing branches admit a prefix with nothing after
 * it once the separators are deleted — `0x_` and `0b,` and their signed spellings — and Psych deletes
 * them before it calls `Integer()`, so the call is handed `0x` and RAISES. See
 * {@link UNREADABLE_NUMBER} for what the export does with the raise.
 *
 * The MAGNITUDE is the nearest double, as every number in this value space is, so an integer past 2⁵³
 * loses its low digits here where Ruby keeps a Bignum: `12345678901234567890` comes back as `…567000`.
 * What is NOT lost is how the export spells it, which is the half that decides colours — the exact
 * digits go on with the value as a {@link ../print-appearance/units.RubyNumber}, so
 * `10000000000000000000000` is still the twenty-three characters whose first six the export inks.
 * Carrying `BigInt` as the magnitude too would change every reader downstream for the one key in
 * nothing that needs it.
 *
 * @param text - The literal, with its digit separators already deleted.
 * @returns What the literal denotes in the base its prefix selects, as both the exact integer and the
 *   nearest double, or undefined where `Integer()` raises.
 */
function rubyInteger(text: string): { value: number; exact: bigint } | undefined {
  const negative = text.startsWith('-');
  const digits = text.replace(RUBY_INTEGER_SIGN, '');
  let magnitude: number;
  let exact: bigint;
  if (RUBY_BINARY_PREFIX.test(digits)) {
    magnitude = Number.parseInt(digits.slice(2), 2);
    exact = bigIntInBase(digits.slice(2), 2);
  } else if (RUBY_HEX_PREFIX.test(digits)) {
    magnitude = Number.parseInt(digits.slice(2), 16);
    exact = bigIntInBase(digits.slice(2), 16);
  } else if (RUBY_OCTAL_PREFIX.test(digits)) {
    magnitude = Number.parseInt(digits.slice(1), 8);
    exact = bigIntInBase(digits.slice(1), 8);
  } else {
    magnitude = Number(digits);
    exact = Number.isNaN(magnitude) ? 0n : BigInt(digits);
  }
  if (Number.isNaN(magnitude)) return undefined;
  return { value: negative ? -magnitude : magnitude, exact: negative ? -exact : exact };
}

/**
 * The exact integer a run of digits denotes in one of `Integer()`'s bases.
 *
 * `BigInt` reads a prefixed literal itself, but only its own prefixes and never a BARE leading zero —
 * `BigInt('010')` is ten where `Integer('010')` is eight — so the base is applied here rather than
 * spelled back into a literal for it to re-read.
 *
 * @param digits - The digits alone, with the prefix and any sign already removed.
 * @param base - The base its prefix selected.
 * @returns The integer they denote.
 */
function bigIntInBase(digits: string, base: number): bigint {
  const radix = BigInt(base);
  let total = 0n;
  for (const digit of digits) total = total * radix + BigInt(Number.parseInt(digit, base));
  return total;
}

/**
 * Type one plain scalar exactly as the export's reader types it.
 *
 * A port of `Psych::ScalarScanner#tokenize` (ruby 3.3.3), branch for branch and in its order, because
 * the order is what decides several of the answers: the prose test runs FIRST, so `NotARealSize` never
 * reaches the number branches, and the base-60 tests run before the float, so `1:30.5` is 5,430 rather
 * than a syntax error.
 *
 * Only ever asked about a PLAIN, untagged scalar. `deserialize` returns `o.value` unread for anything
 * quoted — which in Psych includes a block scalar — and dispatches on the tag when there is one
 * (`psych/visitors/to_ruby.rb:63-64`), so `'yes'`, `"010"` and `!!str 1e9` are the text they spell in
 * the export and must stay the text they spell here.
 *
 * @param text - The scalar's text, folded as the parser folds it.
 * @returns The value, {@link DISALLOWED_CLASS} for the three shapes `safe_load` will not build, or
 *   {@link UNREADABLE_NUMBER} for the shapes it matches as a number and then raises converting.
 */
function psychScalar(text: string): unknown {
  if (text === '') return null;
  if (PSYCH_PROSE.test(text) || text.includes('\n')) {
    // Five characters is Psych's own cutoff: nothing longer can be a keyword, so nothing longer is
    // tested against one. `Off-white` and `On the road` are prose by this branch, not booleans.
    if (text.length > 5) return text;
    if (PSYCH_NOT_KEYWORD_START.test(text)) return text;
    if (text === '~' || PSYCH_NULL.test(text)) return null;
    if (PSYCH_TRUE.test(text)) return true;
    if (PSYCH_FALSE.test(text)) return false;
    return text;
  }
  if (PSYCH_TIME.test(text) || PSYCH_DATE.test(text) || PSYCH_SYMBOL.test(text)) return DISALLOWED_CLASS;
  if (PSYCH_POSITIVE_INFINITY.test(text)) return Number.POSITIVE_INFINITY;
  if (PSYCH_NEGATIVE_INFINITY.test(text)) return Number.NEGATIVE_INFINITY;
  if (PSYCH_NAN.test(text)) return Number.NaN;
  // Both base-60 branches sum in Ruby's own arithmetic, which this does in doubles, so the exact
  // integer a huge one denotes is already gone by the time there is a value to spell. The spelling is
  // taken from the double, which is the most that can honestly be said about a number this model
  // reached by arithmetic rather than by reading digits — and it is exact for every one that fits.
  if (PSYCH_BASE_60_INTEGER.test(text)) return spelledInteger(psychBase60(text, rubyToInteger));
  if (PSYCH_BASE_60_FLOAT.test(text)) return spelledFloat(psychBase60(text, rubyToFloat));
  if (PSYCH_FLOAT.test(text)) {
    if (PSYCH_BARE_POINT.test(text)) return text;
    const literal = text.replaceAll(PSYCH_SEPARATORS, '').replace(PSYCH_TRAILING_POINT, '$1');
    // `.e+1` matched — the integer part is optional and the fraction may be empty — and the
    // trailing-point rewrite has just taken its only dot away, leaving `Float()` an exponent with
    // nothing in front of it. See {@link UNREADABLE_NUMBER}.
    if (RUBY_FLOAT_WITHOUT_MANTISSA.test(literal)) return UNREADABLE_NUMBER;
    return spelledFloat(Number(literal));
  }
  if (PSYCH_INTEGER.test(text)) {
    const integer = rubyInteger(text.replaceAll(PSYCH_SEPARATORS, ''));
    return integer === undefined ? UNREADABLE_NUMBER : spelledInteger(integer.value, integer.exact);
  }
  return text;
}

/** The one tag that stops a `<<` key merging, in the export's reader and so in this one. */
const STRING_TAG = 'tag:yaml.org,2002:str';

/**
 * What each of the YAML parser's own error codes means, in this module's words.
 *
 * The parser's `message` cannot be used: it appends a CODE FRAME of the line it failed on, so the
 * document's own text ends up inside it — `parseThemeDocument('a: 1\n\t</style>…: 2\n')` yields a
 * message carrying that markup verbatim. Copying it into a diagnostic breaks the guarantee this
 * file's header makes and the one {@link ../print-appearance/appearance-diagnostic.AppearanceDiagnostic.message}
 * makes, and those guarantees are what lets the delivery layer render a diagnostic without treating
 * it as untrusted. Two of the parser's messages interpolate document text into the SENTENCE as well
 * (an unresolved alias names the anchor), so trimming the frame off would not be enough either.
 *
 * Keying off the code instead keeps the explanation as specific as the parser was while making it
 * structurally impossible for any of the document to travel with it. A code this table does not name
 * — a newer parser release, say — falls back to the general sentence rather than to the parser's own.
 */
const PARSE_FAILURE_REASONS: Readonly<Record<string, string>> = {
  ALIAS_PROPS: 'An alias in the theme document carries an anchor or a tag of its own.',
  BAD_ALIAS: 'An alias in the theme document is not a well-formed name.',
  BAD_COLLECTION_TYPE: 'A value in the theme document is tagged as a kind of collection it is not.',
  BAD_DIRECTIVE: 'The theme document opens with a directive that is not well formed.',
  BAD_DQ_ESCAPE: 'A double-quoted value in the theme document carries an escape sequence that is not valid.',
  BAD_INDENT: 'A line of the theme document is not indented consistently with the ones around it.',
  BAD_PROP_ORDER: 'An anchor and a tag in the theme document are written in the wrong order.',
  BAD_SCALAR_START: 'A value in the theme document starts with a character that has to be quoted.',
  BLOCK_AS_IMPLICIT_KEY: 'A key in the theme document is followed by a nested block where a value was expected.',
  BLOCK_IN_FLOW: 'The theme document mixes indented settings into a bracketed list.',
  IMPOSSIBLE: 'The theme document could not be read.',
  KEY_OVER_1024_CHARS: 'A key in the theme document is longer than YAML allows.',
  MISSING_CHAR: 'A bracket, brace or quotation mark in the theme document is never closed.',
  MULTILINE_IMPLICIT_KEY: 'A key in the theme document runs across more than one line.',
  MULTIPLE_ANCHORS: 'A value in the theme document carries more than one anchor.',
  MULTIPLE_DOCS: 'The file holds more than one document, and a theme is a single document.',
  MULTIPLE_TAGS: 'A value in the theme document carries more than one tag.',
  // The composer catches its own stack overflow and reports it as this. Without a sentence it fell
  // to "is not valid YAML", which is the one thing such a document is not — it is well-formed and
  // nested past what a recursive descent holds, and an author told it is invalid has nothing to fix.
  RESOURCE_EXHAUSTION: 'A value in the theme document is nested more deeply than it can be read.',
  TAB_AS_INDENT: 'A line of the theme document is indented with a tab, which YAML does not allow.',
  UNEXPECTED_TOKEN: 'The theme document has a character where a key, a value or a comment was expected.',
};

/** The sentence for a failure with no code, or a code this module does not know. */
const GENERIC_PARSE_FAILURE = 'The theme document is not valid YAML.';

/** An alias that names an anchor set after it, or none at all. */
const UNRESOLVED_ALIAS_FAILURE =
  'An alias in the theme document names an anchor that is not set before it.';

/** More expansion than a document read on the preview path is allowed to ask for. */
const EXPANSION_BUDGET_FAILURE =
  'The theme document expands its aliases into far more content than it is written from, and was not read.';

/**
 * The stringified-key bound's own sentence, which is a third distinct claim.
 *
 * Not {@link EXPANSION_BUDGET_FAILURE}'s: a document refused here denotes very little — one node and a
 * dozen characters of flat key per collection key — and telling its author it expands into far more
 * content than it is written from would be as untrue as it was when the parser's own alias bound
 * refused documents under that sentence. What is over budget is the PRODUCT of two things it writes,
 * and the sentence names both, because neither on its own is what was refused.
 */
const STRINGIFIED_KEY_FAILURE =
  'The theme document writes more of its keys as lists or mappings, against more anchors, than a theme is read with.';

/** A document that parsed and then could not be turned into settings — see {@link readThemeDocument}. */
const UNREADABLE_FAILURE = 'The theme document could not be read.';

/**
 * The sentence for a document holding a value the export's reader will not build. See
 * {@link DISALLOWED_CLASS}.
 *
 * A whole-document failure rather than a rejected value, because that is what it is in the export:
 * `safe_load` raises while READING, before a key has been looked at, so the converter logs that it
 * could not load the theme and prints the document with the default one. A preview that dropped the
 * one value and applied the rest would show a page built from a theme the export never applied.
 */
const DISALLOWED_CLASS_FAILURE =
  'A value in the theme document is written as a date, a time or a symbol, and a theme is not read with any of those.';

/**
 * The sentence for a document holding a number the export's reader raises on. See
 * {@link UNREADABLE_NUMBER}.
 *
 * A sentence of its own rather than a widening of {@link DISALLOWED_CLASS_FAILURE}, even though the
 * export cannot tell the two apart: what an author has to fix is different. There, a value is the
 * wrong KIND of thing and the fix is to quote it or to write it another way; here, a value is a
 * number that was not finished — a base prefix with only separators after it, or an exponent with
 * nothing in front of it — and naming it a date would send its author looking at the wrong line.
 * Neither sentence carries any of the document's text, which is the rule the whole diagnostic
 * surface rests on.
 */
const UNREADABLE_NUMBER_FAILURE =
  'A value in the theme document is written as a number the theme reader cannot read, so none of the document is read.';

/**
 * The two sentences above, said about a KEY.
 *
 * Psych types a key with the same `ScalarScanner` it types a value with — `revive_hash` calls
 * `accept` on the key before it calls it on the value (`psych/visitors/to_ruby.rb:344-381`) — so both
 * refusals reach the export from key position too, and neither depends on where in the document the
 * key sits. Measured against the vendored gem under ruby 3.3.3: `0x_: 1` raises
 * `ArgumentError: invalid value for Integer(): "0x"` and `2001-12-14: 1` raises
 * `Psych::DisallowedClass: Tried to load unspecified class: Date`, at the top level, nested, and
 * under `role` alike — the reader has not reached a key yet, so the `role` exemption that saves an
 * Integer key does not apply. Both were read here: `{"0x_": 1}` and `{"2001_12_14": 1}`, alongside
 * every other setting in a document the export prints with the DEFAULT theme.
 *
 * Sentences of their own rather than a widening of the two above, on the same reasoning that split
 * those two from each other: what an author has to fix is in a different place. A theme is read for
 * its VALUES, and an author told that a value is a date will look down the right-hand column of a
 * document whose problem is on the left.
 */
const DISALLOWED_CLASS_KEY_FAILURE =
  'A key in the theme document is written as a date, a time or a symbol, and a theme is not read with any of those.';
const UNREADABLE_NUMBER_KEY_FAILURE =
  'A key in the theme document is written as a number the theme reader cannot read, so none of the document is read.';

/**
 * The sentence for a key the export's LOADER cannot name a setting with. See {@link isNonStringKey}.
 *
 * A third whole-document failure by a third road, and the only one of the three that the reader
 * survives: `safe_load` builds the Hash, and `process_entry` then calls `key.include? '-'` on a key
 * the reader typed as an Integer, a Float, a true, a false or a nil, none of which has that method.
 * `load_theme`'s rescue (`converter.rb:556`) names no exception class, so the `NoMethodError` leaves
 * the export exactly where `Psych::DisallowedClass` does — `could not locate or load the pdf theme
 * …; reverting to default theme`, and the page printed with the default one.
 *
 * Measured against the vendored gem under ruby 3.3.3. `10:\n  font_size: 5` raises at the top level,
 * `base:\n  10:\n    font_size: 5` raises nested, and so do `yes:`, `true:`, `~:`, `1.5:` and `010:`,
 * which Psych types as a true, a true, a nil, a Float and an Integer. All of them were read here, as
 * `10_font_size`, `base_10_font_size`, `yes_font_size` and the rest.
 *
 * Not `role`, which is the exception the sentence deliberately does not try to name: the loader's
 * nested join is `key == 'role' || !(subkey.include? '-')` (`theme_loader.rb:172`) and `||`
 * SHORT-CIRCUITS, so under `role` the method is never called and the key is interpolated by its own
 * `to_s`. Measured: `role:\n  10:\n    font_size: 5` loads `role_10_font_size => 5`, and `role` with
 * a true, a nil and a Float subkey load `role_true_…`, `role__…` and `role_1.5_…`.
 */
const NON_STRING_KEY_FAILURE =
  'A key in the theme document is written as a number, a boolean or nothing at all, and a theme names its settings with text.';

/**
 * The same refusal by a THIRD method, for a key that is a list or a mapping rather than a scalar.
 *
 * A different mechanism from {@link NON_STRING_KEY_FAILURE}'s, and it has to be, because an Array and
 * a Hash both HAVE `include?`. `process_entry` gets past the normalisation on one and raises four
 * lines later, at `key.start_with? 'admonition_icon_'` (`theme_loader.rb:161`) — a method neither of
 * them has. Measured against the vendored gem under ruby 3.3.3: `? [1, 2]\n: v` raises
 * `undefined method 'start_with?' for an instance of Array` and `? {a: 1}\n: v` the same for a Hash,
 * as do `? []`, `? {}`, an alias naming either, and one carried to the top level by a merge
 * (`c: &c\n  ? [1, 2]\n  : v\n<<: *c`). All of them were read here, as a setting named `[ 1, 2 ]`
 * alongside every other setting in a document the export prints with the DEFAULT theme.
 *
 * Only at the TOP level, which is the reason this is drawn where the walk can still see a node rather
 * than in {@link flatten}. A nested collection key never reaches `start_with?` at all: the loader
 * interpolates it into the flat name it recurses with (`%(#{key}_#{subkey})`), so `d0:\n  ? [1, 2]\n
 * : v` loads as the inert setting `d0_[1, 2]` and the document is read in full — which is the outcome
 * {@link MAX_STRINGIFIED_KEY_CHARGE} already argues a collection key must not cost.
 *
 * A sentence of its own for the reason the two above are: what an author has to fix differs. There is
 * no number or boolean anywhere in such a document — there is a bracketed list where a name belongs —
 * and being told to look for a number would send its author down the wrong column.
 *
 * Said of a list ITEM as well, which is the one other place the loader turns a value into a name: an
 * admonition icon written as a list keys its properties by the list's elements, so an element that is
 * itself a list or a mapping is a key of this shape. See {@link readAdmonitionIcon}.
 */
const COLLECTION_KEY_FAILURE =
  'A key in the theme document is written as a list or a mapping, and a theme names its settings with text.';

/**
 * The sentence for an `extends` the loader cannot read as the name of a theme. See
 * {@link extendsRefusal}.
 *
 * The EARLIEST of this module's whole-document refusals, because `extends` is followed before any
 * setting is looked at (`theme_loader.rb:107`) — so it is answered before the walk that finds the
 * others.
 *
 * A sentence of its own for the reason each of the others has one: what an author has to fix is a
 * single line, and it is not a setting. Being told that a key or a value is unreadable would send
 * them down a document whose every setting is fine.
 *
 * It says "the name of a theme" rather than "text", because the half of this the module does NOT
 * refuse is a String that names no theme it can layer — `extends: brand` raises `Errno::ENOENT` in
 * the export and is reported here as a warning instead, since resolving it would mean reading a
 * second document that a pure resolver over one theme's text does not have. Widening this sentence
 * to cover that would make it a sentence about a case it does not answer.
 */
const EXTENDS_SHAPE_FAILURE =
  'The extends setting in the theme document has something other than the name of a theme where a name was expected, and reading it stops the whole document being read.';

/**
 * The sentence for an admonition icon whose value the loader cannot read any properties out of.
 *
 * `process_entry`'s admonition branch is `val.each do |key2, val2| … end if val`
 * (`theme_loader.rb:162-166`), and `each` is the whole of what it requires of the value. A Hash has
 * one and a list has one; a String, an Integer, a Float and `true` have none, so the loader raises
 * `NoMethodError` and `converter.rb:556`'s bare rescue reverts the whole document to the default
 * theme. Measured against the vendored gem under ruby 3.3.3: `admonition_icon_tip: hello` raises
 * `undefined method 'each' for an instance of String`, and `5`, `5.5` and `true` raise the same for
 * an Integer, a Float and `true` — while `false` and an empty value raise nothing at all, because the
 * trailing `if val` guards the branch. All four raising shapes were read here, as an inert
 * `admonition_icon_tip` setting beside every other setting in a document the export throws away.
 *
 * A sentence of its own, again because the fix is elsewhere: nothing about the KEY is wrong. The
 * author wrote a name where the loader reads a group of properties, and the line to change is the one
 * to the right of the colon.
 */
const ADMONITION_ICON_VALUE_FAILURE =
  'An admonition icon in the theme document is set to one value where a group of icon properties was expected, so none of the document is read.';

/**
 * The sentence for a font file the loader cannot even ask a question about. See
 * {@link fontCatalogueRefusal}.
 *
 * `(path.start_with? 'GEM_FONTS_DIR')` (`theme_loader.rb:145`) is the FIRST thing the catalogue does
 * with a style's value, and `start_with?` is a method only a String has. Measured against the
 * vendored gem under ruby 3.3.3, across every style slot — `normal`, `bold`, `italic`, `bold_italic`,
 * `regular`, `*` and a name the loader does not recognise alike — an Integer, a Float, a `true`, a
 * `false`, a list and a mapping all raise `NoMethodError`, and `converter.rb:556`'s bare rescue then
 * reverts the WHOLE document to the default theme. `font_catalog:` written flat at the top level
 * reaches the same branch and raises the same way.
 *
 * Two shapes do NOT raise, and both are exemptions this had to be measured for rather than reasoned
 * to. A family whose value is not a mapping at all — `Brand: 10` — is simply dropped, because
 * `accum[name] = styles.reduce … if ::Hash === styles` never assigns and never enters the reduce; and
 * `merge` is `delete`d out of the catalogue before the reduce begins, so `merge: 10` is a catalogue
 * that merges rather than one that raises. Measured: both load, with `font_catalog` `{}`.
 */
const FONT_STYLE_VALUE_FAILURE =
  'A font style in the theme document is set to a number, a boolean, a list or a mapping where a font file was expected, so none of the document is read.';

/**
 * The same refusal for the one shape of it that is a line the author has not finished.
 *
 * `nil` has no `start_with?` either, so `Brand:\n  normal:` raises exactly as `normal: 10` does and
 * the export throws the document away just as completely. Measured against the vendored gem under
 * ruby 3.3.3; the preview read the theme in full and said nothing, so a document the export prints at
 * 10.5 pt previewed at 20.
 *
 * A sentence of its own, on the rule the rest of this file's sentences are split by: what the author
 * has to do differs. There is nothing wrong with what is written — there is nothing written yet — and
 * a style with an empty value is the state a live preview is in for as long as it takes to type a
 * filename. Telling its author that a font file is "set to" the wrong kind of thing describes a
 * mistake they have not made, and sends them looking for one.
 *
 * The SEVERITY is deliberately not softened with it. A caller shows what the export would print, and
 * what the export prints for this document is the default page — the theme really is discarded, right
 * now, and a warning would say the page is fine when it is not. What is transient is the mistake, not
 * its effect, so this is the same whole-document error under a sentence that reads as unfinished
 * rather than as broken.
 *
 * Only an EMPTY value, not an empty string: `normal: ''` is a String, has `start_with?`, and loads —
 * measured, `font_catalog` comes back `{"Brand" => {"normal" => ""}}`. So the two are told apart here
 * exactly as Psych tells them apart, and a quoted empty path stays a document that reads.
 */
const FONT_STYLE_UNSET_FAILURE =
  'A font style in the theme document has no font file after it yet, and a theme is not read until every style it declares names one.';

/**
 * Fold one of THIS MODULE's own dotted descriptor keys into the flat space.
 *
 * `heading.h2.font-color` is how a descriptor and the theme editor spell a key; `heading_h2_font_color`
 * is how the cascade stores it. Both spellings are this module's vocabulary — a closed set it
 * generates from the gem — so lower-casing them is a normalisation of its own names and nothing to do
 * with what a document wrote.
 *
 * NOT for a key a document wrote. See {@link documentKeySegment}, which is the loader's own rule and a
 * different one.
 *
 * @param key - A dotted descriptor key.
 * @returns The flat form the cascade stores it under.
 */
export function flatThemeKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '_').replaceAll('.', '_');
}

/**
 * Fold one key SEGMENT the document wrote, exactly as the loader folds it.
 *
 * The rule is one expression — `key.tr '-', '_'` (`theme_loader.rb:132`) — and the two things it does
 * not do are the whole of this function's reason to exist.
 *
 * It does not DOWNCASE. `ThemeData` keys by `name.to_sym`, so `:base_FONT_SIZE` and `:base_font_size`
 * are two settings and the second is the one anything reads. Measured against the vendored gem under
 * ruby 3.3.3, `BASE:\n  FONT_SIZE: 30` loads as `BASE_FONT_SIZE => 30` while `base_font_size` keeps
 * the default theme's 10.5 — and the preview, folding the case, showed body text at 30 pt with no
 * diagnostic, for a page the export prints at 10.5.
 *
 * It does not fold `.` either. A document writing `out.er:\n  font_size: 9` loads in the gem as
 * `out.er_font_size`, an inert setting; folding the dot made it `out_er_font_size`, so a theme could
 * reach a setting through a spelling the export has no way to read. Same defect, same direction: the
 * preview being more capable than the document it is previewing.
 *
 * And it does not fold a hyphen at all under `role`. The loader's join is
 * `%(#{key}_#{key == 'role' || !(subkey.include? '-') ? subkey : (subkey.tr '-', '_')})`
 * (`theme_loader.rb:172`): a role NAME is the author's own word, not a category the loader renames,
 * so it keeps its hyphens while everything under it goes on folding normally. Measured against the
 * vendored gem under ruby 3.3.3, `role:\n  my-role:\n    font-color: FF0000` loads as
 * `role_my-role_font_color` and `role_my_role_font_color` is unset. The rule reaches ONE level: the
 * immediate children of a top-level `role`, and nothing deeper.
 *
 * @param key - A key segment exactly as the document wrote it.
 * @param underRole - Whether the enclosing key is exactly `role`, which is where hyphens survive.
 * @returns The segment the loader stores under.
 */
function documentKeySegment(key: string, underRole = false): string {
  // The prefix {@link installOrderedKeys} put on an index-like key, taken back off. Both the object
  // walk and the node walk pass through here, so this is the one place the two have to agree.
  const written = writtenKeyName(key);
  return underRole ? written : written.replaceAll('-', '_');
}

/**
 * The one enclosing key under which a document's own hyphens survive. See {@link documentKeySegment}.
 *
 * Tested against the key the loader STORES under rather than the one the document wrote, because that
 * is the key its join sees — though the two can only ever agree here, since no deprecated category is
 * renamed to `role`.
 */
const ROLE_KEY = 'role';

/**
 * Apply the loader's pre-parse substitution, which quotes SOME bare hexadecimal runs and unquotes
 * others.
 *
 * The rewrite is `m[:h] || (m[:k].end_with? 'color') ? "'#{m[:v]}'" : m[:v]`
 * (`theme_loader.rb:102`, where `||` binds tighter than the conditional): a matched value is quoted
 * when it carries a `#`, or when its KEY ends in the five letters `color` — and is emitted BARE
 * otherwise, even where the author wrote quotes around it. So `font_color: 999999` is the string
 * `999999` and `base_font_size: 105` is the number 105, while `#428BCA` keeps its digits and loses
 * its hash on any key at all.
 *
 * Quoting every hexadecimal-looking value instead, on every key, was the same rule for colours and
 * the wrong one for everything else: `font_size: 105`, `logo_image_width: 250` and
 * `border_width: 123456` all reached the preview as text the export reads as a measurement.
 *
 * The key suffix is tested exactly as `String#end_with?` tests it — case-sensitively, with no `_`
 * required before it and no British spelling — because that is the test the export makes.
 *
 * The document is split on every line break YAML recognises rather than on `\n` alone, because the
 * loader reads the file with `newline: :universal` (`theme_loader.rb:100`) and so never sees a `\r`
 * at all. Matching `\n` only left a carriage return sitting where the pattern expects the end of the
 * line, and a theme saved on Windows got no substitution whatsoever — `font_color: 000123` reached
 * the preview as the number 123 and the export as the string `000123`.
 *
 * One line at a time, one anchored match per line: linear in the document, which this runs on every
 * keystroke of a live preview.
 */
function quoteHexColours(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => {
      const match = HEX_COLOUR_ENTRY.exec(line);
      if (match?.groups === undefined) return line;
      const { key, hash, hex, comment } = match.groups;
      // A trailing comment the loader simply drops, since it re-emits the key and value alone. It is
      // kept here — with the space that keeps it a comment — because YAML discards it either way.
      const tail = comment === undefined ? '' : ` ${comment}`;
      const value = hash !== undefined || key.endsWith('color') ? `'${hex}'` : hex;
      return `${key}: ${value}${tail}`;
    })
    .join('\n');
}

/**
 * Whether a parsed YAML node is a plain mapping rather than a scalar or a sequence.
 *
 * A {@link ../print-appearance/units.RubyNumber} is an object and is NOT one: it is how a scalar whose
 * Ruby spelling JavaScript cannot write carries that spelling, and a walk that took it for a mapping
 * would flatten one `a: 1.0` into the two settings `a_value` and `a_spelling`. Held by the plain-scalar
 * tests, which read the whole entry list back.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof RubyNumber)
  );
}

/** Everything one `font.catalog` answers: the families it declares, or why the loader refuses it. */
interface FontCatalogue {
  /** The families read, in document order. Not to be used when {@link refusal} is set. */
  readonly families: ThemeFontFamily[];
  /** Why the loader refuses the whole document over this catalogue, or undefined when it reads it. */
  readonly refusal?: string;
}

/**
 * Read a theme's `font.catalog` into the family list, ignoring anything that is not a mapping, and
 * say when the loader would refuse the document over it instead.
 *
 * The two answers come from ONE walk because they come from one test: the value the loader calls
 * `start_with?` on is the value this reads a path out of, so "not a path" and "the export raised" are
 * the same branch seen from two sides. Splitting them into two functions meant two passes over a
 * subtree a document sizes, and left the reader's own type guard unreachable — it can only be reached
 * by a catalogue this refuses.
 *
 * The refusal is returned at the FIRST style the loader would raise on, in document order, which is
 * the one it raises on: the gem folds the catalogue's families in the order the document wrote them.
 *
 * @param catalogue - The `font.catalog` node, exactly as the document wrote it.
 * @returns The families, or the sentence saying the document is not read at all.
 */
function readFontCatalogue(catalogue: unknown): FontCatalogue {
  if (!isMapping(catalogue)) return { families: [] };
  const families: ThemeFontFamily[] = [];
  for (const [rawName, declared] of Object.entries(catalogue)) {
    // A family may be named `10`, and {@link installOrderedKeys} will have moved it out of the index
    // space to keep the catalogue in document order. The NAME is what a `font-family` key matches on,
    // so it is taken back as the document wrote it.
    const name = writtenKeyName(rawName);
    if (name === 'merge') continue;
    if (typeof declared === 'string') {
      families.push({
        name,
        styles: { normal: declared, bold: declared, italic: declared, bold_italic: declared },
      });
      continue;
    }
    if (!isMapping(declared)) continue;
    const styles: Record<string, string> = {};
    for (const [style, path] of Object.entries(declared)) {
      // The loader's very first act on a style's value is `path.start_with? 'GEM_FONTS_DIR'`, and
      // only a String has that — so this is not a path to skip, it is the whole document gone. See
      // {@link FONT_STYLE_VALUE_FAILURE} and {@link FONT_STYLE_UNSET_FAILURE}. It used to `continue`,
      // and the half-typed line an author is looking at while they type it previewed a theme the
      // export throws away, with nothing said.
      if (typeof path !== 'string') {
        return {
          families,
          refusal:
            path === null || path === undefined ? FONT_STYLE_UNSET_FAILURE : FONT_STYLE_VALUE_FAILURE,
        };
      }
      // `*` declares one file for every style, and `regular` is the renderer's alias for `normal`.
      // Every OTHER style name is stored exactly as the document wrote it — `subaccum[style] = path`
      // (`theme_loader.rb:151`) is the whole of the loader's rule, and it neither folds a hyphen nor
      // downcases. `register_fonts` then registers the face under `style.to_sym`
      // (`converter.rb:4158`), and prawn only ever asks for `:normal`, `:bold`, `:italic` and
      // `:bold_italic` — so a face declared as `bold-italic` or `Bold` is registered under a name
      // nothing looks up and inks nothing at all. Folding those spellings here made the PREVIEW set
      // text in a face the export leaves on the shelf, which is the preview being more capable than
      // the document it is previewing. Measured against the vendored gem under ruby 3.3.3:
      // `bold-italic` and `Bold` come back from `font_catalog` exactly as written.
      if (style === '*') {
        for (const each of ['normal', 'bold', 'italic', 'bold_italic']) styles[each] = path;
      } else {
        styles[style === 'regular' ? 'normal' : style] = path;
      }
    }
    families.push({ name, styles });
  }
  return { families };
}

/** What walking a document answers besides the entries it emits, filled in as the walk proceeds. */
interface FlattenNotes {
  /** Number of entries emitted before `font.catalog` was reached, or undefined when there is none. */
  at?: number;
  /**
   * Why the loader refuses the whole document over a key, or undefined when it names every one.
   *
   * The FIRST such key is the one reported, which is the one `process_entry` reaches first: it folds
   * a mapping's pairs in order, descending as it goes, and the walk below is the same order.
   */
  refusal?: string;
  /**
   * The families `font.catalog` declares, read where the walk meets it.
   *
   * Read HERE rather than afterwards because the same read answers whether the loader refuses the
   * document over the catalogue, and a refusal has to be found in the walk's own order to be reported
   * in it. See {@link readFontCatalogue}.
   */
  fontFamilies?: ThemeFontFamily[];
  /**
   * Strings the loader runs `expand_vars` over that nothing else here reads. See
   * {@link ParsedTheme.expandedOnlyStrings}.
   */
  expandedOnly?: ExpandedOnlyString[];
}

/**
 * The prefix of the keys whose value is ONE icon's own properties rather than a group of settings.
 *
 * `process_entry`'s admonition branch (`theme_loader.rb:161-166`) is reached by
 * `key.start_with? 'admonition_icon_'` on the name the loader has BUILT so far, so it is reached at
 * any depth the composition arrives at — not only from a top-level key — and it is reached BEFORE the
 * general `::Hash === val` branch, so it REPLACES the descent rather than qualifying it.
 *
 * What it then does is one level deep and no further: fold the hyphens of each immediate subkey, ask
 * whether that subkey ends in `_color`, and hand the value to `evaluate`, which returns a Hash
 * untouched. So below one level nothing is read at all — no hyphen is folded, no `$reference` is
 * expanded, and no key is inspected.
 *
 * Measured against the vendored gem under ruby 3.3.3, all four:
 *
 * - `admonition:\n  icon_tip:\n    a:\n      10: 5` loads `admonition_icon_tip => {a: {10 => 5}}`, so
 *   the branch is reached through the composed spelling — as it is through `admonition_icon:\n  tip:`
 *   and `admonition:\n  icon-tip:`, and even through `admonition:\n  icon:\n    _tip:`, which builds
 *   `admonition_icon__tip`. This module refused all five, so an author whose theme the export applies
 *   in full was shown the default page and an error.
 * - `admonition_icon_tip:\n  a:\n    my-key: 5` keeps `my-key`.
 * - `admonition_icon_tip:\n  a:\n    b: $base_font_size` keeps the reference as the eleven characters
 *   it is written from.
 * - `admonition_icon_tip:\n  stroke-color:\n    a: FF0000` reaches `to_color` on the Hash and stores
 *   the string `{"A"=>`, which prawn then paints with.
 */
const ADMONITION_ICON_PREFIX = 'admonition_icon_';

/**
 * The current spelling of a leaf setting the loader renames, or undefined when it renames none.
 *
 * `process_entry`'s deprecated-key branch (`theme_loader.rb:174-176`) is a table lookup with one
 * regular rule beside it, and it is SILENT: the export applies `sidebar: title: align` as though it
 * read `text-align`, so a resolver that keeps the written spelling shows a differently-aligned page
 * and has nothing to report about it.
 *
 * @param key - The flat key as the document spelled it.
 * @returns The key the loader would store it under, or undefined when the spelling is current.
 */
function deprecatedLeafKey(key: string): string | undefined {
  const renamed = Object.hasOwn(DEPRECATED_THEME_KEYS, key) ? DEPRECATED_THEME_KEYS[key] : undefined;
  if (renamed !== undefined) return renamed;
  // Role names are the author's own, so this half of the rename is a rule rather than a table. The
  // loader applies it to `role_…_text_align` as well, where it is a no-op on the key and still puts
  // the value down the deprecated branch — which is what decides whether arithmetic runs on it.
  if (key.startsWith('role_') && key.endsWith('_align')) {
    return key.replace(ROLE_ALIGN_SUFFIX, ROLE_ALIGN_REPLACEMENT);
  }
  return undefined;
}

/**
 * Walk a parsed theme document into flat entries, in document order.
 *
 * Two prefixes are carried rather than one because the loader RENAMES as it descends: a deprecated
 * category is stored under its current name (`theme_loader.rb:167-170`), so the key an entry is
 * emitted under stops matching the path the document wrote it at — and the line map is keyed by the
 * path the document wrote.
 *
 * A non-String key is refused HERE rather than where the document writes it, because this is where
 * the loader meets it: `process_entry` is handed the Hash `safe_load` built, so a key's position is
 * the position it MATERIALISES at, and a merge can carry a mapping written under `role` into a
 * parent that is not `role`. See {@link isNonStringKey} and {@link NON_STRING_KEY_FAILURE}.
 *
 * @param node - The mapping being walked.
 * @param sourcePrefix - The flat path as the document spells it, for attributing a line.
 * @param targetPrefix - The flat path the loader stores under, after any category rename.
 * @param out - Entries, appended in document order.
 * @param lines - Flat source path → the line it was written on.
 * @param notes - What the walk answers besides its entries.
 * @param mappings - Flat target paths written as a mapping, appended as they are met.
 */
function flatten(
  node: Record<string, unknown>,
  sourcePrefix: string,
  targetPrefix: string,
  out: ThemeEntry[],
  lines: ReadonlyMap<string, number>,
  notes: FlattenNotes,
  mappings: Set<string>,
): void {
  for (const [rawKey, value] of Object.entries(node)) {
    const segment = documentKeySegment(rawKey, targetPrefix === ROLE_KEY);
    const sourceKey = sourcePrefix === '' ? segment : `${sourcePrefix}_${segment}`;
    const key = targetPrefix === '' ? segment : `${targetPrefix}_${segment}`;
    // `role` is the one parent whose subkey the loader never asks `include?` of, and it is the only
    // exemption this walk needs. The other place the loader does not ask is below an admonition icon,
    // and this walk no longer goes there: {@link readAdmonitionIcon} stops one level down, exactly
    // where the loader's own reading stops.
    if (targetPrefix !== ROLE_KEY && isNonStringKey(rawKey)) {
      notes.refusal ??= NON_STRING_KEY_FAILURE;
    }
    if (OPAQUE_SUBTREES.has(key)) {
      if (key === 'font_catalog') {
        if (notes.at === undefined) notes.at = out.length;
        // The flat spelling reaches the same branch of `process_entry` the nested one does, so it
        // raises on the same paths — measured against the vendored gem under ruby 3.3.3,
        // `font_catalog:\n  Brand:\n    normal: 10` raises `NoMethodError` exactly as the nested
        // spelling does. `font-catalog` arrives here too, its hyphen already folded by
        // {@link documentKeySegment}.
        //
        // Only the REFUSAL is taken from it. The families a flat catalogue declares have never been
        // read, and reading them now would be a second change with its own semantics to settle —
        // which of the two spellings wins, and where the flat one sits in the catalogue's document
        // order. That is a divergence in its own right and is left as one, deliberately: it makes the
        // preview under-read a theme, where this makes it over-read one the export discards.
        const flat = readFontCatalogue(value);
        notes.refusal ??= flat.refusal;
        // …but a refusal the PATHS carry is still a refusal, and not reading the families is no
        // reason to miss it. `expand_vars` runs over every path a flat catalogue declares exactly as
        // it does over a nested one, so `font_catalog:\n  Brand:\n    normal: -$v` above a list-valued
        // `v` throws the document away — measured, and it was the one negation the cascade fix alone
        // still applied. Kept as bare strings because the refusal is all that is wanted from them:
        // promoting the families is the separate change above.
        for (const family of flat.families) {
          for (const path of Object.values(family.styles)) {
            (notes.expandedOnly ??= []).push({ text: path, index: out.length });
          }
        }
      }
      // `data[key] = ::Array === val ? val.map {|name| expand_vars name.to_s, data } : []`
      // (`theme_loader.rb:157`). The flat spelling of the fallback list is not read for its names
      // either — {@link ParsedTheme.fontFallbacks} takes only `font.fallbacks` — and it goes through
      // the same expansion, so the same value refuses the same document from here.
      if (key === 'font_fallbacks' && Array.isArray(value)) {
        if (notes.at === undefined) notes.at = out.length;
        for (const name of value) {
          if (typeof name === 'string') {
            (notes.expandedOnly ??= []).push({ text: name, index: out.length });
          }
        }
      }
      continue;
    }
    // `font` is not a category, it is a branch of its own. The loader reads `catalog` and `fallbacks`
    // out of it and DROPS every other subkey (`theme_loader.rb:133-136`), so `font: size: 30` sets
    // nothing in the export, and a `font` that is not a mapping at all sets nothing either — the
    // branch is guarded by `::Hash === val` with no fall-through to the general assignment. Measured
    // against the vendored gem under ruby 3.3.3: `font_size`, `font_weird` and `font` all come back
    // nil. Descended into anyway, since this is where the catalogue's POSITION in document order is
    // recorded, and it emits nothing on the way.
    //
    // Nothing the model claims begins with `font`, so what this changes today is only that
    // `$font_size` resolved in the preview and dangled in the export.
    if (key === 'font') {
      if (isMapping(value)) {
        // The split is where the loader expands font STRINGS, which is either subkey and not the
        // catalogue alone. A `font.fallbacks` with no catalogue beside it used to leave the split at
        // the end of the document, so its names were expanded against the FINISHED cascade — and a
        // name written above the definition it refers to then found it, where the loader leaves it
        // dangling. Measured: `font:\n  fallbacks: [-$v]\nv: true` loads in the gem, and resolving it
        // against the finished values refuses it.
        if (
          notes.at === undefined &&
          (Object.hasOwn(value, 'catalog') || Object.hasOwn(value, 'fallbacks'))
        ) {
          notes.at = out.length;
        }
        if (Object.hasOwn(value, 'catalog')) {
          const catalogue = readFontCatalogue(value['catalog']);
          notes.fontFamilies ??= catalogue.families;
          notes.refusal ??= catalogue.refusal;
        }
      }
      continue;
    }
    // Before the mapping branch, which is the order `process_entry` tests the two in — so an icon
    // written as a mapping is read as an icon and never descended into as a category.
    if (key.startsWith(ADMONITION_ICON_PREFIX)) {
      readAdmonitionIcon(key, sourceKey, value, out, lines, notes, mappings);
      continue;
    }
    if (isMapping(value)) {
      const category = Object.hasOwn(DEPRECATED_THEME_CATEGORIES, key)
        ? DEPRECATED_THEME_CATEGORIES[key]
        : key;
      mappings.add(category);
      flatten(value, sourceKey, category, out, lines, notes, mappings);
    } else {
      const line = lines.get(sourceKey);
      const renamed = deprecatedLeafKey(key);
      out.push({
        key: renamed ?? key,
        value,
        ...(renamed === undefined ? {} : { math: false }),
        ...(line === undefined ? {} : { line }),
      });
    }
  }
}

/**
 * A value with every {@link installTypedKeys} rename inside it taken back off.
 *
 * The mint is a name this module writes so that a materialised OBJECT can still tell a key the export
 * typed as an Integer from one it typed as text. It is undone wherever a key is read back —
 * {@link documentKeySegment} is the one place a key passes through — and until an admonition icon's
 * properties stopped being descended into, a key was the only place it could reach. It can now reach a
 * VALUE: the loader hands the mapping under an icon's property straight to `evaluate`, so that mapping
 * is a value the resolver stores, and `admonition:\n  icon_tip:\n    a:\n      10: 5` carried a
 * `\0n10` into it — a name from this module's own bookkeeping, in data the preview reads and prints.
 *
 * Returns the value itself where nothing was minted, so the common shape — an icon whose properties
 * are the scalars every real theme writes — allocates nothing. Recursion is bounded exactly as
 * {@link flatten}'s is, by the expansion budget: it caps depth, and it refuses the cyclic documents
 * that have no depth at all. This walk replaces the descent {@link flatten} used to make over the same
 * subtree, so it is not work the reading did not already do.
 *
 * @param value - A value as it materialised.
 * @returns The value the document wrote.
 */
function withWrittenKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item: unknown) => {
      const written = withWrittenKeys(item);
      if (written !== item) changed = true;
      return written;
    });
    return changed ? items : value;
  }
  if (!isMapping(value)) return value;
  let changed = false;
  const written: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    const name = writtenKeyName(key);
    const under = withWrittenKeys(held);
    if (name !== key || under !== held) changed = true;
    // `defineProperty` for the reason {@link writeMergedEntry} uses it: a key of `__proto__` is a
    // setter on `Object.prototype`, and an assignment to it would set nothing at all.
    Object.defineProperty(written, name, {
      value: under,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return changed ? written : value;
}

/**
 * Emit one property of one admonition icon, at the depth the loader stops reading.
 *
 * Not through {@link deprecatedLeafKey}, and that is the loader's own shape rather than an omission:
 * the admonition branch is reached BEFORE the branch that renames a deprecated key, so nothing under
 * an icon is ever renamed. No spelling the gem renames begins with {@link ADMONITION_ICON_PREFIX}
 * anyway, so today this only makes the reason legible.
 *
 * @param key - The icon's flat key, as the loader stores it.
 * @param sourceKey - The icon's flat path as the document spells it, for attributing a line.
 * @param segment - The property's name, already folded.
 * @param value - The property's value, exactly as written — `evaluate` is the resolver's job.
 * @param out - Entries, appended in document order.
 * @param lines - Flat source path → the line it was written on.
 */
function pushIconProperty(
  key: string,
  sourceKey: string,
  segment: string,
  value: unknown,
  out: ThemeEntry[],
  lines: ReadonlyMap<string, number>,
): void {
  const line = lines.get(`${sourceKey}_${segment}`);
  out.push({
    key: `${key}_${segment}`,
    value: withWrittenKeys(value),
    ...(line === undefined ? {} : { line }),
  });
}

/**
 * Read one admonition icon's own properties — one level, and no descent past it.
 *
 * The loader's reach is {@link ADMONITION_ICON_PREFIX}'s to describe; this is what that reach means in
 * a FLAT key space. An icon's properties become `admonition_icon_tip_size` and the rest, which is what
 * the model reads them by, and a property whose value is itself a mapping becomes ONE entry holding
 * that mapping rather than a subtree of settings the export has no way to name. Descending emitted
 * `admonition_icon_tip_stroke_color_a` for `stroke-color:\n  a: FF0000`, where the export sets
 * `stroke_color` — to nonsense, but it sets it, and the preview showed a key that does not exist
 * beside a default colour it says nothing about.
 *
 * The list form is the same branch: `val.each` over an Array yields each element as `key2` and, where
 * the element is itself a list, its second item as `val2`. Measured against the vendored gem under
 * ruby 3.3.3, `admonition_icon_tip: [a, b]` loads `{a: nil, b: nil}` and
 * `admonition_icon_tip:\n  - [stroke-color, FF0000]` loads `{stroke_color: "FF0000"}`, while an
 * element the loader cannot name a property with raises exactly as a key of that shape does:
 * `- [1, 2]` raises `undefined method 'include?' for an instance of Integer` and `- {a: 1}` raises
 * `undefined method 'to_sym' for an instance of Hash`.
 *
 * @param key - The icon's flat key, as the loader stores it.
 * @param sourceKey - The icon's flat path as the document spells it, for attributing a line.
 * @param value - Whatever the document wrote after the icon's key.
 * @param out - Entries, appended in document order.
 * @param lines - Flat source path → the line it was written on.
 * @param notes - What the walk answers besides its entries.
 * @param mappings - Flat target paths written as a group rather than as a value.
 */
function readAdmonitionIcon(
  key: string,
  sourceKey: string,
  value: unknown,
  out: ThemeEntry[],
  lines: ReadonlyMap<string, number>,
  notes: FlattenNotes,
  mappings: Set<string>,
): void {
  // `… end if val` guards the WHOLE branch (`theme_loader.rb:166`), so an icon written with nothing
  // after it, or with `false`, sets nothing and raises nothing. Measured: both load a theme with no
  // `admonition_icon_tip` in it at all, where this module set one to `null` and to `false`.
  if (value === null || value === undefined || value === false) return;
  if (isMapping(value)) {
    mappings.add(key);
    for (const [rawSub, sub] of Object.entries(value)) {
      // The one key under an icon the loader DOES inspect: `key2.include? '-'`, on the immediate
      // subkey and on nothing below it.
      if (isNonStringKey(rawSub)) notes.refusal ??= NON_STRING_KEY_FAILURE;
      pushIconProperty(key, sourceKey, documentKeySegment(rawSub), sub, out, lines);
    }
    return;
  }
  if (Array.isArray(value)) {
    mappings.add(key);
    for (const item of value) {
      const paired = Array.isArray(item);
      const name: unknown = paired ? item[0] : item;
      if (typeof name !== 'string') {
        // An element is a VALUE the loader turns into a name, so which sentence it earns is decided
        // by what it is rather than by how a key node was tagged — there is no key node here at all.
        notes.refusal ??=
          typeof name === 'object' && name !== null ? COLLECTION_KEY_FAILURE : NON_STRING_KEY_FAILURE;
        continue;
      }
      // `key2.tr '-', '_'` directly rather than through {@link documentKeySegment}, which also undoes
      // the rename {@link installTypedKeys} makes to a KEY. An element is not a key and never carries
      // one, so putting it through that would take a mint off a name the document wrote itself.
      pushIconProperty(key, sourceKey, name.replaceAll('-', '_'), paired ? (item[1] ?? null) : null, out, lines);
    }
    return;
  }
  notes.refusal ??= ADMONITION_ICON_VALUE_FAILURE;
}

/** Byte offsets at which each line of a document starts, for turning a node range into a line. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  let found = text.indexOf('\n');
  while (found !== -1) {
    starts.push(found + 1);
    found = text.indexOf('\n', found + 1);
  }
  return starts;
}

/** The 1-based line an offset falls on. */
function lineAt(offset: number, starts: readonly number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Record the line each flat key was written on, by walking the document's own syntax tree.
 *
 * The flattened JavaScript value has no positions, and a reported problem with no location cannot
 * offer to reveal itself in the editor. Walking the tree in parallel with the same key rules is what
 * keeps the two in step; guessing a line by searching the text for the leaf name would attribute a
 * rejection to whichever construct happened to mention `font-size` first.
 */
function collectLines(node: unknown, prefix: string, starts: readonly number[], out: Map<string, number>): void {
  if (!isMap(node)) return;
  for (const item of node.items) {
    if (!isPair(item) || !isScalar(item.key)) continue;
    const segment = documentKeySegment(String(item.key.value), prefix === ROLE_KEY);
    const key = prefix === '' ? segment : `${prefix}_${segment}`;
    const keyNode: Node = item.key;
    const start = keyNode.range?.[0];
    if (start !== undefined) out.set(key, lineAt(start, starts));
    if (!OPAQUE_SUBTREES.has(key)) collectLines(item.value, key, starts, out);
  }
}

/**
 * Whether a mapping's key is the merge key — the one key whose value is another mapping's ENTRIES
 * rather than a value of its own.
 *
 * The export's rule is one line: `key == '<<' && k.tag != "tag:yaml.org,2002:str"`
 * (`psych/visitors/to_ruby.rb:349`). The TAG is the whole test, so the QUOTING is not — measured
 * against the vendored reader, `"<<"`, `'<<'` and a folded `>-\n  <<` all merge, and only an explicit
 * `!!str '<<'` is an ordinary key spelled oddly.
 *
 * The parser draws a different line: it resolves a plain `<<` to a scalar holding `Symbol('<<')` and
 * leaves every quoted spelling an ordinary string, so its own merge test
 * (`schema/yaml-1.1/merge.isMergeKey`) requires `type === PLAIN`. Testing for the symbol alone
 * therefore reads `base:\n  font_size: 9\n  "<<": *common` as a literal key — 9 pt in the preview
 * against 17 pt in the export, plus a `base_<<_font_size` setting the export never has.
 *
 * @param key - A pair's key node.
 * @returns Whether it merges its value's entries into the mapping.
 */
function isMergeKey(key: unknown): boolean {
  if (!isScalar(key) || key.tag === STRING_TAG) return false;
  const { value } = key;
  if (typeof value === 'symbol') return value.description === MERGE_KEY;
  return value === MERGE_KEY;
}

/** The reader's conversion context, which the parser types but does not export. */
type MergeContext = Parameters<NonNullable<Node['addToJSMap']>>[0];

/** What a mapping is being materialised into: an object, or a `Map` when a merge source. */
type MergeTarget = Parameters<NonNullable<Node['addToJSMap']>>[1];

/**
 * An alias in a merge, or the failure of one, the way the export's reader orders the two.
 *
 * `revive_hash` materialises the merge's value BEFORE it decides what to do with it, so an alias that
 * names nothing raises `Psych::AnchorNotDefined` and nothing else about the merge is reached. The
 * parser's own merge instead lets an unresolved alias fall through to "merge sources must be maps",
 * which is a different sentence about a document whose problem is the anchor.
 *
 * Answered from the map this module already built rather than from `Alias.resolve`, which is the
 * same answer by construction — {@link installAliasResolution} hands that very map to the reader for
 * every other dereference — and which is why an alias missing from it is missing because it names no
 * anchor set before it.
 *
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param alias - The alias node.
 * @returns The node it names.
 * @throws {ReferenceError} When it names no anchor set before it, which is what the caller's
 *   boundary turns into {@link UNRESOLVED_ALIAS_FAILURE}. The sentence carries no document text: the
 *   parser's own for this case interpolates the anchor's name.
 */
function resolveMergeAlias(targets: ReadonlyMap<Alias, Node>, alias: Alias): Node {
  const target = targets.get(alias);
  if (target === undefined) throw new ReferenceError('Unresolved alias');
  return target;
}

/**
 * Write one entry into a mapping being materialised, replacing whatever is there.
 *
 * REPLACING is the whole of this module's difference from the parser's own merge, which skips a key
 * the mapping already has. Written with `defineProperty` for the same reason the parser writes its
 * own that way: a key of `__proto__` is a setter on `Object.prototype` and an assignment to it sets
 * nothing. An existing property keeps its position in the mapping, which is what `Hash#merge!` does
 * and what leaves the flattened order the document's own.
 *
 * @param map - The mapping being materialised.
 * @param key - The entry's key.
 * @param value - The entry's value.
 */
function writeMergedEntry(map: MergeTarget, key: unknown, value: unknown): void {
  // A `Map` when the mapping is itself a merge source being materialised, and an object otherwise.
  // The reader's third kind of target, a `Set`, is not among them: only `YAMLSet.toJSON` forces one,
  // and `!!set` belongs to the YAML 1.1 schema, which this module does not parse with — `merge: true`
  // adds the merge tag to the core schema and nothing besides.
  if (map instanceof Map) {
    map.set(key, value);
    return;
  }
  // `String` rather than the key itself, which is the conversion `defineProperty` would apply to it
  // anyway (`ToPropertyKey`, for everything but a symbol): a merge source is materialised into a
  // `Map`, whose keys are VALUES, so a theme that writes a list as a key has one here. Naming the
  // conversion is what makes this a check rather than an assertion about parsed theme input, and
  // there is no symbol to lose — the one the reader mints is the merge key, which never reaches a map.
  Object.defineProperty(map, String(key), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Keep `<<` as an ordinary key holding its value, which is what the export's rescue leaves behind.
 *
 * @param context - The reader's conversion context.
 * @param map - The mapping being materialised.
 * @param value - The merge key's value node, materialised here exactly as the merge would have
 *   materialised it, so no branch of {@link addPsychMergeToJSMap} reads the same node twice.
 */
function writeMergeLiteral(context: MergeContext, map: MergeTarget, value: unknown): void {
  writeMergedEntry(map, MERGE_KEY, isNode(value) ? value.toJSON(MERGE_KEY, context) : value);
}

/** Copy every entry of a materialised merge source into the mapping, replacing as it goes. */
function copyMergedEntries(context: MergeContext, map: MergeTarget, source: YAMLMap): void {
  // `Map` rather than an object, as the parser's own merge does: the reader's `Map` branch keys an
  // entry by the key's own value instead of re-serialising a collection key against every anchor the
  // document has set, and that is the property {@link MAX_STRINGIFIED_KEY_CHARGE} is measured against.
  for (const [key, value] of source.toJSON(null, context, Map)) writeMergedEntry(map, key, value);
}

/**
 * Apply one merge key the way the export's reader applies it.
 *
 * The two readers disagree about precedence, and the disagreement is a wrong VALUE in the preview
 * rather than a wrong sentence about one. `revive_hash` reaches `hash.merge!`
 * (`psych/visitors/to_ruby.rb:353`), so a merge REPLACES what the mapping already holds; the parser's
 * `mergeValue` writes only `if (!Object.prototype.hasOwnProperty.call(map, key))`, so the mapping
 * keeps it. Measured against the vendored gem, `base:\n  font_size: 9\n  <<: *common` with `*common`
 * at 17 exports at 17 pt and previewed at 9 pt. Everything downstream of the parse inherits that: a
 * theme written this way was shown a page it would not print.
 *
 * Stated as the export states it, both branches collapse into one rule — a mapping's pairs are
 * applied in document order, LAST write wins, and a merge is the writes its source would make. That
 * is why a later `<<` beats an earlier one, why an explicit key written after a merge still beats it,
 * and why the sequence form is the one place the order inverts: `revive_hash` folds the sequence into
 * a mapping back to front (`val.reverse_each`), so the earliest element of `<<: [*a, *b]` is the last
 * written and wins, which is what YAML 1.1's merge type specifies and the one case both readers
 * already agreed on.
 *
 * A merge value that is not a mapping is not a failure either. `Hash#merge!` raises `TypeError` on
 * one and the rescue keeps `<<` as an ordinary key holding the value (`to_ruby.rb:354-356`), so
 * `<<: 42` loads as a `<<` setting and the rest of the theme applies; the parser throws instead, and
 * this module turned that into a refusal of the whole document. The branch is on the merge value's
 * NODE, not on what it materialises to, which is why an alias naming a sequence of mappings is a
 * `TypeError` while the same sequence written out is a merge.
 *
 * Installed on the merge key's own node — see {@link installMergeSemantics} — because that is the one
 * hook the reader offers (`addPairToJSMap` calls `key.addToJSMap` before it tests for a merge at
 * all), and because the alternative, rewriting the document's pairs so that the parser's own rule
 * happens to come out right, would have to reorder a mapping the flattening then reads in order.
 *
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param context - The reader's conversion context.
 * @param map - The mapping being materialised.
 * @param value - The merge key's value node.
 */
function addPsychMergeToJSMap(
  targets: ReadonlyMap<Alias, Node>,
  context: MergeContext,
  map: MergeTarget,
  value: unknown,
): void {
  if (isAlias(value)) {
    const target = resolveMergeAlias(targets, value);
    // `hash[key] = val`, where `val` is the value the reader had already materialised — so the same
    // node, materialised once, whichever branch it lands in.
    if (isMap(target)) copyMergedEntries(context, map, target);
    else writeMergeLiteral(context, map, value);
    return;
  }
  if (isMap(value)) {
    copyMergedEntries(context, map, value);
    return;
  }
  if (isSeq(value)) {
    // Every alias is resolved before any element is judged, because the export materialises the whole
    // sequence first: a sequence holding both an unresolved alias and a number is the anchor's
    // failure, wherever in it the two sit.
    const sources: YAMLMap[] = [];
    let mergeable = true;
    for (let at = value.items.length - 1; at >= 0; at -= 1) {
      const item: unknown = value.items[at];
      const source = isAlias(item) ? resolveMergeAlias(targets, item) : item;
      if (isMap(source)) sources.push(source);
      else mergeable = false;
    }
    // `h.merge!` raises on the first element that is not a mapping, and `h` is a mapping of its own,
    // so a sequence with one bad element merges NOTHING rather than merging up to it.
    if (!mergeable) {
      writeMergeLiteral(context, map, value);
      return;
    }
    // Folded back to front into a mapping of its own and applied once, which is `h` — the earliest
    // element of the sequence is written last and so wins, and only then does the fold replace what
    // the mapping already holds.
    const folded = new Map<unknown, unknown>();
    for (const source of sources) {
      for (const [key, entry] of source.toJSON(null, context, Map)) folded.set(key, entry);
    }
    for (const [key, entry] of folded) writeMergedEntry(map, key, entry);
    return;
  }
  writeMergeLiteral(context, map, value);
}

/**
 * Give every merge key in a document the export's merge, so that reading it applies the export's rule.
 *
 * An own property on the node, which is how the parser itself marks a merge key: the merge tag's
 * `resolve` sets `addToJSMap` on the scalar it composes, and `addPairToJSMap` consults that property
 * before it applies any merge rule of its own. Overwriting it therefore replaces the rule for the
 * keys the parser found, and setting it on a QUOTED `<<` adds the keys the parser did not — its own
 * test requires a plain scalar, and the export's requires only that the key is not tagged `!!str`.
 *
 * @param mergeKeys - Every merge key node in the document, in the order it walks them.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param prefixes - The merge keys whose source ENCLOSES them, against the part of that source the
 *   export copies. See {@link ancestorMergePrefixes}.
 */
function installMergeSemantics(
  mergeKeys: readonly Node[],
  targets: ReadonlyMap<Alias, Node>,
  prefixes: ReadonlyMap<Node, Node>,
): void {
  // One closure for the whole document rather than one per merge: the reader calls this once per
  // merge key REACHED, which a chain of merges multiplies out.
  const merge: NonNullable<Node['addToJSMap']> = (context, map, value) =>
    addPsychMergeToJSMap(targets, context, map, value);
  for (const key of mergeKeys) {
    const prefix = prefixes.get(key);
    Object.defineProperty(key, 'addToJSMap', {
      configurable: true,
      writable: true,
      enumerable: true,
      // The source the export actually copies, in place of the one the document names — the merge
      // itself is unchanged, and reads the substitute exactly as it would have read the original.
      value:
        prefix === undefined
          ? merge
          : ((context, map) =>
              addPsychMergeToJSMap(targets, context, map, prefix)) satisfies NonNullable<
              Node['addToJSMap']
            >,
    });
  }
}

/**
 * The part of an enclosing merge source the export copies, for every merge that names one.
 *
 * The materialisation cannot be asked this question while it runs. `revive_hash` answers it with
 * object identity — the anchor is registered against its Hash before that Hash is filled, so an
 * inner `<<` copies whatever is in it at that moment — and the reader here has no such handle: a
 * mapping node's `toJSON` builds a fresh object on every call, which is why merging an enclosing
 * anchor recursed until the stack ran out. See {@link mergeSourceCost} for the export's own
 * behaviour and the measurements it is taken from.
 *
 * Answered STATICALLY instead, which the export's own rule makes exact rather than approximate. The
 * entries in the part-built Hash at the moment a merge is reached are the pairs written above the
 * enclosing mapping's pair that the merge sits under, and every one of them is already complete —
 * the reader finishes each pair's value before it starts the next. So the copy is a mapping of those
 * pairs, and substituting one for the alias makes the ordinary merge produce the export's entries.
 * Sharing the pair nodes rather than copying them is what keeps that true of pairs which are
 * themselves merges: the substitute re-applies them, prefix and all.
 *
 * Terminating, and not by a depth cap. Every substitution replaces a merge at some position with
 * pairs written strictly EARLIER in the document, so following one can only move backwards through a
 * finite text — the walk cannot come back round to where it started.
 *
 * Run only for a document that writes a merge key at all, so the ordinary theme pays nothing for it.
 *
 * @param contents - The document's root node.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @returns Merge key node → the mapping, or the sequence of mappings, to merge in its place.
 */
function ancestorMergePrefixes(
  contents: Node,
  targets: ReadonlyMap<Alias, Node>,
): ReadonlyMap<Node, Node> {
  const prefixes = new Map<Node, Node>();
  collectAncestorMerges(contents, targets, new Map(), prefixes);
  return prefixes;
}

/**
 * The mapping a merge source stands for when it encloses the merge, or undefined when it does not.
 *
 * @param value - The merge key's value node, or one element of a sequence of sources.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param onPath - Each mapping between here and the root, against the pairs written above the one
 *   the walk descended through — which is what the export has copied into its Hash by now.
 * @returns The substitute node, or undefined when the source is not an enclosing mapping.
 */
function ancestorMergeSource(
  value: unknown,
  targets: ReadonlyMap<Alias, Node>,
  onPath: ReadonlyMap<unknown, readonly Pair[]>,
): Node | undefined {
  // One hop, the hop {@link addPsychMergeToJSMap} takes, so that the substitution is made for
  // exactly the sources the merge would otherwise have read.
  const named = isAlias(value) ? targets.get(value) : value;
  if (isMap(named)) {
    const prefix = onPath.get(named);
    if (prefix === undefined) return undefined;
    const copy = new YAMLMap();
    // A snapshot: the walk goes on appending to the array behind this as it advances, and what a
    // merge copies is the prefix as it stood where the merge was written.
    copy.items = [...prefix];
    return copy;
  }
  // A sequence of sources is substituted element by element, so `<<: [*outer, *palette]` keeps its
  // fold — and its precedence, which the fold's direction decides.
  //
  // Substituted even where the fold never happens. One element that is not a mapping makes
  // `h.merge!` raise and the rescue keeps `<<` as an ordinary key holding the whole sequence
  // (`to_ruby.rb:354-356`), and what the export then holds, when another element is the mapping that
  // ENCLOSES the merge, is a list containing itself: measured against the vendored gem under ruby
  // 3.3.3, `a: &a\n  k: 1\n  y:\n    <<: [*a, 5]` loads and stores `a_y_<<` as that cyclic list.
  // The substitute makes it the prefix instead — `[{k: 1}, 5]` — which is a divergence in a `<<`
  // setting no theme reads, against refusing a document the export prints in full. It is also the
  // only structure this side can hold: nothing below here is written for a value that contains
  // itself.
  if (!isSeq(value)) return undefined;
  let substituted = false;
  const items: unknown[] = value.items.map((item: unknown) => {
    const source = ancestorMergeSource(item, targets, onPath);
    if (source === undefined) return item;
    substituted = true;
    return source;
  });
  if (!substituted) return undefined;
  const copy = new YAMLSeq();
  copy.items = items;
  return copy;
}

/**
 * Walk a document collecting {@link ancestorMergePrefixes}' answer.
 *
 * @param node - The node being walked.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param onPath - Each enclosing mapping against the pairs written above this point in it, appended
 *   to as the walk advances so that a merge sees the prefix its own position has.
 * @param out - Merge key node → its substitute, appended as they are found.
 */
function collectAncestorMerges(
  node: unknown,
  targets: ReadonlyMap<Alias, Node>,
  onPath: Map<unknown, Pair[]>,
  out: Map<Node, Node>,
): void {
  if (isSeq(node)) {
    for (const item of node.items) collectAncestorMerges(item, targets, onPath, out);
    return;
  }
  if (!isMap(node)) return;
  const prefix: Pair[] = [];
  onPath.set(node, prefix);
  // Every item of a mapping is a pair — the parser composes nothing else into one — so the walk is
  // over the pairs and the prefix is the pairs, with no shape to skip.
  for (const item of node.items) {
    if (isMergeKey(item.key)) {
      const source = ancestorMergeSource(item.value, targets, onPath);
      if (source !== undefined && isNode(item.key)) out.set(item.key, source);
      // The merge's own value is walked too: a merge source written out in place can hold merges of
      // its own, and those are read from where they are WRITTEN.
      collectAncestorMerges(item.value, targets, onPath, out);
    } else {
      collectAncestorMerges(item.key, targets, onPath, out);
      collectAncestorMerges(item.value, targets, onPath, out);
    }
    // After the pair, never before it: what the export has copied by the time a merge inside a pair
    // is reached is the pairs above that pair, and the pair itself is not among them.
    prefix.push(item);
  }
  onPath.delete(node);
}

/** What one ordered walk of a document answers about its anchors and aliases. */
interface DocumentAnchors {
  /** Each alias node mapped to the node it names, omitting any that names nothing. */
  readonly targets: ReadonlyMap<Alias, Node>;
  /**
   * How many nodes carry an anchor.
   *
   * Nodes rather than NAMES: the reader's conversion context is keyed by node, so a name set twice is
   * two entries in the list every stringified key is re-serialised against, and it is the length of
   * that list which is the cost — see {@link MAX_STRINGIFIED_KEY_CHARGE}.
   */
  readonly count: number;
  /**
   * Every merge key the document writes, in the order the walk reaches them.
   *
   * Gathered here rather than in a walk of its own because this walk already reaches every node, and
   * a second one over a document the budget has not yet passed is work spent on a bomb.
   */
  readonly mergeKeys: readonly Node[];
  /**
   * Every scalar key the document writes, other than a merge key.
   *
   * Both key passes read this one list — {@link installPsychKeys} gives each key the type the
   * export's reader gives it, and {@link installTypedKeys} then mints a name for the ones the
   * materialisation would otherwise lose. Gathered in the same walk for the same reason the merge
   * keys are.
   */
  readonly keys: readonly Scalar[];
  /**
   * Every ALIAS the document writes in key position.
   *
   * A second list because an alias is not a key node the two passes above can rename: what it names
   * is a value written somewhere else, whose own spelling has to stay what the document wrote it as.
   * See {@link installTypedAliasKeys}, which is where the mint reaches this road into the key space.
   */
  readonly aliasKeys: readonly Alias[];
  /**
   * Every plain, untagged scalar in VALUE position — the ones the export types for itself.
   *
   * See {@link psychScalar} and {@link installPsychScalars}. Gathered in the same walk for the same
   * reason the merge keys are.
   */
  readonly plainValues: readonly Scalar[];
}

/**
 * What every alias in a document resolves to, in one pass over it.
 *
 * `Alias.resolve` answers this one alias at a time and visits the WHOLE document to do it, so asking
 * it per alias is quadratic — on the render thread, for a question asked before anything is read.
 * The rule it applies is "the last node anchored under this name before this alias", and one ordered
 * walk carrying the latest definition of each name answers it for every alias at once.
 *
 * The rule below is that rule, deliberately spelled the parser's way rather than a way that means the
 * same thing on the documents anyone writes. It decides what an alias RESOLVES to and not merely what
 * one would cost — see {@link installAliasResolution} — so a difference of interpretation is a wrong
 * VALUE in the theme, not a mis-priced one. An anchor is a non-empty name on a scalar or a collection
 * (`nodes/identity.hasAnchor`), aliases carry none of their own, and the walk order is the parser's
 * because it is the parser's own `visit`.
 *
 * @param contents - The document's root node.
 * @returns What each alias names, and how many anchors the document sets.
 */
function aliasTargets(contents: Node): DocumentAnchors {
  const latest = new Map<string, Node>();
  const targets = new Map<Alias, Node>();
  const mergeKeys: Node[] = [];
  const keys: Scalar[] = [];
  const aliasKeys: Alias[] = [];
  const plainValues: Scalar[] = [];
  let count = 0;
  visit(contents, {
    Node: (key, node) => {
      if (isAlias(node)) {
        const found = latest.get(node.source);
        if (found !== undefined) targets.set(node, found);
      } else if (typeof node.anchor === 'string' && node.anchor !== '') {
        latest.set(node.anchor, node);
        count += 1;
      }
      // `'key'` is what the parser's own walk calls a pair's key position, and a merge key is only a
      // merge key there — `<<` written as a VALUE is the two characters it looks like.
      if (key !== 'key') {
        if (isScalar(node) && node.type === PLAIN_SCALAR && node.tag === undefined) plainValues.push(node);
        return;
      }
      if (isMergeKey(node)) mergeKeys.push(node);
      else if (isScalar(node)) keys.push(node);
      else if (isAlias(node)) aliasKeys.push(node);
    },
  });
  return { targets, count, mergeKeys, keys, aliasKeys, plainValues };
}

/**
 * The scalar style the export types for itself. See {@link psychScalar}.
 *
 * Spelled as the literal the parser tags a node with rather than as `Scalar.PLAIN`, so that reading
 * a node's style costs no runtime import of the parser's class.
 */
const PLAIN_SCALAR = 'PLAIN';

/**
 * Give every plain value the type the export's reader gives it, and say when it refuses one.
 *
 * The two readers disagree about what a plain scalar IS, and the disagreement is a wrong value in the
 * preview rather than a wrong sentence about one. The parser resolves the YAML 1.2 core schema and
 * Psych resolves YAML 1.1 with extensions of its own, so `1e9` is a number here and the three
 * characters it spells there, `010` is ten here and eight there, `1_000` is text here and a thousand
 * there, `yes` is text here and true there, and `1:30` is text here and 5,400 there. Every one of
 * those reaches the page: `page: size: [1e9, 1e9]` laid out a page a billion points square in the
 * preview while the export printed MediaBox `595.28 841.89`, because the converter's own measurement
 * pattern rejects the STRING `1e9` and falls back to A4 — measured, from a converted PDF.
 *
 * Done by re-typing the parsed nodes rather than by parsing under the `yaml-1.1` schema, which was
 * the obvious move and is the wrong one. That schema does not fix the case above at all — it reads
 * `1e9` as a number exactly as the core schema does, since the mandatory dot and signed exponent are
 * Psych's rule and not YAML 1.1's — while introducing divergences the core schema does not have:
 * `y` and `n` become booleans where Psych keeps two letters, `1000_` becomes a thousand where Psych
 * keeps text, `e9` becomes `NaN`, `1:30` becomes the 90 the spec says rather than the 5,400 the
 * export lays out, and a date becomes a `Date` where the export refuses the document. It also types
 * KEYS, which would move settings to names the export cannot reach, and brings the 1.1 tag set with
 * it — `!!set`, `!!binary`, `!!omap` — each of which materialises to a shape nothing downstream of
 * here has ever been handed.
 *
 * Applied BEFORE the expansion budget is drawn, so the budget counts the values the reader will
 * actually see rather than the ones it would have seen. Safe there, unlike the merge semantics and
 * the alias resolution beside it, because re-typing a scalar cannot make a document denote more than
 * it did: the pass is one loop over scalars the parser has already composed, so it is linear in what
 * the document WRITES and not in what it expands to.
 *
 * KEYS go through {@link installPsychKeys}, which is the same typing over the same scanner and
 * differs only in what it does with the answer.
 *
 * @param values - Every plain, untagged scalar in value position. See {@link aliasTargets}.
 * @returns Why the export's `safe_load` refuses the document, or undefined when it reads it.
 */
function installPsychScalars(values: readonly Scalar[]): ScalarRefusal | undefined {
  let refusal: ScalarRefusal | undefined;
  for (const scalar of values) {
    // `source` is the text the document wrote, folded as the parser folds a plain scalar across
    // lines — which is the same text Psych's own reader is handed, since libyaml folds it too. The
    // fall-back covers a node with no recorded source, whose value is already its own text.
    const written = scalar.source ?? String(scalar.value);
    const typed = psychScalar(written);
    // The loop runs on rather than returning, because every OTHER scalar still has to be given the
    // type the export gives it: a refusal is the caller's to act on, and this is the one pass that
    // types the document. The FIRST refusal is the one reported, which is the one the export's reader
    // would have raised on first.
    if (typed === DISALLOWED_CLASS) {
      refusal ??= refusedAt(scalar, DISALLOWED_CLASS_FAILURE);
      continue;
    }
    if (typed === UNREADABLE_NUMBER) {
      refusal ??= refusedAt(scalar, UNREADABLE_NUMBER_FAILURE);
      continue;
    }
    scalar.value = typed;
  }
  return refusal;
}

/** A refusal the export's reader raises, and where in the document it raises it. */
interface ScalarRefusal {
  /** One of this module's own sentences, carrying none of the document's text. */
  readonly message: string;
  /** The offset of the scalar it was raised over, for ordering it against the other pass's. */
  readonly at: number;
}

/**
 * Pair a sentence with the offset of the scalar it is about.
 *
 * @param scalar - The scalar the export's reader raises over.
 * @param message - This module's sentence for that raise.
 * @returns The refusal.
 */
function refusedAt(scalar: Scalar, message: string): ScalarRefusal {
  return { message, at: scalar.range?.[0] ?? 0 };
}

/**
 * The earlier of two refusals, which is the one the export's reader reaches first.
 *
 * `revive_hash` accepts a pair's KEY and then its value, mapping by mapping in document order, so
 * the raise an author is shown is the one written EARLIEST — and the two passes each answer for half
 * of the document, so neither can order itself against the other.
 *
 * @param first - One pass's refusal, if it had one.
 * @param second - The other pass's refusal, if it had one.
 * @returns Whichever is written earlier, or undefined when there is neither.
 */
function firstRefusal(
  first: ScalarRefusal | undefined,
  second: ScalarRefusal | undefined,
): ScalarRefusal | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first.at <= second.at ? first : second;
}

/**
 * Give every plain KEY the type the export's reader gives it, and say when it refuses one.
 *
 * `revive_hash` calls `accept` on a pair's key exactly as it does on its value
 * (`psych/visitors/to_ruby.rb:344-381`), so the same `ScalarScanner` runs over both and the same two
 * refusals reach the export from either position — see {@link DISALLOWED_CLASS_KEY_FAILURE}.
 *
 * Typing a key is not only how those two are found; it is also what decides the key's NAME and
 * whether the loader can name a setting with it at all. `1e9:` is the three characters it spells to
 * Psych and a billion to the parser, so leaving the key to the parser stored the setting as
 * `1000000000_font_size` where the export stores `1e9_font_size` — a name a `$reference` and a
 * descriptor look a setting up by. And `yes:` is the word to the parser and a true to Psych, which is
 * a key the loader raises on rather than a key at all. The comment this replaces argued there was no
 * key spelling to agree with; there is, and it is the one the export's reader produces.
 *
 * The value is assigned rather than merely inspected because {@link installTypedKeys} reads it back:
 * a key is non-String exactly when the type this pass gave it is not a string, so the mint below has
 * one question to ask and no second copy of this table to keep in step.
 *
 * @param keys - Every scalar key in the document, other than a merge key. See {@link aliasTargets}.
 * @returns Why the export's `safe_load` refuses the document, or undefined when it reads it.
 */
function installPsychKeys(keys: readonly Scalar[]): ScalarRefusal | undefined {
  let refusal: ScalarRefusal | undefined;
  for (const key of keys) {
    // `deserialize` hands back a quoted scalar's text unread and dispatches on the tag where there is
    // one (`psych/visitors/to_ruby.rb:63-64`), so `"10":` and `!!str yes:` are the text they spell in
    // both readers and only a plain, untagged key is the scanner's to type.
    if (key.type !== PLAIN_SCALAR || key.tag !== undefined) continue;
    const typed = psychScalar(key.source ?? String(key.value));
    if (typed === DISALLOWED_CLASS) {
      refusal ??= refusedAt(key, DISALLOWED_CLASS_KEY_FAILURE);
      continue;
    }
    if (typed === UNREADABLE_NUMBER) {
      refusal ??= refusedAt(key, UNREADABLE_NUMBER_KEY_FAILURE);
      continue;
    }
    key.value = typed;
  }
  return refusal;
}

/**
 * Whether a key's text is one a JavaScript object would enumerate ahead of everything else.
 *
 * @param value - A scalar key's value.
 * @returns Whether materialising it would move it to the front of its mapping.
 */
function isIndexLikeKey(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return INDEX_LIKE_KEY.test(text) && Number(text) <= MAX_ARRAY_INDEX;
}

/**
 * Give every key a name that survives materialisation, and one that says how the reader typed it.
 *
 * Order is not a detail here — it is the invariant this file's header calls load-bearing. The
 * renderer expands `$references` against what it has already loaded, so a key can only refer
 * BACKWARDS, and a preview that resolved forward references would be more capable than the document
 * it is previewing. Materialising into a JavaScript object broke exactly that, because an own
 * property whose name is an array index is enumerated first whatever order it was inserted in.
 *
 * The measured case was a document ending `"10": 20` above a `base.font_size` of `$10`. Its entries
 * came back as `["10", "base_font_size"]`, so `$10` resolved to 20 and the preview showed body text
 * at 20 pt. The vendored gem under ruby 3.3.3 loads `base` first, leaves `base_font_size` as the
 * literal `"$10"`, warns about an unknown variable reference, and prints at the default 10.5.
 *
 * Done by renaming the KEY NODE rather than by taking over its materialisation, which is what makes it
 * safe: every road into the object — a direct pair, a merge source materialised into a `Map`, the
 * `Map` branch of `writeMergedEntry` — reads the same node, so all of them agree without any of them
 * being reimplemented. The prefix is taken back off in {@link documentKeySegment}. That is the one
 * place both the object walk and the node walk pass through, so the two stay in step.
 *
 * Two index-like keys that differ only in QUOTING are kept APART, which is what the type tag in
 * {@link INDEX_KEY_PREFIX} is for. An unquoted numeric key does not survive the export in most
 * positions — `key.tr` and `subkey.include?` are called on it and `Integer` has neither, so
 * `process_entry` raises `NoMethodError` and the whole theme fails to load, measured at the top level
 * and under a non-`role` parent — but `role` is the exception, and it is an exception in the join
 * itself: `key == 'role' || !(subkey.include? '-')` (`theme_loader.rb:172`) SHORT-CIRCUITS, so
 * `include?` is never called on a role's subkey and an Integer one raises nothing at all. Measured
 * against the vendored gem under ruby 3.3.3, `role: {10: {font_size: 5}, "10": {font_color:
 * '333333'}}` loads BOTH settings. Collapsing the two spellings dropped `role_10_font_size` outright.
 *
 * That same tag is what carries the key's TYPE past the materialisation, which is the second thing
 * this mint is for. A JavaScript object's keys are strings whatever the document typed them as, so a
 * key that raises out of `process_entry` is indistinguishable from a key spelled the same way in
 * quotes by the time {@link flatten} meets it — and {@link flatten} is where the position that
 * decides it is known. So every non-String key is minted, not only the index-like ones: `1.5`,
 * `true`, `yes`, `~` and `010` each get the `n` tag and the name `String(value)`, which is the name
 * the loader would interpolate. A nil is the one place `String` and Ruby's `to_s` part company —
 * `nil.to_s` is empty and `String(null)` is `null` — and the reader already keys a null by the empty
 * name, so the mint writes the empty one and `role:\n  ~:\n    font_size: 5` goes on loading as
 * `role__font_size`, exactly as the gem loads it.
 *
 * A key in a mapping that is not a settings mapping — one inside a sequence, or one materialised as
 * part of a collection USED as a key — is minted too, and its name is carried into the value rather
 * than stripped, since {@link writtenKeyName} only runs where a flat key is built. `page:\n  margin:
 * [{10: 1}]` therefore holds a NUL-tagged key inside its value. Left as it is: that value is a
 * mapping where both readers expect a measurement, so it is inert in both, and narrowing the mint to
 * the mappings {@link flatten} descends into would mean answering, before the materialisation, a
 * question the merge makes unanswerable there.
 *
 * Installed after the expansion budget has passed, like the alias resolution beside it, so a document
 * that is refused is never walked twice. The budget's own count runs before the rename and is charged
 * the un-prefixed length, which leaves it an upper bound by two characters short for a minted key and
 * by one for an escaped one — see {@link keySegmentCost}, which is charged per node beneath the key
 * and so is unaffected in kind by either.
 *
 * @param keys - Every scalar key in the document, already typed by {@link installPsychKeys}.
 */
function installTypedKeys(keys: readonly Scalar[]): void {
  for (const key of keys) {
    const minted = typedKeyName(key.value);
    if (minted !== undefined) key.value = minted;
  }
}

/**
 * The name a key materialises under once the mint has had it, or undefined where it keeps its own.
 *
 * @param value - What the export's reader typed the key as.
 * @returns The minted or escaped name, or undefined when the written one already is the name.
 */
function typedKeyName(value: unknown): string | undefined {
  const nonString = typeof value !== 'string';
  const written = value === null || value === undefined ? '' : String(value);
  // A text key keeps the name it was written under unless the object would enumerate it as an
  // index; a non-String key is minted whatever it is called, because the tag is the only record
  // that the reader typed it as something `process_entry` cannot name a setting with.
  if (!nonString && !isIndexLikeKey(written)) {
    // Unless the name the document wrote is already IN the mint's space, in which case it is
    // escaped out of it. Neither branch above can produce a name that begins with the prefix — a
    // number's spelling does not, and an index-like name is digits — so the mint and the escape
    // cannot collide, and no key a document writes reads back as one this module minted. See
    // {@link MINTED_INDEX_KEY_LENGTH} for what that closes in both directions.
    return written.startsWith(INDEX_KEY_PREFIX) ? INDEX_KEY_PREFIX + written : undefined;
  }
  return INDEX_KEY_PREFIX + (nonString ? NUMBER_KEY_TAG : STRING_KEY_TAG) + written;
}

/**
 * Mint the ALIAS keys too, which is the one road into the key space the rename does not sit on.
 *
 * `? *big` names its key from somewhere else, and the reader keys the object by
 * `String(jsKey)` — the anchored scalar's own value, untouched by {@link installTypedKeys}, which
 * renames key NODES and an alias is not one. So both halves of what the mint is for came apart on
 * this road, in opposite directions, and both are measured against the vendored gem under ruby
 * 3.3.3:
 *
 * `big: &big 10` over `base:\n  ? *big\n  : 5` hands `process_entry` an Integer and raises
 * `NoMethodError`, exactly as `base:\n  10: 5` does — and the preview read a setting `base_10` and
 * showed a page for a theme the export throws away. And `big: &big "\0n10"` hands it the String
 * `"\x00n10"`, which loads as the inert `base_\x00n10` — where the preview read the mint's own
 * spelling, stripped it, and refused the whole document over a key the author wrote as text.
 *
 * Written on the alias rather than on the scalar it names, because that scalar is a VALUE somewhere
 * too and its own spelling is the document's. `toJSON` is where the reader asks, and answering it
 * for the aliases in key position leaves every other dereference of the same anchor alone.
 *
 * Only for an alias naming a SCALAR. One naming a collection is stringified by a road of its own —
 * `stringifyKey` re-serialises it rather than calling `String` — and that road is what
 * {@link isStringifiedKey} prices and {@link COLLECTION_KEY_FAILURE} answers for.
 *
 * @param aliasKeys - Every alias the document writes in key position.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 */
function installTypedAliasKeys(
  aliasKeys: readonly Alias[],
  targets: ReadonlyMap<Alias, Node>,
): void {
  for (const alias of aliasKeys) {
    const target = targets.get(alias);
    if (!isScalar(target)) continue;
    const minted = typedKeyName(target.value);
    if (minted === undefined) continue;
    Object.defineProperty(alias, 'toJSON', { configurable: true, value: () => minted });
  }
}

/**
 * Give every alias the node it names, so that reading the document never searches for one.
 *
 * `Alias.toJSON` calls `Alias.resolve` on EVERY dereference, and `resolve` answers by scanning a list
 * of the document's alias and anchor nodes from the start (`nodes/Alias.js:24-46`, yaml 2.9.0). The
 * LIST is cached on the conversion context; the scan through it is not, and it runs to the alias's own
 * position. Reading is therefore quadratic in the number of aliases a document WRITES — a dimension
 * neither half of {@link ExpansionCost} measures, and cannot: an alias to a one-node scalar denotes
 * one node and no key text, which is the truth about what it materialises. Sixty thousand of them fit
 * in 180 KB of flow sequence and took 20 seconds; forty-five thousand written as `k: *t` lines took
 * 11.3, in the render-phase `useMemo` that reads the theme, per keystroke.
 *
 * Charging the written alias count as a third dimension would bound that, and would have to refuse
 * those 180 KB — but the palette idiom is written from the same three bytes an alias costs, so the
 * bound that stops the flow sequence is a bound that lands on the theme that names one anchored colour
 * from every role. Removing the quadratic is available instead: this module has already worked the
 * answer out for every alias at once, in one ordered pass, and handing it over turns each dereference
 * into a map lookup. The two dimensions the budget does measure then cover what is left — a
 * dereference costs the materialisation it is already charged for, and nothing besides. The two
 * documents above now read in 0.20 and 0.46 seconds, and the 480 KB theme that names one anchored
 * colour from 5,600 roles falls from 1.78 seconds to 0.23 — a seventh over what the same theme costs
 * with every colour written out, which is what says the idiom is no longer paying for itself.
 *
 * An alias the map has no entry for keeps the parser's own resolution, so an alias naming an anchor
 * that is not set before it still fails as it did, and one such alias costs one scan.
 *
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 */
function installAliasResolution(targets: ReadonlyMap<Alias, Node>): void {
  for (const [alias, target] of targets) {
    // An own, non-enumerable property: the prototype's scan stays reachable for any alias not in the
    // map, and nothing that walks a node's own keys sees a shape it did not before.
    Object.defineProperty(alias, 'resolve', { configurable: true, value: () => target });
  }
}

/**
 * What reading a node would cost, in the two resources a theme document can be written to exhaust.
 *
 * Three numbers rather than one because none is a function of the others. Materialising costs one unit
 * per node; FLATTENING costs the length of the flat key naming each node, which grows with how deeply
 * it sits; and NAMING a key the reader cannot key an object by costs a re-serialisation against every
 * anchor the document has set. Each of the three has been the one a document was small in while being
 * enormous in another — the key-text shape cost 1.4 seconds a keystroke with the node count at a fifth
 * of its budget, and the stringified-key shape 14.6 seconds with the node count at a third of its and
 * the key text at a tenth of its.
 */
interface ExpansionCost {
  /** How many nodes materialising the subtree produces. */
  readonly nodes: number;
  /**
   * How many characters of flat key {@link flatten} would build for it, relative to this node.
   *
   * Relative, so it is a property of the subtree rather than of where the subtree sits — which is
   * what lets it be memoised across the many places an anchored subtree is named. The path ABOVE a
   * node is charged by whoever holds it, one key segment at a time.
   */
  readonly keyChars: number;
  /**
   * How many keys the reader would have to re-serialise to name, in the subtree.
   *
   * Counted rather than priced, because what one costs is a property of the DOCUMENT — the length of
   * its anchor list — and not of the subtree. The two are multiplied once, where the budget is drawn.
   */
  readonly stringifiedKeys: number;
}

/** A leaf: one node, and no key of its own — the key naming it belongs to the mapping that holds it. */
const ONE_LEAF: ExpansionCost = { nodes: 1, keyChars: 0, stringifiedKeys: 0 };

/**
 * How many characters a mapping key adds to the flat key of everything beneath it.
 *
 * `flatten` joins segments with `_`, so a segment costs its own length plus the separator.
 *
 * A key that is not a plain scalar is not a short key, and `addPairToJSMap.stringifyKey` decides how
 * long it is in two branches that this has to price separately.
 *
 * A key that MATERIALISES TO AN OBJECT cannot key a JavaScript object, so the reader re-serialises it
 * — a collection to its own text in flow style, and an alias naming a collection to `*name`. That text
 * is what every flat key beneath it then carries. Charged a nominal two, a 40 KB sequence written as
 * one explicit key over a merged mapping of twenty thousand settings was read as 40,000 settings with
 * keys of 60,012 characters, 1.2 billion characters in all, from 253 KB of document; resolving it did
 * not finish in two minutes. The written span bounds the re-serialisation, and doubling it covers the
 * punctuation flow style adds to a collection the document wrote in block form.
 *
 * Anything ELSE takes `stringifyKey`'s first branch, `typeof jsKey !== 'object' → String(jsKey)`, and
 * that branch is the one the written span does not bound. An alias naming an anchored SCALAR is keyed
 * by the whole of that scalar's text while the alias itself is written from four bytes, so charging
 * the written span for one charged `2 × len("*big") + 2 = 10` for a segment that every flat key
 * beneath it carries in full. That omission was the bypass, and the description that named only the
 * collection case is what made it look deliberate. The same line is already drawn correctly, by
 * resolving the alias, in {@link isStringifiedKey}. This drew it by node type and missed it.
 *
 * Measured: `big: &big "…60,000 A's"` beside a wide anchor merged under twenty `? *big` keys is 61 KB
 * of document denoting 60,007,693 characters of flat key against a 3,906,944-character budget — 15.4×
 * over, accepted, with no diagnostic. Widening the same shape to 62,726 bytes took 1,690 ms and 479 MB
 * of resident memory in the render-phase `useMemo` that reads the theme, per keystroke; maximised
 * under {@link MAX_THEME_BYTES} the shape denotes on the order of 10¹⁰ characters. The same document
 * with the key written out literally is refused, so the alias was the entire bypass.
 *
 * @param key - A pair's key node.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @returns The characters every flat key under it carries.
 */
function keySegmentCost(key: unknown, targets: ReadonlyMap<Alias, Node>): number {
  // Resolved BEFORE the node-type test, so the alias is charged for what it names rather than for
  // what it is written as. An alias the map has no entry for names no anchor set before it, and the
  // reader refuses the document over it, so the fall-through below is the right answer for one.
  const named = isAlias(key) ? targets.get(key) : key;
  if (isScalar(named)) {
    // Exactly `String(jsKey)`, which is `String(scalar.value)`: a `Scalar`'s `toJSON` hands back its
    // own value, and the reader stringifies whatever that is. Charged for every scalar rather than
    // for strings and numbers alone, so no shape reaches the written-span fall-through by having a
    // value of a type this forgot — a boolean and a null are both short, and over-charging a short
    // key by a few characters keeps this the upper bound the whole count rests on.
    const { value } = named;
    return (typeof value === 'string' ? value.length : String(value).length) + 1;
  }
  const range = isNode(key) ? key.range : undefined;
  if (range === undefined || range === null) return 2;
  return 2 * (range[1] - range[0]) + 2;
}

/**
 * Whether naming this key costs the reader a re-serialisation against the document's anchor list.
 *
 * The reader takes that branch for exactly the keys that MATERIALISE to an object
 * (`addPairToJSMap.stringifyKey`): a list or a mapping, or an alias to one. An alias to a scalar is
 * stringified by `String(…)` and costs nothing, which is why this resolves the alias rather than
 * charging every alias key — the palette idiom names anchored COLOURS, and a bound that charged those
 * would land on the theme that reuses one, exactly as `maxAliasCount` did.
 *
 * @param key - A pair's key node.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @returns Whether the reader re-serialises it.
 */
function isStringifiedKey(key: unknown, targets: ReadonlyMap<Alias, Node>): boolean {
  const named = isAlias(key) ? targets.get(key) : key;
  return isMap(named) || isSeq(named);
}

/**
 * What one merge source would cost to copy in, which is not the same question as what it costs to
 * read — and is the whole difference between the two kinds of document that name an ENCLOSING anchor.
 *
 * A merge naming an enclosing anchor terminates in the export, and reads. `revive_hash` registers
 * the anchor against its Hash BEFORE it fills it, so the object an inner `<<` resolves to is that
 * same Hash part-built, and `merge!` copies the entries written above the pair the merge sits
 * under — a finite, already-complete prefix, since the reader finishes each pair's value before it
 * starts the next (`to_ruby.rb:344-350`). Measured against the vendored gem under ruby 3.3.3:
 *
 * The idiom is a category's defaults written once with a level specialised from them —
 * `heading: &heading` over `font_color: '333333'` and `font_style: bold`, then an `h2:` holding
 * `<<: *heading` and `font_size: 20`. It loads `heading_h2_font_color => "333333"`,
 * `heading_h2_font_style => "bold"` and `heading_h2_font_size => 20`, and this module refused it
 * whole, under a sentence about expansion, for a document denoting ten nodes.
 *
 * The prefix stops at the pair the merge is under: `x: &x\n  k: 1\n  y:\n    <<: *x` loads `x_k` and
 * `x_y_k`, and NOT `x_y_y`. Above every other key it copies nothing at all — `x: &x\n  y:\n
 * <<: *x\n  k: 1` loads `x_k` alone. And a mapping that merges itself is a no-op:
 * `base: &b\n  font_size: 17\n  <<: *b` and its sequence spelling `<<: [*b]` both load at 17.
 *
 * A VALUE naming an enclosing anchor does not terminate: `a: &a\n  b: *a` raises `SystemStackError`
 * out of the same reader, and that document is refused by {@link expansionCost}. It must go on being
 * refused: the two were one branch, and the doubt this resolves is which of them it was written for.
 *
 * The prefix is not free, and charging it is not a formality. Each sibling merge copies everything
 * the mapping has accumulated, including the earlier siblings' own copies, so
 * `a: &a\n  k: 1\n  s1:\n    <<: *a\n  s2:\n    <<: *a\n  s3:\n    <<: *a` denotes eight settings
 * from three merges and doubles with every sibling added — measured in the gem, which loads
 * `a_s3_s2_s1_k`. Charging what the reader has counted so far, at the position the copy lands, is
 * what makes that shape cost what it costs and refuse when it grows past the budget, while the
 * ten-node idiom above costs ten nodes.
 *
 * @param value - The merge key's value node.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param memo - Costs already computed, keyed by node.
 * @param onPath - Collections between this node and the root, each against what merging it would
 *   copy — the prefix above, for a mapping, and nothing for a sequence.
 * @param budget - The cost above which the answer stops mattering.
 * @returns What copying the source in would cost.
 */
function mergeSourceCost(
  value: unknown,
  targets: ReadonlyMap<Alias, Node>,
  memo: Map<unknown, ExpansionCost>,
  onPath: Map<unknown, ExpansionCost | undefined>,
  budget: ExpansionCost,
): ExpansionCost {
  // One hop, which is the hop the materialisation takes: {@link addPsychMergeToJSMap} resolves the
  // alias and then asks whether what it named is a mapping, so an alias naming an alias is not a
  // merge source there either.
  const named = isAlias(value) ? targets.get(value) : value;
  if (isMap(named)) {
    const prefix = onPath.get(named);
    // Only a mapping records one, so this is `undefined` for a sequence on the path and for anything
    // not on it — and both of those fall through to the ordinary count, which is what refuses the
    // sequence case as the cycle it stays.
    if (prefix !== undefined) return prefix;
  }
  // A sequence WRITTEN as the merge value is a fold of its elements, not a value of its own, so each
  // element is asked the same question. `<<: [*b]` where `b` encloses it is the sequence spelling of
  // the case above, and the gem loads it.
  if (isSeq(value) && !onPath.has(value)) {
    let nodes = 1;
    let keyChars = 0;
    let stringifiedKeys = 0;
    // Counted to the end rather than stopped at the budget, unlike every other loop here: a merge
    // source is asked for once per merge, and the memo makes an element that has already been
    // counted a lookup — so what is left to save is one lookup per element, against a branch nothing
    // reaches. The mapping that holds the merge stops for both of them, one line up.
    for (const item of value.items) {
      const each = mergeSourceCost(item, targets, memo, onPath, budget);
      nodes += each.nodes;
      keyChars += each.keyChars;
      stringifiedKeys += each.stringifiedKeys;
    }
    // Not memoised against the sequence: what a merge source costs depends on WHERE it is merged
    // from, and the memo is keyed by node alone.
    return { nodes, keyChars, stringifiedKeys };
  }
  return expansionCost(value, targets, memo, onPath, budget);
}

/**
 * What a document would cost to read, counted without materialising any of it.
 *
 * Saturating and memoised, which is what makes it safe to ask: an alias is resolved once and its
 * target's cost remembered, so the graph that expands exponentially is still walked node by node,
 * once per node. The cost returned is an upper bound — a merge whose source repeats a key the
 * mapping already sets contributes less than it is charged for, and a subtree under `font.catalog`
 * is charged key text that {@link flatten} never builds — and an upper bound is the right side to err
 * on for a limit whose whole job is to refuse before the work is done.
 *
 * A node already on the path back to the root, named in VALUE position, is a cycle
 * (`a: &a\n  b: *a`), which denotes infinitely many nodes; it is reported as over budget rather than
 * followed. Materialising it does not fail — it succeeds, and the cyclic object it produces is what
 * sent {@link flatten} into unbounded recursion, throwing `RangeError` out of the resolver from
 * twelve bytes of theme. The export agrees that such a document cannot be read: measured against the
 * vendored gem under ruby 3.3.3, `a: &a\n  b: *a` raises `SystemStackError`.
 *
 * The same node named by a MERGE is a different document, and one the export reads in full — see
 * {@link mergeSourceCost}, which is what the merge branch below asks instead of following the node.
 *
 * @param node - The node to count.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param memo - Costs already computed, keyed by node.
 * @param onPath - Collections between this node and the root, each against what merging it would
 *   copy. See {@link mergeSourceCost}.
 * @param budget - The cost above which the answer stops mattering, so counting can stop there.
 * @returns The cost, or any cost above `budget` once any dimension of it is exceeded.
 */
function expansionCost(
  node: unknown,
  targets: ReadonlyMap<Alias, Node>,
  memo: Map<unknown, ExpansionCost>,
  onPath: Map<unknown, ExpansionCost | undefined>,
  budget: ExpansionCost,
): ExpansionCost {
  if (onPath.has(node)) {
    return {
      nodes: budget.nodes + 1,
      keyChars: budget.keyChars + 1,
      stringifiedKeys: budget.stringifiedKeys + 1,
    };
  }
  const remembered = memo.get(node);
  if (remembered !== undefined) return remembered;
  const over = (nodes: number, keyChars: number, stringifiedKeys: number): boolean =>
    nodes > budget.nodes || keyChars > budget.keyChars || stringifiedKeys > budget.stringifiedKeys;

  let cost: ExpansionCost;
  if (isAlias(node)) {
    const target = targets.get(node);
    // An alias naming an anchor that is not set before it denotes nothing. `toJS` rejects it, with a
    // sentence of its own — not this one.
    if (target === undefined) return ONE_LEAF;
    cost = expansionCost(target, targets, memo, onPath, budget);
  } else if (isSeq(node)) {
    // No prefix recorded: a sequence cannot be merged. `Hash#merge!` raises `TypeError` on an Array
    // and the rescue keeps `<<` as an ordinary key holding it (`to_ruby.rb:354-356`), so a merge
    // naming an enclosing SEQUENCE builds the cyclic object the value case builds, and this stays a
    // cycle. Measured: `a: &a\n  - <<: *a` loads in the gem — the cycle sits inside a list, which
    // `flatten_theme` never walks into — and is refused here, deliberately: what the export ends up
    // holding is a list that contains itself, and no reader below this one is written to hold one.
    onPath.set(node, undefined);
    let nodes = 1;
    let keyChars = 0;
    let stringifiedKeys = 0;
    for (const item of node.items) {
      // A sequence is one VALUE to the flattening — `page: margin: [a, b]` is one setting — so its
      // items are charged what they materialise and no key text of their own.
      const each = expansionCost(item, targets, memo, onPath, budget);
      nodes += each.nodes;
      keyChars += each.keyChars;
      stringifiedKeys += each.stringifiedKeys;
      if (over(nodes, keyChars, stringifiedKeys)) break;
    }
    onPath.delete(node);
    cost = { nodes, keyChars, stringifiedKeys };
  } else if (isMap(node)) {
    let nodes = 1;
    let keyChars = 0;
    let stringifiedKeys = 0;
    // What merging this mapping would copy, before any of its pairs have been counted. See
    // {@link mergeSourceCost}: the reader registers the anchor's Hash before it fills it, so a merge
    // reached from inside the mapping's own first pair copies nothing.
    onPath.set(node, ONE_LEAF);
    for (const item of node.items) {
      // Re-recorded before every pair, so a merge reached from inside this one is charged the pairs
      // written ABOVE it and no more. Set before the pair rather than after it, which is what makes
      // a mapping that merges itself (`base: &b\n  font_size: 17\n  <<: *b`) charge its own prefix.
      onPath.set(node, { nodes, keyChars, stringifiedKeys });
      if (!isPair(item)) {
        nodes += 1;
      } else if (isMergeKey(item.key)) {
        // A merge contributes no key of its own: it copies the source's entries in, so what it costs
        // is a whole materialisation of the source, at this mapping's depth rather than one below it.
        // That is the charge `maxAliasCount` never made.
        //
        // Its stringified keys are carried too, and there the charge is knowingly HIGH: `mergeValue`
        // materialises the source into a `Map`, and the reader's `Map` branch keys it by the object
        // itself rather than re-serialising it, so a collection key in a merge source costs one
        // re-serialisation however many mappings merge it (measured: 400 such keys merged ten times
        // are re-serialised 400 times, not 4,400). Charging the copies anyway keeps this an upper
        // bound — the property the whole count rests on — and the only documents it can refuse for
        // more than they cost are documents that merge a collection key, which no theme does.
        const source = mergeSourceCost(item.value, targets, memo, onPath, budget);
        nodes += source.nodes;
        keyChars += source.keyChars;
        stringifiedKeys += source.stringifiedKeys;
      } else {
        const key = expansionCost(item.key, targets, memo, onPath, budget);
        const value = expansionCost(item.value, targets, memo, onPath, budget);
        nodes += key.nodes + value.nodes;
        // Every node the value denotes is named by a flat key carrying THIS segment, so the segment
        // is charged once per node beneath it. That product is the whole point: it is what makes a
        // wide anchor merged at the bottom of a deep chain cost what it actually costs.
        keyChars += value.keyChars + keySegmentCost(item.key, targets) * value.nodes;
        // The key is materialised before it is named, so a collection used as a key is charged for
        // any collection keys of its OWN as well as for the one re-serialisation it is.
        stringifiedKeys +=
          key.stringifiedKeys + value.stringifiedKeys + (isStringifiedKey(item.key, targets) ? 1 : 0);
      }
      if (over(nodes, keyChars, stringifiedKeys)) break;
    }
    onPath.delete(node);
    cost = { nodes, keyChars, stringifiedKeys };
  } else {
    cost = ONE_LEAF;
  }

  memo.set(node, cost);
  return cost;
}

/**
 * Why a composed document may not be read, or undefined when it may.
 *
 * @param contents - The document's root node.
 * @param bytes - The length of the text it was composed from.
 * @param anchors - What each alias names and how many anchors there are. See {@link aliasTargets}.
 * @returns The sentence explaining what it is over, or undefined when it is within every bound.
 */
function expansionBudgetFailure(
  contents: unknown,
  bytes: number,
  anchors: DocumentAnchors,
): string | undefined {
  if (!isMap(contents) && !isSeq(contents)) return undefined;
  const budget: ExpansionCost = {
    nodes: Math.min(MAX_EXPANDED_NODES, MAX_EXPANSION_NODES_PER_BYTE * bytes),
    keyChars: Math.min(MAX_EXPANDED_KEY_CHARS, MAX_EXPANSION_KEY_CHARS_PER_BYTE * bytes),
    // The allowance is a product, so the count a document may write is what is left of it once the
    // anchor list each one is re-serialised against has been divided out. A document that sets no
    // anchors re-serialises against nothing, and the node bound is what limits it.
    stringifiedKeys: Math.floor(MAX_STRINGIFIED_KEY_CHARGE / Math.max(anchors.count, 1)),
  };
  const cost = expansionCost(contents, anchors.targets, new Map(), new Map(), budget);
  // Ordered, and the order is load-bearing: a CYCLE is reported as over every bound at once, and what
  // is true of it is that it denotes infinitely many nodes rather than anything about its keys.
  if (cost.nodes > budget.nodes || cost.keyChars > budget.keyChars) return EXPANSION_BUDGET_FAILURE;
  if (cost.stringifiedKeys > budget.stringifiedKeys) return STRINGIFIED_KEY_FAILURE;
  return undefined;
}

/**
 * Whether `extends` names something the loader cannot even ASK for, and so refuses the document over.
 *
 * `(Array extends).each {|extend_path| … extend_path.end_with? ' !important' … }`
 * (`theme_loader.rb:107-119`). `end_with?` belongs to String, so anything else in that list raises
 * `NoMethodError` before a single setting is read — out of `load_file`, out of `ThemeLoader.load`,
 * and into `load_theme`'s bare rescue (`converter.rb:556`), which prints the whole document with the
 * DEFAULT theme. The preview said NOTHING about any of these: `readExtends` filtered a non-String
 * out of the list and read the rest, so `extends: 5` was a theme with no `extends` at all.
 *
 * Three things decide the answer and none of them is obvious.
 *
 * `Array()` is not `[value]`. Over a Hash it yields the PAIRS, and a pair is an Array, so a non-empty
 * mapping refuses — while an EMPTY mapping yields nothing at all and loads. Measured: `extends: {}`
 * loads and `extends: {a: b}` raises `undefined method 'end_with?' for an instance of Array`.
 *
 * The guard in front of it is RUBY truthiness, which admits values JavaScript's does not. `extends`
 * is skipped only for `false` and for an absent or empty value, so `extends: 0` reaches `end_with?`
 * and raises — measured — where a JavaScript falsiness test would have let it through. `extends: []`
 * is truthy in both and simply iterates nothing.
 *
 * And the elements are tested one at a time, so a list is refused for any member: `[base, 5]`,
 * `[base, false]`, `[~]`, `[true]`, `[{a: b}]` and `[[base]]` all raise, while `[base]` and `[]` do
 * not. All measured against the vendored gem under ruby 3.3.3.
 *
 * A String that names no readable file is a DIFFERENT failure — `Errno::ENOENT`, out of the same
 * rescue — and deliberately not answered here. See {@link EXTENDS_SHAPE_FAILURE}.
 *
 * @param declared - The document's `extends` value, exactly as the reader typed it.
 * @returns The sentence to refuse with, or undefined when the loader would read the list.
 */
function extendsRefusal(declared: unknown): string | undefined {
  if (declared === false || declared === null || declared === undefined) return undefined;
  const mapped = isMapping(declared) ? Object.entries(declared) : [declared];
  const elements: readonly unknown[] = Array.isArray(declared) ? declared : mapped;
  return elements.every((element) => typeof element === 'string')
    ? undefined
    : EXTENDS_SHAPE_FAILURE;
}

/**
 * The `extends` targets a document declares, as a list whatever form it wrote them in.
 *
 * Only ever asked of a document {@link extendsRefusal} has passed, so the list holds Strings and the
 * narrowing below discards nothing. It stays a narrowing because that is what makes the fact
 * checkable rather than assumed: a shape that starts reaching this without a refusal is a shape the
 * cascade would silently skip, which is the defect the refusal exists to close.
 */
function readExtends(document: Record<string, unknown>): string[] {
  const declared = document['extends'];
  if (typeof declared === 'string') return [declared];
  if (!Array.isArray(declared)) return [];
  return declared.filter((entry) => typeof entry === 'string');
}

/**
 * Every mapping one merge key copies into the mapping holding it, in the order the reader copies them.
 *
 * The branches are {@link addPsychMergeToJSMap}'s, read for their SOURCES alone: an alias naming a
 * mapping is one source, a mapping written out is one source, a sequence is one source per element,
 * and everything else — including an alias naming a sequence — is a `<<` key holding a value rather
 * than a merge at all.
 *
 * @param value - The merge key's value node.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @returns The mappings whose entries land in the mapping holding the merge.
 */
function mergeSourceMaps(value: unknown, targets: ReadonlyMap<Alias, Node>): YAMLMap[] {
  const named = isAlias(value) ? targets.get(value) : value;
  if (isMap(named)) return [named];
  if (isAlias(value) || !isSeq(named)) return [];
  const sources: YAMLMap[] = [];
  for (const item of named.items) {
    const source: unknown = isAlias(item) ? targets.get(item) : item;
    // `h.merge!` raises on the first element that is not a mapping and `h` is a mapping of its own, so
    // a sequence with one bad element merges NOTHING rather than merging up to it.
    if (!isMap(source)) return [];
    sources.push(source);
  }
  return sources;
}

/**
 * Whether a mapping puts a LIST or a MAPPING among the keys the loader is handed. See
 * {@link COLLECTION_KEY_FAILURE}.
 *
 * Asked of the document's root and of nothing below it, because the loader only raises on such a key
 * at the top: one level down it has already interpolated the key into a name.
 *
 * Asked of NODES rather than of the materialised object, for the one reason the object cannot answer
 * it: a collection key materialises to text, and text is exactly what a quoted key of the same
 * spelling materialises to. Merge sources are followed for the reason
 * {@link NON_STRING_KEY_FAILURE} is drawn on the materialised position — a mapping written anywhere
 * can be merged into the root, and the loader meets its keys there. Measured against the vendored gem
 * under ruby 3.3.3: `c: &c\n  ? [1, 2]\n  : v\n<<: *c` raises, and `role:\n  <<: *c` reads
 * `c_[1, 2]` and `role_[1, 2]`.
 *
 * @param map - The mapping whose keys the loader is handed.
 * @param targets - What each alias resolves to. See {@link aliasTargets}.
 * @param seen - Merge sources already followed, so a source that merges itself is followed once.
 * @returns Whether the loader raises over one of its keys.
 */
function holdsCollectionKey(
  map: YAMLMap,
  targets: ReadonlyMap<Alias, Node>,
  seen: Set<unknown>,
): boolean {
  if (seen.has(map)) return false;
  seen.add(map);
  for (const item of map.items) {
    if (!isPair(item)) continue;
    if (!isMergeKey(item.key)) {
      if (isStringifiedKey(item.key, targets)) return true;
      continue;
    }
    for (const source of mergeSourceMaps(item.value, targets)) {
      if (holdsCollectionKey(source, targets, seen)) return true;
    }
  }
  return false;
}

/**
 * Read one theme document into flat entries, throwing whatever the parser or the walks throw.
 *
 * Split from {@link parseThemeDocument} so that the boundary around it covers the WHOLE reading, not
 * the parse alone. Every walk below it is recursive over a structure the document controls, and the
 * only thing that had kept `flatten` off a cyclic object was the expansion budget being correct.
 * Totality is the promise this module's header makes; resting it on one bound being right is how a
 * twelve-byte theme threw `RangeError` out of a render-phase `useMemo` the first time.
 *
 * @param source - The document's text, after any hexadecimal-colour quoting.
 * @returns The flattened theme, or the reason it could not be read.
 */
function readThemeDocument(source: string): ParseThemeResult {
  // `uniqueKeys: false` turns OFF the parser's own duplicate-key check, for two separate reasons.
  //
  // It is WRONG. `revive_hash` writes `hash[key] = val` for every pair in turn
  // (`psych/visitors/to_ruby.rb:344-381`) and has no duplicate check at all, so the export reads
  // `base:\n  font_size: 9\n  font_size: 17` at 17 pt — measured against the vendored gem under
  // ruby 3.3.3, which returns `base_font_size => 17` and warns about nothing. This module used to
  // refuse the whole document, so an author got the DEFAULT page and an error, for a theme the export
  // applies in full. That is the outcome {@link MAX_STRINGIFIED_KEY_CHARGE} already argues against for
  // a collection key, on exactly this reasoning, and the two now agree: a document the export reads is
  // read here, and what the export's last write wins, wins here.
  //
  // Last-write-wins needs nothing added to get right. The reader assigns each pair in order into the
  // same object, and assigning an existing own property keeps its POSITION — which is what `Hash#[]=`
  // does too, so the flattened order stays the document's.
  //
  // And it is expensive: `mapIncludes` scans every key already in the mapping for each new one
  // (`compose/util-map-includes`), which is quadratic in the number of keys under one parent. A theme
  // may hold tens of thousands of settings under `role`, and at forty thousand that check alone was
  // six seconds — on the thread rendering the preview, per keystroke, because a resolution is
  // memoised on the theme's text.
  //
  // `logLevel: 'error'` silences the parser's own warnings, which are not this module's to emit and
  // carry the document's TEXT: a collection used as a mapping key raises "Keys with collection values
  // will be stringified…" through `process.emitWarning`, quoting the key. Everything this module has
  // to say about a document it says in a diagnostic, and a diagnostic never repeats the document.
  const parsed = parseDocument(source, { merge: true, uniqueKeys: false, logLevel: 'error' });
  if (parsed.errors.length > 0) {
    const [first] = parsed.errors;
    return {
      ok: false,
      failure: {
        message: PARSE_FAILURE_REASONS[first.code] ?? GENERIC_PARSE_FAILURE,
        ...(first.linePos === undefined ? {} : { line: first.linePos[0].line }),
      },
    };
  }
  // The expansion budget is applied here rather than at parse time — an expansion bomb is a parse
  // that succeeds and an expansion that does not — and BEFORE the expansion rather than during it,
  // because the expansion is the thing that does not survive.
  //
  // `toJS`'s own `maxAliasCount` cannot be that bound, for two separate reasons. It is charged in
  // `Alias.toJSON`, and a MERGE key never goes through it: the merge resolves the alias itself and
  // then materialises the source afresh for every merge, so a chain of merges is exponential and
  // entirely unmetered. Six levels of it in 952 bytes composed 1.1 million entries in 1.3 seconds;
  // seven levels exhausted a 1 GB heap, which is a V8 abort rather than anything this module could
  // turn into a diagnostic. And what it charges is not the cost of anything: `count × aliasCount`,
  // where `aliasCount` is the LARGEST such product anywhere in the anchor's subtree
  // (`nodes/Alias.getAliasCount`), multiplies up a chain of anchors that each name the one below —
  // so a 947-byte document naming three of them a hundred times each is charged 1,050,804 for six
  // settings it reads in 2.6 milliseconds. At its default of 100 it refused the palette idiom
  // outright; at any setting it refuses documents by a measure of nothing.
  //
  // Counting what the document DENOTES answers the question without materialising any of it, and
  // costs one walk of the composed nodes. `maxAliasCount` is therefore off — `-1` is how the parser
  // spells that, and omitting the option would not be removing the bound but restoring it at 100.
  //
  // The same walk answers what every alias resolves to, which the reader would otherwise re-derive
  // per dereference by scanning the document — see {@link installAliasResolution}. It is installed
  // only once the budget has passed, so the cyclic documents the budget refuses are never handed a
  // resolution that would let the reader follow one.
  const anchors: DocumentAnchors = isNode(parsed.contents)
    ? aliasTargets(parsed.contents)
    : {
        targets: new Map<Alias, Node>(),
        count: 0,
        mergeKeys: [],
        keys: [],
        aliasKeys: [],
        plainValues: [],
      };
  // Before the budget, so the budget is drawn over the values and the key names the reader will see.
  // See {@link installPsychScalars} for why that is safe here and is not for the two installs below.
  // Both passes run whatever either answers: each types half of the document, and a refusal is only
  // the reason to stop AFTER both halves have been typed.
  const refusedValue = installPsychScalars(anchors.plainValues);
  const refusedKey = installPsychKeys(anchors.keys);
  const refused = firstRefusal(refusedKey, refusedValue);
  if (refused !== undefined) return { ok: false, failure: { message: refused.message } };
  const overBudget = expansionBudgetFailure(parsed.contents, source.length, anchors);
  if (overBudget !== undefined) return { ok: false, failure: { message: overBudget } };
  installAliasResolution(anchors.targets);
  // Before the merge semantics and before the materialisation, because both read the key nodes this
  // renames — which is what makes one rename enough for every road into the object.
  installTypedKeys(anchors.keys);
  installTypedAliasKeys(anchors.aliasKeys, anchors.targets);
  // After the budget, for the same reason the alias resolution is: a document refused for expanding
  // without bound is never handed a merge that would expand it.
  // And with the merge sources that ENCLOSE their merge already worked out, since that is a property
  // of where each merge is written and the materialisation has no way to ask it. See
  // {@link ancestorMergePrefixes}.
  const prefixes =
    anchors.mergeKeys.length > 0 && isNode(parsed.contents)
      ? ancestorMergePrefixes(parsed.contents, anchors.targets)
      : new Map<Node, Node>();
  installMergeSemantics(anchors.mergeKeys, anchors.targets, prefixes);
  const document: unknown = parsed.toJS({ maxAliasCount: -1 });

  if (document === null || document === undefined) {
    // An empty document is not a failure: it names no settings, so it overrides nothing.
    return {
      ok: true,
      theme: {
        entries: [],
        extendsTargets: [],
        fontFamilies: [],
        fontFallbacks: [],
        fontCatalogueMerges: false,
        fontCatalogueEntryIndex: 0,
        mappingKeys: new Set(),
        expandedOnlyStrings: [],
      },
    };
  }
  if (!isMapping(document)) {
    return { ok: false, failure: { message: 'The theme document is not a mapping of settings.' } };
  }

  const lines = new Map<string, number>();
  collectLines(parsed.contents, '', lineStartsOf(source), lines);

  // Before the walk, and before every refusal the walk finds, because `load_file` follows `extends`
  // before it hands the mapping to `load` (`theme_loader.rb:107-121`) — so a document that is wrong
  // in both places is refused over its `extends` in the export, and must be here too.
  const badExtends = extendsRefusal(document['extends']);
  if (badExtends !== undefined) {
    return {
      ok: false,
      failure: {
        message: badExtends,
        ...(lines.has('extends') ? { line: lines.get('extends') } : {}),
      },
    };
  }

  const settings = { ...document };
  // `extends` is an instruction to the cascade, not a setting; leaving it in would mint one.
  Reflect.deleteProperty(settings, 'extends');
  const entries: ThemeEntry[] = [];
  const notes: FlattenNotes = {};
  // Seeded before the walk rather than found during it, because a collection key is the one refusal
  // the walk cannot see: it is asked of a node and the walk is over an object whose keys are all text.
  //
  // That costs the ORDER between this refusal and the walk's own, and only that. `load` folds the
  // root's pairs in order, so a document holding BOTH a collection key at the root and a key the
  // loader cannot name deeper in raises over whichever comes first, while this always reports the
  // collection key. Both leave the export in the same place — `converter.rb:556` reverts the whole
  // document to the default theme either way — so what the position decides is which sentence the
  // author reads, not what the page looks like.
  if (isMap(parsed.contents) && holdsCollectionKey(parsed.contents, anchors.targets, new Set())) {
    notes.refusal = COLLECTION_KEY_FAILURE;
  }
  const mappingKeys = new Set<string>();
  flatten(settings, '', '', entries, lines, notes, mappingKeys);
  // The loader reaches a key it cannot name a setting with only once `safe_load` has built the whole
  // Hash, so this is refused after the walk rather than during the parse — and it refuses the whole
  // document, because the export's rescue throws away every other setting with it.
  if (notes.refusal !== undefined) return { ok: false, failure: { message: notes.refusal } };
  const fontNode = settings['font'];
  const catalogue = isMapping(fontNode) ? fontNode['catalog'] : undefined;
  // Read during the walk, where the same read decides whether the document is refused at all — so a
  // catalogue that got this far is one every style of which names a String. See
  // {@link readFontCatalogue}.
  const fontFamilies = notes.fontFamilies ?? [];
  // `(val.delete 'merge') ? … : {}` — any truthy value merges, so only `false` and an explicit null
  // replace the inherited catalogue. Testing for `true` alone drops the built-in families for a theme
  // that wrote `merge: 1`, which is a catalogue the export still has.
  const merge = isMapping(catalogue) ? catalogue['merge'] : undefined;
  const fontCatalogueMerges = merge !== undefined && merge !== false && merge !== null;
  // `::Array === val ? val.map … : []` — anything that is not a list names no fallback at all.
  const declaredFallbacks = isMapping(fontNode) ? fontNode['fallbacks'] : undefined;
  const fontFallbacks = Array.isArray(declaredFallbacks)
    ? declaredFallbacks.filter((name): name is string => typeof name === 'string')
    : [];

  return {
    ok: true,
    theme: {
      entries,
      extendsTargets: readExtends(document),
      fontFamilies,
      fontFallbacks,
      fontCatalogueMerges,
      fontCatalogueEntryIndex: notes.at ?? entries.length,
      mappingKeys,
      expandedOnlyStrings: notes.expandedOnly ?? [],
    },
  };
}

/**
 * Read one theme document into flat entries.
 *
 * Total: any input either parses into entries or produces a failure describing why. Nothing throws,
 * because the caller is a live preview and a half-typed theme is the normal case rather than an
 * exceptional one.
 *
 * @param text - The theme document's text, exactly as stored.
 * @param options - Set `bundled` for the renderer's own vendored theme, which it reads verbatim
 *   without the bare-hexadecimal quoting it applies to project documents.
 * @returns The flattened theme, or the reason it could not be read.
 */
export function parseThemeDocument(
  text: string,
  options: { readonly bundled?: boolean } = {},
): ParseThemeResult {
  if (text.length > MAX_THEME_BYTES) {
    return {
      ok: false,
      failure: { message: `Theme document is larger than ${MAX_THEME_BYTES / 1024} KB and was not read.` },
    };
  }

  try {
    return readThemeDocument(options.bundled === true ? text : quoteHexColours(text));
  } catch (error) {
    // Only ever a sentence of this module's own: the parser's own text for the named case
    // interpolates the anchor the document wrote, and a diagnostic never carries the document's text.
    const message = error instanceof ReferenceError ? UNRESOLVED_ALIAS_FAILURE : UNREADABLE_FAILURE;
    return { ok: false, failure: { message } };
  }
}
