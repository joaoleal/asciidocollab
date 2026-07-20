/**
 * @file Reusable reference-PDF generator for the PDF reference-parity corpus.
 *
 * Given a fixture directory, it runs the REAL, external Asciidoctor-PDF command-line toolchain inside
 * a pinned Docker container and writes the fixture's `reference.pdf` — the canonical output the in-app
 * client export is compared against. The gem version baked here is kept in lockstep with the version
 * the wasm engine bundles, so a same-source render by both toolchains should match tightly; using the
 * SAME theme, fonts, images-dir and attributes the in-app pipeline uses is what makes the comparison
 * meaningful rather than a comparison of two different documents.
 *
 * Usage:
 *   node apps/web/e2e/pdf-parity/generate-reference.mjs <fixture-dir> [<fixture-dir> ...]
 *   node apps/web/e2e/pdf-parity/generate-reference.mjs --all
 *
 * It reads each fixture's `manifest.json` (`mainFile`, and the `render` block that mirrors the in-app
 * ProjectSnapshot: `themePath`, `fontPaths`, `imagesDir`, `attributes`) and reconstructs the equivalent
 * CLI invocation. The container mounts only the fixture directory; there is no network use beyond the
 * one-time gem install captured in the reusable image.
 *
 * Requires Docker. The first run builds the reference image from `tools/Dockerfile.reference` and its
 * locked gem closure; subsequent runs reuse it. The image is tagged with a HASH of that definition,
 * so reuse is only ever a genuine cache hit, and it runs as the invoking user rather than as root.
 */

import { readFileSync, existsSync, readdirSync, statSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureReferenceImage, referenceImageTag, SOURCE_DATE_EPOCH } from './tools/reference-image.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

// The toolchain image — a digest-pinned base plus a fully locked gem closure, tagged by a hash of its
// own definition — is defined once in tools/reference-image.mjs and shared by every reference tool.

/** The mount point of the fixture directory inside the container. */
const WORK = '/work';
/**
 * The first-party extension gem's `lib/`, mounted read-only so the reference render can `-r` the very
 * same Ruby the app loads. Without this a fixture declaring `enabledExtensions` would be regenerated
 * WITHOUT its extensions — a reference that silently disagrees with what the fixture claims to test.
 */
const EXTENSIONS_DIR = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'asciidoc-pdf',
  'ruby',
  'extensions',
  'asciidocollab-pdf-extensions',
  'lib',
);
/** Where {@link EXTENSIONS_DIR} appears inside the container. */
const EXTENSIONS_MOUNT = '/extensions';
/** The Ruby file each extension directory carries, matching the API's shipped-set loader. */
const EXTENSION_SOURCE_FILE = 'extension.rb';
/** Sub-directory, inside a fixture, holding the AsciiDoc project source. */
const SOURCE_DIR_NAME = 'source';
/** The Asciidoctor-PDF token that expands to the gem's own bundled default fonts. */
const GEM_FONTS_TOKEN = 'GEM_FONTS_DIR';
/** The `pdf-fontsdir` entry separator Asciidoctor-PDF splits on (`;` or `,`, never `:`). */
const FONTS_DIR_SEPARATOR = ';';

function log(message) {
  process.stderr.write(`${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw result.error;
  }
  return result;
}


function readManifest(fixtureDir) {
  const raw = readFileSync(join(fixtureDir, 'manifest.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Malformed manifest in ${fixtureDir}`);
  }
  return parsed;
}

