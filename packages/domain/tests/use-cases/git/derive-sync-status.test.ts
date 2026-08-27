import { deriveSyncStatus } from '../../../src/use-cases/git/derive-sync-status';

describe('deriveSyncStatus', () => {
  test('level with the remote (no commits either way) is UP_TO_DATE', () => {
    expect(deriveSyncStatus(0, 0)).toBe('UP_TO_DATE');
  });

  test('only the remote has commits ahead is BEHIND', () => {
    expect(deriveSyncStatus(3, 0)).toBe('BEHIND');
  });

  test('only the local branch has commits ahead is AHEAD', () => {
    expect(deriveSyncStatus(0, 2)).toBe('AHEAD');
  });

  test('both sides have unique commits is DIVERGED', () => {
    expect(deriveSyncStatus(4, 5)).toBe('DIVERGED');
  });
});
