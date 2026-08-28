import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getConfig, loadConfig } from '../../src/config';
import { setupTestEnvironment } from '../helpers/test-environment';

/** A throwaway directory holding the YAML files one loadConfig call should pick up. */
function makeConfigDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'asciidocollab-config-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), contents);
  }
  return directory;
}

describe('loadConfig', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;

  beforeAll(() => {
    setupTestEnvironment();
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
  });

  afterEach(() => {
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('layers the environment file over default.yaml', () => {
    process.env.NODE_ENV = 'test';
    const directory = makeConfigDirectory({
      'default.yaml': 'api:\n  port: 4000\n  host: 0.0.0.0\n',
      'test.yaml': 'api:\n  port: 4321\n',
    });

    loadConfig(directory);

    expect(getConfig().api.port).toBe(4321);
    expect(getConfig().api.host).toBe('0.0.0.0');
  });

  it('reads the development file when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    const directory = makeConfigDirectory({
      'default.yaml': 'api:\n  port: 4000\n',
      'development.yaml': 'api:\n  port: 4444\n',
    });

    loadConfig(directory);

    expect(getConfig().api.port).toBe(4444);
  });

  it('loads from an empty directory without touching the current values', () => {
    process.env.NODE_ENV = 'test';
    loadConfig(makeConfigDirectory({ 'default.yaml': 'api:\n  port: 4500\n' }));

    expect(() => loadConfig(makeConfigDirectory({}))).not.toThrow();
    expect(getConfig().api.port).toBe(4500);
  });

  it('rejects a git OAuth provider configured without a state encryption key', () => {
    process.env.NODE_ENV = 'test';
    const directory = makeConfigDirectory({
      'default.yaml': 'git:\n  oauth:\n    stateEncryptionKey: ""\n    github:\n      clientId: "gh-client-id"\n',
    });

    expect(() => loadConfig(directory)).toThrow(
      'ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY is required',
    );
  });
});

describe('getConfig', () => {
  it('hands back a detached copy so a caller cannot mutate the loaded config', () => {
    const first = getConfig();
    const second = getConfig();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
