import { randomUUID } from 'crypto';
import type { SessionEncryption } from '@asciidocollab/infrastructure';
import type { Result } from '@asciidocollab/domain';
import type { GitOAuthProviderName } from '../config/schema-git';
import { isGitOAuthProviderName } from '../config/schema-git';

/**
 * How long a minted `state` blob is honored, measured from `issuedAt`. Short enough that a state
 * blob leaked (e.g. via a referrer header, a shared screenshot, or a browser history entry) is
 * useless well before anyone could act on it, long enough that a user who pauses on the provider's
 * own consent screen doesn't get bounced back to a failure page.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Everything the OAuth guided-connect flow needs to carry across the redirect round-trip to the
 * provider and back, encrypted+authenticated (AES-256-GCM, via {@link SessionEncryption}) into the
 * `state` query parameter so nothing here needs a server-side session store.
 */
export interface OAuthState {
  /** The project the connect action targets. */
  readonly projectId: string;
  /** The user who started the flow — the callback's CSRF check requires the authenticated caller to match this. */
  readonly actorId: string;
  /** Which provider this attempt is for. */
  readonly provider: GitOAuthProviderName;
  /** The remote repository URL to connect, exactly as the caller supplied it at the start step. */
  readonly remoteUrl: string;
  /** The branch to check out initially, if the caller supplied one. */
  readonly branch?: string;
  /** The PKCE code verifier generated at the start step (matches the challenge sent to the provider). */
  readonly codeVerifier: string;
  /**
   * Random per-attempt value with no server-side record to check against — see the module doc for
   * why this cannot enforce single-use on its own. Present so two attempts started back-to-back with
   * identical other fields still encrypt to visibly distinct plaintexts, and so a defense-in-depth
   * store could be layered in later without changing the `state` shape.
   */
  readonly nonce: string;
  /** Epoch milliseconds this state was minted at — the TTL check's reference point. */
  readonly issuedAt: number;
}

/** Everything the caller supplies when minting a fresh `state` (the rest is filled in here). */
export type MintOAuthStateInput = Omit<OAuthState, 'nonce' | 'issuedAt'>;

/**
 * Encrypts a freshly-minted `state` blob for the given attempt. Stamps `nonce` and `issuedAt`
 * itself — callers never choose these, so nothing about their own clock or randomness source
 * affects TTL/uniqueness guarantees.
 *
 * @param encryption - The dedicated `git.oauth.stateEncryptionKey`-keyed encryption instance.
 * @param input - Everything else the state blob carries.
 * @param now - Epoch milliseconds to stamp as `issuedAt`. Defaults to `Date.now()`; a fixed value
 *   lets a test mint a state that is already expired.
 * @returns The opaque, encrypted `state` string to attach to the authorize URL.
 */
export function mintOAuthState(
  encryption: SessionEncryption,
  input: MintOAuthStateInput,
  now: number = Date.now(),
): string {
  const state: OAuthState = { ...input, nonce: randomUUID(), issuedAt: now };
  return encryption.encrypt(JSON.stringify(state));
}

/** Why {@link readOAuthState} refused a `state` value — never anything more specific than this. */
export type OAuthStateRejectionReason = 'invalid' | 'expired';

/** Narrows an unknown JSON value to a plain, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a decrypted JSON value actually has the shape {@link OAuthState} requires, rather than
 * trusting the decrypted plaintext blindly. GCM's authentication tag already guarantees the
 * ciphertext was produced by `mintOAuthState` under the same key (a tampered ciphertext fails to
 * decrypt at all, before this function ever runs) — this is a second, independent guard against a
 * key-rotation or format-change mismatch producing a structurally-wrong-but-still-authentic value.
 */
function parseOAuthState(value: unknown): OAuthState | null {
  if (!isPlainObject(value)) return null;
  const { projectId, actorId, provider, remoteUrl, branch, codeVerifier, nonce, issuedAt } = value;
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  if (typeof actorId !== 'string' || actorId.length === 0) return null;
  if (typeof provider !== 'string' || !isGitOAuthProviderName(provider)) return null;
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) return null;
  if (branch !== undefined && typeof branch !== 'string') return null;
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  return {
    projectId,
    actorId,
    provider,
    remoteUrl,
    ...(branch !== undefined ? { branch } : {}),
    codeVerifier,
    nonce,
    issuedAt,
  };
}

/**
 * Decrypts and validates a `state` value from an OAuth callback request. Fails closed: any
 * decryption failure (wrong key, tampered ciphertext, garbage input), JSON-parse failure, or
 * shape mismatch is reported as `'invalid'`; a structurally-valid state whose `issuedAt` is older
 * than {@link OAUTH_STATE_TTL_MS} is reported as `'expired'`. Callers still owe their own
 * actorId-binding (CSRF) check on top of this — this function only proves the blob is one this
 * server minted, not that the caller redeeming it is the one who started the attempt.
 *
 * Single-use is NOT enforced here (nor anywhere in this stateless design): nothing records that a
 * given `state` was already redeemed, so a captured, still-fresh `state` could in principle be
 * replayed within the TTL window. The TTL, the actorId/CSRF binding callers must still apply, and the
 * PKCE code verifier (useless to a replayer who never received the matching `code`) are this
 * design's accepted mitigations — see the report's stateless single-use caveat for the full
 * reasoning; enforcing true single-use would require a server-side store, which this design
 * deliberately avoids (no new DB table/migration for OAuth state).
 *
 * @param encryption - The same dedicated `git.oauth.stateEncryptionKey`-keyed instance the mint side used.
 * @param encoded - The raw `state` query parameter value from the callback request.
 * @param now - Epoch milliseconds to check the TTL against. Defaults to `Date.now()`.
 */
export function readOAuthState(
  encryption: SessionEncryption,
  encoded: string,
  now: number = Date.now(),
): Result<OAuthState, OAuthStateRejectionReason> {
  let decrypted: string;
  try {
    decrypted = encryption.decrypt(encoded);
  } catch {
    return { success: false, error: 'invalid' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return { success: false, error: 'invalid' };
  }

  const state = parseOAuthState(parsedJson);
  if (!state) {
    return { success: false, error: 'invalid' };
  }

  if (now - state.issuedAt > OAUTH_STATE_TTL_MS) {
    return { success: false, error: 'expired' };
  }

  return { success: true, value: state };
}
