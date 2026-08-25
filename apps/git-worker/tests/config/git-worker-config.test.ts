import { createGitWorkerConfig } from '../../src/config/git-worker-config.js';

describe('createGitWorkerConfig', () => {
  afterEach(() => {
    delete process.env.ASCIIDOCOLLAB_STORAGE_PATH;
    delete process.env.ASCIIDOCOLLAB_DATABASE_URL;
    delete process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS;
  });

  it('defaults storageRoot to ./storage', () => {
    const config = createGitWorkerConfig();

    expect(config.get('storageRoot')).toBe('./storage');
  });

  it('reads storageRoot from ASCIIDOCOLLAB_STORAGE_PATH, shared with apps/api and apps/collab', () => {
    process.env.ASCIIDOCOLLAB_STORAGE_PATH = '/mnt/project-storage';

    const config = createGitWorkerConfig();

    expect(config.get('storageRoot')).toBe('/mnt/project-storage');
  });

  it('defaults databaseUrl and credentialEncryptionKey to empty strings', () => {
    const config = createGitWorkerConfig();

    expect(config.get('databaseUrl')).toBe('');
    expect(config.get('credentialEncryptionKey')).toBe('');
  });

  it('reads databaseUrl from ASCIIDOCOLLAB_DATABASE_URL', () => {
    process.env.ASCIIDOCOLLAB_DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';

    const config = createGitWorkerConfig();

    expect(config.get('databaseUrl')).toBe('postgresql://user:pass@localhost:5432/db');
  });

  it('reads credentialEncryptionKey from ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY', () => {
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(44);

    const config = createGitWorkerConfig();

    expect(config.get('credentialEncryptionKey')).toBe('a'.repeat(44));
  });

  it('defaults the poll/heartbeat/stale-heartbeat timings to bounded, non-zero values', () => {
    const config = createGitWorkerConfig();

    expect(config.get('pollIntervalMs')).toBe(2000);
    expect(config.get('heartbeatIntervalMs')).toBe(15_000);
    expect(config.get('staleHeartbeatAfterMs')).toBe(60_000);
  });

  it('reads the poll/heartbeat/stale-heartbeat timings from their env vars', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS = '500';
    process.env.ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS = '5000';
    process.env.ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS = '30000';

    const config = createGitWorkerConfig();

    expect(config.get('pollIntervalMs')).toBe(500);
    expect(config.get('heartbeatIntervalMs')).toBe(5000);
    expect(config.get('staleHeartbeatAfterMs')).toBe(30_000);
  });
});
