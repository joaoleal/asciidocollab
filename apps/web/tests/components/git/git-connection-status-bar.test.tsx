import { render, screen, fireEvent } from '@testing-library/react';
import {
  GitConnectionStatusBar,
  syncStatusStyle,
  type GitConnectionStatusBarProperties,
} from '@/components/git/git-connection-status-bar';
import type { BehindAheadDto, GitStatusDto, GitSyncStatus } from '@asciidocollab/shared';

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

/** Default props for the bar, so each test only overrides what it cares about. */
function barProperties(overrides: Partial<GitConnectionStatusBarProperties> = {}): GitConnectionStatusBarProperties {
  return {
    status: status(),
    connected: true,
    canCommit: true,
    onCommitClick: jest.fn(),
    behindAhead: null,
    canPull: true,
    onPullClick: jest.fn(),
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

  test('NEEDS_REAUTH maps to the warning attention token with a reconnect label', () => {
    const style = syncStatusStyle('NEEDS_REAUTH');
    expect(style.label).toBe('Reconnect needed');
    expect(style.className).toContain('warning');
  });

  test('never returns a hardcoded hex or rgb color', () => {
    const statuses: GitSyncStatus[] = [
      'UP_TO_DATE',
      'AHEAD',
      'BEHIND',
      'DIVERGED',
      'CONFLICTED',
      'DISCONNECTED',
      'NEEDS_REAUTH',
    ];
    for (const value of statuses) {
      const style = syncStatusStyle(value);
      expect(style.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(style.className).not.toMatch(/rgb\(/);
    }
  });
});

describe('GitConnectionStatusBar', () => {
  test('renders nothing when not connected', () => {
    const { container } = render(<GitConnectionStatusBar {...barProperties({ status: null, connected: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing when not connected even with a stale status object', () => {
    const { container } = render(<GitConnectionStatusBar {...barProperties({ connected: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the sync label when connected', () => {
    // The branch name itself is shown by BranchSwitcher (the toolbar's single source of truth for
    // it) — this bar no longer duplicates it.
    render(<GitConnectionStatusBar {...barProperties()} />);
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  test('shows "Never synced" when lastSyncAt is null', () => {
    render(<GitConnectionStatusBar {...barProperties({ status: status({ lastSyncAt: null }) })} />);
    expect(screen.getByText('Never synced')).toBeInTheDocument();
  });

  test('shows a relative last-sync time when lastSyncAt is set', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<GitConnectionStatusBar {...barProperties({ status: status({ lastSyncAt: recent }) })} />);
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  test.each([
    ['UP_TO_DATE', 'Up to date'],
    ['AHEAD', 'Ahead'],
    ['BEHIND', 'Behind'],
    ['DIVERGED', 'Diverged'],
    ['CONFLICTED', 'Conflicted'],
    ['DISCONNECTED', 'Disconnected'],
    ['NEEDS_REAUTH', 'Reconnect needed'],
  ] as const)('renders the %s sync state label %s', (syncStatus, label) => {
    render(<GitConnectionStatusBar {...barProperties({ status: status({ syncStatus }) })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  test('shows a Commit button and calls onCommitClick when canCommit is true', () => {
    const onCommitClick = jest.fn();
    render(<GitConnectionStatusBar {...barProperties({ onCommitClick })} />);
    const button = screen.getByRole('button', { name: /commit/i });
    fireEvent.click(button);
    expect(onCommitClick).toHaveBeenCalledTimes(1);
  });

  test('hides the Commit button when canCommit is false', () => {
    render(<GitConnectionStatusBar {...barProperties({ canCommit: false })} />);
    expect(screen.queryByRole('button', { name: /commit/i })).not.toBeInTheDocument();
  });
});

describe('GitConnectionStatusBar real ahead/behind counts', () => {
  const COUNTS: BehindAheadDto = { behind: 4, ahead: 2 };

  test('renders the real behind count from behindAhead, not the status.behind placeholder', () => {
    // `status.behind` is the fixed-0 placeholder; behindAhead carries the real count.
    render(<GitConnectionStatusBar {...barProperties({ status: status({ behind: 0, ahead: 0 }), behindAhead: COUNTS })} />);
    expect(screen.getByLabelText('4 commits behind')).toBeInTheDocument();
    expect(screen.getByLabelText('2 commits ahead')).toBeInTheDocument();
  });

  test('renders nothing for ahead/behind when behindAhead is null', () => {
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: null })} />);
    expect(screen.queryByLabelText(/commits behind/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/commits ahead/)).not.toBeInTheDocument();
  });

  test('renders nothing for a zero count even when behindAhead is loaded', () => {
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: { behind: 0, ahead: 0 } })} />);
    expect(screen.queryByLabelText(/commits behind/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/commits ahead/)).not.toBeInTheDocument();
  });
});

describe('GitConnectionStatusBar pull affordance', () => {
  test('shows the Pull button only when canPull and behindAhead.behind > 0', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPull: true, behindAhead: { behind: 3, ahead: 0 } })} />);
    expect(screen.getByRole('button', { name: /pull/i })).toBeInTheDocument();
  });

  test('hides the Pull button when behindAhead.behind is 0', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPull: true, behindAhead: { behind: 0, ahead: 1 } })} />);
    expect(screen.queryByRole('button', { name: /pull/i })).not.toBeInTheDocument();
  });

  test('hides the Pull button when behindAhead is null', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPull: true, behindAhead: null })} />);
    expect(screen.queryByRole('button', { name: /pull/i })).not.toBeInTheDocument();
  });

  test('hides the Pull button when canPull is false, even with a positive behind count', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPull: false, behindAhead: { behind: 3, ahead: 0 } })} />);
    expect(screen.queryByRole('button', { name: /pull/i })).not.toBeInTheDocument();
  });

  test('calls onPullClick when the Pull button is clicked', () => {
    const onPullClick = jest.fn();
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: { behind: 3, ahead: 0 }, onPullClick })} />);
    fireEvent.click(screen.getByRole('button', { name: /pull/i }));
    expect(onPullClick).toHaveBeenCalledTimes(1);
  });

  test('gives the Pull button an accessible label naming the behind count', () => {
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: { behind: 5, ahead: 0 } })} />);
    expect(screen.getByRole('button', { name: 'behind by 5 — pull available' })).toBeInTheDocument();
  });

  test('disables the Pull button and shows a pending label while pullPending is true', () => {
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: { behind: 3, ahead: 0 }, pullPending: true })} />);
    const button = screen.getByRole('button', { name: /pull/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Pulling…');
  });
});

