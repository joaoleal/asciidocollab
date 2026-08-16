/**
 * @packageDocumentation
 * Turns an Asciidoctor-PDF theme document into the appearance the Print preview presents.
 *
 * Pure: data in, data out. No DOM, no browser, no wasm VM, no filesystem — which is what makes the
 * breadth assertions cheap and what keeps the preview from booting a renderer to decide what a
 * heading should look like.
 *
 * Total, too. Whatever text arrives — half-typed, malformed, or hostile — the result carries an
 * appearance. A theme that cannot be read at all costs the theme; a value that cannot be read costs
 * its own key. Neither ever costs the document, because the preview's job is to keep showing what
 * the author is writing.
 *
 * Totality is a promise about ARBITRARY input, so it is checked against arbitrary input rather than
 * against the cases anyone thought of: `hostile-theme.test.ts` generates documents from a seeded
 * grammar and asserts every one of them resolves. It is not decorative. This function runs in a
 * `useMemo`, on the thread that renders the preview, with no error boundary between it and the page;
 * a throw here replaces the editor. Twice now the thing that threw was a document under 600 bytes
 * whose references denoted more than they were written from, and both times inspection had read the
 * code and concluded it was bounded.
 *
 * ## Bounded by the document's SIZE
 *
 * A resolution is memoised on the theme's text, so it is paid on every keystroke in the theme editor.
 * Everything here is therefore linear (or near enough) in the document, and the two places that were
 * not — the parser's own duplicate-key check and the diagnostic de-duplication, both quadratic in the
 * number of keys — made a document the module ACCEPTS cost nineteen seconds. What a document can ask
 * for is bounded as well as what it can say: the diagnostics it can produce, and the font files it
 * can make the delivery layer fetch.
 *
 * ## Where the cascade starts
 *
 * The renderer's own default theme is always the base layer here. That is what "the corresponding
 * default" means everywhere in this feature: the value the gem's `default-theme.yml` gives a key.
 *
 * The renderer itself is narrower — a project theme that declares no `extends` starts from almost
 * nothing rather than from the default theme, and the converter's Ruby-side fallbacks fill the rest.
 * Reproducing that would mean modelling those fallbacks, which live in the converter's code rather
 * than in any theme file. Every theme in this repository, and every theme the application's own
 * theme editor seeds, declares `extends: default`, so the two agree for them.
 *
 * A theme that declares something else — `extends: base`, one of the gem's other bundled themes, or
 * a file of its own — is a different page again, and not by a little: `base-theme.yml` sets Helvetica
 * at 12 pt where `default-theme.yml` sets Noto Serif at 10.5, and left-aligns body text the default
 * theme justifies. So {@link ParsedTheme.extendsTargets} is READ rather than merely recorded, and any
 * target this module does not layer is reported. A preview that quietly showed the default theme's
 * page for a document extending another would be wrong in exactly the way this feature exists to
 * prevent, and silent about it.
 */

import { DEFAULT_THEME_YAML } from '../render-config/default-theme.generated';
import type { AppearanceDiagnostic } from './appearance-diagnostic';
import type { AppearanceModel } from './appearance-model';
import type { ThemeFontFamily } from './parse-theme';
import { parseThemeDocument } from './parse-theme';
import { buildAppearance, CLAIMED_THEME_KEYS } from './resolve-appearance';
import type { ExpansionBudget, ResolvedValues } from './resolve-values';
import {
  createExpansionBudget,
  deriveLoaderSettings,
  derivePreparedSettings,
  expandThemeVariables,
  fontStyleRefusedAtPrepare,
  NEGATION_REFUSED,
  resolveThemeValues,
} from './resolve-values';

