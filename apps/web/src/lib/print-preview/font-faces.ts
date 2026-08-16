/**
 * @file Where the Print preview's typefaces come from, and what happens when one is not there.
 *
 * The preview's claim about line lengths is a claim about font files, so this module's whole job is
 * to get the browser the same file the renderer uses — the project's own, or the gem's own converted
 * subset — and to be honest when it cannot.
 *
 * Four sources, in priority order:
 *
 *  1. **project** — a face the theme's catalogue names as a project file, fetched through the
 *     application's existing project-asset mechanism. No new route, no new storage reader, and no
 *     path assembled here: the path is the one the theme wrote, handed to the mechanism that already
 *     validates it for every image and font the PDF pipeline loads.
 *  2. **catalogue** — the gem's own subsets, converted to WOFF2 and published as committed assets by
 *     `packages/asciidoc-pdf`, served from this application's own origin. Not `next/font`'s copy of
 *     the same family: same name, different build, different metrics.
 *  3. **substitute** — a stand-in for one of the PDF base-14 core fonts, which are the one family of
 *     faces that has no file to serve at all. See {@link SUBSTITUTE_FAMILIES}.
 *  4. **fallback** — a same-classification local stack. No fetch of any kind.
 *
 * Font bytes are never interpreted here. They go to the browser's own font loader as opaque bytes,
 * which is both the only correct way to load a font and the reason untrusted project content can be
 * loaded as one at all.
 *
 * Nothing in this module can reach outside the application's origin: the only URLs it can produce are
 * built from {@link CATALOGUE_FONT_BASE} and a file name out of the committed manifest.
 */

import type { AppearanceDiagnostic, FontRequirement, FontSourceKind } from '@asciidocollab/shared';
import manifest from '@asciidocollab/asciidoc-pdf/assets/fonts/manifest.json';
// The stand-ins' `browser.json` and not their `manifest.json`: the manifest is an audit record as
// much as a lookup table — a content hash, a source hash, a byte count and the two dozen divergent
// advances per face — and none of that is readable from here. It is not droppable either, because a
// bundler cannot prune fields from inside an array of objects, so importing the manifest put about
// 6 KB of evidence into every bundle that loads the Print preview. The generator writes both files
// and its `--check` compares both; `tests/fonts/base14-fonts.test.ts` holds this one to being the
// manifest projected.
import base14Manifest from '@asciidocollab/asciidoc-pdf/assets/base14-fonts/browser.json';
import { resolveSandboxedPath } from '@/lib/asciidoc/sandbox-path';

/** Where the catalogue faces are served from. Kept in step with `scripts/build-catalogue-fonts.mjs`. */
export const CATALOGUE_FONT_BASE = '/vendor/catalogue-fonts/';

/**
 * Where the base-14 stand-ins are served from. Kept in step with `scripts/build-catalogue-fonts.mjs`.
 *
 * A path of its own, not a corner of the catalogue's: what the two directories hold is two different
 * claims, and one directory holding both is how a reader of either stops being able to tell which
 * they have.
 */
export const SUBSTITUTE_FONT_BASE = '/vendor/base14-fonts/';

/** The catalogue's own path marker: a face the GEM supplies, not one the project does. */
const GEM_FONTS_DIR = 'GEM_FONTS_DIR/';

/** The four faces a family may declare, in the theme's own spelling. */
export const FACE_STYLES = ['normal', 'bold', 'italic', 'boldItalic'] as const;

/** One of the four faces a family may declare. */
export type FaceStyle = (typeof FACE_STYLES)[number];

/** The manifest's own spelling of each style, which uses the renderer's underscore form. */
const MANIFEST_STYLE: Readonly<Record<FaceStyle, string>> = {
  normal: 'normal',
  bold: 'bold',
  italic: 'italic',
  boldItalic: 'bold_italic',
};