describe('GitConnectionStatusBar push-preview affordance', () => {
  test('shows the preview affordance only when ahead > 0 and a handler is given', () => {
    const onPreviewPushClick = jest.fn();
    render(
      <GitConnectionStatusBar
        {...barProperties({ behindAhead: { behind: 0, ahead: 2 }, onPreviewPushClick })}
      />,
    );
    expect(screen.getByRole('button', { name: /preview push/i })).toBeInTheDocument();
  });

  test('hides the preview affordance when ahead is 0', () => {
    const onPreviewPushClick = jest.fn();
    render(
      <GitConnectionStatusBar
        {...barProperties({ behindAhead: { behind: 0, ahead: 0 }, onPreviewPushClick })}
      />,
    );
    expect(screen.queryByRole('button', { name: /preview push/i })).not.toBeInTheDocument();
  });

  test('hides the preview affordance when no handler is given', () => {
    render(<GitConnectionStatusBar {...barProperties({ behindAhead: { behind: 0, ahead: 2 } })} />);
    expect(screen.queryByRole('button', { name: /preview push/i })).not.toBeInTheDocument();
  });

  test('calls onPreviewPushClick when the affordance is activated', () => {
    const onPreviewPushClick = jest.fn();
    render(
      <GitConnectionStatusBar
        {...barProperties({ behindAhead: { behind: 0, ahead: 2 }, onPreviewPushClick })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /preview push/i }));
    expect(onPreviewPushClick).toHaveBeenCalledTimes(1);
  });
});

describe('GitConnectionStatusBar push affordance', () => {
  test('shows the Push button only when canPush and behindAhead.ahead > 0', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 0, ahead: 3 } })} />);
    expect(screen.getByRole('button', { name: /push/i })).toBeInTheDocument();
  });

  test('hides the Push button when behindAhead.ahead is 0', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 1, ahead: 0 } })} />);
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument();
  });

  test('hides the Push button on a diverged branch (behind > 0 && ahead > 0) — pull first', () => {
    // A push against a diverged branch is a guaranteed non-fast-forward failure; steer to Pull.
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 2, ahead: 3 } })} />);
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument();
    // The Pull button IS offered instead (behind > 0).
    expect(screen.getByRole('button', { name: /pull/i })).toBeInTheDocument();
  });

  test('shows the Push button when purely ahead (behind === 0 && ahead > 0)', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 0, ahead: 3 } })} />);
    expect(screen.getByRole('button', { name: /push/i })).toBeInTheDocument();
  });

  test('hides the Push button when behindAhead is null', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: null })} />);
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument();
  });

  test('hides the Push button when canPush is false, even with a positive ahead count', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: false, behindAhead: { behind: 0, ahead: 3 } })} />);
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument();
  });

  test('calls onPushClick when the Push button is clicked', () => {
    const onPushClick = jest.fn();
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 0, ahead: 3 }, onPushClick })} />);
    fireEvent.click(screen.getByRole('button', { name: /push/i }));
    expect(onPushClick).toHaveBeenCalledTimes(1);
  });

  test('gives the Push button an accessible label naming the ahead count', () => {
    render(<GitConnectionStatusBar {...barProperties({ canPush: true, behindAhead: { behind: 0, ahead: 5 } })} />);
    expect(screen.getByRole('button', { name: 'ahead by 5 — push available' })).toBeInTheDocument();
  });

  test('disables the Push button and shows a pending label while pushPending is true', () => {
    render(
      <GitConnectionStatusBar
        {...barProperties({ canPush: true, behindAhead: { behind: 0, ahead: 3 }, pushPending: true })}
      />,
    );
    const button = screen.getByRole('button', { name: /push/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Pushing…');
  });

  test('hides the Push button when the credential needs reauth, even with a positive ahead count', () => {
    // A rejected credential still reports commits ahead from the last known remote head, but a push
    // would fail auth immediately — steer to reconnect instead of offering a doomed Push.
    render(
      <GitConnectionStatusBar
        {...barProperties({ canPush: true, status: status({ syncStatus: 'NEEDS_REAUTH' }), behindAhead: { behind: 0, ahead: 3 } })}
      />,
    );
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument();
    // The "Reconnect needed" readout is still shown so the owner knows why.
    expect(screen.getByText('Reconnect needed')).toBeInTheDocument();
  });

  test('still shows the Push button in the normal connected/ahead state (not reauth)', () => {
    render(
      <GitConnectionStatusBar
        {...barProperties({ canPush: true, status: status({ syncStatus: 'AHEAD' }), behindAhead: { behind: 0, ahead: 3 } })}
      />,
    );
    expect(screen.getByRole('button', { name: /push/i })).toBeInTheDocument();
  });
});
