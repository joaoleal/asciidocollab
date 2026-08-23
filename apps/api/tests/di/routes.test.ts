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
});
