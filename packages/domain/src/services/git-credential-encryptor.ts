/**
 * The encrypted form of a plaintext Git access token, ready to hand to
 * `GitCredentialStore.save` — that port only ever moves already-encrypted ciphertext.
 */
export interface EncryptedGitCredential {
  /** Opaque ciphertext; the plaintext token cannot be recovered from this value alone. */
  readonly encryptedToken: string;
  /** A short, non-sensitive fragment of the token (e.g. its last four characters), safe to display. */
  readonly tokenHint: string;
}

/**
 * Encrypts a plaintext Git access token for at-rest storage, so the token itself never reaches
 * persistence — or a log line — in the clear.
 *
 * Kept as its own interface, the same reason `PasswordHasher` keeps password hashing out of the
 * use cases that call it: the actual cryptography (e.g. AES-256-GCM under a dedicated key) is an
 * infrastructure concern, and a use case that handles a token should depend on this contract, not
 * on the concrete algorithm or key management behind it.
 */
export interface GitCredentialEncryptor {
  /**
   * Encrypts a plaintext token.
   *
   * @param plaintextToken - The raw access token. Held only for the duration of this call — never
   *   logged, persisted, or returned by the encryptor itself.
   * @returns The ciphertext and a display-safe hint, ready for `GitCredentialStore.save`.
   */
  encrypt(plaintextToken: string): EncryptedGitCredential;
}
