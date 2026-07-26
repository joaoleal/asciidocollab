import { readFileSync } from 'node:fs';
import path from 'node:path';

import packageJson from '../../../package.json';

describe('Grammar build scripts', () => {
  // Issue C6: predev must compile the grammar so `pnpm dev` works on a fresh clone
  test('predev script includes lezer-generator so the grammar is compiled before dev server starts', () => {
    const predev: string = packageJson.scripts.predev;
    expect(predev).toContain('lezer-generator');
  });

  test('prebuild script includes lezer-generator', () => {
    const prebuild: string = packageJson.scripts.prebuild;
    expect(prebuild).toContain('lezer-generator');
  });

  // The Harper grammar engine's wasm must be vendored into public/ before dev/build so the on-device
  // checker can fetch it same-origin (offline, no CDN). Both chains run the vendor step.
  test('predev and prebuild vendor the Harper wasm engine', () => {
    expect(packageJson.scripts.predev).toContain('build:harper-wasm');
    expect(packageJson.scripts.prebuild).toContain('build:harper-wasm');
    expect(packageJson.scripts['build:harper-wasm']).toContain('build-harper-wasm.mjs');
  });

  // harper.js's worker bootstrap fetches the slim binary by its own same-origin URL, so the copier must
  // vendor BOTH the full and slim wasm flavors — the full one alone leaves the slim request 404ing.
  test('the vendor script copies both the full and slim Harper wasm binaries', () => {
    const script = readFileSync(
      path.resolve(__dirname, '../../../scripts/build-harper-wasm.mjs'),
      'utf8',
    );
    expect(script).toContain('harper_wasm_bg.wasm');
    expect(script).toContain('harper_wasm_slim_bg.wasm');
  });
});
