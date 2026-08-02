/**
 * Contract tests for the document-order engine's internal boundaries — the parts that are not reachable
 * from the package barrel, so no end-to-end test can pin them.
 *
 * `stripReservedAttributes` is the boundary every VALUE consumer (attribute scope, inherited
 * attributes, `{ref}` resolution) passes through. What its callers hand it is derived from the include
 * walk's running accumulator, and that accumulator must KEEP `leveloffset` — the engine resolves the
 * offset through `effectiveLevelOffset`, but `ifdef::leveloffset[]` still has to see the attribute the
 * way real Asciidoctor does. So "strips the reserved name from what it returns, and touches nothing
 * the caller still holds" is the contract, and it is pinned here rather than left to the call sites'
 * habit of passing a throwaway map.
 */

import { stripReservedAttributes } from '../../src/extraction/document-order';

describe('stripReservedAttributes', () => {
  test('removes the engine-reserved leveloffset from the map it returns', () => {
    const stripped = stripReservedAttributes(new Map([['leveloffset', '+3'], ['author', 'Ada']]));
    expect(stripped.has('leveloffset')).toBe(false);
  });

  test('carries every other attribute over unchanged', () => {
    const stripped = stripReservedAttributes(
      new Map([['leveloffset', '+3'], ['author', 'Ada'], ['imagesdir', 'assets/img'], ['empty', '']]),
    );
    expect([...stripped]).toEqual([['author', 'Ada'], ['imagesdir', 'assets/img'], ['empty', '']]);
  });

  test('leaves the caller\'s map intact, reserved name included', () => {
    // The gating scope the include walk carries: it must still answer `ifdef::leveloffset[]` after a
    // consumer boundary has taken its value view.
    const gatingScope = new Map([['leveloffset', '+1'], ['draft', '']]);
    stripReservedAttributes(gatingScope);
    expect(gatingScope.get('leveloffset')).toBe('+1');
    expect(gatingScope.size).toBe(2);
  });

  test('returns a map that is independent of its source in both directions', () => {
    const source = new Map([['author', 'Ada']]);
    const stripped = stripReservedAttributes(source);
    expect(stripped).not.toBe(source);
    stripped.set('author', 'Grace');
    source.set('imagesdir', 'assets');
    expect(source.get('author')).toBe('Ada');
    expect(stripped.has('imagesdir')).toBe(false);
  });

  test('a map with nothing reserved in it comes back as an equal copy', () => {
    const source = new Map([['author', 'Ada'], ['version', '2.1']]);
    expect([...stripReservedAttributes(source)]).toEqual([...source]);
  });

  test('an empty map comes back empty', () => {
    expect(stripReservedAttributes(new Map()).size).toBe(0);
  });
});