/** The CSS weight and slant each face stands for. */
const FACE_CSS: Readonly<Record<FaceStyle, { weight: number; style: 'normal' | 'italic' }>> = {
  normal: { weight: 400, style: 'normal' },
  bold: { weight: 700, style: 'normal' },
  italic: { weight: 400, style: 'italic' },
  boldItalic: { weight: 700, style: 'italic' },
};

/** One face the preview will load, and where it comes from. */
export interface PlannedFace {
  /** The family name the appearance's `fontFamily` values use. */
  readonly family: string;
  /** Which of the four faces this is. */
  readonly style: FaceStyle;
  /** CSS `font-weight` for the `@font-face` descriptor. */
  readonly weight: number;
  /** CSS `font-style` for the `@font-face` descriptor. */
  readonly slant: 'normal' | 'italic';
  /** Which source supplies it. */
  readonly source: FontSourceKind;
  /** Same-origin URL, for a `catalogue` face. */
  readonly url?: string;
  /** Project-relative asset path, for a `project` face. */
  readonly assetPath?: string;
}

/**
 * The metrics a face is registered WITH, rather than the ones its file happens to carry.
 *
 * A browser and the renderer read a font file's vertical metrics from different tables — Skia takes
 * `hhea` unless the font asks for OS/2 typographic metrics, ttfunk prefers OS/2 whenever it is there
 * — and in the gem's own catalogue they disagree by a third of an em. These descriptors are how CSS
 * lets the answer be stated rather than discovered, so every box the preview draws around a run of
 * text is measured the way the export measures it. Percentages of the em, as the descriptors take
 * them; `font-metrics.ts` computes them from the same numbers the renderer uses.
 */
export interface FaceMetricOverrides {
  /** CSS `ascent-override`. */
  readonly ascentOverride: string;
  /** CSS `descent-override`. */
  readonly descentOverride: string;
  /** CSS `line-gap-override`. */
  readonly lineGapOverride: string;
}

/**
 * Which of a face's two registrations a set of overrides is for.
 *
 * One file goes into the font set twice under two names, because the renderer measures a face two
 * ways and CSS can only be told one of them per `@font-face`. `text` is the family the theme names
 * and the page's prose is set in; `box` is the derived name of {@link metricFamilyOf}, which only the
 * constructs that paint a box behind their own glyphs are set in. See `faceLineOverrides` and
 * `faceBoxOverrides` in `font-metrics.ts` for the two readings and why they differ.
 */
export type FaceRegistration = 'text' | 'box';

/**
 * The name the same file is registered under a second time, for the constructs that paint their own box.
 *
 * One file, two registrations, and BOTH now carry the metrics ttfunk reads — see {@link loadOne} for
 * why the first one does. The second exists because the stylesheet has to be able to NAME the face a
 * box-painting construct is measured in — a codespan's tint, a key cap, a button — separately from
 * the face the surrounding text is set in, and a font stack is the only way CSS lets that be said.
 * That box is the browser's content area, and the renderer's is its text fragment, and the two are
 * the same box only when the two agree about the face.
 *
 * ## Why the separator is a character no theme can write
 *
 * The suffix used to be ` print-metrics`, spelled entirely out of characters `parseFontFamily`
 * admits — and that made the derived name FORGEABLE. A theme may declare a family called literally
 * `Foo print-metrics` and another called `Foo`, and both are ordinary names: the first is 17
 * characters of `[\w +.-]`, well inside the 64 the resolver allows. Family `Foo`'s box registration
 * and family `Foo print-metrics`'s TEXT registration then go into `document.fonts` under one name at
 * the same weight and slant, and a font set has no notion of who added what. Measured in Chromium:
 * the last one declared wins outright, and declaration order follows `resolveAppearance`'s own `fonts`
 * emission order — so which FILE a codespan is measured and drawn with became a function of the order
 * two keys happen to appear in a theme document. Not a metric mix-up: the wrong typeface, the wrong
 * advances, and every line of that construct breaking somewhere else.
 *
 * `·` closes it by construction rather than by a check. `parseFontFamily` tests `/^[\w +.-]+$/`
 * without the unicode flag, so `\w` is ASCII and no name it returns can hold this character; the
 * derived name is therefore in a namespace the theme cannot reach, and no guard has to be kept in
 * step with the resolver's alphabet. A whitespace separator would have done as well against a theme
 * and worse against a browser — family names are matched after tokenising, and leading or trailing
 * space is exactly what an engine may normalise away.
 *
 * It also has to survive being a family name in CSS, which is what ruled out the ASCII punctuation
 * outside `[\w +.-]`. A code point at or above `U+0080` is a valid identifier character, so
 * `Noto Serif·print-metrics` is a well-formed `<family-name>` unquoted as well as quoted, where
 * `Noto Serif#print-metrics` is neither — and a strict engine rejecting it in the `FontFace`
 * constructor would silently disable every box registration on the page. Measured in Chromium: the
 * name registers, matches through a real stylesheet rule, and is a different family from the same
 * name spelled with a space (three registrations of one file under three ascents, each found).
 *
 * The suffix is still a name and not a marker to parse: nothing reads it back.
 *
 * @param family - The family the theme names.
 * @returns The name the metric-bearing registration takes.
 */