export type {
  AppearanceDiagnostic,
  AppearanceDiagnosticCode,
  AppearanceLocation,
} from './appearance-diagnostic';
export type {
  AdmonitionAppearance,
  AdmonitionIconAppearance,
  AdmonitionType,
  AppearanceModel,
  BaseAppearance,
  BlockFrame,
  ButtonAppearance,
  CalloutListAppearance,
  CaptionAppearance,
  CodeAppearance,
  CodespanAppearance,
  ConumAppearance,
  DescriptionListAppearance,
  ExampleAppearance,
  FontFacePaths,
  FontRequirement,
  FontSourceKind,
  FootnotesAppearance,
  HeadingAppearance,
  ImageAppearance,
  InlineBox,
  KbdAppearance,
  LinkAppearance,
  ListAppearance,
  MarkAppearance,
  MenuAppearance,
  PageAppearance,
  QuoteAppearance,
  SidebarAppearance,
  SpacingAppearance,
  TableAppearance,
  ThematicBreakAppearance,
  TocAppearance,
  Typography,
  UnalignedTypography,
  VerseAppearance,
} from './appearance-model';
export { ADMONITION_TYPES, HEADING_LEVELS } from './appearance-model';
export type { Colour, MeasurementBox } from './units';
export { MAX_FONT_FAMILY_LENGTH } from './units';
export {
  CLAIMED_THEME_KEYS,
  NAMED_THEME_KEYS,
  RENDERER_TEXT_ALIGN_KEYS,
  UNMODELLED_NAMED_THEME_KEYS,
  UNREAD_TEXT_ALIGN_KEYS,
} from './resolve-appearance';

/** What to resolve. */
export interface ResolveAppearanceInput {
  /** Raw theme document text, or undefined when the project has no theme. */
  readonly themeText?: string;
  /** Path of the theme document, used only to attribute diagnostics to a resource. */
  readonly themePath?: string;
}

/** What one resolution produced. */
export interface ResolveAppearanceResult {
  /** Always present — never null, whatever the input text was. */
  readonly appearance: AppearanceModel;
  /** Empty when nothing is wrong. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
  /** False when the appearance is the default because no theme applied, or none could be read. */
  readonly themeApplied: boolean;
}

/** The renderer's own default theme, parsed once — it is a constant, so it is resolved once. */
const DEFAULT_CASCADE = (() => {
  const parsed = parseThemeDocument(DEFAULT_THEME_YAML, { bundled: true });
  if (!parsed.ok) {
    // The default theme is vendored verbatim from the gem and regenerated by a script; if it stops
    // parsing, every appearance in the application is wrong and silence would be the worse failure.
    throw new Error(`The vendored default theme could not be read: ${parsed.failure.message}`);
  }
  const { values } = resolveThemeValues(parsed.theme.entries);
  return { values, fontFamilies: parsed.theme.fontFamilies };
})();

/** The appearance model of the renderer's default theme, built once and shared. */
const DEFAULT_APPEARANCE = buildAppearance({
  values: DEFAULT_CASCADE.values,
  defaults: DEFAULT_CASCADE.values,
  projectKeys: new Set(),
  lines: new Map(),
  fontFamilies: DEFAULT_CASCADE.fontFamilies,
}).appearance;

/**
 * The appearance a project with no theme of its own gets — the PDF export's own default.
 *
 * @returns The default appearance model. The same value every time, so callers may compare by
 *   identity to tell "no theme" from "a theme that resolved to the same thing".
 */
export function defaultAppearance(): AppearanceModel {
  return DEFAULT_APPEARANCE;
}

/** Combine the default catalogue with the project's, honouring the renderer's replace-unless-merge rule. */
function effectiveFontFamilies(
  project: readonly ThemeFontFamily[],
  merges: boolean,
): readonly ThemeFontFamily[] {
  if (project.length === 0) return DEFAULT_CASCADE.fontFamilies;
  if (!merges) return project;
  const byName = new Map(DEFAULT_CASCADE.fontFamilies.map((family) => [family.name, family]));
  for (const family of project) byName.set(family.name, family);
  return [...byName.values()];
}

