import { timingSafeEqual } from 'node:crypto';

/** Header carrying the optional shared secret. */
export const SECRET_HEADER = 'x-git-worker-internal-secret';

/**
 * Constant-time comparison of the request's secret header against the expected secret. Uses
 * `crypto.timingSafeEqual` so a network attacker cannot recover the secret byte-by-byte from
 * comparison timing — the only auth on these endpoints when mTLS is off. The length pre-check is
 * required by `timingSafeEqual` (it throws on differing lengths) and leaks only the secret's length.
 *
 * @param provided - The raw header value (string, array, or undefined for a missing header).
 * @param expected - The configured shared secret.
 * @returns True when the provided secret matches.
 */
export function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}
