import { createCollabConfig } from '../src/config/collab-config';

describe('createCollabConfig', () => {
  const VALID_ENV = {
    ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS: '3000',
    ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS: '30000',
    ASCIIDOCOLLAB_DATABASE_URL: 'postgresql://localhost/test',
  };

  function withEnvironment(overrides: Record<string, string>, function_: () => void) {
    const backup: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({ ...VALID_ENV, ...overrides })) {
      backup[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      function_();
    } finally {
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it('creates config with default authTimeoutMs of 3000', () => {
    const config = createCollabConfig();
    expect(config.get('authTimeoutMs')).toBe(3000);
  });

  it('throws when authTimeoutMs is 0 — prevents AbortSignal.timeout(0) silently blocking all connections', () => {
    withEnvironment({ ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS: '0' }, () => {
      expect(() => {
        const config = createCollabConfig();
        config.validate();
      }).toThrow();
    });
  });

  it('throws when authTimeoutMs is negative', () => {
    withEnvironment({ ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS: '-1' }, () => {
      expect(() => {
        const config = createCollabConfig();
        config.validate();
      }).toThrow();
    });
  });

  it('throws when watchdogIntervalMs is 0', () => {
    withEnvironment({ ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS: '0' }, () => {
      expect(() => {
        const config = createCollabConfig();
        config.validate();
      }).toThrow();
    });
  });

  it('accepts valid positive integers for authTimeoutMs and watchdogIntervalMs', () => {
    withEnvironment({ ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS: '5000', ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS: '60000' }, () => {
      expect(() => {
        const config = createCollabConfig();
        config.validate();
      }).not.toThrow();
    });
  });

  describe('content-changed notify config', () => {
    it('defaults contentChangedNotifyPath to the internal collab route', () => {
      const config = createCollabConfig();
      expect(config.get('contentChangedNotifyPath')).toBe('/internal/collab/content-changed');
    });

    it('defaults contentChangedDebounceMs to a positive window', () => {
      const config = createCollabConfig();
      expect(config.get('contentChangedDebounceMs')).toBe(400);
    });

    it('reads contentChangedNotifyPath from ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_NOTIFY_PATH', () => {
      withEnvironment({ ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_NOTIFY_PATH: '/internal/collab/changed' }, () => {
        const config = createCollabConfig();
        expect(config.get('contentChangedNotifyPath')).toBe('/internal/collab/changed');
      });
    });

    it('reads contentChangedDebounceMs from ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS', () => {
      withEnvironment({ ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS: '250' }, () => {
        const config = createCollabConfig();
        expect(config.get('contentChangedDebounceMs')).toBe(250);
      });
    });

    it('throws when contentChangedDebounceMs is zero', () => {
      withEnvironment({ ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS: '0' }, () => {
        expect(() => {
          const config = createCollabConfig();
          config.validate();
        }).toThrow();
      });
    });
  });

  it('apiInternalTls.cert defaults to empty string (mTLS disabled in development)', () => {
    const config = createCollabConfig();
    expect(config.get('apiInternalTls.cert')).toBe('');
  });

  it('apiInternalTls.key defaults to empty string', () => {
    const config = createCollabConfig();
    expect(config.get('apiInternalTls.key')).toBe('');
  });

  it('apiInternalTls.ca defaults to empty string', () => {
    const config = createCollabConfig();
    expect(config.get('apiInternalTls.ca')).toBe('');
  });

  it('reads apiInternalTls.cert from ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CERT', () => {
    withEnvironment({ ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CERT: '/certs/client.pem' }, () => {
      const config = createCollabConfig();
      expect(config.get('apiInternalTls.cert')).toBe('/certs/client.pem');
    });
  });

  // Security config keys.
  describe('security config keys', () => {
    it('provides safe defaults for the security keys', () => {
      const config = createCollabConfig();
      expect(config.get('allowedOrigins')).toBe('');
      expect(config.get('maxPayloadBytes')).toBe(1_048_576);
      expect(config.get('maxConnectionsPerUser')).toBe(20);
      expect(config.get('maxRoomsPerUser')).toBe(50);
      expect(config.get('connectRatePerMin')).toBe(120);
    });

    it('reads allowedOrigins from ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS', () => {
      withEnvironment({ ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS: 'https://a.example,https://b.example' }, () => {
        const config = createCollabConfig();
        expect(config.get('allowedOrigins')).toBe('https://a.example,https://b.example');
      });
    });

    it.each([
      ['ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES'],
      ['ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER'],
      ['ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER'],
      ['ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN'],
    ])('throws when %s is zero', (environmentKey) => {
      withEnvironment({ [environmentKey]: '0' }, () => {
        expect(() => {
          const config = createCollabConfig();
          config.validate();
        }).toThrow();
      });
    });

    it('throws when maxConnectionsPerUser is negative', () => {
      withEnvironment({ ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER: '-5' }, () => {
        expect(() => {
          const config = createCollabConfig();
          config.validate();
        }).toThrow();
      });
    });

    it('accepts valid positive integers for all security limits', () => {
      withEnvironment(
        {
          ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES: '2097152',
          ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER: '10',
          ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER: '25',
          ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN: '60',
        },
        () => {
          expect(() => {
            const config = createCollabConfig();
            config.validate();
          }).not.toThrow();
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Exhaustive contract pinning: every key's env-var name, default, parsed type,
  // documentation and validation boundary. A rename or retyped default anywhere
  // in the schema silently changes deployed behaviour, so each is asserted here.
  // ---------------------------------------------------------------------------

  /** Every environment variable the collab schema binds. Cleared before default-value assertions. */
  const ALL_ENVIRONMENT_KEYS = [
    'ASCIIDOCOLLAB_COLLAB_PORT',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_HOST',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_CERT',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_KEY',
    'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_CLIENT_CA',
    'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_URL',
    'ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS',
    'ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_NOTIFY_PATH',
    'ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS',
    'ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS',
    'ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS',
    'ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES',
    'ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER',
    'ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER',
    'ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN',
    'ASCIIDOCOLLAB_STORAGE_PATH',
    'ASCIIDOCOLLAB_DATABASE_URL',
    'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CERT',
    'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_KEY',
    'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CA',
  ];

  /** Runs `function_` with every collab env var cleared, then only `overrides` applied. */
  function withOnlyEnvironment(overrides: Record<string, string>, function_: () => void) {
    const backup: Record<string, string | undefined> = {};
    for (const key of ALL_ENVIRONMENT_KEYS) {
      backup[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in backup)) {
        backup[key] = process.env[key];
      }
      process.env[key] = value;
    }
    try {
      function_();
    } finally {
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  type CollabConfigInstance = ReturnType<typeof createCollabConfig>;

  /** Reads a dotted config path without needing a literal key type. */
  function readValue(config: CollabConfigInstance, path: string): unknown {
    return (config.get as unknown as (name: string) => unknown)(path);
  }

  /** Walks the normalized convict schema to the node for a dotted path. */
  function schemaNode(config: CollabConfigInstance, path: string): Record<string, unknown> {
    let node = config.getSchema() as unknown as Record<string, unknown>;
    for (const segment of path.split('.')) {
      const properties = node['_cvtProperties'] as Record<string, unknown> | undefined;
      const next = properties?.[segment] as Record<string, unknown> | undefined;
      if (next === undefined) {
        throw new Error(`schema has no property '${path}' (missing segment '${segment}')`);
      }
      node = next;
    }
    return node;
  }

  interface KeyContract {
    path: string;
    doc: string;
    fallback: string | number;
    environmentKey: string;
    /** Raw string written to the environment variable in the binding test. */
    raw: string;
    /** Value `config.get(path)` must return once `raw` is coerced by the declared format. */
    parsed: string | number;
    sensitive?: boolean;
  }

  const KEY_CONTRACTS: KeyContract[] = [
    {
      path: 'port',
      doc: 'WebSocket port for the collaboration server.',
      fallback: 4002,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_PORT',
      raw: '5101',
      parsed: 5101,
    },
    {
      path: 'internalEditPort',
      doc: 'Port for the internal HTTP server the API calls to rewrite references in live documents.',
      fallback: 4003,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT',
      raw: '5102',
      parsed: 5102,
    },
    {
      path: 'internalEditHost',
      doc: 'Interface the internal edit server binds to. Defaults to loopback; do not expose publicly.',
      fallback: '127.0.0.1',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_HOST',
      raw: '10.0.0.7',
      parsed: '10.0.0.7',
    },
    {
      path: 'internalEditSecret',
      doc: 'Optional shared secret enforced on the internal edit endpoint. Empty disables the check (loopback-trust, development only — set this in production).',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET',
      raw: 'shared-edit-secret',
      parsed: 'shared-edit-secret',
      sensitive: true,
    },
    {
      path: 'internalEditTls.cert',
      doc: 'Path to PEM file containing the server certificate for the internal edit mTLS server. Empty disables mTLS (loopback HTTP only).',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_CERT',
      raw: '/tls/internal-edit-server.pem',
      parsed: '/tls/internal-edit-server.pem',
    },
    {
      path: 'internalEditTls.key',
      doc: 'Path to PEM file containing the server private key for the internal edit mTLS server.',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_KEY',
      raw: '/tls/internal-edit-server.key',
      parsed: '/tls/internal-edit-server.key',
    },
    {
      path: 'internalEditTls.clientCa',
      doc: 'Path to PEM file containing the CA certificate used to verify the API client certificate.',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_TLS_CLIENT_CA',
      raw: '/tls/internal-edit-client-ca.pem',
      parsed: '/tls/internal-edit-client-ca.pem',
    },
    {
      path: 'apiInternalUrl',
      doc: 'Internal URL used by the auth hook to reach apps/api internal server.',
      fallback: 'http://127.0.0.1:4001',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_URL',
      raw: 'http://api.internal:9100',
      parsed: 'http://api.internal:9100',
    },
    {
      path: 'authTimeoutMs',
      doc: 'Auth hook HTTP request timeout in milliseconds.',
      fallback: 3000,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS',
      raw: '7500',
      parsed: 7500,
    },
    {
      path: 'contentChangedNotifyPath',
      doc: 'Path on the API internal server that receives content-changed notifications for live edits.',
      fallback: '/internal/collab/content-changed',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_NOTIFY_PATH',
      raw: '/internal/collab/changed',
      parsed: '/internal/collab/changed',
    },
    {
      path: 'contentChangedDebounceMs',
      doc: 'Per-room debounce window in milliseconds for coalescing a burst of live edits into one content-changed notify.',
      fallback: 400,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS',
      raw: '250',
      parsed: 250,
    },
    {
      path: 'watchdogIntervalMs',
      doc: 'Orphaned-room watchdog polling interval in milliseconds.',
      fallback: 30_000,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS',
      raw: '45000',
      parsed: 45_000,
    },
    {
      path: 'allowedOrigins',
      doc: 'Comma-separated list of allowed WebSocket-handshake Origins. Empty disables the Origin check (development only — set this in production).',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS',
      raw: 'https://one.example,https://two.example',
      parsed: 'https://one.example,https://two.example',
    },
    {
      path: 'maxPayloadBytes',
      doc: 'Maximum size in bytes of a single inbound collaboration message.',
      fallback: 1_048_576,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES',
      raw: '2097152',
      parsed: 2_097_152,
    },
    {
      path: 'maxConnectionsPerUser',
      doc: 'Maximum concurrent WebSocket connections per authenticated user.',
      fallback: 20,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER',
      raw: '11',
      parsed: 11,
    },
    {
      path: 'maxRoomsPerUser',
      doc: 'Maximum distinct rooms a single user may join concurrently.',
      fallback: 50,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER',
      raw: '12',
      parsed: 12,
    },
    {
      path: 'connectRatePerMin',
      doc: 'Maximum new connections accepted per authenticated user per minute.',
      fallback: 120,
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN',
      raw: '13',
      parsed: 13,
    },
    {
      path: 'storagePath',
      doc: 'Root directory for per-project file storage (shared with apps/api).',
      fallback: './storage',
      environmentKey: 'ASCIIDOCOLLAB_STORAGE_PATH',
      raw: '/var/lib/asciidocollab/storage',
      parsed: '/var/lib/asciidocollab/storage',
    },
    {
      path: 'databaseUrl',
      doc: 'PostgreSQL connection URL.',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_DATABASE_URL',
      raw: 'postgresql://db.example/asciidocollab',
      parsed: 'postgresql://db.example/asciidocollab',
      sensitive: true,
    },
    {
      path: 'apiInternalTls.cert',
      doc: 'Path to PEM file containing the client certificate presented to apps/api. Empty string disables mTLS (loopback HTTP only).',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CERT',
      raw: '/tls/api-client.pem',
      parsed: '/tls/api-client.pem',
    },
    {
      path: 'apiInternalTls.key',
      doc: 'Path to PEM file containing the client private key for mTLS.',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_KEY',
      raw: '/tls/api-client.key',
      parsed: '/tls/api-client.key',
    },
    {
      path: 'apiInternalTls.ca',
      doc: 'Path to PEM file containing the CA certificate used to validate the apps/api server certificate.',
      fallback: '',
      environmentKey: 'ASCIIDOCOLLAB_COLLAB_API_INTERNAL_TLS_CA',
      raw: '/tls/api-ca.pem',
      parsed: '/tls/api-ca.pem',
    },
  ];

  describe('schema contract', () => {
    it('declares exactly the documented top-level keys', () => {
      const config = createCollabConfig();
      const root = config.getSchema() as unknown as Record<string, unknown>;
      const properties = root['_cvtProperties'] as Record<string, unknown>;
      expect(Object.keys(properties)).toEqual([
        'port',
        'internalEditPort',
        'internalEditHost',
        'internalEditSecret',
        'internalEditTls',
        'apiInternalUrl',
        'authTimeoutMs',
        'contentChangedNotifyPath',
        'contentChangedDebounceMs',
        'watchdogIntervalMs',
        'allowedOrigins',
        'maxPayloadBytes',
        'maxConnectionsPerUser',
        'maxRoomsPerUser',
        'connectRatePerMin',
        'storagePath',
        'databaseUrl',
        'apiInternalTls',
      ]);
    });

    it('nests the two TLS groups as sub-schemas rather than flat leaves', () => {
      const config = createCollabConfig();
      expect(Object.keys(schemaNode(config, 'internalEditTls')['_cvtProperties'] as object)).toEqual([
        'cert',
        'key',
        'clientCa',
      ]);
      expect(Object.keys(schemaNode(config, 'apiInternalTls')['_cvtProperties'] as object)).toEqual([
        'cert',
        'key',
        'ca',
      ]);
    });

    it.each(KEY_CONTRACTS)('$path documents itself and binds $environmentKey', (contract) => {
      const config = createCollabConfig();
      const node = schemaNode(config, contract.path);
      expect(node['doc']).toBe(contract.doc);
      expect(node['env']).toBe(contract.environmentKey);
      expect(node['default']).toBe(contract.fallback);
    });

    it.each(KEY_CONTRACTS.filter((contract) => contract.sensitive === true))(
      '$path is marked sensitive in the schema',
      (contract) => {
        const config = createCollabConfig();
        expect(schemaNode(config, contract.path)['sensitive']).toBe(true);
      },
    );

    it.each(KEY_CONTRACTS.filter((contract) => contract.sensitive !== true))(
      '$path is not marked sensitive in the schema',
      (contract) => {
        const config = createCollabConfig();
        expect(schemaNode(config, contract.path)['sensitive']).toBeUndefined();
      },
    );

    it('declares port and internalEditPort with the port format so they coerce to numbers', () => {
      const config = createCollabConfig();
      expect(schemaNode(config, 'port')['format']).toBe('port');
      expect(schemaNode(config, 'internalEditPort')['format']).toBe('port');
    });

    it.each([
      'internalEditHost',
      'internalEditSecret',
      'internalEditTls.cert',
      'internalEditTls.key',
      'internalEditTls.clientCa',
      'apiInternalUrl',
      'contentChangedNotifyPath',
      'allowedOrigins',
      'storagePath',
      'databaseUrl',
      'apiInternalTls.cert',
      'apiInternalTls.key',
      'apiInternalTls.ca',
    ])('declares %s with the String format', (path) => {
      const config = createCollabConfig();
      expect(schemaNode(config, path)['format']).toBe('string');
    });
  });

  describe('defaults when no collab environment variable is set', () => {
    it('resolves the complete default configuration tree', () => {
      withOnlyEnvironment({}, () => {
        const config = createCollabConfig();
        expect(config.getProperties()).toEqual({
          port: 4002,
          internalEditPort: 4003,
          internalEditHost: '127.0.0.1',
          internalEditSecret: '',
          internalEditTls: { cert: '', key: '', clientCa: '' },
          apiInternalUrl: 'http://127.0.0.1:4001',
          authTimeoutMs: 3000,
          contentChangedNotifyPath: '/internal/collab/content-changed',
          contentChangedDebounceMs: 400,
          watchdogIntervalMs: 30_000,
          allowedOrigins: '',
          maxPayloadBytes: 1_048_576,
          maxConnectionsPerUser: 20,
          maxRoomsPerUser: 50,
          connectRatePerMin: 120,
          storagePath: './storage',
          databaseUrl: '',
          apiInternalTls: { cert: '', key: '', ca: '' },
        });
      });
    });

    it('validates cleanly with nothing configured', () => {
      withOnlyEnvironment({}, () => {
        expect(() => createCollabConfig().validate()).not.toThrow();
      });
    });

    it('points apiInternalUrl at loopback on the shared internal API port', () => {
      withOnlyEnvironment({}, () => {
        const config = createCollabConfig();
        expect(config.get('apiInternalUrl')).toBe('http://127.0.0.1:4001');
      });
    });

    it.each(KEY_CONTRACTS)('$path falls back to its documented default', (contract) => {
      withOnlyEnvironment({}, () => {
        const config = createCollabConfig();
        expect(readValue(config, contract.path)).toBe(contract.fallback);
      });
    });
  });

  describe('environment variable bindings', () => {
    it.each(KEY_CONTRACTS)('$path reads $environmentKey', (contract) => {
      withOnlyEnvironment({ [contract.environmentKey]: contract.raw }, () => {
        const config = createCollabConfig();
        expect(readValue(config, contract.path)).toBe(contract.parsed);
      });
    });

    it.each(KEY_CONTRACTS)('$path ignores every other collab environment variable', (contract) => {
      const others: Record<string, string> = {};
      for (const other of KEY_CONTRACTS) {
        if (other.environmentKey !== contract.environmentKey) {
          others[other.environmentKey] = other.raw;
        }
      }
      withOnlyEnvironment(others, () => {
        const config = createCollabConfig();
        expect(readValue(config, contract.path)).toBe(contract.fallback);
      });
    });
  });

  describe('sensitive values', () => {
    it('masks internalEditSecret and databaseUrl in toString(), leaving other keys legible', () => {
      withOnlyEnvironment(
        {
          ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET: 'shared-edit-secret',
          ASCIIDOCOLLAB_DATABASE_URL: 'postgresql://user:password@db.example/asciidocollab',
          ASCIIDOCOLLAB_STORAGE_PATH: '/var/lib/asciidocollab/storage',
        },
        () => {
          const config = createCollabConfig();
          const rendered = JSON.parse(config.toString()) as Record<string, unknown>;
          expect(rendered['internalEditSecret']).toBe('[Sensitive]');
          expect(rendered['databaseUrl']).toBe('[Sensitive]');
          expect(rendered['storagePath']).toBe('/var/lib/asciidocollab/storage');
          expect(config.toString()).not.toContain('shared-edit-secret');
          expect(config.toString()).not.toContain('postgresql://user:password@db.example/asciidocollab');
          // The values are still readable through get(); only the rendered form is masked.
          expect(config.get('internalEditSecret')).toBe('shared-edit-secret');
          expect(config.get('databaseUrl')).toBe('postgresql://user:password@db.example/asciidocollab');
        },
      );
    });

    it('masks the sensitive keys even when they are left at their empty defaults', () => {
      withOnlyEnvironment({}, () => {
        const rendered = JSON.parse(createCollabConfig().toString()) as Record<string, unknown>;
        expect(rendered['internalEditSecret']).toBe('[Sensitive]');
        expect(rendered['databaseUrl']).toBe('[Sensitive]');
      });
    });
  });

  describe('positive-integer validation boundary', () => {
    const POSITIVE_INTEGER_KEYS = [
      { key: 'authTimeoutMs', environmentKey: 'ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS' },
      { key: 'contentChangedDebounceMs', environmentKey: 'ASCIIDOCOLLAB_COLLAB_CONTENT_CHANGED_DEBOUNCE_MS' },
      { key: 'watchdogIntervalMs', environmentKey: 'ASCIIDOCOLLAB_COLLAB_WATCHDOG_INTERVAL_MS' },
      { key: 'maxPayloadBytes', environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES' },
      { key: 'maxConnectionsPerUser', environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER' },
      { key: 'maxRoomsPerUser', environmentKey: 'ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER' },
      { key: 'connectRatePerMin', environmentKey: 'ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN' },
    ];

    it.each(POSITIVE_INTEGER_KEYS)('accepts exactly 1 for $key — the bound is inclusive', ({ key, environmentKey }) => {
      withOnlyEnvironment({ [environmentKey]: '1' }, () => {
        const config = createCollabConfig();
        expect(() => config.validate()).not.toThrow();
        expect(readValue(config, key)).toBe(1);
      });
    });

    it.each(POSITIVE_INTEGER_KEYS)('rejects 0 for $key and names the key in the message', ({ key, environmentKey }) => {
      withOnlyEnvironment({ [environmentKey]: '0' }, () => {
        expect(() => createCollabConfig().validate()).toThrow(`${key} must be a positive integer >= 1`);
      });
    });

    it.each(POSITIVE_INTEGER_KEYS)('rejects -1 for $key and names the key in the message', ({ key, environmentKey }) => {
      withOnlyEnvironment({ [environmentKey]: '-1' }, () => {
        expect(() => createCollabConfig().validate()).toThrow(`${key} must be a positive integer >= 1`);
      });
    });

    it.each(POSITIVE_INTEGER_KEYS)(
      'rejects the fractional value 1.5 for $key and names the key in the message',
      ({ key, environmentKey }) => {
        withOnlyEnvironment({ [environmentKey]: '1.5' }, () => {
          expect(() => createCollabConfig().validate()).toThrow(`${key} must be a positive integer >= 1`);
        });
      },
    );

    it('reports the offending key rather than a bare message when several are invalid at once', () => {
      withOnlyEnvironment(
        {
          ASCIIDOCOLLAB_COLLAB_AUTH_TIMEOUT_MS: '0',
          ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER: '0',
        },
        () => {
          expect(() => createCollabConfig().validate()).toThrow(
            /authTimeoutMs must be a positive integer >= 1/,
          );
          expect(() => createCollabConfig().validate()).toThrow(
            /maxRoomsPerUser must be a positive integer >= 1/,
          );
        },
      );
    });
  });

  describe('port format validation', () => {
    it.each([
      ['port', 'ASCIIDOCOLLAB_COLLAB_PORT'],
      ['internalEditPort', 'ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT'],
    ])('rejects a non-port value for %s', (_key, environmentKey) => {
      withOnlyEnvironment({ [environmentKey]: '70000' }, () => {
        expect(() => createCollabConfig().validate()).toThrow();
      });
    });
  });
});
