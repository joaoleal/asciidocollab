import { HARPER_WASM_PATH, resolveHarperWasmUrl } from '@/lib/codemirror/harper/wasm-url';

describe('resolveHarperWasmUrl', () => {
  test('produces an ABSOLUTE same-origin url (a blob: worker cannot resolve a root-relative path)', () => {
    // The engine fetches this URL inside a worker spawned from a blob: URL. A root-relative path
    // there throws "Failed to parse URL", and harper.js never rejects on a worker error — warm-up
    // would hang forever. Absoluteness is what keeps the fetch resolvable.
    const resolved = resolveHarperWasmUrl('http://localhost:3000');
    expect(resolved).toBe('http://localhost:3000/vendor/harper/harper_wasm_bg.wasm');
    expect(resolved.startsWith('http')).toBe(true);
    expect(resolved).not.toBe(HARPER_WASM_PATH);
  });

  test('keeps the asset on the requesting origin (self-hosted; no third-party egress)', () => {
    expect(resolveHarperWasmUrl('https://docs.example.com')).toBe(
      'https://docs.example.com/vendor/harper/harper_wasm_bg.wasm',
    );
    // A deployment served from a port or subpath-less origin still resolves to that exact origin.
    expect(new URL(resolveHarperWasmUrl('https://app.example.com:8443')).origin).toBe(
      'https://app.example.com:8443',
    );
  });

  test('names the FULL binary, not the slim flavour (slim drops rules the app needs)', () => {
    expect(HARPER_WASM_PATH).toContain('harper_wasm_bg.wasm');
    expect(HARPER_WASM_PATH).not.toContain('slim');
  });
});
