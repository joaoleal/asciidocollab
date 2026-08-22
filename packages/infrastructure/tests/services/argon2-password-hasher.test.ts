import * as argon2 from 'argon2';
import { Argon2PasswordHasher, Argon2Config } from '../../src/services/argon2-password-hasher';

// The real native binding is kept — the only assertions worth making about a password hasher are
// that a genuine hash verifies and a tampered one does not, and a stubbed argon2 can prove neither.
// hash/verify are wrapped in jest.fn so the arguments the adapter forwards can be inspected and so
// the failure path can be forced without provoking a real native error.
jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return {
    __esModule: true,
    ...actual,
    hash: jest.fn(actual.hash),
    verify: jest.fn(actual.verify),
  };
});

// Deliberately three DIFFERENT numbers: a swapped pair of constructor arguments would otherwise be
// invisible. They are also the cheapest values that argon2 accepts (memoryCost >= 8 * parallelism),
// because every real hash/verify below pays for them.
function createConfig(overrides: Partial<Argon2Config> = {}): Argon2Config {
  return {
    memoryCost: 4096,
    timeCost: 3,
    parallelism: 2,
    ...overrides,
  };
}

const PASSWORD = 'correct horse battery staple';

/**
 * Replaces the first character of a base64 PHC segment with a different one, which always changes
 * the top six bits of its first decoded byte. Assigning a constant would leave the segment UNCHANGED
 * whenever it already started with that character — a random-salt flake where the "tampered" hash
 * verifies cleanly.
 */
function flipFirstCharacter(segment: string): string {
  return (segment.startsWith('A') ? 'B' : 'A') + segment.slice(1);
}

/** Splits a PHC string `$argon2id$v=19$m=..,t=..,p=..$<salt>$<digest>` into its `$`-separated fields. */
function phcFields(hash: string): string[] {
  return hash.split('$');
}

