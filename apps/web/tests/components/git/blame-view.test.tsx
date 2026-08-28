import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlameView } from '@/components/git/blame-view';
import { getBlame } from '@/lib/api/git';
import { membersApi, type ProjectMember } from '@/lib/api/members';
import { ApiError } from '@/lib/api/transport';
import type { BlameDto } from '@asciidocollab/shared';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

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
  return [...document.querySelectorAll<HTMLElement>('.cm-line')];
}

function gutterMarkers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.cm-blame-gutter .cm-gutterElement')];
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

  test('shows a generic message for a refusal carrying an unrecognized typed code', async () => {
    mockGetBlame.mockRejectedValue(new ApiError(400, 'some_new_code', 'server prose'));
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load blame/i);
    expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument();
  });
});

describe('BlameView gutter coverage of the rendered document', () => {
  test('renders no gutter marker for a document line the blame result does not describe', async () => {
    mockGetBlame.mockResolvedValue({
      lines: [
        { lineNumber: 10, hash: 'cccccccccccccccccccccccccccccccccccccccc', authorUserId: 'user-1', authoredAt: '2026-08-24T10:00:00.000Z', content: 'first line' },
        { lineNumber: 11, hash: 'dddddddddddddddddddddddddddddddddddddddd', authoredAt: '2026-08-25T10:00:00.000Z', content: 'second line' },
      ],
    });
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument());
    await waitFor(() =>
      expect(blameLines().map((line) => line.textContent)).toEqual(['first line', 'second line']),
    );

    expect(gutterMarkers()).toHaveLength(0);
  });
});

describe('BlameView dismissal', () => {
  test('asks to close when the Close button is pressed', async () => {
    mockGetBlame.mockResolvedValue({ lines: [] });
    const onOpenChange = jest.fn();
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={onOpenChange} />);
    await screen.findByText(/this file is empty/i);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    mockGetBlame.mockResolvedValue({ lines: [] });
    const onOpenChange = jest.fn();
    render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={onOpenChange} />);
    await screen.findByText(/this file is empty/i);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByText(/this file is empty/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('BlameView requests that settle after dismissal', () => {
  test('does not render blame that resolves after unmounting', async () => {
    let settle: (value: BlameDto) => void = noop;
    mockGetBlame.mockReturnValue(
      new Promise<BlameDto>((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount } = render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);
    expect(screen.getByText(/loading blame/i)).toBeInTheDocument();

    unmount();
    await act(async () => {
      settle(BLAME);
    });

    expect(blameLines()).toHaveLength(0);
  });

  test('does not render a failure that rejects after unmounting', async () => {
    let fail: (reason: unknown) => void = noop;
    mockGetBlame.mockReturnValue(
      new Promise<BlameDto>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { unmount } = render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);

    unmount();
    await act(async () => {
      fail(new ApiError(404, 'repository_not_connected', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('does not apply a member lookup that resolves after unmounting', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    let settle: (value: { data: { members: ProjectMember[] } }) => void = noop;
    mockMembersList.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount } = render(<BlameView projectId="proj1" open path="doc.adoc" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(/loading blame/i)).not.toBeInTheDocument());

    unmount();
    await act(async () => {
      settle({ data: { members: [member()] } });
    });

    expect(gutterMarkers()).toHaveLength(0);
  });
});