/**
 * Substitute the `$references` in a catalogue's paths, as the renderer's own loader does.
 *
 * `process_entry` runs `expand_vars` over every path it stores (`theme_loader.rb:144`), so a theme
 * that keeps its font directory in a setting and writes `$fonts_dir/brand.ttf` loads a real file in
 * the export. Taking the path as written meant that face resolved to nothing in the preview alone.
 *
 * The budget is the RESOLUTION's, threaded in rather than minted per path. A catalogue is a LOOP over
 * a list the document controls — four style paths per family, and a family costs nine characters to
 * declare — so an allowance created inside the expansion is a per-value bound with nothing above it.
 * See {@link expandThemeVariables}.
 *
 * @param families - The catalogue exactly as the document wrote it.
 * @param values - The values resolved before the catalogue was reached, in document order.
 * @param budget - The resolution's remaining allowance, shared with every other expansion in it.
 * @returns The catalogue with its paths expanded, or {@link NEGATION_REFUSED} when expanding one of
 *   them would have refused the whole document.
 */
function expandCataloguePaths(
  families: readonly ThemeFontFamily[],
  values: ReadonlyMap<string, unknown>,
  budget: ExpansionBudget,
): readonly ThemeFontFamily[] | typeof NEGATION_REFUSED {
  const expanded: ThemeFontFamily[] = [];
  for (const family of families) {
    const styles: Record<string, string> = {};
    for (const [style, path] of Object.entries(family.styles)) {
      const text = expandThemeVariables(path, values, budget);
      if (text === NEGATION_REFUSED) return NEGATION_REFUSED;
      styles[style] = text;
    }
    expanded.push({ name: family.name, styles });
  }
  return expanded;
}

/**
 * Substitute the `$references` in the fallback names, which the loader expands the same way.
 *
 * `val.map {|name| expand_vars name.to_s, data }` (`theme_loader.rb:157`) — the same call the
 * catalogue's paths go through, so the same value refuses the same document from here.
 *
 * @param names - The fallback names exactly as the document wrote them.
 * @param values - The values resolved before `font` was reached, in document order.
 * @param budget - The resolution's remaining allowance, shared with every other expansion in it.
 * @returns The names with their references expanded, or {@link NEGATION_REFUSED}.
 */
function expandFallbackNames(
  names: readonly string[],
  values: ReadonlyMap<string, unknown>,
  budget: ExpansionBudget,
): string[] | typeof NEGATION_REFUSED {
  const expanded: string[] = [];
  for (const name of names) {
    const text = expandThemeVariables(name, values, budget);
    if (text === NEGATION_REFUSED) return NEGATION_REFUSED;
    expanded.push(text);
  }
  return expanded;
}

/**
 * The `extends` targets this module reproduces.
 *
 * Only one: the gem's `default-theme.yml`, which is vendored here and is the base of every cascade
 * below. Everything else the renderer accepts — `base`, its other bundled themes, a relative path to
 * another file in the project — would layer a different document, and none of them is available to a
 * pure resolver that reads one theme's text.
 */
const LAYERED_EXTENDS_TARGETS: ReadonlySet<string> = new Set(['default']);

/**
 * The keys this module may NAME in a diagnostic, which is the same closed set the model reads.
 *
 * Membership is what separates "a key we wrote down" from "a key the document did", and a diagnostic
 * only ever carries the first. See {@link resolveAppearance}'s `aboutKey`.
 */
const CLAIMED: ReadonlySet<string> = new Set(CLAIMED_THEME_KEYS);

/**
 * Why a document holding one unreadable colour is not read at all.
 *
 * The KEY is not named, even where the model would claim it, because the sentence has to hold for
 * every colour key a document can write and most of those are the document's own text. The line is
 * what points at it instead, which is what a reveal-in-editor control navigates by.
 */
const COLOUR_LOAD_FAILURE =
  'A colour in the theme document is written as a list the theme reader cannot read as one, and reading it stops the whole document being read.';

/**
 * Why a document holding one unreadable padding edge is not read at all.
 *
 * The same shape as {@link COLOUR_LOAD_FAILURE} — a conversion the loader performs while reading,
 * which raises out of it and reverts the whole document — and a sentence of its own for the reason
 * every other sentence here has one: what the author has to fix is elsewhere and is a different kind
 * of thing. Nothing is wrong with a colour, and being told a colour is unreadable would send them
 * looking down a column that has none. See `paddingRefusedAtLoad`.
 *
 * It names the two ENDS rather than the whole value because the loader only reads those two — a list
 * or a mapping in the second or fourth position loads and prints — so an author told "a padding edge"
 * without qualification would look at four values where only two can be at fault.
 *
 * The key is not named, on the same reasoning as the colour above: the sentence has to hold for every
 * padding key a document can write, and the line is what points at the one it wrote.
 */
