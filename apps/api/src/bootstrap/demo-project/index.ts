/**
 * @file Public surface of the bundled demo-project bootstrap.
 *
 * The demo project is a read-only "Guided Tour" seeded on API start-up and made
 * readable by every user. Consumers need only two entry points: the start-up
 * {@link provisionDemoProject} and the per-user {@link ensureDemoProjectMembership}
 * hook. The manifest constants are re-exported for tests.
 */
export {
  provisionDemoProject,
  ensureDemoProjectMembership,
  backfillDemoViewerMemberships,
  type DemoProjectDeps,
  type DemoMembershipStore,
  type BootstrapLogger,
} from './provision-demo-project';
export {
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_MAIN_FILE_ID,
  DEMO_FOLDERS,
  DEMO_FILES,
  DEMO_DICTIONARY_TERMS,
  DEMO_DICTIONARY_AUTHOR_ID,
  DEMO_CONTENT_HASH_KEY,
  loadDemoAssetBytes,
  computeDemoContentHash,
} from './manifest';
