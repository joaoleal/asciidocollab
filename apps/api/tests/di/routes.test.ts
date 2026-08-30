import { buildServer, registerAllRoutes } from '../../src/index';
import { setupTestEnvironment } from '../helpers/test-environment';

/**
 * A route module that is written but never registered answers 404 in production
 * while every one of its own unit tests passes, so the composition root's route
 * table is pinned here for the endpoints this feature adds.
 */
describe('route registration', () => {
  beforeAll(() => {
    setupTestEnvironment();
  });

  it('serves the project clone endpoint', async () => {
    const app = await buildServer();
    await registerAllRoutes(app);
    await app.ready();

    expect(app.hasRoute({ method: 'POST', url: '/api/projects/:projectId/clone' })).toBe(true);

    await app.close();
  });

  /**
   * The guided-OAuth callback arrives as a cross-site top-level navigation from the provider, which
   * a `SameSite=Strict` session cookie is withheld from. Registered under `requireAuth` it therefore
   * answered a raw 401 for every real user, no matter how correct the handler was — and the handler's
   * own unit tests could not see it, because they register the route directly. Only the composition
   * root's scoping decides this, so it is pinned here: a cookie-less request must reach the handler.
   */
  it('serves the guided OAuth callback without a session cookie', async () => {
    const app = await buildServer();
    await registerAllRoutes(app);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/git/oauth/github/callback?code=an-authorization-code&state=not-a-real-state',
    });

    // An unreadable state still bounces to the generic failure page — a 302 the handler itself
    // produced. What must never come back is the 401 `requireAuth` would have sent instead.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('gitOAuthError=1');

    await app.close();
  });
});
