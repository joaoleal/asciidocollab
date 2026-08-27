import { DEFAULT_THEME_YAML } from '../../src/render-config/default-theme.generated';
import { NAMED_THEME_KEYS, resolveAppearance } from '../../src/print-appearance';
import type { AppearanceDiagnostic } from '../../src/print-appearance';
import { expectWithinBudget } from './perf-budget';

/**
 * @file The module's two headline promises, held against documents written to break them.
 *
 * `index.ts` promises TOTALITY ("whatever text arrives — half-typed, malformed, or hostile — the
 * result carries an appearance") and `parse-theme.ts` promises that a diagnostic never carries the
 * document's own text. Both were prose, checked by inspection, and both were false: a 512-byte theme
 * threw `RangeError` out of a `useMemo` on the render thread, and a theme's own key was interpolated
 * into the warning list verbatim.
 *
 * Inspection is what missed them, so these are checked by construction instead — one generator that
 * writes documents nobody would write, and one marker planted everywhere a document's text can enter.
 */

/**
 * A theme document's resolution, timed.
 *
 * @param themeText - The document.
 * @returns What it resolved to and how long that took, in milliseconds.
 */
function resolveTimed(themeText: string): {
  readonly diagnostics: readonly AppearanceDiagnostic[];
  readonly fonts: number;
  readonly elapsedMs: number;
} {
  const started = process.hrtime.bigint();
  const result = resolveAppearance({ themeText, themePath: 'theme/hostile-theme.yml' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  expect(result.appearance.page.widthPt).toBeGreaterThan(0);
  expect(result.appearance.base.fontSizePt).toBeGreaterThan(0);
  return { diagnostics: result.diagnostics, fonts: result.appearance.fonts.length, elapsedMs };
}

/**
 * The least a document's resolution was measured to cost, over a few readings.
 *
 * The least rather than the mean, because every disturbance a shared runner adds — a slice lost to
 * another job, a collection landing mid-measurement, a cold cache — only ever makes a reading LARGER.
 * The smallest of a few is the closest any of them gets to what the work itself costs. Five readings
 * rather than three because the caller subtracts two of these figures: each still carries whatever
 * jitter its fastest reading did not shed, the two do not cancel, and more readings shrink the residual
 * each contributes to that difference.
 *
 * @param themeText - The document.
 * @returns The lowest reading, in milliseconds.
 */
function fastestResolveMs(themeText: string): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let reading = 0; reading < 5; reading++) {
    fastest = Math.min(fastest, resolveTimed(themeText).elapsedMs);
  }
  return fastest;
}

/**
 * A chain of array values, each naming the level below it twice, ending in one referring key.
 *
 * `n` lines denote 2^n leaves. Written as an ARRAY rather than as a string, which is the whole
 * point: a lone `$ref` used to be handed back by reference, so `k2: [$k1, $k1]` was two pointers
 * to one array rather than a copy of it, and nothing charged for what it denoted. The chain is a DAG
 * that costs n lines to write and 2^n characters to print — and the first thing that printed it
 * (`String(value)`, an `Array#join`) did that work before any bound could look at the result.
 *
 * @param depth - How many levels.
 * @param ending - The last two lines, which decide WHICH branch of the expander meets the chain.
 * @returns The document.
 */
function arrayChain(depth: number, ending: string): string {
  return [
    'extends: default',
    'k0: [1]',
    ...Array.from({ length: depth }, (_unused, level) => `k${level + 1}: [$k${level}, $k${level}]`),
    'base:',
    ending,
    '',
  ].join('\n');
}

/** The same chain built out of strings, which is the shape a previous round bounded. */
function stringChain(depth: number): string {
  return [
    'extends: default',
    'k0: xxxxxxxx',
    ...Array.from({ length: depth }, (_unused, level) => `k${level + 1}: $k${level} $k${level}`),
    'base:',
    `  font_family: "x $k${depth}"`,
    '',
  ].join('\n');
}

