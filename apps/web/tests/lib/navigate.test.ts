// navigateTo() — the single place the app hands the browser off to an external URL.
// The whole point of the indirection is that a caller can mock this module instead of
// stubbing `Location`, so the only thing worth asserting is that it writes `location.href`.
import { navigateTo } from '@/lib/navigate';

describe('navigateTo', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  afterEach(() => {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });

  /** Installs a writable stand-in for the browser's Location and returns it. */
  function stubLocation(): { href: string } {
    const stub = { href: 'about:blank' };
    Object.defineProperty(globalThis, 'location', { value: stub, configurable: true, writable: true });
    return stub;
  }

  test('sends the browser to the given URL', () => {
    const stub = stubLocation();
    navigateTo('https://provider.example/authorize?client_id=abc');
    expect(stub.href).toBe('https://provider.example/authorize?client_id=abc');
  });

  test('overwrites any previously assigned destination', () => {
    const stub = stubLocation();
    navigateTo('https://first.example/');
    navigateTo('https://second.example/');
    expect(stub.href).toBe('https://second.example/');
  });
});