export function metricFamilyOf(family: string): string {
  return `${family}·print-metrics`;
}

/**
 * The same overrides written as the declarations of an `@font-face` RULE.
 *
 * The application registers its faces through the `FontFace` constructor, which takes them as an
 * object; a page assembled as text has to spell the same three descriptors out. Both spellings are
 * produced from one definition so that a page built out of the stylesheet cannot be measuring a face
 * the application would register differently.
 *
 * @param overrides - The metrics to register the face with, or undefined for none.
 * @returns The declarations, ready to drop inside an `@font-face` block; empty for undefined.
 */
export function faceMetricDeclarations(overrides: FaceMetricOverrides | undefined): string {
  if (overrides === undefined) return '';
  return (
    `ascent-override: ${overrides.ascentOverride}; ` +
    `descent-override: ${overrides.descentOverride}; ` +
    `line-gap-override: ${overrides.lineGapOverride};`
  );
}

/**
 * What one family resolved to, and what has to be fetched to draw it.
 *
 * There is no list of the families that fell back, at either stage. There was one, and it said the
 * same thing as {@link FontPlan.diagnostics} — every diagnostic already names the family it is about
 * as its `resource`, and a family that fell back is exactly a family with a diagnostic. Two
 * representations of one fact, one of which nothing outside this module ever read, is how they drift.
 */
export interface FontPlan {
  /** Every face to load, project and catalogue alike. Fallback families contribute none. */
  readonly faces: readonly PlannedFace[];
  /** Project-relative paths to fetch through the existing asset mechanism, deduplicated. */
  readonly assetPaths: readonly string[];
  /** One per family that could not be supplied; the stylesheet's per-construct fallback covers it. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

/** Family → the styles the committed catalogue holds for it. */
const CATALOGUE: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  manifest.families.map((entry) => [
    entry.family,
    new Map(Object.entries(entry.faces).map(([style, face]) => [style, face.file])),
  ]),
);

/** Every family the gem's default theme declares, for the assertion that none of them falls back. */
export const CATALOGUE_FAMILIES: readonly string[] = manifest.families.map((entry) => entry.family);

/** Built-in font name → the file the committed stand-in for it is published as. */
const SUBSTITUTE_FILES: ReadonlyMap<string, string> = new Map(
  base14Manifest.faces.map((face) => [face.name, face.file]),
);

/**
 * Family → style → the stand-in file, for the fourteen names prawn will load an AFM for.
 *
 * The keys are prawn's own family table, generated from it rather than written out here: three
 * composite families that map four styles onto four different faces (`font.rb:171-194`), and eleven
 * more names that a theme may name directly and that resolve to ONE face whatever style is asked for,
 * because `find_font` only consults the style for a name the family table holds (`font.rb:238-242`).
 * That is why a bold Symbol is Symbol, and why all four styles of `Times-Bold` are Times-Bold: the
 * export does not synthesise a slant for these, and a preview registering only `normal` would have
 * the browser synthesise one the page does not have.
 */
