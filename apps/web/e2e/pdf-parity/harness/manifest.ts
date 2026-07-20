/**
 * Fixture manifests: the declarative description each parity fixture gives of itself, and the loader
 * that turns a fixture directory into the cases the comparison suite runs.
 *
 * The suite is manifest-driven rather than hand-written so a new fixture is a directory, not a new
 * test block. That matters because this feature adds a dozen of them: twelve hand-written blocks
 * would triple the spec, and — as the three fixtures that shipped with committed reference PDFs but
 * no test covering them showed — a hand-written suite silently under-covers what is on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import type { InkTolerance } from './pdftools';

/** File extensions read as opaque bytes rather than UTF-8 — fonts and images. */
export const BINARY_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.gif', '.pdf']);

/**
 * How a fixture is compared against its reference. The kind selects the assertion, because different
 * fidelity risks need different oracles — a bibliography is compared as facts, a diagram as ink.
 */
export type FixtureKind = 'structural' | 'code' | 'citations' | 'ink';

/** One comparison a fixture asks for: a fixture with no variants contributes exactly one. */
export interface ParityCase {
  /** The fixture directory name. */
  readonly fixture: string;
  /** Unique test title suffix — the variant id, or the fixture name when there are no variants. */
  readonly id: string;
  /** Which assertion to apply. */
  readonly kind: FixtureKind;
  /** Absolute path of the reference PDF this case compares against. */
  readonly referencePath: string;
  /** The snapshot fields the fixture declares (theme, fonts, images dir, attributes, bib). */
  readonly render: Partial<ProjectSnapshot>;
  /**
   * The PROJECT CONFIGURATION this fixture stands for, when it declares one.
   *
   * A fixture without this block has its snapshot hand-built from {@link render} — the manifest
   * restates what the app's builder is believed to produce, and the comparison runs below that
   * restatement. Both sides then read the same declaration, so a builder that stops agreeing with it
   * is invisible: that is exactly how the app came to force `doctype: article` onto every PDF while
   * the `theme-editing` fixture, rendering the identical document, matched its reference and passed.
   *
   * A fixture WITH this block instead derives its snapshot by running the real
   * `buildProjectSnapshot` over this configuration, so the comparison covers the app's own input
   * assembly rather than a hand-maintained mirror of it. `render` still describes what the reference
   * was built from, which is what gives the check its teeth: the two are produced independently, and
   * parity fails if the builder's derivation and the reference's declared input drift apart.
   */
  readonly projectConfig?: ParityProjectConfig;
  /** Text fragments both renders must contain (`code` and `ink` kinds). */
  readonly requiredText: readonly string[];
  /** Ink-map tolerance; present only for the `ink` kind. */
  readonly ink?: InkTolerance;
  /** Whether the case needs the DOM-bound mermaid/MathJax shims, and so a browser page. */
  readonly needsBrowser: boolean;
  /** For `citations`: whether the CSL style is numeric, which changes what must match. */
  readonly numericCitations: boolean;
}

/**
 * A project configuration as the app itself holds it, before any snapshot is built.
 *
 * Deliberately the INPUT shape of `buildProjectSnapshot`, not its output: raw attribute values (which
 * may carry the overridable `@` soft-default marker), font directories rather than resolved font
 * paths, and no `imagesDir`/`themePath`/`bibPath` — the builder derives all three. A fixture that
 * declared the derived fields here would be restating the answer instead of testing the derivation.
 */
export interface ParityProjectConfig {
  /** The project's configured main file, or null when it renders whatever is open. */
  readonly mainFile: string | null;
  /** The project attribute seed, lowercase name → raw value. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Extra project-relative font directories from the project render config. */
  readonly extraFontDirs?: readonly string[];
  /** Converter extension ids the project has enabled. Ids only, never code or paths. */
  readonly enabledExtensions?: readonly string[];
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberField(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== 'number') throw new TypeError(`${what}.${key} must be a number`);
  return value;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string') ? value : [];
}