/**
 * A chain of anchors, each level naming the one below it `fan` times through a MERGE key.
 *
 * `<<: *a` copies the entries of what `a` denotes into the mapping, and the copy is a fresh one every
 * time — so `fan` merges of a level that already denotes N entries denote `fan * N`, and the chain
 * denotes `fan ^ depth` from a document that grows by a few lines per level. Both forms of the merge
 * key are built here because they are two spellings of one construct: the mapping form takes a single
 * source, the sequence form a list of them, and a bound that catches one and not the other is not a
 * bound on merging.
 *
 * @param depth - How many levels.
 * @param form - Whether the merge names its source directly or through a one-element sequence.
 * @param fan - How many times each level names the one below it.
 * @returns The document.
 */
function mergeChain(depth: number, form: 'mapping' | 'sequence', fan = 8): string {
  const lines = ['l0: &l0', '  k0: v', '  k1: v'];
  for (let level = 1; level <= depth; level++) {
    lines.push(`l${level}: &l${level}`);
    for (let branch = 0; branch < fan; branch++) {
      lines.push(
        `  m${branch}:`,
        form === 'mapping' ? `    <<: *l${level - 1}` : `    <<: [*l${level - 1}]`,
      );
    }
  }
  return `${[...lines, 'base:', `  <<: *l${depth}`].join('\n')}\n`;
}

/** The same DAG written with plain aliases, which is the shape the alias budget already refused. */
function aliasChain(depth: number, fan = 8): string {
  const lines = ['l0: &l0', '  k0: v', '  k1: v'];
  for (let level = 1; level <= depth; level++) {
    lines.push(`l${level}: &l${level}`);
    for (let branch = 0; branch < fan; branch++) lines.push(`  m${branch}: *l${level - 1}`);
  }
  return `${[...lines, `base: *l${depth}`].join('\n')}\n`;
}

/**
 * A colour whose value is nested `links * wrap` collections deep, from `links` flat lines.
 *
 * Nesting a colour value by writing it out is capped by the parser's own recursion, which gives out
 * somewhere above a thousand levels — but nesting is not a thing a document has to WRITE: an alias
 * names the level below it, so each line here multiplies the depth by what it wraps. The value under
 * the colour key is a list of any length but three or four, which is the branch that joins, and
 * `Array#join` joins a nested collection by joining IT — so the join follows every level of this.
 *
 * @param links - How many lines the chain is written from.
 * @param wrap - How many collections each line wraps the level below it in.
 * @returns The document.
 */
function nestChain(links: number, wrap: number): string {
  const lines = ['extends: default', 'a0: &a0 [1]'];
  for (let link = 1; link <= links; link++) {
    lines.push(`a${link}: &a${link} ${'['.repeat(wrap)}*a${link - 1}${']'.repeat(wrap)}`);
  }
  return `${[...lines, 'base:', `  font_color: [*a${links}, 2]`].join('\n')}\n`;
}

/**
 * A colour value joined from twelve thousand elements, every one of them the SAME alias.
 *
 * What the alias's body costs to write is paid once and what it costs to join is paid twelve
 * thousand times, so the two ends of `aliasBytes` are documents of nearly the same size denoting
 * amounts of text three orders of magnitude apart.
 *
 * @param aliasBytes - How long the string every element names is.
 * @returns The document.
 */
function aliasedColour(aliasBytes: number): string {
  const elements = Array.from({ length: 12_000 }, () => '*s').join(', ');
  return `extends: default\ns: &s "${'x'.repeat(aliasBytes)}"\nbase:\n  font_color: [${elements}]\n`;
}

/**
 * The size of the smallest document in a family that the module refuses to read.
 *
 * @param build - Builds the document at a given depth.
 * @returns Its length in bytes, or infinity when no depth up to eight is refused.
 */