const PADDING_LOAD_FAILURE =
  'A padding setting in the theme document has a boolean, a list or a mapping where its top or bottom edge was expected, and reading it stops the whole document being read.';

/**
 * Why a document that negates the wrong kind of variable is not read at all.
 *
 * The third refusal of the same shape, and the earliest of the three inside one setting: expansion
 * runs before `to_color` and before the padding rewrite. `'-' + val` (`theme_loader.rb:207`) takes a
 * String and nothing else, so `-$v` above a `v:` that holds an empty value, a boolean or a list
 * raises `TypeError` out of `ThemeLoader.load` and the export prints the default theme.
 *
 * A sentence of its own for the reason the other two have theirs: what the author must change is
 * somewhere else again, and it is a RELATIONSHIP between two lines rather than a fault in either.
 * Neither line alone is wrong — `v:` is a perfectly good setting and `-$v` a perfectly good value —
 * so a sentence about the value in front of the author's cursor would send them to fix the half that
 * is fine. It says which of the two ends can be changed, without naming either: the variable's value
 * must be a number or a piece of text.
 *
 * The KEY is not named and the VARIABLE is not quoted, on the same reasoning as the two above: a
 * negation is reachable from every key a document can write, including its own invented ones, and a
 * reference's name is the document's text.
 */
const NEGATION_LOAD_FAILURE =
  'A setting in the theme document puts a minus sign in front of a variable that holds an empty value, a boolean or a list, and only a number or a piece of text can be negated — so reading it stops the whole document being read.';

/**
 * The same fault written in the font catalogue, where no line can be pointed at.
 *
 * `process_entry` runs the same `expand_vars` over every catalogue path and every fallback name
 * (`theme_loader.rb:144` and `:157`), so the refusal is identical — but a catalogue path is not a
 * setting and has no entry, so there is no line in the map to attribute it to. Telling an author to
 * look at "a setting" and giving them nothing to look at would send them down the document; naming
 * the font catalogue is what replaces the line.
 */
const NEGATION_FONT_LOAD_FAILURE =
  'A font file path or fallback name in the theme document puts a minus sign in front of a variable that holds an empty value, a boolean or a list, and only a number or a piece of text can be negated — so reading it stops the whole document being read.';

/**
 * Why a theme whose `base.font-style` is not a word is not applied at all.
 *
 * The fourth road to the default appearance, and the first that is not the loader's: the document
 * READS, and the converter then throws it away while preparing it. `base_font_style&.to_sym`
 * (`converter.rb:573`) is a method String has and a number, a boolean and a list do not, so it
 * raises into the rescue at `converter.rb:575` and the export prints the default theme. See
 * {@link fontStyleRefusedAtPrepare} for what was measured.
 *
 * This one NAMES its key, where the three load refusals deliberately do not. Theirs have to hold for
 * every colour, padding or negated setting a document can write, most of which are the document's
 * own invented names; this one holds for a single key, and that key is in the closed vocabulary
 * {@link CLAIMED_THEME_KEYS} this module wrote. So the name carries nothing of the document, and it
 * is the one thing an author needs to know: nothing else in their theme is at fault.
 */
const FONT_STYLE_PREPARE_FAILURE =
  "The theme's base.font-style is a number, a boolean or a list rather than one of the renderer's style words, and the exported page turns that setting into a word before it draws anything — so the whole document is thrown away rather than that one setting.";

/**
 * Why one cascade pass refuses the whole document, or undefined where it read every value in it.
 *
 * One function over both kinds so that the caller cannot ask them in an order of its own: the order
 * is decided inside the pass, where the entries are, and a pass answers at most one of them.
 *
 * @param pass - What one cascade pass produced.
 * @returns The sentence and the line to point at, or undefined.
 */