function readInk(manifest: Record<string, unknown>, fixture: string): InkTolerance | undefined {
  if (manifest.ink === undefined) return undefined;
  const ink = asRecord(manifest.ink, `${fixture} manifest "ink"`);
  const what = `${fixture} manifest ink`;
  return {
    dpi: numberField(ink, 'dpi', what),
    minDarkFraction: numberField(ink, 'minDarkFraction', what),
    maxDarkFractionRatioDelta: numberField(ink, 'maxDarkFractionRatioDelta', what),
    maxBboxEdgeDelta: numberField(ink, 'maxBboxEdgeDelta', what),
  };
}

/**
 * The snapshot fields a fixture declares. Accepts them under a `render` block, and also at the top
 * level, because the fixtures predating this loader put `bibPath` and `attributes` there.
 */
function readRender(manifest: Record<string, unknown>, fixture: string): Partial<ProjectSnapshot> {
  const block = manifest.render === undefined ? {} : asRecord(manifest.render, `${fixture} manifest "render"`);
  const source: Record<string, unknown> = { ...manifest, ...block };
  const render: Record<string, unknown> = {};
  for (const key of ['themePath', 'bibPath', 'imagesDir'] as const) {
    if (typeof source[key] === 'string') render[key] = source[key];
  }
  const fontPaths = stringArray(source.fontPaths);
  if (fontPaths.length > 0) render.fontPaths = fontPaths;
  // Identifiers only. A fixture declares WHICH extensions its reference PDF was produced with; the
  // registry resolves each id to deployment-controlled source, exactly as a real render does, so the
  // fixture cannot smuggle code into the comparison.
  const enabledExtensions = stringArray(source.enabledExtensions);
  if (enabledExtensions.length > 0) render.enabledExtensions = enabledExtensions;
  if (source.attributes !== undefined) {
    render.attributes = asRecord(source.attributes, `${fixture} manifest "attributes"`);
  }
  return render as Partial<ProjectSnapshot>;
}

/** The project configuration a fixture declares, when it declares one. */
function readProjectConfig(
  manifest: Record<string, unknown>,
  fixture: string,
): ParityProjectConfig | undefined {
  if (manifest.projectConfig === undefined) return undefined;
  const block = asRecord(manifest.projectConfig, `${fixture} manifest "projectConfig"`);
  const what = `${fixture} manifest projectConfig`;

  // Refused rather than ignored. These are the fields the BUILDER derives, so accepting them here
  // would let a fixture declare the very answers the derivation is supposed to produce — and it
  // would do so silently, leaving a fixture that looks config-driven while proving nothing.
  for (const derived of ['themePath', 'fontPaths', 'imagesDir', 'bibPath'] as const) {
    if (block[derived] !== undefined) {
      throw new Error(
        `${what} declares "${derived}", which buildProjectSnapshot derives. Put the underlying ` +
          `attribute (e.g. "pdf-theme") in projectConfig.attributes instead.`,
      );
    }
  }

  const mainFile = block.mainFile;
  if (mainFile !== null && typeof mainFile !== 'string') {
    throw new TypeError(`${what}.mainFile must be a string or null`);
  }
  const attributes = asRecord(block.attributes ?? {}, `${what}.attributes`);
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') throw new TypeError(`${what}.attributes.${name} must be a string`);
  }

  const extraFontDirectories = stringArray(block.extraFontDirs);
  const enabledExtensions = stringArray(block.enabledExtensions);
  return {
    mainFile,
    attributes: attributes as Readonly<Record<string, string>>,
    ...(extraFontDirectories.length > 0 ? { extraFontDirs: extraFontDirectories } : {}),
    ...(enabledExtensions.length > 0 ? { enabledExtensions } : {}),
  };
}

function readKind(manifest: Record<string, unknown>, fixture: string): FixtureKind {
  const declared = manifest.kind;
  if (declared === undefined) return 'structural';
  if (typeof declared !== 'string') throw new TypeError(`${fixture} manifest "kind" must be a string`);
  // `math` and `diagrams` are two names for one oracle: rasterize both renders and compare the ink.
  if (declared === 'math' || declared === 'diagrams' || declared === 'ink') return 'ink';
  if (declared === 'code' || declared === 'citations' || declared === 'structural') return declared;
  throw new Error(`${fixture} manifest declares unknown kind ${JSON.stringify(declared)}`);
}

