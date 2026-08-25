import convict from 'convict';

/** Validates that `value` is a positive (non-zero) integer — bounds the run loop's timings so none can be misconfigured to 0 (busy-spin) or negative. */
function positiveInt(value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('must be a positive integer');
  }
}

/** Typed configuration interface for the git-worker application. */
export interface GitWorkerConfig {
  /**
   * Root directory for per-project file storage, shared with `apps/api` and `apps/collab`. Each
   * project's git working tree lives at `<storageRoot>/<projectId>/`.
   */
  storageRoot: string;

  /** PostgreSQL connection URL, shared with `apps/api`, `apps/collab`, and `packages/db`. */
  databaseUrl: string;

  /**
   * Base64-encoded 32-byte AES-256-GCM key used to decrypt stored git credential tokens. Must
   * match `apps/api`'s `git.credentialEncryptionKey` — the same ciphertext is written by the API
   * and read back here at job execution time.
   */
  credentialEncryptionKey: string;

  /** How long the run loop sleeps between claim attempts when there is nothing queued to claim. */
  pollIntervalMs: number;

  /** How often a running job refreshes its `GitOperation` heartbeat while it executes. */
  heartbeatIntervalMs: number;

  /**
   * How long a `RUNNING` operation may go without a heartbeat before `claimNextQueued` treats its
   * worker as crashed and reclaims the operation.
   */
  staleHeartbeatAfterMs: number;
}

/** Creates a new convict configuration instance for the git-worker application. */
export function createGitWorkerConfig() {
  return convict<GitWorkerConfig>({
    storageRoot: {
      doc: "Root directory for per-project file storage (shared with apps/api and apps/collab). Each project's git working tree lives at `<storageRoot>/<projectId>/`.",
      format: String,
      default: './storage',
      env: 'ASCIIDOCOLLAB_STORAGE_PATH',
    },
    databaseUrl: {
      doc: 'PostgreSQL connection URL.',
      format: String,
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_DATABASE_URL',
    },
    credentialEncryptionKey: {
      doc: "AES-256-GCM key (base64, 32 bytes) for decrypting stored git credential tokens. Must match apps/api's git.credentialEncryptionKey (e.g. openssl rand -base64 32).",
      format: String,
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY',
    },
    pollIntervalMs: {
      doc: 'Milliseconds the run loop sleeps between claim attempts when there is nothing queued.',
      format: positiveInt,
      default: 2000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS',
    },
    heartbeatIntervalMs: {
      doc: 'Milliseconds between heartbeat refreshes for a job currently running.',
      format: positiveInt,
      default: 15_000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS',
    },
    staleHeartbeatAfterMs: {
      doc: 'Milliseconds a RUNNING operation may go without a heartbeat before it is reclaimed as abandoned.',
      format: positiveInt,
      default: 60_000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS',
    },
  });
}