const SUBSTITUTES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  base14Manifest.families.map((entry) => [
    entry.family,
    new Map(
      Object.entries(entry.faces).map(([style, name]) => [style, SUBSTITUTE_FILES.get(name) ?? '']),
    ),
  ]),
);

/**
 * The fourteen family names the PDF base-14 core fonts answer to, and what the preview does with them.
 *
 * These are the one set of faces the renderer draws from no file at all. `Prawn::Fonts::AFM#register`
 * writes a font dictionary of `Type`, `Subtype` and `BaseFont` and embeds nothing (`afm.rb:157-167`),
 * because a PDF viewer is required to supply them; prawn carries only their published METRICS. So the
 * preview cannot be handed the export's own bytes here, and until these existed it reported the
 * fourteen as fonts it could not load — including `Helvetica`, which is what a theme that names no
 * base font family gets (`converter.rb:572`).
 *
 * What it is handed instead is a typeface drawn to the same published metrics: TeX Gyre for the twelve
 * text faces, Foxit for Symbol and ZapfDingbats. Every advance is the export's own, bar two dozen
 * characters recorded face by face in the committed manifest, and the line box is prawn's rather than
 * the stand-in's — see `packages/asciidoc-pdf/scripts/generate-base14-fonts.mjs`.
 *
 * ## Why no diagnostic is reported for them
 *
 * Because there is nothing true to say that is also worth saying. The existing warnings each name
 * something an author can act on — supply the font file, add the missing italic, fix the theme — and
 * each is about a page whose LAYOUT is wrong: a family that fell back has different widths, so every
 * line breaks somewhere else. A stand-in breaks every line where the export breaks it, sets every box
 * where the export sets it, and differs only in the drawing of the glyph. No author action exists for
 * that; the base fourteen have no file to ship, by design. And because `Helvetica` is the default
 * base font family of any theme that does not name one, a warning here would sit permanently on
 * pages that are, by the measure this preview exists to make, correct.
 *
 * The two dozen divergent advances are recorded in the manifest, where they can be reviewed once,
 * rather than announced on every render of a page that may not contain any of those characters.
 */
export const SUBSTITUTE_FAMILIES: readonly string[] = base14Manifest.families.map(
  (entry) => entry.family,
);

/**
 * The project file a theme declared for one face, or undefined when it declared none.
 *
 * A catalogue path is written relative to the theme document that declares it, and is resolved the
 * same way the PDF pipeline's own asset collector resolves it — through the shared sandbox, from the
 * theme's own directory. Taking the path as written would ask for a different file whenever the theme
 * is not at the project root, and would let one escape the project when it tried to.
 *
 * @param requirement - The family and the faces its theme declared.
 * @param style - Which face.
 * @param themePath - The theme document's project-relative path.
 * @returns The project-relative asset path, or undefined when there is no project file to ask for.
 */
function declaredPath(
  requirement: FontRequirement,
  style: FaceStyle,
  themePath: string,
): string | undefined {
  const path = requirement.declaredFaces[style];
  if (path === undefined || path.trim() === '') return undefined;
  // The renderer resolves its own bundled faces out of its own directory; the project has no such file.
  if (path.startsWith(GEM_FONTS_DIR)) return undefined;
  const resolved = resolveSandboxedPath(themePath, path);
  return resolved.ok ? resolved.path : undefined;
}

/**
 * Why a family could not be supplied — one of two, not a phrase a caller writes.
 *
 * A closed set rather than a `string` parameter because the sentence a diagnostic states has to be
 * this module's own, and a free parameter is how something else's text gets into one. Naming the case
 * and keeping the words here means a new call site chooses between the sentences below or adds one,
 * and cannot pass a sentence in.
 */
