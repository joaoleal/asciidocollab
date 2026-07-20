import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parsePdfExtensionManifest, type PdfExtensionManifest } from '@asciidocollab/shared';

/**
 * @file The converter extensions that SHIP with the application.
 *
 * Loaded once at startup from the first-party gem's `lib/` directory, in the same layout the
 * administrator drop folder uses — one directory per extension, carrying a `manifest.json` and an
 * `extension.rb`. Using one layout for both origins means the shipped set is exercised by the same
 * parsing and the same validation as anything an administrator provides, rather than being a
 * privileged path that could drift from it.
 *
 * These are read from disk rather than hardcoded so that adding an extension is adding a directory
 * to the gem, and so the manifest an author sees is the one that ships beside the Ruby that
 * implements it — the two cannot disagree.
 */

/**
 * Where the shipped set may be found, in the order to try.
 *
 * Two entries because the tree the API runs from is not the tree it is developed in. The extensions
 * live in the engine gem, which is their source of truth — but the production image is assembled by
 * `pnpm deploy`, which flattens apps/api to the image root and brings no monorepo tree with it, and
 * the API deliberately does not depend on the engine package (it would drag the wasm engine into a
 * service that never renders). So the build copies them in beside `config/` and `data/`, and the
 * packaged location is tried FIRST: it is the one that is correct when both exist.
 */
const SHIPPED_EXTENSION_DIRECTORIES: readonly string[] = [
  // Packaged: see the artifacts stage of docker/Dockerfile. This file compiles to dist/lib/, so the
  // image root is two levels up — not one, as it is for the assets resolved from dist/index.js.
  path.join(__dirname, '..', '..', 'pdf-extensions'),
  // Development checkout: read straight from the gem.
  path.resolve(
    __dirname,
    '../../../../packages/asciidoc-pdf/ruby/extensions/asciidocollab-pdf-extensions/lib',
  ),
];

/** The manifest file each extension directory carries. */
const MANIFEST_FILE = 'manifest.json';
/** The Ruby source file each extension directory carries. */
const SOURCE_FILE = 'extension.rb';

/** Read the shipped set once at module load. */
function loadShipped(): {
  manifests: PdfExtensionManifest[];
  sources: Record<string, string>;
} {
  const manifests: PdfExtensionManifest[] = [];
  const sources: Record<string, string> = {};

  const directory = SHIPPED_EXTENSION_DIRECTORIES.find((candidate) => existsSync(candidate));
  if (directory === undefined) return { manifests, sources };

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(directory, entry.name);
    const manifestPath = path.join(base, MANIFEST_FILE);
    const sourcePath = path.join(base, SOURCE_FILE);
    if (!existsSync(manifestPath) || !existsSync(sourcePath)) continue;

    const parsed = parsePdfExtensionManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    // A shipped manifest that does not validate is a BUILD error, not a runtime condition: it ships
    // with the application, so failing loudly at startup is right where an exclusion would be wrong.
    if (!parsed.ok) {
      throw new Error(`Shipped extension ${entry.name} has an invalid manifest: ${parsed.reason}`);
    }
    manifests.push(parsed.manifest);
    sources[parsed.manifest.id] = readFileSync(sourcePath, 'utf8');
  }

  return { manifests, sources };
}

const shipped = loadShipped();

/** Every manifest that ships with the application, ordered by id. */
export const SHIPPED_PDF_EXTENSION_MANIFESTS: readonly PdfExtensionManifest[] =
  shipped.manifests.toSorted((a, b) => a.id.localeCompare(b.id));

/** Each shipped extension's Ruby source, by id. */
export const SHIPPED_PDF_EXTENSION_SOURCES: Readonly<Record<string, string>> = Object.freeze(
  shipped.sources,
);