describe('Argon2PasswordHasher', () => {
  // One real hash for the whole suite: argon2 is deliberately slow, so it is computed once and the
  // verify tests all point at it.
  let referenceHash: string;

  beforeAll(async () => {
    referenceHash = await new Argon2PasswordHasher(createConfig()).hash(PASSWORD);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('hash', () => {
    test('produces an argon2id PHC string carrying the configured cost parameters', () => {
      // The algorithm is argon2id (not argon2i/argon2d) and memoryCost/timeCost/parallelism reached
      // the m/t/p slots they belong in — a swapped pair would land the wrong number in a slot.
      // The parameter list is sorted because node-argon2 emits it as `m,p,t`, which is its own
      // serialisation detail rather than part of this adapter's contract.
      expect(referenceHash).toMatch(/^\$argon2id\$v=19\$/);
      expect(phcFields(referenceHash)[3].split(',').toSorted()).toEqual(['m=4096', 'p=2', 't=3']);
    });

    test('produces a hash with a salt and a digest field', () => {
      const fields = phcFields(referenceHash);
      // ['', 'argon2id', 'v=19', 'm=4096,t=3,p=2', salt, digest]
      expect(fields).toHaveLength(6);
      expect(fields[4].length).toBeGreaterThan(0);
      expect(fields[5].length).toBeGreaterThan(0);
    });

    test('forwards the plaintext, the argon2id type and every configured cost to argon2.hash', async () => {
      // Stubbed so unusable-but-distinct cost values can be asserted without the native module
      // rejecting them, and so no further real hashing is paid for.
      (argon2.hash as jest.Mock).mockResolvedValueOnce('$stub-hash');
      const hasher = new Argon2PasswordHasher({ memoryCost: 65_536, timeCost: 7, parallelism: 5 });

      const result = await hasher.hash('some-password');

      expect(argon2.hash).toHaveBeenCalledTimes(1);
      expect(argon2.hash).toHaveBeenCalledWith('some-password', {
        type: argon2.argon2id,
        memoryCost: 65_536,
        timeCost: 7,
        parallelism: 5,
      });
      // The adapter returns argon2's value untouched.
      expect(result).toBe('$stub-hash');
    });

    test('uses the argon2id variant rather than argon2i or argon2d', async () => {
      (argon2.hash as jest.Mock).mockResolvedValueOnce('$stub-hash');

      await new Argon2PasswordHasher(createConfig()).hash('pw');

      const options = (argon2.hash as jest.Mock).mock.calls[0][1];
      expect(options.type).toBe(argon2.argon2id);
      expect(options.type).not.toBe(argon2.argon2i);
      expect(options.type).not.toBe(argon2.argon2d);
    });

    test('salts each call so the same password never hashes to the same string twice', async () => {
      const again = await new Argon2PasswordHasher(createConfig()).hash(PASSWORD);

      expect(again).not.toBe(referenceHash);
      // Same parameters, different salt — the difference must come from the salt field.
      expect(phcFields(again)[3]).toBe(phcFields(referenceHash)[3]);
      expect(phcFields(again)[4]).not.toBe(phcFields(referenceHash)[4]);
    });

    test('propagates an argon2 failure rather than swallowing it', async () => {
      (argon2.hash as jest.Mock).mockRejectedValueOnce(new Error('memory allocation failed'));

      await expect(new Argon2PasswordHasher(createConfig()).hash(PASSWORD))
        .rejects.toThrow('memory allocation failed');
    });
  });

  describe('verify', () => {
    test('accepts the password that produced the hash', async () => {
      const hasher = new Argon2PasswordHasher(createConfig());

      await expect(hasher.verify(referenceHash, PASSWORD)).resolves.toBe(true);
    });

    test('rejects a different password', async () => {
      const hasher = new Argon2PasswordHasher(createConfig());

      await expect(hasher.verify(referenceHash, 'wrong horse battery staple')).resolves.toBe(false);
    });

    test('rejects a password differing only in case', async () => {
      const hasher = new Argon2PasswordHasher(createConfig());

      await expect(hasher.verify(referenceHash, PASSWORD.toUpperCase())).resolves.toBe(false);
    });

    test('rejects the correct password against a hash whose digest was tampered with', async () => {
      const fields = phcFields(referenceHash);
      fields[5] = flipFirstCharacter(fields[5]);
      const tampered = fields.join('$');
      expect(tampered).not.toBe(referenceHash);

      await expect(new Argon2PasswordHasher(createConfig()).verify(tampered, PASSWORD))
        .resolves.toBe(false);
    });

    test('rejects the correct password against a hash whose salt was tampered with', async () => {
      const fields = phcFields(referenceHash);
      fields[4] = flipFirstCharacter(fields[4]);
      const tampered = fields.join('$');
      expect(tampered).not.toBe(referenceHash);

      await expect(new Argon2PasswordHasher(createConfig()).verify(tampered, PASSWORD))
        .resolves.toBe(false);
    });

    test('passes the hash first and the plaintext second', async () => {
      // A swapped pair here is the classic silent auth hole: argon2.verify(plain, hash) throws on a
      // malformed "hash", so the behavioural round-trip above catches it too — this pins the order.
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await new Argon2PasswordHasher(createConfig()).verify(referenceHash, PASSWORD);

      expect(argon2.verify).toHaveBeenCalledWith(referenceHash, PASSWORD);
    });

    test('returns argon2 verify results untouched instead of coercing them', async () => {
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

      await expect(new Argon2PasswordHasher(createConfig()).verify(referenceHash, PASSWORD))
        .resolves.toBe(false);
    });

    test('propagates an argon2 failure rather than reporting a mismatch', async () => {
      // Distinguishing "the password is wrong" from "the hasher is broken" matters: a catch-all that
      // returned false here would turn an outage into a wave of bogus authentication failures.
      (argon2.verify as jest.Mock).mockRejectedValueOnce(new Error('binding unavailable'));

      await expect(new Argon2PasswordHasher(createConfig()).verify(referenceHash, PASSWORD))
        .rejects.toThrow('binding unavailable');
    });

    test('does not silently accept a malformed stored hash', async () => {
      const hasher = new Argon2PasswordHasher(createConfig());

      // Either outcome is acceptable, but "true" never is.
      await hasher.verify('not-a-phc-string', PASSWORD).then(
        (accepted) => expect(accepted).toBe(false),
        (error: unknown) => expect(error).toBeInstanceOf(Error),
      );
    });
  });
});