type UnavailableReason = 'unsupported' | 'unloadable';

/** What each case says. The family itself is named by `resource` — see {@link unavailable}. */
const UNAVAILABLE_SENTENCE: Readonly<Record<UnavailableReason, string>> = {
  unsupported: 'This font is not one this preview can load',
  unloadable: 'This font could not be loaded',
};

/**
 * The diagnostic reported for a family that could not be supplied from either source.
 *
 * The family is carried as `resource` and named nowhere in the message. That is not a matter of
 * escaping — a family name is bounded to 64 characters of `[\w +.-]`, so it can hold no markup and no
 * URL — it is a matter of where the words come from. Spaces and full stops are admitted because real
 * families carry them, and the same characters spell a sentence: interpolating a name put up to
 * sixty-four characters of a project collaborator's own prose inside the application's warning to
 * whoever the project is shared with. `resource` is the field `AppearanceDiagnostic` documents as
 * carrying a font family name, and the diagnostics surface renders it as a separate datum rather than
 * as part of our sentence, which is exactly the distinction being drawn.
 *
 * @param family - The family that could not be supplied.
 * @param reason - Which of the two cases this is.
 * @returns The diagnostic to report.
 */
function unavailable(family: string, reason: UnavailableReason): AppearanceDiagnostic {
  return {
    severity: 'warning',
    code: 'theme-font-unavailable',
    message: `${UNAVAILABLE_SENTENCE[reason]}, so an approximation is shown. Text set in it will not match the PDF exactly.`,
    resource: family,
  };
}

/**
 * The diagnostic for a family the page really is set in, missing one of its four faces.
 *
 * A different thing from {@link unavailable} and said differently, because the difference is the whole
 * of what an author can do about it. A family that could not be supplied is not on the page at all —
 * another typeface is, with its own widths, and every line breaks somewhere else. A family missing its
 * italic IS on the page, and the browser slants the upright face to stand in for the one that is
 * absent: the same widths, the same line breaks, a slope drawn rather than designed.
 *
 * This distinction used to be carried by a list of family names that the preview never received, next
 * to a message that told both cases they were seeing "an approximation". The list is gone and the
 * message now draws the line, because the message is what the preview actually presents — the surface
 * takes a severity, a message and a resource, and drops the code (`to-diagnostic-properties.ts`).
 *
 * Which family it is about is carried by `resource` and not by the message, for the reason
 * {@link unavailable} gives.
 *
 * @param family - The family that is drawing, incompletely.
 * @returns The diagnostic to report.
 */
function synthesised(family: string): AppearanceDiagnostic {
  return {
    severity: 'warning',
    code: 'theme-font-unavailable',
    message:
      'This font is missing some of its faces, so the browser is drawing them from the ones it has. ' +
      'A synthesised bold or italic is not the one the PDF is set in.',
    resource: family,
  };
}

/**
 * Decide where each face of each family the appearance references comes from.
 *
 * Pure: it decides, it does not fetch. Whether a project file is actually there is not knowable
 * here, and is reported by {@link loadFontFaces} once the answer exists.
 *
 * @param fonts - The families the resolved appearance references.
 * @param themePath - The theme document's path, which its catalogue's own paths are relative to.
 * @returns The faces to load, the project paths they need, and what could not be supplied at all.
 */
