/**
 * The single source of truth for the API's base URL.
 *
 * This module is deliberately isomorphic — the same constant is correct in the
 * browser and during server rendering, because the two environments resolve the
 * expression differently:
 *
 *   Server (Node)  `INTERNAL_API_URL` is read at runtime and points straight at
 *                  the API container, so server rendering talks to it directly
 *                  over the internal network.
 *   Browser        Next compiles `process.env.INTERNAL_API_URL` against a shim
 *                  that only carries `NEXT_PUBLIC_*` values, so it yields
 *                  `undefined` and the public URL is used instead.
 *
 * That asymmetry is why the fallback order matters and must not be rearranged:
 * `NEXT_PUBLIC_API_URL` is inlined at BUILD time into both bundles, so it can
 * never point at an internal address, and `INTERNAL_API_URL` must therefore win
 * wherever it is actually defined.
 *
 * Without the internal URL, every server-rendered page would call the public
 * origin and hairpin back through the reverse proxy — costing a round trip, and
 * requiring the proxy to be resolvable and TLS-trusted from inside the network.
 */
export const API_BASE_URL =
  process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