/** The text fragments a `code` fixture requires, from its `structural.requiredFragments` block. */
function readRequiredText(manifest: Record<string, unknown>, kind: FixtureKind): readonly string[] {
  if (kind === 'ink') return stringArray(manifest.labels);
  if (manifest.structural === undefined) return [];
  const structural = asRecord(manifest.structural, 'manifest "structural"');
  return stringArray(structural.requiredFragments);
}

/**
 * Read every fixture directory and expand it into the comparison cases it declares.
 *
 * A fixture with no committed reference PDF yields no case at all — that is how the template fixture
 * stays inert, and how a fixture whose reference has not been generated yet stays visibly absent
 * rather than silently passing.
 *
 * @param fixturesDirectory - Absolute path of the `fixtures/` root.
 * @returns Every case to run, ordered by fixture name for a stable report.
 */
export function loadParityCases(fixturesDirectory: string): ParityCase[] {
  const cases: ParityCase[] = [];

  for (const fixture of readdirSync(fixturesDirectory).toSorted()) {
    const directory = path.join(fixturesDirectory, fixture);
    const manifestPath = path.join(directory, 'manifest.json');
    if (!statSync(directory).isDirectory() || !existsSync(manifestPath)) continue;

    const manifest = asRecord(JSON.parse(readFileSync(manifestPath, 'utf8')), `${fixture}/manifest.json`);
    const kind = readKind(manifest, fixture);
    const render = readRender(manifest, fixture);
    const projectConfig = readProjectConfig(manifest, fixture);
    const requiredText = readRequiredText(manifest, kind);
    const ink = readInk(manifest, fixture);
    const needsBrowser = kind === 'ink';

    const variants = Array.isArray(manifest.variants) ? manifest.variants : [];
    if (variants.length === 0) {
      const referencePdf = typeof manifest.referencePdf === 'string' ? manifest.referencePdf : 'reference.pdf';
      cases.push({
        fixture,
        id: fixture,
        kind,
        referencePath: path.join(directory, referencePdf),
        render,
        ...(projectConfig === undefined ? {} : { projectConfig }),
        requiredText,
        ...(ink === undefined ? {} : { ink }),
        needsBrowser,
        numericCitations: false,
      });
      continue;
    }

    for (const rawVariant of variants) {
      const variant = asRecord(rawVariant, `${fixture} manifest variant`);
      const id = typeof variant.id === 'string' ? variant.id : '';
      if (id === '') throw new Error(`${fixture} manifest has a variant without an id`);
      const referencePdf =
        typeof variant.referencePdf === 'string' ? variant.referencePdf : `reference-${id}.pdf`;
      // A citation variant's style/order reach the engine as ordinary document attributes.
      const attributes: Record<string, string> = { ...render.attributes };
      if (typeof variant.style === 'string') attributes['bibtex-style'] = variant.style;
      if (typeof variant.order === 'string') attributes['bibtex-order'] = variant.order;

      cases.push({
        fixture,
        id: `${fixture}: ${id}`,
        kind,
        referencePath: path.join(directory, referencePdf),
        render: { ...render, attributes },
        ...(projectConfig === undefined ? {} : { projectConfig }),
        requiredText,
        ...(ink === undefined ? {} : { ink }),
        needsBrowser,
        numericCitations: variant.family === 'numeric',
      });
    }
  }

  return cases;
}

/**
 * Read a fixture's `source/` tree, splitting it into UTF-8 text files and opaque binary assets by
 * extension. Fonts and images MUST stay bytes: decoding them as text corrupts them silently, and the
 * engine then falls back to a default font, quietly defeating the very fidelity the fixture asserts.
 *
 * @param sourceDirectory - Absolute path of the fixture's `source/` directory.
 * @returns Project-relative path maps for the text files and the binary assets.
 */
export function readFixtureSource(sourceDirectory: string): {
  files: Record<string, string>;
  binaryAssets: Record<string, Uint8Array>;
} {
  const files: Record<string, string> = {};
  const binaryAssets: Record<string, Uint8Array> = {};

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!statSync(absolute).isFile()) continue;
      const relativePath = path.relative(sourceDirectory, absolute).split('\\').join('/');
      if (BINARY_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
        binaryAssets[relativePath] = new Uint8Array(readFileSync(absolute));
      } else {
        files[relativePath] = readFileSync(absolute, 'utf8');
      }
    }
  };
  walk(sourceDirectory);

  return { files, binaryAssets };
}