export function planFontFaces(fonts: readonly FontRequirement[], themePath = ''): FontPlan {
  const faces: PlannedFace[] = [];
  const assetPaths = new Set<string>();
  const diagnostics: AppearanceDiagnostic[] = [];

  for (const requirement of fonts) {
    const catalogue = CATALOGUE.get(requirement.family);
    // Consulted only where the catalogue has nothing, which is a distinction without a difference
    // today — the gem's catalogue families and prawn's fourteen built-in names do not overlap — and is
    // written down anyway so that a gem which one day shipped its own `Helvetica` would win. A file
    // the renderer really embeds beats a stand-in for one it does not.
    const substitute = catalogue === undefined ? SUBSTITUTES.get(requirement.family) : undefined;
    const familyFaces: PlannedFace[] = [];

    for (const style of FACE_STYLES) {
      const css = FACE_CSS[style];
      const path = declaredPath(requirement, style, themePath);

      // A file the project itself ships takes priority: a project that ships its own build of a family
      // means that build, not one that merely shares its name.
      if (path !== undefined) {
        familyFaces.push({
          family: requirement.family,
          style,
          weight: css.weight,
          slant: css.style,
          source: 'project',
          assetPath: path,
        });
        assetPaths.add(path);
        continue;
      }

      const file = catalogue?.get(MANIFEST_STYLE[style]);
      if (file !== undefined) {
        familyFaces.push({
          family: requirement.family,
          style,
          weight: css.weight,
          slant: css.style,
          source: 'catalogue',
          url: `${CATALOGUE_FONT_BASE}${file}`,
        });
        continue;
      }

      const substituteFile = substitute?.get(MANIFEST_STYLE[style]);
      if (substituteFile !== undefined && substituteFile !== '') {
        familyFaces.push({
          family: requirement.family,
          style,
          weight: css.weight,
          slant: css.style,
          source: 'substitute',
          url: `${SUBSTITUTE_FONT_BASE}${substituteFile}`,
        });
      }
    }

    if (familyFaces.length === 0) {
      diagnostics.push(unavailable(requirement.family, 'unsupported'));
      continue;
    }
    faces.push(...familyFaces);
  }

  return { faces, assetPaths: [...assetPaths], diagnostics };
}

/** What the caller supplies so a planned face can actually be loaded. */
export interface FontLoaderPorts {
  /**
   * The bytes of one project asset, or undefined when it is not held.
   *
   * @param path - The project-relative path the theme declared.
   * @returns The asset's bytes, or undefined when absent or unreadable.
   */
  readonly getAssetBytes: (path: string) => Uint8Array | undefined;
  /** The document's font set. Injected so the loader is testable without a document. */
  readonly fontSet: FontFaceSet;
  /**
   * Build a font face. Injected for the same reason.
   *
   * @param family - The family name to register the face under.
   * @param source - Either the bytes, or a CSS `src` string for a same-origin URL.
   * @param descriptors - Weight and style.
   * @returns The face, unloaded.
   */
  readonly createFace: (
    family: string,
    source: BufferSource | string,
    descriptors: FontFaceDescriptors,
  ) => FontFace;
  /**
   * The metrics to register one face with, or undefined to leave the browser's own reading alone.
   *
   * Injected rather than computed here for the same reason the bytes are: this module hands font
   * files to the browser and interprets none of them, which is what lets untrusted project content
   * be loaded as a font at all. Reading a file's metric tables is `font-metrics.ts`'s job, and it
   * already does it for the line box.
   *
   * @param family - The family the face belongs to.
   * @param style - Which of the four faces this is.
   * @param registration - Which of the face's two registrations the descriptors are for.
   * @returns The overrides, or undefined when this preview has no metrics for that face.
   */
  readonly metricOverridesOf?: (
    family: string,
    style: FaceStyle,
    registration: FaceRegistration,
  ) => FaceMetricOverrides | undefined;
}

/**
 * What one load attempt produced.
 *
 * Two facts, because the caller needs exactly two: what to report, and what to take back out of the
 * document afterwards. The lists of which families loaded and which fell back are deliberately not
 * here — see {@link FontPlan}, and {@link synthesised} for where the distinction between a family
 * that is absent and one that is merely incomplete is actually said.
 */
