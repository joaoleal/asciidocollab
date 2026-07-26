import * as core from '@asciidocollab/asciidoc-core';
import {
  REVIEW_BODY_MAX_LEN as DOMAIN_REVIEW_BODY_MAX_LEN,
  REVIEW_ITEM_KINDS as DOMAIN_REVIEW_ITEM_KINDS,
  REVIEW_ITEM_STATUSES as DOMAIN_REVIEW_ITEM_STATUSES,
  ANCHOR_STATES as DOMAIN_ANCHOR_STATES,
} from '@asciidocollab/domain';
import {
  REVIEW_BODY_MAX_LEN as SHARED_REVIEW_BODY_MAX_LEN,
  REVIEW_ITEM_KINDS as SHARED_REVIEW_ITEM_KINDS,
  REVIEW_ITEM_STATUSES as SHARED_REVIEW_ITEM_STATUSES,
  ANCHOR_STATES as SHARED_ANCHOR_STATES,
} from '@asciidocollab/shared';

/**
 * `@asciidocollab/shared` is a LEAF in `onion.config.json` — it may not import the domain, so the review
 * enums and the body-length limit exist as independent declarations on each side (see the comments in
 * `packages/shared/src/review/constants.ts` and `enums.ts`). Mirroring buys the layering at the cost of
 * a drift risk, and that risk needs a test somewhere that can see BOTH sides.
 *
 * That somewhere is here. `apps/api` is the layer permitted to import domain, shared and asciidoc-core
 * at once, and it is the process that enforces the limit at the HTTP boundary while the domain enforces
 * it in the use case — so a drift between the two would show up as a request the API accepts and the
 * domain then rejects. Neither package can host this check: importing the other is exactly what the
 * architecture guard forbids.
 */
describe('cross-layer mirror parity', () => {
  test('the review body limit agrees between shared and domain', () => {
    expect(SHARED_REVIEW_BODY_MAX_LEN).toBe(DOMAIN_REVIEW_BODY_MAX_LEN);
  });

  test('the review enum value sets agree between shared and domain', () => {
    expect([...SHARED_REVIEW_ITEM_KINDS]).toEqual([...DOMAIN_REVIEW_ITEM_KINDS]);
    expect([...SHARED_REVIEW_ITEM_STATUSES]).toEqual([...DOMAIN_REVIEW_ITEM_STATUSES]);
    expect([...SHARED_ANCHOR_STATES]).toEqual([...DOMAIN_ANCHOR_STATES]);
  });

  test('asciidoc-core stays the zero-dependency leaf the layering assumes', () => {
    // Not a style preference: `shared` and `domain` both re-export this package's structural types, so
    // a dependency added here would be pulled into every layer above — including the browser bundle.
    const manifest = require('@asciidocollab/asciidoc-core/package.json') as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
    // And it really is the module the other layers re-export from, not an empty shim.
    expect(typeof core.substitutePathAttributes).toBe('function');
  });
});
