import { render, screen, fireEvent } from '@testing-library/react';
import {
  GitConnectionStatusBar,
  syncStatusStyle,
} from '@/components/git/git-connection-status-bar';
import type { GitStatusDto, GitSyncStatus } from '@asciidocollab/shared';

function status(overrides: Partial<GitStatusDto> = {}): GitStatusDto {
  return {
    branch: 'main',
    syncStatus: 'UP_TO_DATE',
    ahead: 0,
    behind: 0,
    lastSyncAt: '2026-08-24T00:00:00.000Z',
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

describe('syncStatusStyle', () => {
  test.each([
    ['UP_TO_DATE', 'success', 'Up to date'],
    ['AHEAD', 'info', 'Ahead'],
    ['BEHIND', 'warning', 'Behind'],
    ['DIVERGED', 'warning', 'Diverged'],
  ] as const)('%s maps to a tokenized className carrying the %s token and label %s', (syncStatus, token, label) => {
    const style = syncStatusStyle(syncStatus);
    expect(style.label).toBe(label);
    expect(style.className).toContain(token);
  });

  test('CONFLICTED maps to the destructive token', () => {
    const style = syncStatusStyle('CONFLICTED');
    expect(style.label).toBe('Conflicted');
    expect(style.className).toContain('destructive');
  });

  test('DISCONNECTED maps to the muted-foreground token', () => {
    const style = syncStatusStyle('DISCONNECTED');
    expect(style.label).toBe('Disconnected');
    expect(style.className).toContain('muted-foreground');
  });

  test('never returns a hardcoded hex or rgb color', () => {
    const statuses: GitSyncStatus[] = ['UP_TO_DATE', 'AHEAD', 'BEHIND', 'DIVERGED', 'CONFLICTED', 'DISCONNECTED'];
    for (const value of statuses) {
      const style = syncStatusStyle(value);
      expect(style.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(style.className).not.toMatch(/rgb\(/);
    }
  });
});

describe('GitConnectionStatusBar', () => {
  test('renders nothing when not connected', () => {
    const { container } = render(
      <GitConnectionStatusBar status={null} connected={false} canCommit onCommitClick={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing when not connected even with a stale status object', () => {
    const { container } = render(
      <GitConnectionStatusBar status={status()} connected={false} canCommit onCommitClick={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the branch name and sync label when connected', () => {
    render(<GitConnectionStatusBar status={status()} connected canCommit onCommitClick={jest.fn()} />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  test('shows "Never synced" when lastSyncAt is null', () => {
    render(
      <GitConnectionStatusBar
        status={status({ lastSyncAt: null })}
        connected
        canCommit
        onCommitClick={jest.fn()}
      />,
    );
    expect(screen.getByText('Never synced')).toBeInTheDocument();
  });

  test('shows a relative last-sync time when lastSyncAt is set', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    render(
      <GitConnectionStatusBar
        status={status({ lastSyncAt: recent })}
        connected
        canCommit
        onCommitClick={jest.fn()}
      />,
    );
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  test.each([
    ['UP_TO_DATE', 'Up to date'],
    ['AHEAD', 'Ahead'],
    ['BEHIND', 'Behind'],
    ['DIVERGED', 'Diverged'],
    ['CONFLICTED', 'Conflicted'],
    ['DISCONNECTED', 'Disconnected'],
  ] as const)('renders the %s sync state label %s', (syncStatus, label) => {
    render(
      <GitConnectionStatusBar
        status={status({ syncStatus })}
        connected
        canCommit
        onCommitClick={jest.fn()}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  test('shows a Commit button and calls onCommitClick when canCommit is true', () => {
    const onCommitClick = jest.fn();
    render(<GitConnectionStatusBar status={status()} connected canCommit onCommitClick={onCommitClick} />);
    const button = screen.getByRole('button', { name: /commit/i });
    fireEvent.click(button);
    expect(onCommitClick).toHaveBeenCalledTimes(1);
  });

  test('hides the Commit button when canCommit is false', () => {
    render(<GitConnectionStatusBar status={status()} connected canCommit={false} onCommitClick={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /commit/i })).not.toBeInTheDocument();
  });
});
