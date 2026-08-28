import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffView } from '@/components/git/diff-view';
import { getDiff } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { DiffDto } from '@asciidocollab/shared';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getDiff: jest.fn(),
}));

const mockGetDiff = getDiff as jest.MockedFunction<typeof getDiff>;

const UNIFIED = [
  'diff --git a/doc.adoc b/doc.adoc',
  'index abc123..def456 100644',
  '--- a/doc.adoc',
  '+++ b/doc.adoc',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' unchanged line',
].join('\n');

// `Dialog.Portal` renders into `document.body`, outside RTL's own `container` div, so the diff
// view's CodeMirror content is looked up against the whole document rather than the container.
function diffLines(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.cm-line')];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DiffView loading and rendering', () => {
  test('fetches with the given path/from/to once opened, and renders the diff text', async () => {
    mockGetDiff.mockResolvedValue({ unified: UNIFIED } satisfies DiffDto);
    render(
      <DiffView projectId="proj1" open path="doc.adoc" from="abc123^" to="abc123" onOpenChange={jest.fn()} />,
    );

    expect(screen.getByText(/loading diff/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument());

    expect(mockGetDiff).toHaveBeenCalledWith('proj1', { path: 'doc.adoc', from: 'abc123^', to: 'abc123' });
    expect(screen.getByText(/new line/)).toBeInTheDocument();
    expect(screen.getByText(/old line/)).toBeInTheDocument();
  });

  test('does not fetch while closed', () => {
    render(<DiffView projectId="proj1" open={false} onOpenChange={jest.fn()} />);
    expect(mockGetDiff).not.toHaveBeenCalled();
  });

  test('fetches once opened via a prop change from closed', async () => {
    mockGetDiff.mockResolvedValue({ unified: UNIFIED } satisfies DiffDto);
    const { rerender } = render(<DiffView projectId="proj1" open={false} onOpenChange={jest.fn()} />);
    expect(mockGetDiff).not.toHaveBeenCalled();

    rerender(<DiffView projectId="proj1" open from="a^" to="a" onOpenChange={jest.fn()} />);
    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledWith('proj1', { path: undefined, from: 'a^', to: 'a' }));
  });

  test('shows "No changes." for an empty diff', async () => {
    mockGetDiff.mockResolvedValue({ unified: '' });
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('No changes.')).toBeInTheDocument());
  });

  test('colors added, removed, hunk, file-header, and context lines by role', async () => {
    mockGetDiff.mockResolvedValue({ unified: UNIFIED });
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument());

    const lines = diffLines();
    expect(lines).toHaveLength(UNIFIED.split('\n').length);
    const byText = (text: string) => lines.find((line) => line.textContent === text);

    expect(byText('diff --git a/doc.adoc b/doc.adoc')?.className).toContain('text-muted-foreground');
    expect(byText('@@ -1,2 +1,2 @@')?.className).toContain('--info');
    expect(byText('-old line')?.className).toContain('text-destructive');
    expect(byText('+new line')?.className).toContain('--success');
    expect(byText(' unchanged line')?.className).toContain('text-foreground');
  });
});

describe('DiffView error handling', () => {
  test('shows a specific message for an invalid commit range (e.g. a rootless commit)', async () => {
    mockGetDiff.mockRejectedValue(new ApiError(500, 'git_command_failed', 'boom'));
    render(<DiffView projectId="proj1" open from="root^" to="root" onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/may be invalid/i);
  });

  test('shows a generic message for an unrecognized failure, without crashing', async () => {
    mockGetDiff.mockRejectedValue(new Error('network down'));
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load this diff/i);
  });

  test('shows a not-connected message for a disconnected project', async () => {
    mockGetDiff.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'nope'));
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no connected git repository/i);
  });

  test('shows a generic message for a refusal carrying an unrecognized typed code', async () => {
    mockGetDiff.mockRejectedValue(new ApiError(400, 'some_new_code', 'server prose'));
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load this diff/i);
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });

  test('shows a generic message when the request never reaches the server', async () => {
    mockGetDiff.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load this diff/i);
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });
});

describe('DiffView dismissal', () => {
  test('asks to close when the Close button is pressed', async () => {
    mockGetDiff.mockResolvedValue({ unified: '' });
    const onOpenChange = jest.fn();
    render(<DiffView projectId="proj1" open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByText('No changes.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    mockGetDiff.mockResolvedValue({ unified: '' });
    const onOpenChange = jest.fn();
    render(<DiffView projectId="proj1" open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByText('No changes.')).toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByText('No changes.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('DiffView unmount during an in-flight load', () => {
  test('does not render a diff that resolves after unmounting', async () => {
    let settle: (value: DiffDto) => void = noop;
    mockGetDiff.mockReturnValue(
      new Promise<DiffDto>((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount } = render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);
    expect(screen.getByText(/loading diff/i)).toBeInTheDocument();

    unmount();
    await act(async () => {
      settle({ unified: UNIFIED });
    });

    expect(diffLines()).toHaveLength(0);
  });

  test('does not render a failure that rejects after unmounting', async () => {
    let fail: (reason: unknown) => void = noop;
    mockGetDiff.mockReturnValue(
      new Promise<DiffDto>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { unmount } = render(<DiffView projectId="proj1" open onOpenChange={jest.fn()} />);

    unmount();
    await act(async () => {
      fail(new ApiError(500, 'git_command_failed', 'boom'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