/** Final path segment of a project-relative path. */
function leaf(path) {
  const parts = path.split('/').filter((segment) => segment.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Directory portion of a project-relative path (empty string for a top-level file). */
function dirPart(path) {
  const parts = path.split('/').filter((segment) => segment.length > 0);
  return parts.slice(0, -1).join('/');
}

/**
 * Build the `asciidoctor-pdf` attribute flags for a fixture, mirroring the in-app attribute builder:
 * `source-highlighter: rouge`, the project's `pdf-theme`/`pdf-themesdir`, a `pdf-fontsdir` combining
 * the project's own fonts with the gem's bundled defaults, `imagesdir`, and any explicit attributes.
 */
function attributeFlags(render, themeLeafOverride) {
  const flags = ['-a', 'source-highlighter=rouge'];
  const sourceRoot = `${WORK}/${SOURCE_DIR_NAME}`;

  const themePath = typeof render.themePath === 'string' ? render.themePath : undefined;
  if (themePath !== undefined) {
    const themeDir = dirPart(themePath);
    const themesDir = themeDir.length > 0 ? `${sourceRoot}/${themeDir}` : sourceRoot;
    const themeLeaf = themeLeafOverride ?? leaf(themePath);
    flags.push('-a', `pdf-theme=${themeLeaf}`, '-a', `pdf-themesdir=${themesDir}`);
  }

  const fontPaths = Array.isArray(render.fontPaths) ? render.fontPaths : [];
  if (fontPaths.length > 0) {
    const dirs = new Set();
    for (const fontPath of fontPaths) {
      const fontDir = dirPart(String(fontPath));
      dirs.add(fontDir.length > 0 ? `${sourceRoot}/${fontDir}` : sourceRoot);
    }
    const fontsDir = [...dirs, GEM_FONTS_TOKEN].join(FONTS_DIR_SEPARATOR);
    flags.push('-a', `pdf-fontsdir=${fontsDir}`);
  }

  if (typeof render.imagesDir === 'string') {
    flags.push('-a', `imagesdir=${render.imagesDir}`);
  }

  const attributes = render.attributes && typeof render.attributes === 'object' ? render.attributes : {};
  for (const [key, value] of Object.entries(attributes)) {
    // `pdf-theme` is DERIVED above and must not be taken from here as well. The manifest mirrors the
    // in-app ProjectSnapshot, where `pdf-theme` is a project-relative path (`branding/x-theme.yml@`)
    // resolved against the project root. The CLI has no project root: it needs the theme split into
    // a `pdf-themesdir` and a bare filename. Emitting both put the directory in twice — asciidoctor
    // looked for `/work/source/branding/branding/corporate-theme.yml`, failed to find it, warned
    // "reverting to default theme" on stderr, and still exited 0 — so the run reported success and
    // wrote a reference rendered with the WRONG theme.
    if (key === 'pdf-theme' && themePath !== undefined) continue;
    flags.push('-a', value === null ? `${key}!` : `${key}=${String(value)}`);
  }

  // Zero out ambient timestamps so the committed reference PDF is reproducible.
  flags.push('-a', 'reproducible');
  return flags;
}

/**
 * Build the `-r` flags loading a fixture's enabled converter extensions, in the SAME order the
 * in-app registry loads them (by id).
 *
 * Order matters and is not cosmetic: two extensions touching one converter hook produce different
 * output depending on which was prepended first, so a reference generated in a different order than
 * the app loads is not a reference for what the app does.
 *
 * That is also why the order is a PARAMETER rather than a constant. `tools/check-extension-order.mjs`
 * renders the same fixture with the order reversed and requires the bytes to match, which is the only
 * check that can observe an extension whose output depends on where it landed in the ancestor chain —
 * something the app cannot control, because `Module#prepend` is permanent and the wasm VM is warm.
 *
 * @param render - The fixture's `render` block.
 * @param order - Reorders the id list before it becomes flags. Defaults to the app's own order.
 * @returns The `-r` flags, empty when the fixture enables no extensions.
 */
function extensionFlags(render, order = (ids) => ids) {
  const enabled = Array.isArray(render.enabledExtensions) ? render.enabledExtensions : [];
  const flags = [];
  // Code-unit order, matching the app's compareExtensionIds — localeCompare's hyphen handling is locale-dependent and could disagree with the app, producing a reference in a different load order than the app renders.
  for (const id of order([...new Set(enabled.map(String))].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0))))) {
    const source = join(EXTENSIONS_DIR, id, EXTENSION_SOURCE_FILE);
    if (!existsSync(source)) {
      // Loudly, not silently: a reference rendered without an extension the fixture says it enables
      // would look plausible and prove nothing.
      throw new Error(`Fixture enables unknown extension "${id}" (no ${source}).`);
    }
    flags.push('-r', `${EXTENSIONS_MOUNT}/${id}/${EXTENSION_SOURCE_FILE}`);
  }
  return flags;
}

/**
 * Fixtures whose reference is NOT a render of `source/`, and which this generator must refuse.
 *
 * A `reference-src/` or `reference-build/` directory means the reference is built from a DIFFERENT
 * document than the one under test: `citations` keeps its reference in asciidoctor-bibtex macro
 * syntax rather than the shim syntax, `math`/`diagrams` keep a copy whose figures are already
 * rasterised to committed SVGs, and `theme-fonts-woff2` keeps one whose fonts are decoded to TTF
 * because Prawn cannot read WOFF2. Rendering `source/` for those produces a plausible PDF of the
 * wrong document, overwriting a committed reference with something that will never match.
 *
 * This is not hypothetical. Regenerating the corpus in bulk did exactly that to `math` — the file
 * changed, the command reported success, and only a SHA-256 comparison against the previous corpus
 * caught it. `--all` is documented in this file's own usage, so anyone following it would have hit
 * the same thing. Refused loudly rather than skipped quietly, because a skipped fixture in a bulk
 * regeneration reads as "already up to date".
 */
