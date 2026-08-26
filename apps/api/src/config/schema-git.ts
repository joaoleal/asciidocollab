import type convict from 'convict';

/**
 * Git provider hostnames the egress allowlist covers by default, so a fresh install
 * can reach the three supported providers without any operator configuration.
 */
const DEFAULT_ALLOWED_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

/**
 * A single provider's OAuth authorization-code + PKCE configuration. `clientId` is the provider
 * availability signal: empty means "OAuth unavailable for this provider" (the web hides its guided
 * "Connect with <provider>" button; manual PAT entry keeps working regardless). `authorizeUrl` and
 * `tokenUrl` carry sensible built-in defaults per provider (see {@link gitSchema}) so an operator only
 * ever has to set `clientId`/`clientSecret`/`redirectUri` — they exist as their own fields (rather
 * than being hardcoded in the OAuth client) so a self-hosted GitLab/Bitbucket instance, or a test
 * pointing the token exchange at a local mock, can override them.
 */
export interface GitOAuthProviderConfig {
  /** The OAuth app's client id. Empty means this provider's OAuth flow is not configured/available. */
  clientId: string;
  /** The OAuth app's client secret. Never logged, never returned to a client. */
  clientSecret: string;
  /** The exact redirect URI registered with the provider; the authorize request must send this exact value. */
  redirectUri: string;
  /** Space-separated OAuth scopes requested at the authorize step. */
  scopes: string;
  /** The provider's authorization endpoint the browser is redirected to. */
  authorizeUrl: string;
  /** The provider's token endpoint the server exchanges `code` for an access token against. */
  tokenUrl: string;
}

/**
 * Git OAuth (authorization-code + PKCE guided connect) configuration: the dedicated state-encryption
 * key, plus one {@link GitOAuthProviderConfig} per supported provider. Every field is optional and
 * empty/default by design — a fresh install has OAuth entirely unavailable (PAT connect keeps
 * working) until an operator registers at least one provider's OAuth app.
 */
export interface GitOAuthConfig {
  /**
   * Base64-encoded 32-byte AES-256-GCM key used to encrypt+authenticate the stateless `state`
   * parameter carried through the OAuth redirect (PKCE verifier, the connecting project/actor, the
   * remote to connect, a nonce, and an issue timestamp). A dedicated key, distinct from both
   * `auth.session.encryptionKey` and `git.credentialEncryptionKey`. Empty is valid UNLESS at least
   * one provider below has a `clientId` configured, in which case it becomes required — see
   * {@link assertGitOAuthConfigConsistent}, which enforces that invariant at config-load time (a
   * cross-field check convict's own per-field format validators cannot express).
   */
  stateEncryptionKey: string;
  /** GitHub's OAuth app configuration. */
  github: GitOAuthProviderConfig;
  /** GitLab's OAuth app configuration. */
  gitlab: GitOAuthProviderConfig;
  /** Bitbucket's OAuth app configuration. */
  bitbucket: GitOAuthProviderConfig;
}

/** Git repository sync configuration (import/connect/commit/push/pull/branch/etc). */
export interface GitConfig {
  /** Number of warm git-worker sandboxes in the pool that runs git operations. Sized to load, not to project count. */
  workerPoolSize: number;
  /** Network egress controls enforced for git-worker containers. */
  egress: {
    /** Hostnames git-worker containers are permitted to reach at the network layer; a connection's remote host must be one of these. */
    allowedHosts: string[];
  };
  /**
   * Base64-encoded 32-byte AES-256-GCM key used to encrypt stored git credential
   * tokens at rest. A dedicated key, separate from `auth.session.encryptionKey` — it
   * isolates credential blast radius from session data.
   */
  credentialEncryptionKey: string;
  /** Maximum git operation requests per project per window. */
  rateLimitMax: number;
  /** Git operation rate limit window in milliseconds. */
  rateLimitWindow: number;
  /** Maximum repository size (megabytes) permitted for import/connect. */
  maxRepoSizeMB: number;
  /** File size (bytes) at or above which a tracked binary asset is handled as a Git LFS object rather than stored inline. */
  lfsThresholdBytes: number;
  /** Base URL of the git-worker's internal RPC endpoint (status/stage/unstage/commit short ops). */
  workerUrl: string;
  /** Optional shared secret sent to the git-worker's internal endpoint (must match the worker's own secret). */
  workerSecret: string;
  /** Client mTLS material for the git-worker's internal endpoint. All fields empty disables mTLS (loopback HTTP). */
  workerTls: {
    /** Path to the PEM file containing the client certificate presented to the git-worker. */
    cert: string;
    /** Path to the PEM file containing the client private key. */
    key: string;
    /** Path to the PEM file containing the CA certificate used to verify the git-worker server. */
    ca: string;
  };
  /** The guided OAuth authorization-code + PKCE connect flow's configuration. */
  oauth: GitOAuthConfig;
}

