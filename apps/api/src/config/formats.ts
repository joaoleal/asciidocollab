import convict from 'convict';

/**
 * Custom convict format for hostname validation.
 */
convict.addFormat({
  name: 'hostname',
  validate: (value: unknown) => {
    if (typeof value !== 'string') {
      throw new TypeError('must be a string');
    }
    if (value.length === 0) {
      return; // empty string is valid (means bind to all interfaces)
    }
    const hostnameRegex = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/;
    if (!hostnameRegex.test(value) && value !== '0.0.0.0' && value !== 'localhost') {
      throw new Error(`must be a valid hostname, got "${value}"`);
    }
  },
});

/**
 * Custom convict format for a strictly-positive integer (>= 1).
 *
 * Unlike the built-in `int`/`integer` formats, this rejects 0 and negatives —
 * used for retention/window/interval settings where a non-positive value would
 * silently disable the behaviour (e.g. A zero coalescing window blacks out all
 * auth-attempt telemetry). `coerce` parses the string env vars convict supplies.
 */
convict.addFormat({
  name: 'positive-int',
  coerce: (value: unknown) => (typeof value === 'string' ? Number(value) : value),
  validate: (value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`must be an integer >= 1, got ${String(value)}`);
    }
  },
});

/**
 * Custom convict format for required string validation.
 *
 * Rejects null (unset) and empty strings. When used with `default: null`,
 * convict's `config.validate()` will fail if the env var is not set.
 */
convict.addFormat({
  name: 'required-string',
  validate: (value: unknown) => {
    if (value === null || value === undefined) {
      throw new TypeError('must be set via environment variable');
    }
    if (typeof value !== 'string') {
      throw new TypeError('must be a string');
    }
    if (value.length === 0) {
      throw new TypeError('must not be empty');
    }
  },
});

/**
 * Custom convict format for a base64-encoded 32-byte key.
 *
 * Mirrors the runtime guard in SessionEncryption (the infrastructure package) so a
 * wrong-length or malformed session encryption key is rejected at config load. The server
 * then fails fast at startup with an operator-facing error, instead of booting and later
 * throwing the same "must be a base64-encoded 32-byte string" at the first user who triggers
 * a session, such as the first-admin account-setup submit, where it would surface as a
 * baffling error under the sign-up form. Like `required-string`, this also rejects a
 * null/unset or empty value, so the key remains required.
 */
convict.addFormat({
  name: 'base64-32byte-key',
  validate: (value: unknown) => {
    if (value === null || value === undefined) {
      throw new TypeError('must be set via environment variable');
    }
    if (typeof value !== 'string') {
      throw new TypeError('must be a string');
    }
    if (value.length === 0) {
      throw new TypeError('must not be empty');
    }
    // Validate the alphabet before decoding: Buffer.from silently drops characters outside the
    // base64 alphabet, so an otherwise-malformed key could coincidentally decode to 32 bytes and
    // slip through the length check below.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error('must be a base64-encoded 32-byte string (e.g. openssl rand -base64 32)');
    }
    if (Buffer.from(value, 'base64').length !== 32) {
      throw new Error('must be a base64-encoded 32-byte string (e.g. openssl rand -base64 32)');
    }
  },
});