function referenceBuiltElsewhere(fixtureDir) {
  return ['reference-src', 'reference-build'].find((dir) => existsSync(join(fixtureDir, dir)));
}

/** The reference file a fixture's manifest asks for. */
function referencePdfName(fixtureDir) {
  const manifest = readManifest(fixtureDir);
  return typeof manifest.referencePdf === 'string' ? manifest.referencePdf : 'reference.pdf';
}

/**
 * Generate (or regenerate) one fixture's reference.pdf.
 *
 * @param fixtureDir - The fixture directory.
 * @param tag - The pinned toolchain image tag.
 * @param options - `order` reorders the extension load order (see {@link extensionFlags});
 *   `outputName` writes somewhere other than the manifest's `referencePdf`, so a caller can render a
 *   variant for comparison without touching the committed reference.
 */
export function generate(fixtureDir, tag, options = {}) {
  const elsewhere = referenceBuiltElsewhere(fixtureDir);
  if (elsewhere) {
    throw new Error(
      `${basename(fixtureDir)} builds its reference from ${elsewhere}/, not from ${SOURCE_DIR_NAME}/. ` +
        `Rendering ${SOURCE_DIR_NAME}/ here would overwrite the committed reference with a render of ` +
        `the wrong document. Regenerate it with the toolchain that owns that fixture.`,
    );
  }
  const manifest = readManifest(fixtureDir);
  const mainFile = typeof manifest.mainFile === 'string' ? manifest.mainFile : 'main.adoc';
  const referencePdf = options.outputName ??
    (typeof manifest.referencePdf === 'string' ? manifest.referencePdf : 'reference.pdf');
  const render = manifest.render && typeof manifest.render === 'object' ? manifest.render : {};

  // A `.yaml` theme has to be presented to the CLI under a `.yml` name.
  //
  // Asciidoctor-PDF resolves `pdf-theme` by treating anything not ending in `.yml` as a theme NAME
  // and appending `-theme.yml` — so `local-theme.yaml` became `local-theme.yaml-theme.yml`, was not
  // found, and the run fell back to the DEFAULT theme while still exiting 0. The reference was then
  // a render of the wrong theme that no one was told about.
  //
  // A copy under a `.yml` name beside the original is the faithful reconstruction: it is the same
  // theme content, in the same directory, so relative `extends` and font paths resolve identically —
  // which is exactly what the app does when it accepts the `.yaml` the reference gem will not.
  const themePath = typeof render.themePath === 'string' ? render.themePath : undefined;
  let themeAlias;
  let themeAliasPath;
  if (themePath !== undefined && /\.yaml$/i.test(themePath)) {
    themeAlias = `${leaf(themePath).replace(/\.yaml$/i, '')}.parity-generated.yml`;
    const themeDir = dirPart(themePath);
    themeAliasPath = join(fixtureDir, SOURCE_DIR_NAME, themeDir, themeAlias);
    copyFileSync(join(fixtureDir, SOURCE_DIR_NAME, themePath), themeAliasPath);
  }

  const args = [
    'run', '--rm',
    '--network', 'none',
    // NEVER root. The render reads the fixture and writes one PDF into it, and as root that PDF
    // lands in the developer's checkout owned by root. Running as the host UID also means the file
    // Docker writes is one the developer can edit, move and delete without sudo. Verified not to
    // affect the output: root and host-UID renders of the same fixture are byte-identical, as are
    // renders under a different TZ and locale.
    '--user', `${process.getuid()}:${process.getgid()}`,
    '-e', `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`,
    '-v', `${fixtureDir}:${WORK}`,
    '-v', `${EXTENSIONS_DIR}:${EXTENSIONS_MOUNT}:ro`,
    '-w', `${WORK}/${SOURCE_DIR_NAME}`,
    tag,
    // Through bundler, so the render resolves the LOCKED closure rather than whatever versions
    // happen to be installed in the image.
    'bundle', 'exec', 'asciidoctor-pdf',
    '-b', 'pdf',
    '-S', 'unsafe',
    ...extensionFlags(render, options.order),
    ...attributeFlags(render, themeAlias),
    // Written under a temp name and renamed into place below.
    '-o', `${WORK}/${referencePdf}.tmp`,
    mainFile,
  ];

  log(`\n${basename(fixtureDir)}: asciidoctor-pdf ${args.slice(args.indexOf('asciidoctor-pdf') + 1).join(' ')}`);
  const result = run('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (themeAliasPath !== undefined) rmSync(themeAliasPath, { force: true });
  const scratch = join(fixtureDir, `${referencePdf}.tmp`);
  if (result.status !== 0) {
    rmSync(scratch, { force: true });
    throw new Error(`Reference generation failed for ${fixtureDir} (docker run exited ${String(result.status)}).`);
  }
  const outPath = join(fixtureDir, referencePdf);
  if (!existsSync(scratch)) {
    throw new Error(`Reference generation reported success but ${scratch} is missing.`);
  }
  // RENAMED rather than written straight to the target, for two reasons. It is atomic, so a failed
  // render can never leave a fixture with a half-written reference. And renaming needs write
  // permission on the DIRECTORY rather than on the file, which is what makes the move off root
  // possible at all: every reference generated before this change is owned by root, and a non-root
  // render cannot open one for writing — it fails with `Permission denied @ rb_sysopen`. Replacing
  // the file hands ownership to the invoking user as each fixture is regenerated.
  renameSync(scratch, outPath);
  log(`Wrote ${relative(process.cwd(), outPath)} (${statSync(outPath).size} bytes).`);
}

function fixtureDirsFromArgs(argv) {
  if (argv.includes('--all')) {
    const all = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(FIXTURES_DIR, entry.name))
      .filter((dir) => existsSync(join(dir, 'manifest.json')));
    // Named, not silently dropped. A bulk regeneration that quietly covers less than the whole
    // corpus reads as "everything is up to date", which is how a stale reference survives. Asking
    // for one of these BY NAME still fails loudly, so the skip cannot be mistaken for support.
    const keep = [];
    for (const dir of all) {
      const elsewhere = referenceBuiltElsewhere(dir);
      if (elsewhere) {
        log(
          `Skipping ${basename(dir)}: its reference is built from ` +
            `${elsewhere}/ by another toolchain, not from ${SOURCE_DIR_NAME}/.`,
        );
        continue;
      }
      // `--all` REGENERATES the corpus; it does not enrol new fixtures. A fixture with no reference
      // yet is inactive on purpose — `example` is a committed template whose manifest says to add a
      // reference in order to activate it — and writing one here would quietly turn a template into
      // a fixture the parity suite starts asserting against. Naming it deliberately still works.
      if (!existsSync(join(dir, referencePdfName(dir)))) {
        log(`Skipping ${basename(dir)}: no reference yet — name it explicitly to create one.`);
        continue;
      }
      keep.push(dir);
    }
    return keep;
  }
  return (
    argv
      .filter((arg) => !arg.startsWith('--'))
      // Resolved to absolute: `docker run -v` reads a relative path as a NAMED VOLUME, so a fixture
      // passed as `apps/web/.../theme-editing` failed with "invalid characters for a local volume
      // name" rather than mounting anything. Tab-completing a path from the repository root is the
      // obvious way to invoke this, so it has to work.
      .map((arg) => (existsSync(join(arg, 'manifest.json')) ? resolve(arg) : join(FIXTURES_DIR, arg)))
  );
}

function main() {
  const dirs = fixtureDirsFromArgs(process.argv.slice(2));
  if (dirs.length === 0) {
    log('Usage: node generate-reference.mjs <fixture-dir> [...] | --all');
    process.exitCode = 1;
    return;
  }
  const tag = referenceImageTag();
  ensureReferenceImage(tag, log);
  // Failures are COLLECTED rather than thrown, so one fixture this toolchain cannot build does not
  // decide how much of the corpus gets regenerated. Reported by name and with a non-zero exit — a
  // bulk regeneration that swallowed a failure would be worse than one that stops.
  const failures = [];
  for (const dir of dirs) {
    try {
      generate(dir, tag);
    } catch (error) {
      failures.push(`${basename(dir)}: ${error.message}`);
      log(`FAILED ${basename(dir)}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    log(`\n${failures.length} fixture(s) could not be regenerated:`);
    for (const failure of failures) log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  log('\nDone.');
}

// Only when RUN DIRECTLY. `generate` is imported by tools/check-extension-order.mjs, and without this
// guard that import would regenerate every reference in the corpus as a side effect of loading it.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
