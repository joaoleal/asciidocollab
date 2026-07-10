// Located in apps/web so bare imports resolve apps/web/node_modules; fs paths are repo-root-relative (run from repo root).
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFileSync, writeFileSync } from 'node:fs';

const GLOBALS = 'apps/web/src/styles/globals.css';
const INPUT = 'apps/web/ds-tailwind-input.css';
const OUT = 'apps/web/ds-compiled.css';

let css = readFileSync(GLOBALS, 'utf8');
css = css.replace(
  '@import "tailwindcss";',
  '@import "tailwindcss";\n@source "./src/components/ui";\n@source "../../.design-sync/previews";',
);
writeFileSync(INPUT, css);

const res = await postcss([tailwind()]).process(css, { from: INPUT, to: OUT });
writeFileSync(OUT, res.css);
console.log(`compiled ${OUT}: ${(res.css.length / 1024).toFixed(1)} KiB`);