/** One {@link GitOAuthProviderConfig} convict schema fragment, parameterized by its per-provider defaults. */
function gitOAuthProviderSchema(input: {
  envPrefix: string;
  defaultScopes: string;
  defaultAuthorizeUrl: string;
  defaultTokenUrl: string;
}): convict.Schema<GitOAuthProviderConfig> {
  const { envPrefix, defaultScopes, defaultAuthorizeUrl, defaultTokenUrl } = input;
  return {
    clientId: {
      doc: "The OAuth app's client id. Empty (the default) means this provider's guided OAuth connect is unavailable — PAT connect is unaffected.",
      format: String,
      default: '',
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_CLIENT_ID`,
    },
    clientSecret: {
      doc: "The OAuth app's client secret. Never logged, never returned to a client.",
      format: String,
      default: '',
      sensitive: true,
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_CLIENT_SECRET`,
    },
    redirectUri: {
      doc: 'The exact redirect URI registered with the OAuth app; sent verbatim in the authorize request.',
      format: String,
      default: '',
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_REDIRECT_URI`,
    },
    scopes: {
      doc: 'Space-separated OAuth scopes requested at the authorize step.',
      format: String,
      default: defaultScopes,
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_SCOPES`,
    },
    authorizeUrl: {
      doc: "The provider's authorization endpoint the browser is redirected to.",
      format: String,
      default: defaultAuthorizeUrl,
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_AUTHORIZE_URL`,
    },
    tokenUrl: {
      doc: "The provider's token endpoint the server exchanges `code` for an access token against. Overridable so a test can point it at a local mock.",
      format: String,
      default: defaultTokenUrl,
      env: `ASCIIDOCOLLAB_GIT_OAUTH_${envPrefix}_TOKEN_URL`,
    },
  };
}

/** Convict schema fragment for the git repository sync domain. */
export const gitSchema: convict.Schema<GitConfig> = {
  workerPoolSize: {
    doc: 'Number of warm git-worker sandboxes in the pool that runs git operations. Sized to load, not to project count.',
    format: 'positive-int',
    default: 4,
    env: 'ASCIIDOCOLLAB_GIT_WORKER_POOL_SIZE',
  },
  egress: {
    allowedHosts: {
      doc: 'Comma-separated hostnames git-worker containers are permitted to reach at the network layer. Defaults cover the supported providers (GitHub, GitLab, Bitbucket); extend for a self-hosted remote.',
      format: 'comma-separated-strings',
      default: DEFAULT_ALLOWED_GIT_HOSTS,
      env: 'ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS',
    },
  },
  credentialEncryptionKey: {
    doc: 'AES-256-GCM key (base64, 32 bytes) for encrypting stored git credential tokens at rest. Dedicated key, distinct from auth.session.encryptionKey (e.g. openssl rand -base64 32).',
    format: 'base64-32byte-key',
    default: '',
    sensitive: true,
    env: 'ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY',
  },
  rateLimitMax: {
    doc: 'Maximum git operation requests per project per window.',
    format: 'integer',
    default: 30,
    env: 'ASCIIDOCOLLAB_GIT_RATE_LIMIT_MAX',
  },
  rateLimitWindow: {
    doc: 'Git operation rate limit window in milliseconds.',
    format: 'integer',
    default: 60_000,
    env: 'ASCIIDOCOLLAB_GIT_RATE_LIMIT_WINDOW',
  },
  maxRepoSizeMB: {
    doc: 'Maximum repository size (megabytes) permitted for import/connect.',
    format: 'positive-int',
    default: 500,
    env: 'ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB',
  },
  lfsThresholdBytes: {
    doc: 'File size (bytes) at or above which a tracked binary asset is handled as a Git LFS object rather than stored inline.',
    format: 'positive-int',
    default: 10_485_760, // 10 MiB
    env: 'ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES',
  },
  workerUrl: {
    doc: "Base URL of the git-worker's internal RPC endpoint. Used to run the short git ops (status, stage, unstage, commit) synchronously against a project's working tree.",
    format: String,
    default: 'http://127.0.0.1:4010',
    env: 'ASCIIDOCOLLAB_GIT_WORKER_URL',
  },
  workerSecret: {
    doc: "Optional shared secret sent to the git-worker's internal endpoint; must match the worker's own ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_SECRET. Empty relies on loopback isolation.",
    format: String,
    default: '',
    sensitive: true,
    env: 'ASCIIDOCOLLAB_GIT_WORKER_SECRET',
  },
  workerTls: {
    cert: {
      doc: 'Path to PEM file containing the client certificate presented to the git-worker (mTLS). Empty disables mTLS.',
      format: String,
      default: '',
      env: 'ASCIIDOCOLLAB_GIT_WORKER_TLS_CERT',
    },
    key: {
      doc: 'Path to PEM file containing the client private key for the git-worker mTLS connection.',
      format: String,
      default: '',
      env: 'ASCIIDOCOLLAB_GIT_WORKER_TLS_KEY',
    },
    ca: {
      doc: 'Path to PEM file containing the CA certificate used to verify the git-worker server certificate.',
      format: String,
      default: '',
      env: 'ASCIIDOCOLLAB_GIT_WORKER_TLS_CA',
    },
  },
  oauth: {
    stateEncryptionKey: {
      doc: 'AES-256-GCM key (base64, 32 bytes) encrypting the OAuth guided-connect `state` parameter. Empty unless at least one provider below is configured (openssl rand -base64 32).',
      format: 'optional-base64-32byte-key',
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY',
    },
    github: gitOAuthProviderSchema({
      envPrefix: 'GITHUB',
      defaultScopes: 'repo',
      defaultAuthorizeUrl: 'https://github.com/login/oauth/authorize',
      defaultTokenUrl: 'https://github.com/login/oauth/access_token',
    }),
    gitlab: gitOAuthProviderSchema({
      envPrefix: 'GITLAB',
      defaultScopes: 'read_repository write_repository',
      defaultAuthorizeUrl: 'https://gitlab.com/oauth/authorize',
      defaultTokenUrl: 'https://gitlab.com/oauth/token',
    }),
    bitbucket: gitOAuthProviderSchema({
      envPrefix: 'BITBUCKET',
      defaultScopes: 'repository repository:write',
      defaultAuthorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
      defaultTokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
    }),
  },
};

/** Provider keys `GitConfig.oauth` carries — the ones the guided OAuth connect flow supports. */
export const GIT_OAUTH_PROVIDER_NAMES = ['github', 'gitlab', 'bitbucket'] as const;

/** One of the guided OAuth connect flow's supported providers. */
export type GitOAuthProviderName = (typeof GIT_OAUTH_PROVIDER_NAMES)[number];

/** True when `value` names one of the guided OAuth connect flow's supported providers. */
export function isGitOAuthProviderName(value: string): value is GitOAuthProviderName {
  return (GIT_OAUTH_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Looks up one provider's OAuth config fragment by name — the one place that indexes `GitOAuthConfig` by a dynamic key. */
export function getGitOAuthProviderConfig(oauth: GitOAuthConfig, provider: GitOAuthProviderName): GitOAuthProviderConfig {
  return oauth[provider];
}

/** True when a provider's `clientId` is configured — the sole "OAuth available" signal. */
export function isGitOAuthProviderConfigured(provider: GitOAuthProviderConfig): boolean {
  return provider.clientId.length > 0;
}

/**
 * Enforces the one cross-field invariant convict's own per-field format validators cannot express:
 * `git.oauth.stateEncryptionKey` is required the moment ANY provider has a `clientId` configured
 * (without it, that provider's `state` blobs — and the PKCE verifier + CSRF-binding actorId inside
 * them — would encrypt under an ephemeral, per-process random key, which breaks decoding the moment
 * the callback lands on a different server process/replica than the one that minted it, and is
 * simply insecure to rely on as a default). Call this once, right after `cfg.validate()`, from
 * config loading — never from a route, since a route only ever sees an already-loaded config.
 *
 * @param git - The resolved `git` config fragment (`getConfig().git` / `cfg.get('git')`).
 * @throws {Error} If any provider is configured but `stateEncryptionKey` is empty.
 */
export function assertGitOAuthConfigConsistent(git: GitConfig): void {
  const anyProviderConfigured = GIT_OAUTH_PROVIDER_NAMES.some((name) =>
    isGitOAuthProviderConfigured(git.oauth[name]),
  );
  if (anyProviderConfigured && git.oauth.stateEncryptionKey === '') {
    throw new Error(
      'ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY is required once any git.oauth.<provider>.clientId is configured',
    );
  }
}
