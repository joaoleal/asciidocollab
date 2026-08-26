import { render, screen, waitFor } from '@testing-library/react';
import { CommitPreviewList } from '@/components/git/commit-preview-list';
import type { CommitDto } from '@asciidocollab/shared';

const mockListMembers = jest.fn();

jest.mock('@/lib/api/members', () => ({
  membersApi: { list: (...parameters: unknown[]) => mockListMembers(...parameters) },
}));

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName }: { displayName: string }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'aria-label': displayName }),
}));

const COMMITS: CommitDto[] = [
  { hash: 'abc1234567890', message: 'Fix the intro section', authorUserId: 'user1', authoredAt: '2026-08-20T00:00:00.000Z' },
  { hash: 'def4567890123', message: 'Imported from legacy history', authoredAt: '2026-08-19T00:00:00.000Z' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockListMembers.mockResolvedValue({
    data: { members: [{ userId: 'user1', displayName: 'Alice Smith', email: 'alice@example.com', role: 'editor', joinedAt: '2026-01-01T00:00:00.000Z' }] },
  });
});

describe('CommitPreviewList rendering', () => {
  test('renders each commit row with its short hash, message, date, and known author', async () => {
    render(<CommitPreviewList projectId="proj1" enabled commits={COMMITS} changedPaths={['a.adoc']} />);

    expect(screen.getByText('Fix the intro section')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument());
  });

  test('falls back to a neutral placeholder for a commit with no mapped author', async () => {
    render(<CommitPreviewList projectId="proj1" enabled commits={COMMITS} changedPaths={[]} />);

    // Waits for the member lookup to resolve (it maps `user1`, the OTHER commit's author) so this
    // assertion checks the real fallback rather than the transient "nothing resolved yet" state.
    await waitFor(() => expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument());
    expect(screen.getByText('Imported from legacy history')).toBeInTheDocument();
    expect(screen.getByText('Unknown author')).toBeInTheDocument();
  });

  test('shows the changed-paths count and each path', () => {
    render(
      <CommitPreviewList projectId="proj1" enabled commits={COMMITS} changedPaths={['a.adoc', 'b.adoc']} />,
    );

    expect(screen.getByText('2 changed paths')).toBeInTheDocument();
    expect(screen.getByText('a.adoc')).toBeInTheDocument();
    expect(screen.getByText('b.adoc')).toBeInTheDocument();
  });

  test('uses singular wording for exactly one changed path', () => {
    render(<CommitPreviewList projectId="proj1" enabled commits={COMMITS} changedPaths={['a.adoc']} />);

    expect(screen.getByText('1 changed path')).toBeInTheDocument();
  });

  test('shows a zero count and no path list when nothing changed', () => {
    render(<CommitPreviewList projectId="proj1" enabled commits={[]} changedPaths={[]} />);

    expect(screen.getByText('0 changed paths')).toBeInTheDocument();
  });

  test('does not fetch members when disabled', () => {
    render(<CommitPreviewList projectId="proj1" enabled={false} commits={COMMITS} changedPaths={[]} />);

    expect(mockListMembers).not.toHaveBeenCalled();
  });

  test('never renders a hardcoded hex or rgb color', () => {
    const { container } = render(
      <CommitPreviewList projectId="proj1" enabled commits={COMMITS} changedPaths={['a.adoc']} />,
    );
    for (const element of container.querySelectorAll('[class]')) {
      const className = element.getAttribute('class') ?? '';
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});