function smallestRefused(build: (depth: number) => string): number {
  for (let depth = 1; depth <= 8; depth++) {
    const document = build(depth);
    const { diagnostics } = resolveAppearance({ themeText: document });
    if (diagnostics.some((diagnostic) => /far more content/.test(diagnostic.message))) {
      return document.length;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** One setting per line, each naming a variable nothing defines. */
function danglingSettings(count: number): string {
  return `${Array.from({ length: count }, (_unused, index) => `k${index}: $zz`).join('\n')}\n`;
}

/** A deterministic PRNG, so a failure names a seed that reproduces it exactly. */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fragments a theme document is assembled from — every shape that has ever broken this module. */
const KEY_SHAPES = [
  'base',
  'heading',
  'sidebar',
  'font',
  'catalog',
  'extends',
  'align',
  'blockquote',
  'role',
  'k',
  'a-b.c',
  '$self',
  '  ',
  '<img src=x onerror=alert(1)>',
  ' [31m',
  'k'.repeat(300),
  '🙂',
];

const VALUE_SHAPES = [
  '$a',
  '-$a',
  '$a $a',
  '[$a, $a]',
  '[[$a, $a], [$a, $a]]',
  'round($a * $a)',
  '1 + 1 - 1 * 1 / 1 ^ 1',
  '999999',
  '#abc',
  'null',
  '[]',
  '{}',
  '&anchor value',
  '*anchor',
  'GEM_FONTS_DIR/x.ttf',
  '"unterminated',
  "'",
  '\t\ttabbed',
  '1e400',
  'x'.repeat(4200),
  '',
];

/**
 * Assemble one document out of the fragments above.
 *
 * @param random - The seeded source of randomness.
 * @returns A theme document, usually invalid and occasionally worse.
 */
function generate(random: () => number): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const lines: string[] = [];
  const count = 1 + Math.floor(random() * 40);
  for (let index = 0; index < count; index++) {
    const indent = ' '.repeat(Math.floor(random() * 4) * 2);
    const key = `${pick(KEY_SHAPES)}${random() < 0.5 ? index : ''}`;
    if (random() < 0.15) {
      lines.push(`${indent}${key}:`);
      continue;
    }
    if (random() < 0.1) {
      lines.push(`${indent}- ${pick(VALUE_SHAPES)}`);
      continue;
    }
    lines.push(`${indent}${key}: ${pick(VALUE_SHAPES)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Letters and digits only, lower-cased.
 *
 * The comparison has to survive the transformations a document's text goes through on the way to a
 * diagnostic, or it proves nothing: a flat theme key is lower-cased with `-` folded to `_`, and the
 * message then folds `_` back to `.`. A test looking for the marker as WRITTEN passed against the
 * very defect it was written for, because by then it read `mrkr.contact.admin.at.evil.example`.
 *
 * @param text - The field to normalise.
 * @returns The same text with everything that is not a letter or digit removed.
 */
const normalise = (text: string): string => text.toLowerCase().replaceAll(/[^a-z\d]/g, '');

describe('a theme whose references expand into more than they are written from', () => {
  it.each([
    ['embedded in a larger value', (depth: number) => arrayChain(depth, '  font_family: "x $k' + depth + '"')],
    ['negated', (depth: number) => arrayChain(depth, '  font_size: -$k' + depth)],
    ['taken on whole', (depth: number) => arrayChain(depth, '  font_size: $k' + depth)],
    // The string form of the same defect, which a previous round bounded. It is kept here because
    // the array form proved the bound was on the wrong thing, and a bound that holds for one shape
    // and not the other is the defect, not the shape.
    ['doubled as text', stringChain],
  ])('resolves a chain %s rather than throwing, at any depth', (_label, build) => {
    // Depth 28 is 513 bytes and threw `RangeError: Invalid string length` after 44 seconds; depth 24
    // is 441 bytes and took 2.7 of them. The assertion is that the OUTCOME is an appearance, which is
    // a fact about the result rather than about the machine — the depths beyond 28 are here because
    // no unbounded implementation reaches them at all, whatever it is running on.
    for (const depth of [8, 16, 24, 28, 40, 64]) {
      const document = build(depth);
      expect(document.length).toBeLessThan(2048);
      const { diagnostics } = resolveTimed(document);
      // The chain is reported rather than followed: silence would mean the preview had quietly shown
      // a page built from values it could not resolve.
      expect(diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('spends no more on a deep chain than on a shallow one', () => {
    // A secondary guard, and the reason it is expressed as a whole-family budget rather than as a
    // per-case one: what failed here was EXPONENTIAL, so any finite budget separates a fixed one
    // from a broken one by orders of magnitude, and none of the runner's variance lives at that
    // scale. The family below resolves in single-digit milliseconds; the unbounded version of its
    // last case would not finish this century.
    const started = process.hrtime.bigint();
    for (const depth of [8, 16, 24, 28, 40, 64, 128]) {
      resolveAppearance({ themeText: arrayChain(depth, `  font_family: "x $k${depth}"`) });
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expectWithinBudget(elapsedMs, 2000);
  });
});

/**
 * @remarks These are written out rather than generated because a generator cannot find them. The
 * fuzz above draws from `KEY_SHAPES` and `VALUE_SHAPES`, and a merge chain is not a shape either list
 * holds — it is a RELATIONSHIP between lines. A four-thousand-case run over an anchor-and-merge
 * alphabet was tried and its worst case was one millisecond: a random generator essentially never
 * builds a chain where every level names only the level below it. So the shape is stated.
 */
describe('a theme document that denotes far more than it is written from', () => {
  it.each([
    ['through a mapping merge key', (depth: number) => mergeChain(depth, 'mapping')],
    ['through a sequence merge key', (depth: number) => mergeChain(depth, 'sequence')],
    // The plain-alias spelling of the same DAG, which `maxAliasCount` already refused. It is kept
    // beside the others because what failed was the bound being on the WRONG THING: `maxAliasCount`
    // is charged in `Alias.toJSON`, and a merge key never goes through it — `addMergeToJSMap`
    // resolves the alias itself and materialises the source afresh for each merge.
    ['through plain aliases', aliasChain],
  ])('resolves a chain %s rather than exhausting the heap, at any depth', (_label, build) => {
    // Six levels is 952 bytes and composed 1,123,474 entries in 1,280 ms; seven is 1,104 bytes and
    // ended in `FATAL ERROR: JavaScript heap out of memory` under a 1 GB heap — a V8 abort, so
    // neither this module's totality promise nor any `try` around it applies. The depths past seven
    // are here because no unmetered implementation reaches them at all.
    for (const depth of [3, 4, 5, 6, 7, 10, 16]) {
      const document = build(depth);
      expect(document.length).toBeLessThan(4096);
      const { diagnostics } = resolveTimed(document);
      // Refused, and SAID to be refused. A document read as nothing in silence would show the
      // default page while the export showed the author's.
      expect(diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('refuses every spelling of one chain at about the same document size', () => {
    // The invariant rather than a threshold: three spellings of one DAG, bounded by what a document
    // of a given SIZE is allowed to denote, so the size at which each is refused is about the same.
    // Compared by size rather than by depth because the spellings are not equally verbose — a merge
    // level costs two lines per branch where an alias level costs one — and it is the bytes, not the
    // levels, that the allowance is drawn against.
    //
    // Stated this way it cannot be satisfied by moving a constant, and it fails outright for the
    // defect as it was: the alias form was refused at 298 bytes and neither merge form was ever
    // refused at all.
    const alias = smallestRefused(aliasChain);
    expect(alias).toBeLessThan(1024);
    for (const form of ['mapping', 'sequence'] as const) {
      expect(smallestRefused((depth) => mergeChain(depth, form))).toBeLessThanOrEqual(alias * 4);
    }
  });

  it('spends no more on a deep chain than on a shallow one', () => {
    // Exponential against fixed: any finite budget separates them by orders of magnitude, so none of
    // the runner's variance lives at this scale. Depth 16 of the mapping form denotes 8^16 entries.
    const started = process.hrtime.bigint();
    for (const depth of [3, 4, 5, 6, 7, 10, 16, 24]) {
      resolveAppearance({ themeText: mergeChain(depth, 'mapping') });
      resolveAppearance({ themeText: mergeChain(depth, 'sequence') });
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expectWithinBudget(elapsedMs, 2000);
  });

  it('still applies a merge key a theme uses as one', () => {
    // The bound must not have been bought by dropping merge support. Ruby's `safe_load` honours the
    // merge key (`psych/visitors/to_ruby.rb:349`), which is the loader the export goes through
    // (`theme_loader.rb:104`), so a preview that ignored `<<` would show a different page from the
    // PDF — silently, since the document would parse either way.
    for (const merge of ['  <<: *common', '  <<: [*common]']) {
      const themeText = `extends: default\ncommon: &common\n  font-size: 17\n  font-color: 445566\nbase:\n${merge}\n`;
      const { appearance, diagnostics } = resolveAppearance({ themeText, themePath: 'theme/x-theme.yml' });
      expect(diagnostics).toEqual([]);
      expect(appearance.base.fontSizePt).toBe(17);
      expect(appearance.base.fontColor).toBe('445566');
    }
  });

  it('resolves an anchor that names itself', () => {
    // Twelve bytes, and it threw `RangeError: Maximum call stack size exceeded` out of
    // `resolveAppearance` — from `flatten`, not from the parser: composing succeeds, and what it
    // composes is a CYCLIC object that the flattening walk follows forever. A cycle denotes
    // infinitely many nodes, so the same accounting refuses it.
    for (const themeText of ['a: &a\n  b: *a\n', 'a: &a\n  - *a\n', 'a: &a\n  b:\n    c: *a\n']) {
      expect(resolveTimed(themeText).diagnostics.length).toBeGreaterThan(0);
    }
  });
});

describe('a colour value nested deeper than the export joins', () => {
  it('answers with an appearance rather than exhausting the stack, at any depth', () => {
    // Twenty links of six hundred wraps is 24 KB and nests 12,000 levels, which resolves today; the
    // budget refuses the document somewhere past thirty links, and the parser's own recursion refuses
    // one written a thousand levels deep on a single line. A join that simply recursed threw
    // `RangeError: Maximum call stack size exceeded` out of `resolveAppearance` on every row past the
    // first — from the render thread, per keystroke, which is not a refusal but a broken tab.
    for (const [links, wrap] of [[1, 600], [10, 600], [20, 600], [30, 600], [10, 999], [40, 999]]) {
      const document = nestChain(links, wrap);
      expect(document.length).toBeLessThan(90 * 1024);
      resolveTimed(document);
    }
  });

  it('refuses the value at a depth no ruby joins, and keeps the rest of the theme', () => {
    // `Array#join` recurses in C and gives out: measured against ruby 3.3.3 with an 8 MB stack it
    // joins a thousand levels and raises `SystemStackError` before fifteen hundred, and a
    // `SystemStackError` is not a `StandardError`, so the rescue that turns a bad theme into the
    // default theme does not catch it — the export writes no PDF at all. There is nothing above the
    // bound to reproduce, so the key falls back and says so, and every other setting still applies.
    const { appearance, diagnostics } = resolveAppearance({
      themeText: `${nestChain(10, 600).trimEnd()}\n  font_size: 17\n`,
      themePath: 'theme/hostile-theme.yml',
    });
    expect(appearance.base.fontSizePt).toBe(17);
    expect(appearance.base.fontColor).toBe('333333');
    expect(diagnostics.map((diagnostic) => diagnostic.themeKey)).toContain('base_font_color');
  });

  it('spends no more on a value joined from megabytes than on one joined from bytes', () => {
    // The length rule reads a value's length and then at most its first six characters. Building the
    // rest is work an alias buys cheaply: forty kilobytes under twelve thousand elements is an 86 KB
    // document that joined 480 MB of string in 288 ms, on the thread the preview renders on and per
    // keystroke — for an answer that is six characters of it.
    //
    // Held as the DIFFERENCE between that document and the same one with a one-byte alias body,
    // which is what the sentence above actually says. Nearly all of either reading is the YAML parse
    // of twelve thousand aliases, and both documents pay that alike, so subtracting one from the
    // other leaves the join and only the join. An absolute figure could not: the parse is the term
    // that grows with the machine and with coverage instrumentation, and a bound loose enough to
    // survive a loaded runner is looser than the 480 MB it is meant to refuse.
    const document = aliasedColour(40_000);
    expect(document.length).toBeLessThan(120 * 1024);
    // Bytes first, so the cold reading lands on the side the comparison is measured AGAINST and a
    // warm-up cannot be mistaken for the join.
    const overBytes = fastestResolveMs(aliasedColour(1));
    const overMegabytes = fastestResolveMs(document);
    // The difference measures single digits, and the join it refuses is 211 ms of `Array#join` — a
    // native copy of 480 MB. The bound sits between the two, not against either: both readings are
    // the ~115 ms parse of twelve thousand aliases, and the jitter that parse leaves after a
    // fastest-of-five does not fully cancel when they are subtracted — a loaded runner has left the
    // difference above fifty even with the join absent. A hundred and twenty clears that noise while
    // staying well under the 211 ms it exists to catch, which no machine does in a hundred and twenty
    // and which instrumentation only makes slower.
    expectWithinBudget(overMegabytes - overBytes, 120);
  });
});

describe('a theme document at the size the module accepts', () => {
  it('resolves the largest document it will read without occupying the thread', () => {
    // 519,997 bytes — just inside the 512 KB bound whose own comment says a pathological file cannot
    // occupy the main thread. It could: 19,163 ms, of which the YAML parser's duplicate-key check
    // was 17,734 (quadratic in the keys under one mapping) and the diagnostic de-duplication most of
    // the rest (quadratic in the entries). At 87 KB the same document cost 855 ms, and it is paid per
    // keystroke, because a resolution is memoised on the theme's TEXT.
    const document = danglingSettings(44_259);
    expect(document.length).toBeGreaterThan(500 * 1024);
    expect(document.length).toBeLessThanOrEqual(512 * 1024);
    const { elapsedMs } = resolveTimed(document);
    // Headroom sized for slower developer hardware (CI resolves this in well under a second): the
    // budget only has to stay far below the pathological 19 s this test guards against.
    expectWithinBudget(elapsedMs, 6000);
  });

  it('reports a bounded number of problems however many settings have one', () => {
    // 44,259 diagnostics were produced, held, sorted on every render, and rendered expanded. A list
    // that long is one fact repeated, not an account of what is wrong.
    const { diagnostics } = resolveTimed(danglingSettings(44_259));
    expect(diagnostics.length).toBeLessThanOrEqual(60);
    // And it says what it withheld, rather than quietly showing the first fifty.
    expect(diagnostics.some((diagnostic) => /further settings/.test(diagnostic.message))).toBe(true);
  });

  it('asks for a bounded number of font files however many the catalogue declares', () => {
    // Every requirement is a `fetch` from one effect. 13,000 families fit in 485 KB of catalogue,
    // and all 13,000 were promoted whether or not anything named them.
    const catalogue = [
      'font:',
      '  catalog:',
      ...Array.from({ length: 13_000 }, (_unused, index) => `    Fam${index}:\n      normal: f${index}.ttf`),
      '',
    ].join('\n');
    expect(catalogue.length).toBeLessThanOrEqual(512 * 1024);
    const { fonts, elapsedMs } = resolveTimed(catalogue);
    expect(fonts).toBeLessThanOrEqual(64);
    expectWithinBudget(elapsedMs, 3000);
  });

  it('costs no more than the document is long, within a constant', () => {
    // Scale-free, so it says something a wall-clock bound cannot: the cost of resolving a theme is a
    // function of its SIZE, not of what it says. Both quadratics showed up here as a quadrupled
    // document costing sixteen times as much rather than four.
    const small = danglingSettings(5000);
    const large = danglingSettings(20_000);
    // Warm the parser and the default cascade so the first call's one-time costs are not the sample.
    resolveAppearance({ themeText: small });
    const smallMs = resolveTimed(small).elapsedMs;
    const largeMs = resolveTimed(large).elapsedMs;
    // The document is 4x larger, so linear cost is 4x and the quadratics this guards against are 16x.
    // The bound sits at 12x — a wide margin below the 16x it must catch, with enough headroom that the
    // jitter in a ratio of two single wall-clock readings does not trip it on a loaded shared runner.
    expectWithinBudget(largeMs, Math.max(smallMs * 12, 50));
  });
});

describe('resolveAppearance is total', () => {
  it.each([
    [
      'flow sequences nested past what a stack holds',
      (d: number) => `a: ${'['.repeat(d)}${']'.repeat(d)}\n`,
      [100, 1000, 1500, 4000, 60_000],
    ],
    [
      'flow mappings nested the same way',
      (d: number) => `a: ${'{x: '.repeat(d)}1${'}'.repeat(d)}\n`,
      [100, 1000, 1500, 4000, 60_000],
    ],
    [
      // Indenting one level per line costs a line per level and a space per level of that line, so
      // this shape reaches the document bound at about a thousand.
      'a block mapping indented one level per line',
      (d: number) => `${Array.from({ length: d }, (_unused, index) => `${' '.repeat(index)}k${index}:`).join('\n')}\n`,
      [100, 500, 1000],
    ],
    [
      'array values that nest one level per reference',
      (d: number) =>
        [
          'extends: default',
          'k0: [1]',
          ...Array.from({ length: d }, (_unused, level) => `k${level + 1}: [$k${level}]`),
          'base:',
          `  font_family: "x $k${d}"`,
          '',
        ].join('\n'),
      [100, 1000, 4000, 30_000],
    ],
  ])('resolves %s', (_label, build, depths) => {
    // Depth is the other way a small document denotes a large structure, and every walk in this
    // module is recursive — including the one the platform does for you, since `String(array)` is
    // `join` calling `toString` calling `join`. A chain of `k1: [$k0]` lines nests one level per
    // line, so a 40 KB document reached four thousand levels: cheap to measure in characters, and a
    // stack overflow to print. The last depth of each shape is past what any stack holds.
    for (const depth of depths) {
      const document = build(depth);
      if (document.length > 512 * 1024) continue;
      resolveTimed(document);
    }
  });

  it('carries an appearance for every document a generator can write', () => {
    // The promise this file's header quotes is checked here rather than argued: 500 documents from a
    // seeded generator, each of which either resolves or reports, and none of which throws. A seed is
    // printed with any failure, so a counter-example is a one-line reproduction rather than a hunt.
    for (let seed = 1; seed <= 500; seed++) {
      const random = randomOf(seed);
      const document = generate(random);
      let failure: unknown;
      try {
        const result = resolveAppearance({ themeText: document, themePath: 'theme/fuzz-theme.yml' });
        expect(result.appearance.page.widthPt).toBeGreaterThan(0);
        expect(result.appearance.base.fontSizePt).toBeGreaterThan(0);
        expect(Array.isArray(result.diagnostics)).toBe(true);
      } catch (error) {
        failure = error;
      }
      expect({ seed, failure }).toEqual({ seed, failure: undefined });
    }
  });

  it('spends a bounded amount on all of them together', () => {
    const started = process.hrtime.bigint();
    for (let seed = 1; seed <= 500; seed++) {
      resolveAppearance({ themeText: generate(randomOf(seed)) });
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expectWithinBudget(elapsedMs, 5000);
  });
});

describe('a diagnostic never carries the theme document’s own text', () => {
  /**
   * A marker no sentence of this module contains, planted wherever a document's text can enter.
   *
   * The `extends` VALUE was the only position with a fixture, and the guarantee is about the
   * document, not about one of its settings. A theme's own KEY reached the warning list verbatim:
   * `<img src=x onerror=alert(1)> Contact admin@evil.example for the real theme` was rendered as
   * text — escaped, so never markup, and still the attacker's sentence in the application's own
   * warning surface, addressed to whoever the theme was shared with.
   */
  const MARKER = 'MRKR-contact-admin-at-evil-example';

  const positions: [string, string][] = [
    ['a key the model does not read', `extends: default\n${MARKER}: $nothing\n`],
    [
      'a key that expands without bound',
      `extends: default\nq: ${'x'.repeat(2000)}\n${MARKER}: $q $q $q\n`,
    ],
    ['a nested key', `extends: default\nbase:\n  ${MARKER}: $nothing\n`],
    ['a variable reference', `extends: default\nbase:\n  font_family: "a $${MARKER.replaceAll('-', '_')}"\n`],
    ['an extends target', `extends: ${MARKER}\n`],
    ['a value', `extends: default\nbase:\n  font_size: ${MARKER}\n`],
    ['a font family name', `extends: default\nbase:\n  font_family: ${MARKER}!!\n`],
    ['a catalogue family name', `extends: default\nfont:\n  catalog:\n    ${MARKER}!!:\n      normal: x.ttf\n`],
    ['a catalogue path', `extends: default\nfont:\n  catalog:\n    Brand:\n      normal: "${MARKER};rm -rf /"\n`],
    ['a key the model does read', `extends: default\nbase:\n  ${MARKER}_font_size: 9\n`],
    // A document that cannot be parsed at all, where the parser's own message quotes the line.
    ['a line the parser blamed', `extends: default\n\t${MARKER}: 1\n`],
  ];

  it.each(positions)('says nothing of %s', (_label, themeText) => {
    const result = resolveAppearance({ themeText, themePath: 'theme/x-theme.yml' });
    for (const diagnostic of result.diagnostics) {
      // Every string field, not just the message: the guarantee is what lets the delivery layer
      // render a diagnostic without treating it as untrusted, and it cannot hold for one field only.
      const carried = [diagnostic.message, diagnostic.detail, diagnostic.themeKey, diagnostic.resource]
        .filter((field): field is string => field !== undefined)
        .filter((field) => normalise(field).includes(normalise(MARKER)));
      expect(carried).toEqual([]);
    }
  });

  it('still names a key it claims, which is its own vocabulary rather than the document’s', () => {
    // The guarantee is not "say less". A key the model reads is drawn from a closed list this
    // package wrote, so naming one carries nothing of the document — and that is the case an author
    // is most often looking at.
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_family: "$nowhere Sans"\n',
      themePath: 'theme/x-theme.yml',
    });
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes('base.font.family')),
    ).toBe(true);
  });

  it('holds for the document the module reads on every resolution', () => {
    // The vendored default theme is beneath every cascade; if its text could reach a diagnostic, no
    // theme would be safe.
    const result = resolveAppearance({ themeText: DEFAULT_THEME_YAML });
    expect(result.diagnostics).toEqual([]);
  });

  it('names a key only out of this package’s own closed vocabulary, across the whole corpus', () => {
    // The marker test above asks whether one planted string escaped. This asks the stronger
    // question the field is documented by: is `themeKey` ever anything but a word this package
    // wrote down? It was already not — `extends` is reported by flat name and is not a key the
    // model claims — so the invariant had an exception in it, which is the shape a real leak hides
    // in. `NAMED_THEME_KEYS` is the vocabulary the rule is now stated over, and this walks the
    // generated corpus rather than a fixture, so a key that starts escaping through some future
    // path fails here whether or not anyone thought to plant a marker in it.
    const vocabulary = new Set(NAMED_THEME_KEYS);
    const seen = new Set<string>();
    const escaped = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const documents = [
        generate(randomOf(seed)),
        // The shapes the generator does not write, added by hand: the two that report a key with
        // no value to reject, and one that reports the document as a whole.
        `extends: not-the-default-theme.yml\npage:\n  background_image: seed-${seed}.png\n`,
        `base:\n  font_size:\n    seed${seed}: 24\n`,
      ];
      for (const themeText of documents) {
        for (const { themeKey } of resolveAppearance({ themeText, themePath: 't.yml' }).diagnostics) {
          if (themeKey === undefined) continue;
          seen.add(themeKey);
          if (!vocabulary.has(themeKey)) escaped.add(themeKey);
        }
      }
    }
    expect([...escaped]).toEqual([]);
    // …and the field really was exercised, so an implementation that stopped setting `themeKey`
    // altogether cannot pass this by reporting nothing. The generated documents contribute no named
    // key at all — their keys are invented, and an invented key is exactly what must NOT be named —
    // so the three positions that do name one are stated outright: a key reported without a value
    // to reject, a key the model does not read, and the document as a whole.
    expect([...seen].toSorted()).toEqual(['base_font_size', 'extends', 'page_background_image']);
  });
});
