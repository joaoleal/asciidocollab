/**
 * @file Extension isolation across renders in one warm VM.
 *
 * WHY THIS EXISTS, given the parity suite already renders every extension.
 *
 * `Module#prepend` cannot be undone, and the wasm VM is warm and never torn down. So an extension
 * required into it is in the converter's ancestor chain for every LATER render in that session,
 * whatever the project that asked for it. Three of this feature's guarantees are therefore claims
 * about a VM that has already loaded the thing being disabled:
 *
 *   - SC-015a — disabling an extension returns the output to the unextended document.
 *   - FR-031b1 — the theme editor previews the sample WITHOUT one of the enabled extensions.
 *   - FR-032g / SC-012b — adding an extension never changes existing output.
 *
 * The parity fixtures cannot measure any of them. Each fixture enables exactly what it is testing,
 * so an extension that leaks into the NEXT render still matches its own reference; the leak surfaces
 * as some unrelated fixture failing later in the run. That is precisely how the accumulation bug
 * survived: three fixtures were red, every one of them innocent, and the whole suite's result
 * depended on the order the fixture directory happened to enumerate.
 *
 * So this asserts the property directly. `warm-vm-extensions.mjs` renders ONE document five times
 * through ONE warm VM, varying only the enabled set, plus once in a VM that has never loaded an
 * extension at all. That last render is the control, and it has to be: comparing two warm-VM renders
 * would let a leak that affected both sides equally cancel out and read as success.
 *
 * Gated the same way parity is: it self-skips when the wasm engine is absent, so a clean checkout
 * stays green and this activates once the artifact is present.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HARNESS = path.join(__dirname, 'warm-vm-extensions.mjs');
const WASM_PATH = path.join(__dirname, '..', '..', 'ruby', 'asciidoctor-pdf.wasm');

/** One render in the sequence: what it enabled, and the hash of the PDF it produced. */
interface Render {
  readonly label: string;
  readonly enabled: readonly string[];
  readonly hash: string;
}

interface Summary {
  readonly ran: boolean;
  readonly reason?: string;
  /** The unextended document, rendered by a VM that never required an extension. */
  readonly pristine?: string;
  /** Renders through one warm VM, in order. */
  readonly sequence?: readonly Render[];
}

const enginePresent = existsSync(WASM_PATH);

/** Run the harness once for the whole file — it boots two wasm VMs and renders six documents. */
function measure(): Summary {
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  // The VM writes `wasi:` progress lines to stdout, so the JSON summary is the LAST line.
  const last = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(last) as Summary;
  } catch {
    return { ran: false, reason: `unparseable harness output: ${last.slice(0, 200)}` };
  }
}

describe('extensions do not leak between renders in a warm VM', () => {
  let summary: Summary;
  /** Each render by label, so an assertion names the case it is about rather than an index. */
  let byLabel: Map<string, Render>;

  beforeAll(() => {
    if (!enginePresent) return;
    summary = measure();
    byLabel = new Map((summary.sequence ?? []).map((render) => [render.label, render]));
  }, 15 * 60 * 1000);

  const maybe = enginePresent ? it : it.skip;

  maybe('renders the whole sequence', () => {
    expect(summary.ran).toBe(true);
    expect(summary.reason).toBeUndefined();
    expect(byLabel.size).toBe(5);
  });

  maybe('SC-015a: disabling every extension returns the unextended document, byte for byte', () => {
    // THE assertion this file exists for. By this point the warm VM has required four extensions and
    // cannot un-require any of them, so the only thing that can make this hold is the per-render
    // enabled set. Compared against a VM that never loaded an extension — not against another warm
    // render, which a leak affecting both sides would satisfy while still being broken.
    expect(byLabel.get('none')?.hash).toBe(summary.pristine);
  });

  maybe('FR-031b1: holding one extension out changes the document', () => {
    // The theme editor's comparison control in miniature. If these matched, the control would show
    // the same document twice while appearing to work — which is worse than not offering it.
    expect(byLabel.get('without-narrow-contents')?.hash).not.toBe(byLabel.get('all')?.hash);
  });

  maybe('a render depends on what IT selected, not on what ran before it', () => {
    // `only-narrow-contents` runs third, after two renders that between them loaded four extensions.
    // It must not carry any of them, and it must differ from the unextended document — otherwise the
    // gate would be passing this test by disabling everything, including the selection.
    const only = byLabel.get('only-narrow-contents')?.hash;
    expect(only).not.toBe(summary.pristine);
    expect(only).not.toBe(byLabel.get('all')?.hash);
    expect(only).not.toBe(byLabel.get('without-narrow-contents')?.hash);
  });

  maybe('re-enabling reproduces the earlier output exactly', () => {
    // Not merely "extension-shaped again": identical. An extension that accumulated state across
    // renders in the warm VM — a queue, a counter, a memo — would drift here while every other
    // assertion in this file still passed.
    expect(byLabel.get('all-again')?.hash).toBe(byLabel.get('all')?.hash);
  });

  maybe('every distinct selection produces a distinct document', () => {
    // Guards the harness itself. If the document gave an extension nothing to do, its renders would
    // coincide and the comparisons above would hold vacuously.
    const distinct = new Set([...byLabel.values()].map((render) => render.hash));
    expect(distinct.size).toBe(4);
  });
});
