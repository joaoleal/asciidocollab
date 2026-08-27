import { createGitWorkerConfig } from '../../src/config/git-worker-config.js';

describe('createGitWorkerConfig', () => {
  afterEach(() => {
    delete process.env.ASCIIDOCOLLAB_STORAGE_PATH;
    delete process.env.ASCIIDOCOLLAB_DATABASE_URL;
    delete process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_INTERVAL_MS;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_ENABLED;
    delete process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_MAX_CONCURRENCY;
    delete process.env.ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS;
    delete process.env.ASCIIDOCOLLAB_GIT_CONFLICT_STORE_ROOT;
    delete process.env.ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB;
    delete process.env.ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES;
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

  it('defaults contentStorageRoot to ./storage', () => {
    const config = createGitWorkerConfig();

    expect(config.get('contentStorageRoot')).toBe('./storage');
  });

  it('reads contentStorageRoot from the same ASCIIDOCOLLAB_STORAGE_PATH variable as storageRoot and apps/api storage.path, so the two can never drift apart', () => {
    process.env.ASCIIDOCOLLAB_STORAGE_PATH = '/mnt/project-storage';

    const config = createGitWorkerConfig();

    expect(config.get('contentStorageRoot')).toBe('/mnt/project-storage');
    expect(config.get('contentStorageRoot')).toBe(config.get('storageRoot'));
  });

  it('defaults conflictStoreRoot to a path distinct from storageRoot (never nested inside a working tree)', () => {
    const config = createGitWorkerConfig();

    expect(config.get('conflictStoreRoot')).toBe('./storage-git-conflicts');
    expect(config.get('conflictStoreRoot')).not.toBe(config.get('storageRoot'));
  });

  it('reads conflictStoreRoot from its own env var, independent of ASCIIDOCOLLAB_STORAGE_PATH', () => {
    process.env.ASCIIDOCOLLAB_STORAGE_PATH = '/mnt/project-storage';
    process.env.ASCIIDOCOLLAB_GIT_CONFLICT_STORE_ROOT = '/mnt/git-conflicts';

    const config = createGitWorkerConfig();

    expect(config.get('conflictStoreRoot')).toBe('/mnt/git-conflicts');
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

  it('defaults the background remote-refresh interval to a bounded, non-zero value and enables it', () => {
    const config = createGitWorkerConfig();

    expect(config.get('backgroundRefreshIntervalMs')).toBe(60_000);
    expect(config.get('backgroundRefreshEnabled')).toBe(true);
  });

  it('reads the background remote-refresh interval and enabled flag from their env vars', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_INTERVAL_MS = '3000';
    process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_ENABLED = 'false';

    const config = createGitWorkerConfig();

    expect(config.get('backgroundRefreshIntervalMs')).toBe(3000);
    expect(config.get('backgroundRefreshEnabled')).toBe(false);
  });

  it('rejects a zero or negative background remote-refresh interval', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_INTERVAL_MS = '0';

    const config = createGitWorkerConfig();

    expect(() => config.validate({ allowed: 'strict' })).toThrow();
  });

  it('defaults the background remote-refresh max concurrency to a bounded, non-zero value', () => {
    const config = createGitWorkerConfig();

    expect(config.get('backgroundRefreshMaxConcurrency')).toBe(4);
  });

  it('reads the background remote-refresh max concurrency from its env var', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_MAX_CONCURRENCY = '10';

    const config = createGitWorkerConfig();

    expect(config.get('backgroundRefreshMaxConcurrency')).toBe(10);
  });

  it('rejects a zero or negative background remote-refresh max concurrency', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_BACKGROUND_REFRESH_MAX_CONCURRENCY = '0';

    const config = createGitWorkerConfig();

    expect(() => config.validate({ allowed: 'strict' })).toThrow();
  });

  it('defaults egressAllowedHosts to the supported providers (GitHub, GitLab, Bitbucket)', () => {
    const config = createGitWorkerConfig();

    expect(config.get('egressAllowedHosts')).toEqual(['github.com', 'gitlab.com', 'bitbucket.org']);
  });

  it('reads egressAllowedHosts from ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS as a comma-separated list', () => {
    process.env.ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS = 'git.example.com, self-hosted.internal';

    const config = createGitWorkerConfig();

    expect(config.get('egressAllowedHosts')).toEqual(['git.example.com', 'self-hosted.internal']);
  });

  it('defaults maxRepoSizeMB and lfsThresholdBytes to the same values as apps/api\'s git schema', () => {
    const config = createGitWorkerConfig();

    expect(config.get('maxRepoSizeMB')).toBe(500);
    expect(config.get('lfsThresholdBytes')).toBe(10_485_760);
  });

  it('reads maxRepoSizeMB and lfsThresholdBytes from the same env vars as apps/api\'s git schema', () => {
    process.env.ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB = '250';
    process.env.ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES = '1048576';

    const config = createGitWorkerConfig();

    expect(config.get('maxRepoSizeMB')).toBe(250);
    expect(config.get('lfsThresholdBytes')).toBe(1_048_576);
  });

  it('rejects a zero or negative maxRepoSizeMB', () => {
    process.env.ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB = '0';

    const config = createGitWorkerConfig();

    expect(() => config.validate({ allowed: 'strict' })).toThrow();
  });
});
