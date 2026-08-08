import Fastify from 'fastify';
import { runFailedSignInPurge } from '../../src/plugins/failed-sign-in-purge';
import { decorateApp } from '../helpers/decorate-app';

const DAY_MS = 24 * 60 * 60 * 1000;

function buildApp(deleteOlderThan: jest.Mock) {
  const app = Fastify();
  decorateApp(app, 'config', { failedSignIn: { retentionDays: 90, purgeIntervalHours: 24 } });
  decorateApp(app, 'repos', { authAttemptTelemetry: { deleteOlderThan } });
  return app;
}

describe('runFailedSignInPurge', () => {
  it('purges with a cutoff of now - retention, logs, and returns the deleted count', async () => {
    const deleteOlderThan = jest.fn().mockResolvedValue(3);
    const app = buildApp(deleteOlderThan);
    const infoSpy = jest.spyOn(app.log, 'info');

    const before = Date.now();
    const count = await runFailedSignInPurge(app);

    expect(count).toBe(3);
    expect(deleteOlderThan).toHaveBeenCalledTimes(1);
    const cutoff = deleteOlderThan.mock.calls[0][0] as Date;
    expect(Math.abs(cutoff.getTime() - (before - 90 * DAY_MS))).toBeLessThan(5000);
    expect(infoSpy).toHaveBeenCalledWith({ deleted: 3 }, expect.stringContaining('purged'));
  });
});