function loadRefusal(
  pass: ResolvedValues,
): { readonly message: string; readonly line?: number } | undefined {
  // At most one of the three is ever set — `resolveThemeValues` keeps the first refusal it meets of
  // any kind — so this READS which one rather than deciding between them, and the pairs below are in
  // one list so the sentence cannot drift from the record it belongs to.
  const kinds = [
    [pass.refusedNegation, NEGATION_LOAD_FAILURE],
    [pass.refusedColour, COLOUR_LOAD_FAILURE],
    [pass.refusedPadding, PADDING_LOAD_FAILURE],
  ] as const;
  const found = kinds.find(([refusal]) => refusal !== undefined);
  if (found === undefined) return undefined;
  const [refused, message] = found;
  return { message, ...(refused?.line === undefined ? {} : { line: refused.line }) };
}

/**
 * The most settings one resolution names one at a time.
 *
 * Every theme key can produce a row, and a theme document may hold forty thousand of them — a list
 * that long is not an account of what is wrong, it is the same fact forty thousand times, and it is
 * built, sorted and rendered on the thread showing the preview.
 */
const MAX_REPORTED_SETTINGS = 50;

/**
 * The first of each equivalence class, in order, in one pass.
 *
 * @param items - What to deduplicate.
 * @param identity - What makes two items the same.
 * @returns The distinct items, in the order they were first met.
 */
