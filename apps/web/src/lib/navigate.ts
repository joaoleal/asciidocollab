/**
 * Performs a full-page browser redirect. Used by flows that must leave the app entirely, such as
 * the guided OAuth connect flow sending the browser to a provider's authorize URL. Pulled out into
 * its own function, rather than assigning `location.href` inline, so a test can mock this module
 * instead of having to stub the browser's `Location` object, which does not allow redefining.
 *
 * @param url - The absolute URL to navigate the browser to.
 */
export function navigateTo(url: string): void {
  globalThis.location.href = url;
}