export interface LoadedFonts {
  /** One per family that could not be supplied, or whose file could not be used. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
  /**
   * The faces this attempt put into the font set.
   *
   * Handed back so the caller can take them out again. A font set is a document-wide collection with
   * no notion of who added what: register a family twice and both faces stay, and the browser may
   * keep matching the older one — which is how an author who replaces their font file goes on seeing
   * the file they replaced.
   */
  readonly added: readonly FontFace[];
}

/**
 * A load that failed partway, carrying the faces it had already put into the font set.
 *
 * A font set is document-wide and has no notion of who added what, so a face is removable only by the
 * exact object that was added — which lives in the `added` list and nowhere else. Resolving carries
 * that list back to the caller; REJECTING used to drop it on the floor, and the faces this attempt
 * had already registered then stayed in the document for the life of the page, unremovable by the
 * supersede path or by unmounting. Every Print → elsewhere → Print cycle stacked another set, which
 * is the "two faces of one family in the set" hazard the caller is otherwise careful about.
 *
 * So the two exits carry the same fact. Anything a caller does with `LoadedFonts.added` it can do
 * with this.
 */
export class FontLoadFailure extends Error {
  /** The faces this attempt had put into the font set before it failed. */
  readonly added: readonly FontFace[];

  /**
   * @param cause - Whatever the load threw.
   * @param added - The faces already registered when it did.
   */
  constructor(cause: unknown, added: readonly FontFace[]) {
    super('The Print preview could not finish loading its typefaces.', { cause });
    this.name = 'FontLoadFailure';
    this.added = added;
  }
}

/**
 * Load a plan's faces into the document, falling back per family for anything that will not load.
 *
 * A face is handed to the browser's font loader as bytes or as a same-origin URL, and the loader is
 * what decides whether it is a font. A file that is absent, is not a font, or is corrupt fails there
 * — which is exactly where that judgement belongs, and is why nothing here inspects the bytes.
 *
 * @param plan - The plan from {@link planFontFaces}.
 * @param ports - How to reach project bytes and the document's font set.
 * @returns What to report about the families that could not be supplied, and the faces to take back
 *   out of the document when this attempt is replaced.
 * @throws {FontLoadFailure} When something other than a font failing to decode goes wrong — the font
 *   set refusing a face, or a metric lookup throwing. It carries the faces added so far, so they can
 *   be taken back out.
 */
export async function loadFontFaces(plan: FontPlan, ports: FontLoaderPorts): Promise<LoadedFonts> {
  const byFamily = new Map<string, PlannedFace[]>();
  for (const face of plan.faces) {
    const existing = byFamily.get(face.family);
    if (existing === undefined) byFamily.set(face.family, [face]);
    else existing.push(face);
  }

  const diagnostics: AppearanceDiagnostic[] = [...plan.diagnostics];
  // Declared outside the attempt so a throw can still hand it over: `ports.fontSet.add` is a real DOM
  // call and `metricOverridesOf` is the caller's own code, and a family failing after an earlier one
  // has been registered is exactly the case that leaked.
  const added: FontFace[] = [];

  try {
    for (const [family, faces] of byFamily) {
      const attempts = await Promise.all(faces.map((face) => loadOne(family, 'text', face, ports)));
      const usable = attempts.filter((face): face is FontFace => face !== null);

      if (usable.length === 0) {
        diagnostics.push(unavailable(family, 'unloadable'));
        continue;
      }
      for (const face of usable) {
        ports.fontSet.add(face);
        added.push(face);
      }

      // The same files again, under the metric-bearing name. A face this preview has no metrics for
      // contributes nothing here, and the stylesheet's font stack then falls through to the family
      // above — so a construct is never left with no face at all because a second registration failed.
      const metric = await Promise.all(
        faces.map((face) =>
          ports.metricOverridesOf?.(family, face.style, 'box') === undefined
            ? null
            : loadOne(metricFamilyOf(family), 'box', face, ports),
        ),
      );
      for (const face of metric) {
        if (face === null) continue;
        ports.fontSet.add(face);
        added.push(face);
      }

      // A family that loaded some of its faces and not others still draws: the browser synthesises the
      // missing slant or weight. It is worth saying so, because synthesised bold is not the PDF's bold.
      if (usable.length < faces.length) {
        diagnostics.push(synthesised(family));
      }
    }
  } catch (error) {
    throw new FontLoadFailure(error, added);
  }

  return { diagnostics, added };
}

