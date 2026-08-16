// Copies the Asciidoctor-PDF catalogue fonts this app serves into its own public assets, so the Print
// preview can load them same-origin. The faces are the gem's own subsets converted to WOFF2 and
// committed by `packages/asciidoc-pdf` (see that package's generate:catalogue-fonts); this step only
// moves published files into place — it never reads the gem, and never converts anything.
//
// Serving them from our own origin is what keeps the no-egress invariant: no CDN, no cross-origin
// fetch, and no `next/font` stand-in for a family whose metrics the preview depends on.
//
// The preview expects them under `/vendor/catalogue-fonts/`; keep that in sync with
// `CATALOGUE_FONT_BASE` in `src/lib/print-preview/font-faces.ts`.
//
// Runs in predev/prebuild. Output is git-ignored generated data — do not edit by hand.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(here, '../../../packages/asciidoc-pdf/assets/fonts');
const TARGET_DIR = resolve(here, '../public/vendor/catalogue-fonts');

if (!existsSync(join(SOURCE_DIR, 'manifest.json'))) {
  // Loud rather than silent: without these the Print preview would fall back for the DEFAULT theme's
  // own body face, which is the appearance every project with no theme of its own gets.
  throw new Error(
    `The catalogue fonts are not present at ${SOURCE_DIR}. They are committed by ` +
      '@asciidocollab/asciidoc-pdf — run: pnpm --filter @asciidocollab/asciidoc-pdf generate:catalogue-fonts',
  );
}

const manifest = JSON.parse(readFileSync(join(SOURCE_DIR, 'manifest.json'), 'utf8'));
mkdirSync(TARGET_DIR, { recursive: true });

let copied = 0;
for (const entry of manifest.families) {
  for (const face of Object.values(entry.faces)) {
    copyFileSync(join(SOURCE_DIR, face.file), join(TARGET_DIR, face.file));
    copied += 1;
  }
}
// The licences travel with the fonts they cover; serving the faces without them would ship the one
// thing their licence asks us not to drop.
for (const licence of manifest.licences) {
  copyFileSync(join(SOURCE_DIR, licence), join(TARGET_DIR, licence));
}

console.log(
  `Copied ${copied} catalogue faces (asciidoctor-pdf ${manifest.gemVersion}) and ${manifest.licences.length} licence files to ${TARGET_DIR}`,
);

// The base-14 stand-ins travel the same road and land in a directory of their own. They are NOT the
// gem's own faces — the fourteen core fonts have no file in the export at all, so these are typefaces
// drawn to the same published metrics — and folding them in beside the catalogue would put two
// different claims behind one path. The preview expects them under `/vendor/base14-fonts/`; keep that
// in sync with `SUBSTITUTE_FONT_BASE` in `src/lib/print-preview/font-faces.ts`.
const BASE14_SOURCE_DIR = resolve(here, '../../../packages/asciidoc-pdf/assets/base14-fonts');
const BASE14_TARGET_DIR = resolve(here, '../public/vendor/base14-fonts');

if (!existsSync(join(BASE14_SOURCE_DIR, 'manifest.json'))) {
  // Loud rather than silent, and for a sharper reason than the catalogue's: without these the preview
  // falls back for `Helvetica`, which is the base font family of every theme that does not name one
  // (`converter.rb:572`).
  throw new Error(
    `The base-14 stand-ins are not present at ${BASE14_SOURCE_DIR}. They are committed by ` +
      '@asciidocollab/asciidoc-pdf — run: pnpm --filter @asciidocollab/asciidoc-pdf generate:base14-fonts',
  );
}

const base14 = JSON.parse(readFileSync(join(BASE14_SOURCE_DIR, 'manifest.json'), 'utf8'));
mkdirSync(BASE14_TARGET_DIR, { recursive: true });
for (const face of base14.faces) {
  copyFileSync(join(BASE14_SOURCE_DIR, face.file), join(BASE14_TARGET_DIR, face.file));
}
// The licences travel; the AFMs the widths were measured against deliberately do not. They are the
// package's own evidence, read by its tests, and half a megabyte of metrics no browser reads has no
// business in a public directory.
for (const licence of base14.licences) {
  copyFileSync(join(BASE14_SOURCE_DIR, licence), join(BASE14_TARGET_DIR, licence));
}

console.log(
  `Copied ${base14.faces.length} base-14 stand-in faces (prawn ${base14.prawnVersion}) and ` +
    `${base14.licences.length} licence files to ${BASE14_TARGET_DIR}`,
);

// The admonition icons travel the same road, for the same reason: they are the renderer's own glyphs,
// extracted and committed by the package that owns the gem, and the Print stylesheet paints them as
// masks from `/vendor/admonition-icons/`. Keep that path in sync with the stylesheet.
const ICON_SOURCE_DIR = resolve(here, '../../../packages/asciidoc-pdf/assets/admonition-icons');
const ICON_TARGET_DIR = resolve(here, '../public/vendor/admonition-icons');

if (!existsSync(join(ICON_SOURCE_DIR, 'manifest.json'))) {
  throw new Error(
    `The admonition icons are not present at ${ICON_SOURCE_DIR}. They are committed by ` +
      '@asciidocollab/asciidoc-pdf — run: pnpm --filter @asciidocollab/asciidoc-pdf generate:admonition-icons',
  );
}

const icons = JSON.parse(readFileSync(join(ICON_SOURCE_DIR, 'manifest.json'), 'utf8'));
mkdirSync(ICON_TARGET_DIR, { recursive: true });
for (const icon of icons.icons) {
  copyFileSync(join(ICON_SOURCE_DIR, icon.file), join(ICON_TARGET_DIR, icon.file));
}
for (const licence of icons.licences) {
  copyFileSync(join(ICON_SOURCE_DIR, licence), join(ICON_TARGET_DIR, licence));
}

console.log(
  `Copied ${icons.icons.length} admonition icons (prawn-icon ${icons.iconGemVersion}) and ${icons.licences.length} licence files to ${ICON_TARGET_DIR}`,
);
