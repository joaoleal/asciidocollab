import { render, screen } from '@testing-library/react';
import {
  GitActivityIndicator,
  gitActivityStyle,
  type GitActivityIndicatorProperties,
} from '@/components/git/git-activity-indicator';
import type { GitOperationKind, GitOperationState, GitOperationStatusDto } from '@asciidocollab/shared';

function operation(overrides: Partial<GitOperationStatusDto> = {}): GitOperationStatusDto {
  return {
    id: 'op1',
    kind: 'PULL',
    state: 'RUNNING',
    progress: 40,
    errorCode: null,
    driftSummary: null,
    ...overrides,
  };
}

describe('gitActivityStyle', () => {
  test.each<[GitOperationKind, GitOperationState, string]>([
    ['PULL', 'RUNNING', 'Git activity: Pull in progress'],
    ['PULL', 'QUEUED', 'Git activity: Pull in progress'],
    ['PUSH', 'RUNNING', 'Git activity: Push in progress'],
    ['IMPORT', 'QUEUED', 'Git activity: Import in progress'],
    ['BRANCH_SWITCH', 'RUNNING', 'Git activity: Branch switch in progress'],
  ])('maps kind=%s state=%s to the expected label', (kind, state, expectedLabel) => {
    const style = gitActivityStyle(operation({ kind, state }));
    expect(style).not.toBeNull();
    expect(style?.label).toBe(expectedLabel);
    expect(style?.spinning).toBe(true);
    expect(style?.className).toContain('--info');
  });

  test('an AWAITING_CONFLICT pull reads as paused, not spinning, with the warning token', () => {
    const style = gitActivityStyle(operation({ kind: 'PULL', state: 'AWAITING_CONFLICT' }));
    expect(style?.className).toBe('text-[hsl(var(--warning))]');
    expect(style?.label).toBe('Pull paused — conflicts');
    expect(style?.spinning).toBe(false);
    expect(style?.icon).toBeDefined();
  });

  test.each<GitOperationState>(['SUCCEEDED', 'FAILED', 'ABORTED'])(
    'returns null for a terminal state (%s) even though this should not normally be passed in',
    (state) => {
      expect(gitActivityStyle(operation({ state }))).toBeNull();
    },
  );
});

/** Default props for the indicator, so each test only overrides what it cares about. */
function indicatorProperties(
  overrides: Partial<GitActivityIndicatorProperties> = {},
): GitActivityIndicatorProperties {
  return { activeOperation: null, ...overrides };
}

describe('GitActivityIndicator', () => {
  test('renders nothing when there is no active operation', () => {
    const { container } = render(<GitActivityIndicator {...indicatorProperties()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders the labelled indicator for a RUNNING pull', () => {
    render(<GitActivityIndicator {...indicatorProperties({ activeOperation: operation({ kind: 'PULL', state: 'RUNNING' }) })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Git activity: Pull in progress');
  });

  test('renders the paused-conflicts label for AWAITING_CONFLICT', () => {
    render(
      <GitActivityIndicator
        {...indicatorProperties({ activeOperation: operation({ kind: 'PULL', state: 'AWAITING_CONFLICT' }) })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Pull paused — conflicts');
  });
});