/**
 * Load one planned face, or resolve null when it cannot be used.
 *
 * @param registerAs - The family name to register it under: the theme's own, or the metric-bearing
 *   name the same file is registered a second time under.
 * @param registration - Which of the two that is, which decides the metrics it carries.
 * @param face - The planned face.
 * @param ports - How to reach project bytes and build a face.
 * @returns The loaded face, or null.
 */
async function loadOne(
  registerAs: string,
  registration: FaceRegistration,
  face: PlannedFace,
  ports: FontLoaderPorts,
): Promise<FontFace | null> {
  // The metrics go on as descriptors, not as a later mutation: a `FontFace` reads its descriptors
  // when it is constructed, and a browser that does not know these three ignores them rather than
  // rejecting the face.
  //
  // They go on EVERY registration of the face, including the family the page's text is set in. This
  // used to be the metric-bearing registration alone, on the argument that the browser's own reading
  // of the file should lay the lines out because a declared ascent is quantised to whole pixels at
  // each size drawn. That argument only ever held for a face whose two metric tables agree, and it is
  // the catalogue's own faces that made it look safe: Noto Serif's `hhea` IS its OS/2 typographic
  // pair (1.06885/0.29297/0), so nothing in the gem's default appearance could tell the two apart.
  //
  // Most fonts a project ships follow the Windows convention instead, where `hhea` is stretched to
  // cover the accented capitals and the typographic pair is the design's own. ttfunk takes OS/2
  // sTypo whenever the table is there (`ttfunk-1.7.0/lib/ttfunk.rb:66-68` → `prawn-2.4.0/lib/prawn/
  // fonts/ttf.rb:58`), and a browser takes `hhea` unless the face sets OS/2 `fsSelection` bit 7,
  // which none of the anchors' faces does (measured: `fsSelection = 0x40`). Liberation Mono Bold
  // measures typo 0.6333/0.2090 against hhea 0.8325/0.3003 — a third of an em apart — and with the
  // overrides withheld here the project-font anchor's h1 baseline landed 0.91pt above the page's,
  // because Chromium derived the half-leading from the `hhea` pair: round(0.8325x36) = 30 over
  // round(0.3003x36) = 11 inside a 30.276px line box gives floor((30.276-41)/2) = -6.
  //
  // The quantisation the old comment worried about is real but is the smaller error, and it is the
  // one the geometry tolerance is sized for; laying a page out from the wrong metric table is not.
  //
  // What the two registrations carry is not the same pair, which is what `registration` selects: the
  // text one folds the face's line gap into its ascent, because that is where the renderer puts it
  // when it places a block's first line, and the box one leaves the gap out, because the box painted
  // behind a fragment is `ascender + descender` and no gap. See `font-metrics.ts`.
  const descriptors: FontFaceDescriptors = {
    weight: String(face.weight),
    style: face.slant,
    ...ports.metricOverridesOf?.(face.family, face.style, registration),
  };
  let source: BufferSource | string;

  if (face.source === 'project') {
    const bytes = face.assetPath === undefined ? undefined : ports.getAssetBytes(face.assetPath);
    if (bytes === undefined) return null;
    // A copy, because the font loader takes ownership of the buffer it is given and the asset cache
    // hands the same bytes to the PDF pipeline as well.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    source = copy;
  } else {
    if (face.url === undefined) return null;
    source = `url(${face.url}) format("woff2")`;
  }

  try {
    return await ports.createFace(registerAs, source, descriptors).load();
  } catch {
    // Absent, not a font, or corrupt — the loader is the authority, and all three end the same way.
    return null;
  }
}
