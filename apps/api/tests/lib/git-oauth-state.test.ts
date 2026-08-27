import { SessionEncryption } from '@asciidocollab/infrastructure';
import { mintOAuthState, readOAuthState, OAUTH_STATE_TTL_MS } from '../../src/lib/git-oauth-state';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const BASE_INPUT = {
  projectId: 'project-1',
  actorId: 'actor-1',
  provider: 'github' as const,
  remoteUrl: 'https://github.com/acme/handbook.git',
  codeVerifier: 'the-code-verifier',
};

describe('OAuth state crypto', () => {
  it('round-trips every field, including an optional branch', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const now = Date.now();

    const state = mintOAuthState(encryption, { ...BASE_INPUT, branch: 'develop' }, now);
    const result = readOAuthState(encryption, state, now);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.projectId).toBe(BASE_INPUT.projectId);
      expect(result.value.actorId).toBe(BASE_INPUT.actorId);
      expect(result.value.provider).toBe(BASE_INPUT.provider);
      expect(result.value.remoteUrl).toBe(BASE_INPUT.remoteUrl);
      expect(result.value.codeVerifier).toBe(BASE_INPUT.codeVerifier);
      expect(result.value.branch).toBe('develop');
      expect(result.value.issuedAt).toBe(now);
      expect(typeof result.value.nonce).toBe('string');
      expect(result.value.nonce.length).toBeGreaterThan(0);
    }
  });

  it('round-trips with no branch given (field simply absent, not null/empty)', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const state = mintOAuthState(encryption, BASE_INPUT);
    const result = readOAuthState(encryption, state);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.branch).toBeUndefined();
    }
  });

  it('mints a different ciphertext for two calls with identical input (nonce + fresh GCM IV)', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const a = mintOAuthState(encryption, BASE_INPUT, 1000);
    const b = mintOAuthState(encryption, BASE_INPUT, 1000);
    expect(a).not.toBe(b);
  });

  it('rejects a state decrypted under a different key', () => {
    const mintKey = new SessionEncryption({ encryptionKey: KEY });
    const readKey = new SessionEncryption({ encryptionKey: OTHER_KEY });

    const state = mintOAuthState(mintKey, BASE_INPUT);
    const result = readOAuthState(readKey, state);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a tampered (bit-flipped) state', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const state = mintOAuthState(encryption, BASE_INPUT);
    const parts = state.split(':');
    // Flip one hex character in the ciphertext segment — GCM's auth tag must reject this.
    const flippedChar = parts[2][0] === 'a' ? 'b' : 'a';
    parts[2] = flippedChar + parts[2].slice(1);
    const tampered = parts.join(':');

    const result = readOAuthState(encryption, tampered);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a garbage string that is not even well-formed ciphertext', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const result = readOAuthState(encryption, 'not-a-real-state-value');
    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload that decrypts fine but is not valid JSON', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const notJson = encryption.encrypt('this is not json {');

    const result = readOAuthState(encryption, notJson);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload that is valid JSON but does not have the OAuthState shape', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const wrongShape = encryption.encrypt(JSON.stringify({ foo: 1 }));

    const result = readOAuthState(encryption, wrongShape);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload that is valid JSON but not an object at all (a bare JSON number)', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const notAnObject = encryption.encrypt(JSON.stringify(42));

    const result = readOAuthState(encryption, notAnObject);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload with a missing/empty actorId', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(
      JSON.stringify({ ...BASE_INPUT, actorId: '', nonce: 'n', issuedAt: Date.now() }),
    );

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload with an unrecognized provider', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(
      JSON.stringify({ ...BASE_INPUT, provider: 'not-a-real-provider', nonce: 'n', issuedAt: Date.now() }),
    );

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload with a missing/empty remoteUrl', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(
      JSON.stringify({ ...BASE_INPUT, remoteUrl: '', nonce: 'n', issuedAt: Date.now() }),
    );

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload where branch is present but not a string', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(
      JSON.stringify({ ...BASE_INPUT, branch: 123, nonce: 'n', issuedAt: Date.now() }),
    );

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload with a missing/empty codeVerifier', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(
      JSON.stringify({ ...BASE_INPUT, codeVerifier: '', nonce: 'n', issuedAt: Date.now() }),
    );

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a payload with a missing/empty nonce', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const payload = encryption.encrypt(JSON.stringify({ ...BASE_INPUT, nonce: '', issuedAt: Date.now() }));

    const result = readOAuthState(encryption, payload);

    expect(result).toEqual({ success: false, error: 'invalid' });
  });

  it('rejects a state whose issuedAt is exactly at the TTL boundary plus one millisecond', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const issuedAt = 1_000_000;
    const state = mintOAuthState(encryption, BASE_INPUT, issuedAt);

    const stillValid = readOAuthState(encryption, state, issuedAt + OAUTH_STATE_TTL_MS);
    expect(stillValid.success).toBe(true);

    const expired = readOAuthState(encryption, state, issuedAt + OAUTH_STATE_TTL_MS + 1);
    expect(expired).toEqual({ success: false, error: 'expired' });
  });

  it('the actorId-binding (CSRF) check is the caller\'s own responsibility: a state minted for one actor decrypts fine when read back — the mismatch check happens outside this module', () => {
    const encryption = new SessionEncryption({ encryptionKey: KEY });
    const state = mintOAuthState(encryption, { ...BASE_INPUT, actorId: 'attacker' });
    const result = readOAuthState(encryption, state);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.actorId).toBe('attacker');
      expect(result.value.actorId).not.toBe('victim');
    }
  });
});
