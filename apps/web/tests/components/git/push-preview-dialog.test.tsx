import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describePushPreviewFailure, PushPreviewDialog } from '@/components/git/push-preview-dialog';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockGetPushPreview = jest.fn();
const mockListMembers = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getPushPreview: (...parameters: unknown[]) => mockGetPushPreview(...parameters),
}));

jest.mock('@/lib/api/members', () => ({
  membersApi: { list: (...parameters: unknown[]) => mockListMembers(...parameters) },
}));

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName }: { displayName: string }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'aria-label': displayName }),
}));

const COMMITS: CommitDto[] = [
  { hash: 'abc1234567890', message: 'Add a new section', authorUserId: 'user1', authoredAt: '2026-08-20T00:00:00.000Z' },
];

function renderDialog(overrides: Partial<{ onOpenChange: (open: boolean) => void }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const result = render(<PushPreviewDialog projectId="proj1" open onOpenChange={onOpenChange} />);
  return { onOpenChange, container: result.container, unmount: result.unmount };
}

/** A never-settling promise plus the handles that settle it, for driving in-flight request states. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: unknown) => void } {
  let resolve: (value: unknown) => void = noop;
  let reject: (reason: unknown) => void = noop;
  const promise = new Promise<unknown>((resolveIt, rejectIt) => {
    resolve = resolveIt;
    reject = rejectIt;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPushPreview.mockResolvedValue({ outgoingCommits: [], changedPaths: [] });
  mockListMembers.mockResolvedValue({ data: { members: [] } });
});

describe('PushPreviewDialog structure', () => {
  test('renders a real Dialog.Description', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/remote/i);
  });

  test('fetches the push preview on open', () => {
    renderDialog();
    expect(mockGetPushPreview).toHaveBeenCalledWith('proj1');
  });

  test('shows a loading state while the preview loads', () => {
    mockGetPushPreview.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(screen.getByText('Loading push preview…')).toBeInTheDocument();
  });

  test('shows "Nothing to push" when there are no outgoing commits', async () => {
    mockGetPushPreview.mockResolvedValue({ outgoingCommits: [], changedPaths: [] });
    renderDialog();
    expect(await screen.findByText('Nothing to push.')).toBeInTheDocument();
  });

  test('renders outgoing commits and changed paths', async () => {
    mockGetPushPreview.mockResolvedValue({ outgoingCommits: COMMITS, changedPaths: ['a.adoc', 'b.adoc'] });
    renderDialog();

    expect(await screen.findByText('Add a new section')).toBeInTheDocument();
    expect(screen.getByText('2 changed paths')).toBeInTheDocument();
  });

  test('renders an alert for a failed preview load', async () => {
    mockGetPushPreview.mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('You need editor access to see what would be pushed.');
  });

  test('closes on the Close button', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('never renders a hardcoded hex or rgb color', async () => {
    mockGetPushPreview.mockResolvedValue({ outgoingCommits: COMMITS, changedPaths: ['a.adoc'] });
    const { container } = renderDialog();
    await screen.findByText('Add a new section');
    for (const element of container.querySelectorAll('[class]')) {
      const className = element.getAttribute('class') ?? '';
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});

describe('PushPreviewDialog while closed', () => {
  test('requests nothing until it is opened', () => {
    render(<PushPreviewDialog projectId="proj1" open={false} onOpenChange={jest.fn()} />);

    expect(mockGetPushPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    const { onOpenChange } = renderDialog();
    await screen.findByText('Nothing to push.');
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('PushPreviewDialog loads that settle after dismissal', () => {
  test('does not render a preview that resolves after the dialog is gone', async () => {
    const pending = deferred();
    mockGetPushPreview.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    expect(screen.getByText('Loading push preview…')).toBeInTheDocument();

    unmount();
    await act(async () => {
      pending.resolve({ outgoingCommits: COMMITS, changedPaths: ['a.adoc'] });
    });

    expect(screen.queryByText('Add a new section')).not.toBeInTheDocument();
  });

  test('does not render a failure that settles after the dialog is gone', async () => {
    const pending = deferred();
    mockGetPushPreview.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    await waitFor(() => expect(mockGetPushPreview).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(403, 'insufficient_role', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('shows a generic message when the preview request never reaches the server', async () => {
    mockGetPushPreview.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the push preview.");
    expect(screen.queryByText('Loading push preview…')).not.toBeInTheDocument();
  });
});

describe('describePushPreviewFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to see what would be pushed.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['some_unmapped_code', "Couldn't load the push preview."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describePushPreviewFailure(new ApiError(409, code, 'server said so'))).toBe(expectedMessage);
  });

  test('falls back to the generic message for a non-ApiError', () => {
    expect(describePushPreviewFailure(new Error('boom'))).toBe("Couldn't load the push preview.");
  });
});
