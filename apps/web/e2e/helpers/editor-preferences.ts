import { expect, type Page } from '@playwright/test';

/** The API the account's editor preferences live behind. */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The editor preferences that live on the ACCOUNT rather than in the browser.
 *
 * Every spec in this suite signs in as the one shared test administrator, and Playwright runs spec
 * files in parallel workers. So each of these is shared mutable state between tests that never see
 * each other: a test that turns scroll sync on, or picks the Print style, changes what the NEXT test
 * — in another file, in another worker, possibly on another day's run — finds when its editor mounts.
 * Nothing about a fresh browser context isolates it; the panel reads the value back from the server.
 *
 * That made two rules, and this module exists to make both cheap to follow:
 *
 *  - a test that depends on a value must SEED it (`setEditorPreferences`), never assume the default;
 *  - a test that CHANGES one must put it back (`resetEditorPreferences` in an `afterEach`), so the
 *    account sits at its defaults for everyone else.
 *
 * The second rule is the load-bearing one. Without it a leaked `previewStyle: 'print'` renders every
 * other preview spec's document as a scaled page — and a leaked `scrollSyncEnabled: true` is sticky,
 * so the retry of the test it breaks fails for the same reason the first attempt did.
 */
export interface SharedEditorPreferences {
  /** When true, the preview panel follows the editor caret/scroll position. */
  scrollSyncEnabled?: boolean;
  /** When true, the editor wraps long lines instead of scrolling sideways. */
  softWrap?: boolean;
  /** Which stylesheet the rendered preview is presented in. */
  previewStyle?: 'asciidocollab' | 'asciidoctor' | 'print';
}

/**
 * What a fresh account reports, and therefore what every "by default …" assertion in the suite means.
 * Mirrors the domain defaults (`EditorPreferences`) — deliberately restated as the value a test may
 * DEPEND on, rather than imported, so that a change to the product default shows up here as a failing
 * assertion to look at instead of silently redefining what the tests are checking.
 */
export const EDITOR_PREFERENCE_DEFAULTS: Required<SharedEditorPreferences> = {
  scrollSyncEnabled: false,
  softWrap: true,
  previewStyle: 'asciidocollab',
};

/**
 * Set account-global editor preferences through the API, before the page that reads them is opened.
 *
 * Through the API rather than by clicking the control: the panel reads the stored value once at
 * mount, and a click issued before that read has landed is silently overwritten by the stored value
 * moments later. Only the preferences named are changed — the endpoint keeps the stored value for any
 * it is not given, so this cannot disturb a preference the caller did not mention.
 *
 * @param page - The page whose signed-in account the preferences belong to.
 * @param changes - The preferences to set; anything omitted is left as it is stored.
 */
export async function setEditorPreferences(
  page: Page,
  changes: SharedEditorPreferences,
): Promise<void> {
  const current = await page.request.get(`${API_URL}/auth/me/editor-preferences`);
  expect(current.ok(), 'the account must report its editor preferences').toBe(true);
  const preferences: unknown = await current.json();
  if (typeof preferences !== 'object' || preferences === null) {
    throw new TypeError('the editor-preferences endpoint answered with something that is not an object');
  }

  // `fontSize` and `theme` are required by the endpoint, so they are sent back exactly as stored:
  // this must change nothing but the preferences it was asked to change.
  const saved = await page.request.put(`${API_URL}/auth/me/editor-preferences`, {
    data: {
      fontSize: Number(Reflect.get(preferences, 'fontSize')),
      theme: String(Reflect.get(preferences, 'theme')),
      ...changes,
    },
  });
  expect(saved.ok(), 'the editor preferences must be saved before the editor opens').toBe(true);
}

/**
 * Put every shared preference back to its default, for the tests that run after this one.
 *
 * Call it from an `afterEach` in any spec that changes one — including indirectly, by clicking the
 * scroll-sync toggle or picking a preview style. Failure to restore is reported rather than
 * swallowed: a restore that quietly did not happen is exactly the leak this exists to prevent.
 *
 * @param page - The page whose signed-in account the preferences belong to.
 */
export async function resetEditorPreferences(page: Page): Promise<void> {
  await setEditorPreferences(page, EDITOR_PREFERENCE_DEFAULTS);
}
