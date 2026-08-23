import { UserId } from '@asciidocollab/domain';
import { buildServer } from '../../src/index';
import { setupTestEnvironment } from '../helpers/test-environment';

/**
 * The clone use case is built fresh inside the route handler on every request,
 * so the one-clone-per-user guard only works if the registry it is handed is
 * NOT rebuilt with it. That makes the registry a property of the composition
 * root rather than of the use case, and these tests pin exactly that: one
 * instance per server, shared by every request, and never process-wide state
 * that leaks between servers.
 */
const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_ACTOR_ID = '550e8400-e29b-41d4-a716-44665544000b';

/** Registers a probe that claims the clone slot exactly as a clone request would. */
function withCloneSlotProbe(app: Awaited<ReturnType<typeof buildServer>>): void {
  app.post<{ Body: { userId: string } }>('/__clone-slot', async (request) => ({
    acquired: request.server.services.activeCloneRegistry.tryAcquire(UserId.create(request.body.userId)),
  }));
  app.post<{ Body: { userId: string } }>('/__clone-slot/release', async (request) => {
    request.server.services.activeCloneRegistry.release(UserId.create(request.body.userId));
    return { released: true };
  });
}

describe('active-clone registry wiring', () => {
  beforeAll(() => {
    setupTestEnvironment();
  });

  it('hands every request the same registry, so a second clone by one user is refused', async () => {
    const app = await buildServer();
    withCloneSlotProbe(app);
    await app.ready();

    const first = await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });
    const second = await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });

    expect(first.json()).toEqual({ acquired: true });
    expect(second.json()).toEqual({ acquired: false });

    await app.close();
  });

  it('bounds each user separately, so one user cloning never blocks another', async () => {
    const app = await buildServer();
    withCloneSlotProbe(app);
    await app.ready();

    await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });
    const other = await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: OTHER_ACTOR_ID } });

    expect(other.json()).toEqual({ acquired: true });

    await app.close();
  });

  it('frees the slot for a later request once the running clone releases it', async () => {
    const app = await buildServer();
    withCloneSlotProbe(app);
    await app.ready();

    await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });
    await app.inject({ method: 'POST', url: '/__clone-slot/release', payload: { userId: ACTOR_ID } });
    const again = await app.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });

    expect(again.json()).toEqual({ acquired: true });

    await app.close();
  });

  it('keeps the registry per composition root rather than as process-wide state', async () => {
    // A module-level set would make one server's unreleased holder deny the next
    // server's first request — and the architecture constitution forbids the
    // static singleton that would cause it.
    const first = await buildServer();
    withCloneSlotProbe(first);
    await first.ready();
    await first.inject({ method: 'POST', url: '/__clone-slot', payload: { userId: ACTOR_ID } });

    const second = await buildServer();
    withCloneSlotProbe(second);
    await second.ready();
    const onSecondServer = await second.inject({
      method: 'POST',
      url: '/__clone-slot',
      payload: { userId: ACTOR_ID },
    });

    expect(onSecondServer.json()).toEqual({ acquired: true });

    await first.close();
    await second.close();
  });
});
