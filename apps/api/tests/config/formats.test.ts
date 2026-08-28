import '../../src/config/formats';
import convict from 'convict';

function makeHostnameConfig() {
  return convict({
    value: { format: 'hostname', default: '' as string, env: 'FORMATS_TEST_HOSTNAME_' + Math.random() },
  });
}

function makeRequiredStringConfig() {
  return convict({
    value: { format: 'required-string', default: null as unknown as string, env: 'FORMATS_TEST_REQ_' + Math.random() },
  });
}

function makePositiveIntConfig() {
  return convict({
    value: { format: 'positive-int', default: 1, env: 'FORMATS_TEST_POSINT_' + Math.random() },
  });
}

function makeBase64KeyConfig() {
  return convict({
    value: {
      format: 'base64-32byte-key',
      default: null as unknown as string,
      env: 'FORMATS_TEST_KEY_' + Math.random(),
    },
  });
}

function makeOptionalBase64KeyConfig() {
  return convict<{ value: unknown }>({
    value: {
      format: 'optional-base64-32byte-key',
      default: '',
      env: 'FORMATS_TEST_OPTIONAL_KEY_' + Math.random(),
    },
  });
}

function makeCommaSeparatedConfig() {
  return convict<{ value: unknown }>({
    value: {
      format: 'comma-separated-strings',
      default: [],
      env: 'FORMATS_TEST_LIST_' + Math.random(),
    },
  });
}

// A canonical valid key: 32 zero bytes, base64-encoded (44 chars). `openssl rand -base64 32`
// produces the same shape.
const VALID_32_BYTE_KEY = Buffer.alloc(32).toString('base64');
// The real-world misconfiguration this format guards against: `openssl rand -base64 48`, which is
// valid base64 but decodes to 48 bytes. The runtime SessionEncryption guard rejects it at the first
// session; this format must reject it at startup instead.
const KEY_48_BYTES = Buffer.alloc(48).toString('base64');

describe('hostname format', () => {
  it('accepts an empty string (bind to all interfaces)', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', '');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts a valid hostname', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', 'example.com');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts localhost', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', 'localhost');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts 0.0.0.0', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', '0.0.0.0');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('rejects a non-string value', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', 42 as never);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a string');
  });

  it('rejects an invalid hostname string', () => {
    const cfg = makeHostnameConfig();
    cfg.set('value', 'not a valid hostname!!');
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a valid hostname');
  });
});

describe('required-string format', () => {
  it('accepts a non-empty string', () => {
    const cfg = makeRequiredStringConfig();
    cfg.set('value', 'hello');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('rejects null', () => {
    const cfg = makeRequiredStringConfig();
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be set');
  });

  it('rejects an empty string', () => {
    const cfg = makeRequiredStringConfig();
    cfg.set('value', '');
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must not be empty');
  });

  it('rejects a non-string value', () => {
    const cfg = makeRequiredStringConfig();
    cfg.set('value', 123 as never);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a string');
  });
});

describe('positive-int format', () => {
  it('accepts 1 (the minimum)', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', 1);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts a larger integer', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', 90);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('rejects 0', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', 0);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an integer >= 1');
  });

  it('rejects a negative integer', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', -5);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an integer >= 1');
  });

  it('rejects a non-integer', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', 1.5);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an integer >= 1');
  });

  it('coerces a numeric string from the environment', () => {
    const cfg = makePositiveIntConfig();
    cfg.set('value', '30' as never);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
    expect(cfg.get('value')).toBe(30);
  });
});

describe('base64-32byte-key format', () => {
  it('accepts a base64-encoded 32-byte key', () => {
    const cfg = makeBase64KeyConfig();
    cfg.set('value', VALID_32_BYTE_KEY);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('rejects a key that decodes to 48 bytes at startup (the leaked-to-signup-form bug)', () => {
    const cfg = makeBase64KeyConfig();
    cfg.set('value', KEY_48_BYTES);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('rejects a key that decodes to fewer than 32 bytes', () => {
    const cfg = makeBase64KeyConfig();
    cfg.set('value', Buffer.alloc(16).toString('base64'));
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('rejects a string containing non-base64 characters', () => {
    const cfg = makeBase64KeyConfig();
    // 44 chars (the right length) but with characters outside the base64 alphabet.
    cfg.set('value', 'this is not base64 and it is definitely wrong!');
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('rejects null (unset environment variable)', () => {
    const cfg = makeBase64KeyConfig();
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be set');
  });

  it('rejects an empty string', () => {
    const cfg = makeBase64KeyConfig();
    cfg.set('value', '');
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must not be empty');
  });

  it('rejects a non-string value', () => {
    const cfg = makeBase64KeyConfig();
    cfg.set('value', 123 as never);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a string');
  });
});

describe('optional-base64-32byte-key format', () => {
  it('accepts an unset value, so the key stays optional until a provider needs it', () => {
    const cfg = makeOptionalBase64KeyConfig();
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts an explicitly empty string', () => {
    const cfg = makeOptionalBase64KeyConfig();
    cfg.set('value', '');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('accepts a base64-encoded 32-byte key', () => {
    const cfg = makeOptionalBase64KeyConfig();
    cfg.set('value', VALID_32_BYTE_KEY);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
  });

  it('rejects a key of the wrong decoded length', () => {
    const cfg = makeOptionalBase64KeyConfig();
    cfg.set('value', KEY_48_BYTES);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a base64-encoded 32-byte string');
  });

  it('rejects a string containing non-base64 characters', () => {
    const cfg = makeOptionalBase64KeyConfig();
    cfg.set('value', 'this is not base64 and it is definitely wrong!');
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a base64-encoded 32-byte string');
  });

  it('rejects a non-string value', () => {
    const cfg = makeOptionalBase64KeyConfig();
    cfg.set('value', 123);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be a string');
  });
});

describe('comma-separated-strings format', () => {
  it('splits, trims and drops empty entries from an environment string', () => {
    const cfg = makeCommaSeparatedConfig();
    cfg.set('value', 'github.com, gitlab.com,,');
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
    expect(cfg.get('value')).toEqual(['github.com', 'gitlab.com']);
  });

  it('passes an array default through unchanged', () => {
    const cfg = makeCommaSeparatedConfig();
    cfg.set('value', ['github.com']);
    expect(() => cfg.validate({ allowed: 'strict' })).not.toThrow();
    expect(cfg.get('value')).toEqual(['github.com']);
  });

  it('rejects a value that is neither a string nor an array', () => {
    const cfg = makeCommaSeparatedConfig();
    cfg.set('value', 42);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an array of strings');
  });

  it('rejects an array holding a non-string entry', () => {
    const cfg = makeCommaSeparatedConfig();
    cfg.set('value', ['github.com', 7]);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an array of non-empty strings');
  });

  it('rejects an array holding an empty entry', () => {
    const cfg = makeCommaSeparatedConfig();
    cfg.set('value', ['github.com', '']);
    expect(() => cfg.validate({ allowed: 'strict' })).toThrow('must be an array of non-empty strings');
  });
});
