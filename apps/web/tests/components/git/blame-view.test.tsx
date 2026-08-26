import { render, screen, waitFor } from '@testing-library/react';
import { BlameView } from '@/components/git/blame-view';
import { getBlame } from '@/lib/api/git';
import { membersApi, type ProjectMember } from '@/lib/api/members';
import { ApiError } from '@/lib/api/transport';
import type { BlameDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getBlame: jest.fn(),
}));

jest.mock('@/lib/api/members', () => ({
  membersApi: { list: jest.fn() },
}));

const mockGetBlame = getBlame as jest.MockedFunction<typeof getBlame>;
const mockMembersList = membersApi.list as jest.MockedFunction<typeof membersApi.list>;

function member(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    userId: 'user-1',
    email: 'a@example.com',
    displayName: 'Ada Lovelace',
    role: 'editor',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const BLAME: BlameDto = {
  lines: [
    { lineNumber: 1, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', authorUserId: 'user-1', authoredAt: '2026-08-24T10:00:00.000Z', content: 'first line' },
    { lineNumber: 2, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', authoredAt: '2026-01-02T00:00:00.000Z', content: 'second line' },
  ],
};

// `Dialog.Portal` renders into `document.body`, outside RTL's own `container` div, so the blame
// view's CodeMirror content is looked up against the whole document rather than the container.
function blameLines(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.cm-line'));
}

function gutterMarkers(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.cm-blame-gutter .cm-gutterElement'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMembersList.mockResolvedValue({ data: { members: [member()] } });
});

describe('BlameView loading and rendering', () => {
  test('fetches with the required path (and ref when given), and renders the file content', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    render(<BlameView projectId="proj1" open path="doc.adoc" ref="main" onOpenChange={jest.fn()} />);

    expect(screen.getByText(/loading blame/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument());

    expect(mockGetBlame).toHaveBeenCalledWith('proj1', 'doc.adoc', { ref: 'main' });
    await waitFor(() =>
      expect(blameLines().map((line) => line.textContent)).toEqual(['first line', 'second line']),
    );
  });

  test('renders one gutter entry per blame line, resolving the author and an unknown-author fallback', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument());
    await waitFor(() => expect(gutterMarkers()).toHaveLength(2));

    const markers = gutterMarkers();
    expect(markers[0]).toHaveTextContent('Ada Lovelace');
    expect(markers[0]).toHaveTextContent('2026-08-24');
    expect(markers[1]).toHaveTextContent('Unknown author');
    expect(markers[1]).toHaveTextContent('2026-01-02');
  });

  test('shows the fallback author for every line when the member lookup fails', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    mockMembersList.mockRejectedValue(new Error('boom'));
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument());

    await waitFor(() => {
      const markers = gutterMarkers();
      expect(markers.every((marker) => marker.textContent?.includes('Unknown author'))).toBe(true);
    });
  });

  test('shows an empty-file message when the file has no lines', async () => {
    mockGetBlame.mockResolvedValue({ lines: [] });
    render(<BlameView projectId="proj1" open path="empty.adoc" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByText(/this file is empty/i)).toBeInTheDocument());
  });

  test('does not fetch while closed', () => {
    render(<BlameView projectId="proj1" open={false} path="doc.adoc" onOpenChange={jest.fn()} />);
    expect(mockGetBlame).not.toHaveBeenCalled();
  });
});

describe('BlameView error handling', () => {
  test('shows a generic error message on an unrecognized failure, without crashing', async () => {
    mockGetBlame.mockRejectedValue(new Error('network down'));
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load blame/i);
  });

  test('shows a not-connected message for a disconnected project', async () => {
    mockGetBlame.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'nope'));
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no connected git repository/i);
  });
});
