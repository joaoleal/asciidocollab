import { createHash } from 'node:crypto';
import {
  INVITATION_TOKEN_EXPIRY_MS,
  EMAIL_VERIFICATION_TOKEN_EXPIRY_MS,
} from '@asciidocollab/domain';
import { CryptoTokenGenerator, CryptoTokenConfig } from '../../src/services/crypto-token-generator';

// node:crypto is used for real — the guarantees under test (unpredictable tokens, a hash that
// actually matches its token) are exactly the ones a stub would fake away.

/**
 * Configured expiry is deliberately a number that matches NEITHER domain constant, so a generator
 * that reached for the wrong one is visible in the expiresAt assertions.
 */
const CONFIGURED_EXPIRY_MS = 3_600_000;

function createConfig(overrides: Partial<CryptoTokenConfig> = {}): CryptoTokenConfig {
  return {
    tokenByteLength: 20,
    tokenExpiry: CONFIGURED_EXPIRY_MS,
    ...overrides,
  };
}

const NOW = new Date('2026-08-16T12:00:00.000Z');

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('CryptoTokenGenerator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('generatePasswordResetToken', () => {
    test('returns a hex token of exactly the configured byte length', () => {
      const { token } = new CryptoTokenGenerator(createConfig()).generatePasswordResetToken();

      // 20 bytes -> 40 hex characters. An off-by-one in the byte length shows up here.
      expect(token).toMatch(/^[0-9a-f]{40}$/);
      expect(token).toHaveLength(40);
    });

    test('honours a different configured byte length', () => {
      const config = createConfig({ tokenByteLength: 32 });

      const { token } = new CryptoTokenGenerator(config).generatePasswordResetToken();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    test('hashes the raw token it returns, not something else', () => {
      const result = new CryptoTokenGenerator(createConfig()).generatePasswordResetToken();

      expect(result.hashedToken).toBe(sha256Hex(result.token));
      expect(result.hashedToken).toMatch(/^[0-9a-f]{64}$/);
      // The stored value must not be the raw token itself.
      expect(result.hashedToken).not.toBe(result.token);
    });

    test('expires exactly the configured number of milliseconds from now', () => {
      const result = new CryptoTokenGenerator(createConfig()).generatePasswordResetToken();

      expect(result.expiresAt.getTime()).toBe(NOW.getTime() + CONFIGURED_EXPIRY_MS);
    });

    test('uses the configured expiry rather than either token-kind constant', () => {
      const result = new CryptoTokenGenerator(createConfig()).generatePasswordResetToken();

      expect(result.expiresAt.getTime()).not.toBe(NOW.getTime() + INVITATION_TOKEN_EXPIRY_MS);
      expect(result.expiresAt.getTime()).not.toBe(
        NOW.getTime() + EMAIL_VERIFICATION_TOKEN_EXPIRY_MS,
      );
    });

    test('measures the expiry from the current time, not from a fixed epoch', () => {
      const generator = new CryptoTokenGenerator(createConfig());
      const first = generator.generatePasswordResetToken();

      jest.setSystemTime(new Date(NOW.getTime() + 60_000));
      const second = generator.generatePasswordResetToken();

      expect(second.expiresAt.getTime() - first.expiresAt.getTime()).toBe(60_000);
    });

    test('generates a distinct token on every call', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      const tokens = new Set(
        Array.from({ length: 20 }, () => generator.generatePasswordResetToken().token),
      );

      expect(tokens.size).toBe(20);
    });

    test('generates a distinct hash on every call', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      const first = generator.generatePasswordResetToken();
      const second = generator.generatePasswordResetToken();

      expect(second.hashedToken).not.toBe(first.hashedToken);
    });
  });

  describe('generateInvitationToken', () => {
    test('expires after the domain invitation lifetime (72 hours)', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateInvitationToken();

      expect(INVITATION_TOKEN_EXPIRY_MS).toBe(72 * 60 * 60 * 1000);
      expect(result.expiresAt.getTime()).toBe(NOW.getTime() + INVITATION_TOKEN_EXPIRY_MS);
    });

    test('ignores the configured password-reset expiry', () => {
      const config = createConfig({ tokenExpiry: 1 });

      const result = new CryptoTokenGenerator(config).generateInvitationToken();

      expect(result.expiresAt.getTime()).toBe(NOW.getTime() + INVITATION_TOKEN_EXPIRY_MS);
    });

    test('does not reuse the email-verification lifetime', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateInvitationToken();

      expect(result.expiresAt.getTime()).not.toBe(
        NOW.getTime() + EMAIL_VERIFICATION_TOKEN_EXPIRY_MS,
      );
    });

    test('returns a hex token of the configured length with a matching hash', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateInvitationToken();

      expect(result.token).toMatch(/^[0-9a-f]{40}$/);
      expect(result.hashedToken).toBe(sha256Hex(result.token));
    });

    test('generates a distinct token on every call', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      expect(generator.generateInvitationToken().token).not.toBe(
        generator.generateInvitationToken().token,
      );
    });
  });

  describe('generateEmailVerificationToken', () => {
    test('expires after the domain email-verification lifetime (24 hours)', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateEmailVerificationToken();

      expect(EMAIL_VERIFICATION_TOKEN_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
      expect(result.expiresAt.getTime()).toBe(NOW.getTime() + EMAIL_VERIFICATION_TOKEN_EXPIRY_MS);
    });

    test('does not reuse the invitation lifetime', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateEmailVerificationToken();

      expect(result.expiresAt.getTime()).not.toBe(NOW.getTime() + INVITATION_TOKEN_EXPIRY_MS);
    });

    test('returns a hex token of the configured length with a matching hash', () => {
      const result = new CryptoTokenGenerator(createConfig()).generateEmailVerificationToken();

      expect(result.token).toMatch(/^[0-9a-f]{40}$/);
      expect(result.hashedToken).toBe(sha256Hex(result.token));
    });

    test('generates a distinct token on every call', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      expect(generator.generateEmailVerificationToken().token).not.toBe(
        generator.generateEmailVerificationToken().token,
      );
    });
  });

  describe('token kinds are independent', () => {
    test('the three kinds carry three different lifetimes', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      const reset = generator.generatePasswordResetToken().expiresAt.getTime();
      const invitation = generator.generateInvitationToken().expiresAt.getTime();
      const verification = generator.generateEmailVerificationToken().expiresAt.getTime();

      expect(new Set([reset, invitation, verification]).size).toBe(3);
      // Ordering the design intends: a reset link is the shortest lived, an invitation the longest.
      expect(reset).toBeLessThan(verification);
      expect(verification).toBeLessThan(invitation);
    });

    test('no two kinds share a token value', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      const tokens = [
        generator.generatePasswordResetToken().token,
        generator.generateInvitationToken().token,
        generator.generateEmailVerificationToken().token,
      ];

      expect(new Set(tokens).size).toBe(3);
    });
  });

  describe('hashToken', () => {
    test('returns the SHA-256 hex digest of the token', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      // Published SHA-256 test vector for "abc" — pins the algorithm and the hex encoding, so a
      // switch to SHA-1/SHA-512 or to base64 cannot pass.
      expect(generator.hashToken('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    test('hashes the empty string to the known empty digest', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      expect(generator.hashToken('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    test('is deterministic for the same input', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      expect(generator.hashToken('some-token')).toBe(generator.hashToken('some-token'));
    });

    test('produces a different digest for a one-character difference', () => {
      const generator = new CryptoTokenGenerator(createConfig());

      expect(generator.hashToken('some-token')).not.toBe(generator.hashToken('some-tokem'));
    });

    test('reproduces the hashedToken of every generated token kind', () => {
      // The lookup path hashes an incoming raw token with hashToken and compares it against the
      // stored hashedToken, so the two MUST agree for any kind of token.
      const generator = new CryptoTokenGenerator(createConfig());

      for (const result of [
        generator.generatePasswordResetToken(),
        generator.generateInvitationToken(),
        generator.generateEmailVerificationToken(),
      ]) {
        expect(generator.hashToken(result.token)).toBe(result.hashedToken);
      }
    });

    test('does not salt the digest with any per-instance state', () => {
      const first = new CryptoTokenGenerator(createConfig());
      const second = new CryptoTokenGenerator(createConfig({ tokenByteLength: 32 }));

      expect(second.hashToken('shared-token')).toBe(first.hashToken('shared-token'));
    });
  });
});
