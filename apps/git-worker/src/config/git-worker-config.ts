import convict from 'convict';

/** Typed configuration interface for the git-worker application. */
export interface GitWorkerConfig {
  /**
   * Root directory for per-project file storage, shared with `apps/api` and `apps/collab`. Each
   * project's git working tree lives at `<storageRoot>/<projectId>/`.
   */
  storageRoot: string;
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
  });
}