function distinctBy<T>(items: readonly T[], identity: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = identity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Strip the `!important` suffix the renderer allows on an `extends` target before comparing it. */
function extendsTargetName(target: string): string {
  return target.replace(/ !important$/, '').trim();
}

/**
 * Resolve a project's theme text into the appearance the Print preview presents.
 *
 * @param input - The theme document's text and path, both optional.
 * @returns The appearance, any problems found, and whether a theme was applied at all.
 */
export function resolveAppearance(input: ResolveAppearanceInput = {}): ResolveAppearanceResult {
  const { themeText, themePath } = input;
  if (themeText === undefined || themeText.trim() === '') {
    return { appearance: DEFAULT_APPEARANCE, diagnostics: [], themeApplied: false };
  }

  /**
   * The default appearance under one sentence saying why the document was not read.
   *
   * Shared by the two roads to the same outcome — a document the reader refuses, and a document the
   * reader refuses while CONVERTING one of its values — because the export cannot tell them apart
   * either: both leave `ThemeLoader` through the same bare rescue and both print the default theme.
   *
   * @param reason - Why, in this module's own words. Never any of the document's text.
   * @param line - The line to point at, when there is one.
   * @returns The whole result, since nothing else of the document survives.
   */
  const unreadable = (reason: string, line?: number): ResolveAppearanceResult => ({
    appearance: DEFAULT_APPEARANCE,
    diagnostics: [
      {
        severity: 'error',
        code: 'theme-unparseable',
        message: `The theme document could not be read, so the default appearance is shown: ${reason}`,
        // The reason on its own, so a caller showing something other than the default can say so
        // without losing why. See `AppearanceDiagnostic.detail`.
        detail: reason,
        resource: themePath ?? 'theme',
        ...(themePath === undefined
          ? {}
          : { location: { path: themePath, ...(line === undefined ? {} : { line }) } }),
      },
    ],
    themeApplied: false,
  });

  const parsed = parseThemeDocument(themeText);
  // Returning here rather than reading on is what costs the ORDER between a refusal the READING
  // finds and one the cascade finds, and only that. The export raises once, wherever it gets to
  // first, and `converter.rb:556` reverts to the default theme for either — so a document wrong in
  // both places shows the same page whichever sentence it carries, and what the position decides is
  // which line the author is sent to.
  //
  // The two stages are the export's two stages, and each is in document order within itself. What
  // crosses the seam is a document whose LATER fault is the one the loader reaches first, because
  // `safe_load` finishes before `process_entry` starts while `expand_vars` runs inside it. Measured
  // against the vendored gem under ruby 3.3.3: `v: true\nzzz: -$v\nfont:\n  catalog:\n    B:\n
  // normal: 10` raises `TypeError` over the negation on line 2, and this reports the font style;
  // `v: true\nfont:\n  fallbacks: [-$v]\n10:\n  font_size: 5` raises `TypeError` over the fallback,
  // and this reports the non-string key.
  //
  // Left as it is, deliberately, and for the reason the collection-key seam inside the reading is —
  // see {@link readThemeDocument}. Closing it would mean running the cascade over a document the
  // reading has already refused, so that the two answers could be ordered against each other: work
  // spent, per keystroke, on a document that is going to show the default page either way.
  if (!parsed.ok) return unreadable(parsed.failure.message, parsed.failure.line);

  // Two passes over one list of entries, split where the font catalogue was written: the renderer
  // expands a catalogue path against what it has loaded at that point, so a path can only refer
  // backwards, exactly as a setting can.
  //
  // ONE allowance for the whole resolution, threaded through both passes, the catalogue's paths and
  // the fallback list. Every one of those used to mint its own — the two cascade passes one each, and
  // the expansions one PER CALL, in a loop the document sizes — so what `MAX_EXPANSION_BUDGET` claims
  // to be a bound on a whole resolution bounded nothing above a single value.
  const budget = createExpansionBudget();
  const { entries, fontCatalogueEntryIndex } = parsed.theme;
  const beforeCatalogue = resolveThemeValues(
    entries.slice(0, fontCatalogueEntryIndex),
    DEFAULT_CASCADE.values,
    budget,
  );
  const afterCatalogue = resolveThemeValues(
    entries.slice(fontCatalogueEntryIndex),
    beforeCatalogue.values,
    budget,
  );
  // A negation, `to_color` and the padding rewrite all run as the theme is READ, so a value any of
  // them raises on is not a rejected setting — it is a document the export threw away whole, down to
  // the settings written above it. See `resolveThemeValues`, `NEGATION_REFUSED`,
  // `colourRefusedAtLoad` and `paddingRefusedAtLoad`. Checked before the appearance is built, because
  // there is no appearance to build: the page is the default one.
  //
  // Within ONE pass the three are mutually exclusive — the cascade keeps the first refusal it meets
  // of any kind — so the only order left to decide is between the passes and the font declarations
  // that sit between them, and the earlier of those holds the earlier settings.
  const beforeRefusal = loadRefusal(beforeCatalogue);
  if (beforeRefusal !== undefined) return unreadable(beforeRefusal.message, beforeRefusal.line);

  // Expanded HERE rather than at the point they are handed to the model, because the catalogue sits
  // exactly at the split: `process_entry` reaches `font.catalog` and `font.fallbacks` between the
  // settings written above them and the settings written below. Doing it later left a refusal in a
  // path being reported after a refusal in a setting the loader never reached, and spent the shared
  // allowance in an order the export does not.
  const catalogue = expandCataloguePaths(parsed.theme.fontFamilies, beforeCatalogue.values, budget);
  const fallbacks = expandFallbackNames(parsed.theme.fontFallbacks, beforeCatalogue.values, budget);
  // The flat spellings of the same two keys, expanded for their refusal and nothing else. See
  // {@link ParsedTheme.expandedOnlyStrings}: the module does not read the faces they declare, and a
  // path it does not read is still a path the export throws the document away over.
  const flatFontRefusal = parsed.theme.expandedOnlyStrings.some(
    (declared) =>
      expandThemeVariables(
        declared.text,
        // `<=`, because a declaration AT the split is the declaration the split was taken from: the
        // loader has read the settings above it and none below. A strict `<` sent the first font
        // declaration in the document — whose index is the split — to the finished cascade instead.
        declared.index <= fontCatalogueEntryIndex ? beforeCatalogue.values : afterCatalogue.values,
        budget,
      ) === NEGATION_REFUSED,
  );
  if (catalogue === NEGATION_REFUSED || fallbacks === NEGATION_REFUSED || flatFontRefusal) {
    return unreadable(NEGATION_FONT_LOAD_FAILURE);
  }

  const afterRefusal = loadRefusal(afterCatalogue);
  if (afterRefusal !== undefined) return unreadable(afterRefusal.message, afterRefusal.line);

  // Last, and only once the whole document has been read: `load_theme` derives its seven settings
  // after `load_file` returns, so they see the merge rather than any one pass of it. Placed after
  // the refusals for the same reason — a document the loader threw away never reaches line 82, and
  // deriving a face onto a cascade that is about to be replaced by the default appearance would be
  // work spent on a page nobody sees. See {@link deriveLoaderSettings}.
  const loaded = deriveLoaderSettings(afterCatalogue.values);

  // The converter's turn, and its own refusal comes first: `prepare_theme` reads `base.font-style`
  // on its fourth line, and for a value that is not text there is no prepared theme to derive
  // anything onto. See {@link FONT_STYLE_PREPARE_FAILURE}.
  //
  // The line is looked up only when the document is being refused, and it is the LAST occurrence
  // because the last one is what the cascade holds — a document that writes the key twice is refused
  // over the value that reached the converter, not over the one it replaced. The `lines` map below
  // is built the same way and says the same thing, and is deliberately not hoisted above this: a
  // document that never reaches the appearance should not pay a pass over its entries to build one.
  //
  // The two readings cannot be told apart today, because the reader attributes ONE line per key — the
  // last place the document wrote it — to every entry it makes for that key. So this is a choice
  // about which entry is meant rather than about which line comes back, and it is written to match
  // the map below so that the two do not drift if that ever changes.
  if (fontStyleRefusedAtPrepare(loaded)) {
    const written = entries.findLast((entry) => entry.key === 'base_font_style');
    return unreadable(FONT_STYLE_PREPARE_FAILURE, written?.line);
  }

  const values = derivePreparedSettings(loaded);
  const unresolved = [...beforeCatalogue.unresolved, ...afterCatalogue.unresolved];
  const oversized = [...beforeCatalogue.oversized, ...afterCatalogue.oversized];

  // The document's own keys, which a derived setting is NOT. Membership decides whether a value the
  // model cannot read is spoken about, and a derivation is this module's inference rather than
  // something the author typed: `heading: font_family: 0` is one mistake on one line, and telling
  // the author about `sidebar.title.font-family` as well would send them to a line they never wrote.
  // It cuts the other way too — a face the author DID write as `false` is replaced by the loader
  // before anything reads it, so the rejection that used to be reported was about a value the export
  // never saw.
  const projectKeys = new Set(entries.map((entry) => entry.key));
  const lines = new Map<string, number>();
  for (const entry of entries) {
    if (entry.line !== undefined) lines.set(entry.key, entry.line);
  }

  const { appearance, diagnostics } = buildAppearance({
    values,
    defaults: DEFAULT_CASCADE.values,
    projectKeys,
    lines,
    ...(themePath === undefined ? {} : { themePath }),
    fontFamilies: effectiveFontFamilies(catalogue, parsed.theme.fontCatalogueMerges),
    // Expanded against the same values the catalogue's paths are, because they are written at the
    // same point in the document — `font.fallbacks` sits beside `font.catalog` under `font`.
    fontFallbacks: fallbacks,
    mappingKeys: parsed.theme.mappingKeys,
  });

  // A dangling `$reference` leaves the reference visible in the value, which then fails to parse and
  // is already reported as a rejected value. Reporting it a second time would double-count one
  // mistake, so only references whose key the model does not read are surfaced here — those are the
  // ones nothing else would mention.
  const reportedKeys = new Set(diagnostics.map((diagnostic) => diagnostic.themeKey));

  /**
   * A warning about one setting, attributed to the line the theme wrote it on.
   *
   * The setting is NAMED only when its name is this module's own vocabulary. A flat theme key is the
   * document's text — YAML allows a thousand characters of it, and every character of it is the
   * author's — so interpolating one put arbitrary attacker-chosen prose into the application's own
   * warning list, addressed to whoever the theme was shared with. React escapes it, so it was never
   * markup; it was a sentence of the attacker's beside a sentence of ours, which is the more
   * durable problem. A key the model claims is drawn from {@link CLAIMED_THEME_KEYS} — a closed set
   * this module wrote — so naming one of those carries nothing of the document.
   *
   * What is lost is the name of a setting the model does not read, and the location is what replaces
   * it: the diagnostic still points at the line, which is what a reveal-in-editor control needs and
   * what an author navigates by.
   *
   * @param key - The flat theme key, used to attribute a line whether or not it is named.
   * @param named - The sentence for a key this module can name, given its dotted form.
   * @param anonymous - The sentence for a key it cannot.
   * @returns The diagnostic.
   */
  const aboutKey = (
    key: string,
    named: (dotted: string) => string,
    anonymous: string,
  ): AppearanceDiagnostic => {
    const line = lines.get(key);
    const claimed = CLAIMED.has(key);
    return {
      severity: 'warning',
      code: 'theme-value-rejected',
      message: claimed ? named(key.replaceAll('_', '.')) : anonymous,
      ...(claimed ? { themeKey: key } : {}),
      resource: themePath ?? 'theme',
      ...(themePath === undefined
        ? {}
        : { location: { path: themePath, ...(line === undefined ? {} : { line }) } }),
    };
  };

  // Deduplicated through a Set rather than by scanning what came before, which is what this did:
  // `findIndex` inside `filter` is quadratic in the number of entries, and the number of entries is
  // one per theme key. A 512 KB document — a size this module accepts — holds forty thousand of
  // them, and the two scans below cost over a second between them before a diagnostic was built.
  const dangling = distinctBy(
    unresolved.filter((reference) => !reportedKeys.has(reference.key)),
    (reference) => JSON.stringify([reference.key, reference.reference]),
  );

  // A value whose `$references` expand past what the resolver will build. It is reported here rather
  // than left to fail as an unreadable value, because the two are not the same mistake: the key's own
  // text is fine, and it is the chain of references behind it that cannot be followed.
  const unexpandable = distinctBy(
    oversized.filter((value) => !reportedKeys.has(value.key)),
    (value) => value.key,
  );

  // Whether the document extends anything this resolver does not layer. One diagnostic, not one per
  // target: it is a single decision the document made, not a fault in any of its settings. The target
  // is deliberately NOT named — it is the document's own text, and a diagnostic never carries that.
  const extendsUnlayered = parsed.theme.extendsTargets.some(
    (target) =>
      extendsTargetName(target) !== '' && !LAYERED_EXTENDS_TARGETS.has(extendsTargetName(target)),
  );

  // One row per setting, and a theme may hold tens of thousands of them. The list is capped rather
  // than truncated silently: what is dropped is said, and it is dropped from the END, after the
  // rejections the model found — those name keys the page is actually dressed by, and there are at
  // most as many of them as the model claims keys.
  const perSetting = [
    ...dangling.map((reference) =>
      aboutKey(
        reference.key,
        (dotted) => `The theme's ${dotted} refers to a variable the theme does not define.`,
        'A setting in the theme refers to a variable the theme does not define.',
      ),
    ),
    ...unexpandable.map((value) =>
      aboutKey(
        value.key,
        (dotted) =>
          `The theme's ${dotted} expands into far more text than a theme value can hold, so its default is used instead.`,
        'A setting in the theme expands into far more text than a theme value can hold, so its default is used instead.',
      ),
    ),
  ];
  const withheld = Math.max(0, perSetting.length - MAX_REPORTED_SETTINGS);

  return {
    appearance,
    diagnostics: [
      ...diagnostics,
      ...perSetting.slice(0, MAX_REPORTED_SETTINGS),
      ...(withheld === 0
        ? []
        : [
            {
              severity: 'warning',
              code: 'theme-value-rejected',
              message: `${withheld} further settings in the theme have the same kinds of problem and are not listed individually.`,
              resource: themePath ?? 'theme',
              ...(themePath === undefined ? {} : { location: { path: themePath } }),
            } satisfies AppearanceDiagnostic,
          ]),
      ...(extendsUnlayered
        ? [
            {
              severity: 'warning',
              code: 'theme-value-rejected',
              message:
                "The theme extends a document other than the renderer's default theme, which this preview does not layer — it shows the default theme beneath this one instead, so the exported page may differ.",
              themeKey: 'extends',
              resource: themePath ?? 'theme',
              ...(themePath === undefined ? {} : { location: { path: themePath } }),
            } satisfies AppearanceDiagnostic,
          ]
        : []),
    ],
    themeApplied: true,
  };
}
