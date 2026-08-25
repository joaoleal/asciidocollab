import { createGitWorkerConfig } from '../../src/config/git-worker-config.js';

describe('createGitWorkerConfig', () => {
  afterEach(() => {
    delete process.env.ASCIIDOCOLLAB_STORAGE_PATH;
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
});
