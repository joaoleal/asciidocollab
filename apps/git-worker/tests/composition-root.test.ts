import { compositionRoot } from '../src/composition-root.js';

describe('git-worker composition root', () => {
  it('constructs, starts, and cleanly shuts down without throwing', async () => {
    const app = await compositionRoot();

    expect(app.isRunning()).toBe(false);

    await app.start();
    expect(app.isRunning()).toBe(true);

    await app.shutdown();
    expect(app.isRunning()).toBe(false);
  });
});
