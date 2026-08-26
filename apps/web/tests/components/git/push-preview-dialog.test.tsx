import { fireEvent, render, screen } from '@testing-library/react';
import { describePushPreviewFailure, PushPreviewDialog } from '@/components/git/push-preview-dialog';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

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
  return { onOpenChange, container: result.container };
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
