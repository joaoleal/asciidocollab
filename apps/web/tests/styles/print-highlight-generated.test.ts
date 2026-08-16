import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The Print style's `.hljs-*` rules are DERIVED — from the renderer's own highlighting palette and
// from the class vocabulary the shipped highlight.js can emit — and the derivation lives in
// `scripts/build-print-highlight-css.mjs`. Committed rules that no longer match what it produces
// would be a stylesheet quoting a palette it has drifted from, which is exactly the state the whole
// arrangement exists to make impossible.
//
// Running the generator's own `--check` rather than restating its output: a second copy of the
// expected CSS here would be one more thing to keep in step, and it would go stale in the same way.
// The script needs nothing but the committed palette and `node_modules`, so unlike the palette's own
// gem check it can run in an ordinary test run.
const WEB_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(WEB_ROOT, 'scripts/build-print-highlight-css.mjs');

describe("the Print style's highlighting rules", () => {
  it('are what the renderer palette and the shipped highlighter derive', () => {
    // Throws on a non-zero exit, carrying the script's own message — which names the command to run.
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: WEB_ROOT, encoding: 'utf8' }),
    ).not.toThrow();
  });
});
