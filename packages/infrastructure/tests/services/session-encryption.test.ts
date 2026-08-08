import { SessionEncryption } from '../../src/services/session-encryption';

// 32 zero bytes in base64
const VALID_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
// Different 32-byte base64 key for cross-key tests
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
// 16 bytes (too short)
const SHORT_KEY = 'AAAAAAAAAAAAAAAAAAAAAA==';
// 33 bytes (too long)
const LONG_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('Session Encryption', () => {
  test('encrypts and decrypts text with provided key', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const text = 'hello world';
    const encrypted = encryption.encrypt(text);
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  test('encrypts and decrypts text with generated key when empty', () => {
    const encryption = new SessionEncryption({ encryptionKey: '' });
    const text = 'test data';
    const encrypted = encryption.encrypt(text);
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  test('encrypted output has correct format (iv:tag:ciphertext)', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption.encrypt('test');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  test('throws when key decodes to fewer than 32 bytes', () => {
    const encryption = new SessionEncryption({ encryptionKey: SHORT_KEY });
    expect(() => encryption.encrypt('test')).toThrow(
      'Encryption key must be a base64-encoded 32-byte string (e.g. openssl rand -base64 32)',
    );
  });

  test('throws when key decodes to more than 32 bytes', () => {
    const encryption = new SessionEncryption({ encryptionKey: LONG_KEY });
    expect(() => encryption.encrypt('test')).toThrow(
      'Encryption key must be a base64-encoded 32-byte string (e.g. openssl rand -base64 32)',
    );
  });

  test('different encryptions produce different ciphertext', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const text = 'same text';
    const encrypted1 = encryption.encrypt(text);
    const encrypted2 = encryption.encrypt(text);
    expect(encrypted1).not.toBe(encrypted2);
  });

  test('decrypt fails with wrong key', () => {
    const encryption1 = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption1.encrypt('test');

    const encryption2 = new SessionEncryption({ encryptionKey: OTHER_KEY });
    expect(() => encryption2.decrypt(encrypted)).toThrow();
  });

  test('decrypt fails with tampered ciphertext', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption.encrypt('test');
    const parts = encrypted.split(':');
    const tampered = parts[0] + ':' + parts[1] + ':' + 'ff' + parts[2].slice(2);
    expect(() => encryption.decrypt(tampered)).toThrow();
  });

  test('decrypt fails with tampered tag', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption.encrypt('test');
    const parts = encrypted.split(':');
    const firstByte = Number.parseInt(parts[1].slice(0, 2), 16);
    const tamperedFirstByte = (firstByte ^ 0xFF).toString(16).padStart(2, '0');
    const tampered = parts[0] + ':' + tamperedFirstByte + parts[1].slice(2) + ':' + parts[2];
    expect(() => encryption.decrypt(tampered)).toThrow();
  });

  test('decrypt fails with tampered IV', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption.encrypt('test');
    const parts = encrypted.split(':');
    // Flip the first byte rather than setting it to a constant: the IV is random, so assigning `ff`
    // leaves it UNCHANGED whenever it already began with `ff` — a 1-in-256 run where the "tampered"
    // value decrypts cleanly and the assertion fails for the right reason. XOR always changes it.
    const firstByte = Number.parseInt(parts[0].slice(0, 2), 16);
    const tamperedFirstByte = (firstByte ^ 0xFF).toString(16).padStart(2, '0');
    const tampered = tamperedFirstByte + parts[0].slice(2) + ':' + parts[1] + ':' + parts[2];
    expect(() => encryption.decrypt(tampered)).toThrow();
  });

  test('decrypt fails with invalid format (missing parts)', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    expect(() => encryption.decrypt('invalid')).toThrow();
  });

  test('decrypt fails with empty string', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    expect(() => encryption.decrypt('')).toThrow();
  });

  test('encrypts empty string', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const encrypted = encryption.encrypt('');
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe('');
  });

  test('encrypts long text', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const text = 'a'.repeat(10_000);
    const encrypted = encryption.encrypt(text);
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  test('encrypts special characters', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const text = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const encrypted = encryption.encrypt(text);
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  test('encrypts unicode', () => {
    const encryption = new SessionEncryption({ encryptionKey: VALID_KEY });
    const text = 'こんにちは世界';
    const encrypted = encryption.encrypt(text);
    const decrypted = encryption.decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  // Issue: Buffer.from silently strips leading/trailing whitespace in base64 strings.
  // A key copied from a terminal with a trailing newline would decode to exactly 32 bytes,
  // pass the length check, and be silently accepted — but the operator intended a different key.
  test('throws when encryption key has a trailing space (silently strips to 32 bytes)', () => {
    // VALID_KEY + trailing space → Buffer.from strips the space, still 32 bytes
    const keyWithTrailingSpace = `${VALID_KEY} `;
    const encryption = new SessionEncryption({ encryptionKey: keyWithTrailingSpace });
    expect(() => encryption.encrypt('test')).toThrow(
      'Encryption key must be a base64-encoded 32-byte string',
    );
  });

  test('throws when encryption key has a trailing newline', () => {
    // A key pasted from a terminal often has a trailing newline
    const keyWithNewline = `${VALID_KEY}\n`;
    const encryption = new SessionEncryption({ encryptionKey: keyWithNewline });
    expect(() => encryption.encrypt('test')).toThrow(
      'Encryption key must be a base64-encoded 32-byte string',
    );
  });
});
