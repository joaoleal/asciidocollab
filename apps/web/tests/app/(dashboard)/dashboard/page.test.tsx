import React from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/dashboard/page';
import type { CloneFailure } from '@/components/clone-project-dialog';

const mockList = jest.fn();
jest.mock('@/lib/api', () => ({
  projectsApi: {
    list: (...arguments_: unknown[]) => mockList(...arguments_),
  },
}));

let searchValue: string | null = null;
// A single stable instance mirrors Next's real useSearchParams (a referentially stable
// ReadonlyURLSearchParams), so the notice effect runs once instead of on every render.
const stableSearchParameters = { get: () => searchValue };
// The router is mocked although the page never reaches for it — it takes only useSearchParams from
// next/navigation — so that a clone can be shown leaving the user where they are.
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useSearchParams: () => stableSearchParameters,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const CREATED_COPY = { id: 'clone-1', name: 'Copy of Alpha' };
// A second copy, distinct in both id and name, so a confirmation that kept the first can be told
// apart from one that took the second — by what it says and by where its link goes.
const LATER_CREATED_COPY = { id: 'clone-2', name: 'Second copy of Alpha' };

// A refusal no landing copy can disprove: access to the source was lost, and stays lost whatever
// else finishes.
const CLONE_FAILURE: CloneFailure = {
  code: 'FORBIDDEN',
  message: 'You no longer have access to that project.',
};
// The refusal overlapping attempts actually produce — the server copies one project per user at a
// time — and the only one whose whole content a landing copy makes false.
const IN_PROGRESS_FAILURE: CloneFailure = {
  code: 'CLONE_IN_PROGRESS',
  message: 'A clone is already running. Wait for it to finish, then try again.',
};

// The stand-in card exposes the three callbacks the real card fires as its dialog reports progress,
// each on its own control. Keeping the start signal separate from the two outcomes is what lets a
// test decide whether the attempts it drives run one after another or overlap.
jest.mock('@/components/project-card', () => ({
  ProjectCard: ({
    project,
    onCloneStarted,
    onCloned,
    onCloneFailed,
  }: {
    project: { id: string; name: string };
    onCloneStarted?: () => void;
    onCloned?: (created: { id: string; name: string }) => void;
    onCloneFailed?: (failure: CloneFailure) => void;
  }) => (
    <div data-testid="project-card">
      {project.name}
      <button
        type="button"
        data-testid={`clone-start-${project.id}`}
        aria-label={`start cloning ${project.name}`}
        onClick={() => onCloneStarted?.()}
      />
      <button
        type="button"
        data-testid={`clone-${project.id}`}
        aria-label={`clone ${project.name}`}
        onClick={() => onCloned?.(CREATED_COPY)}
      />
      <button
        type="button"
        data-testid={`clone-alt-${project.id}`}
        aria-label={`clone ${project.name} a second time`}
        onClick={() => onCloned?.(LATER_CREATED_COPY)}
      />
      <button
        type="button"
        data-testid={`clone-failure-${project.id}`}
        aria-label={`fail cloning ${project.name}`}
        onClick={() => onCloneFailed?.(CLONE_FAILURE)}
      />
      <button
        type="button"
        data-testid={`clone-failure-alt-${project.id}`}
        aria-label={`refuse cloning ${project.name} while another copy runs`}
        onClick={() => onCloneFailed?.(IN_PROGRESS_FAILURE)}
      />
    </div>
  ),
}));

jest.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));

function project(id: string, name: string) {
  return { id, name };
}

describe('DashboardPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchValue = null;
  });

  async function renderWithOneProject() {
    mockList.mockResolvedValue({ data: [project('p1', 'Alpha')] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('project-card')).toBeInTheDocument();
    });
  }

  test('renders the projects returned by the API', async () => {
    mockList.mockResolvedValue({ data: [project('p1', 'Alpha'), project('p2', 'Beta')] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('project-card')).toHaveLength(2);
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith({ page: 1, limit: 20 });
  });

  test('renders the empty state when there are no projects', async () => {
    mockList.mockResolvedValue({ data: [] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  });

  test('renders the error message when the API rejects with an Error', async () => {
    mockList.mockRejectedValue(new Error('Server is down'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Server is down')).toBeInTheDocument();
    });
  });

  test('renders a fallback error message when the API rejects with a non-Error', async () => {
    mockList.mockRejectedValue('oops');
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load projects/i)).toBeInTheDocument();
    });
  });

  test('shows the deleted notice when the deleted=1 query param is present', async () => {
    searchValue = '1';
    mockList.mockResolvedValue({ data: [] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/project deleted successfully/i)).toBeInTheDocument();
    });
  });

  test('hides the deleted notice after the timeout elapses', async () => {
    jest.useFakeTimers();
    try {
      searchValue = '1';
      mockList.mockResolvedValue({ data: [] });
      render(<DashboardPage />);
      // Flush the resolved list promise so the component leaves its loading state and
      // settles on a single pending dismiss timer (the notice effect re-runs per render).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText(/project deleted successfully/i)).toBeInTheDocument();
      act(() => {
        jest.runOnlyPendingTimers();
      });
      expect(screen.queryByText(/project deleted successfully/i)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('adds the cloned project to the listing without a second request', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await waitFor(() => {
      expect(screen.getAllByTestId('project-card')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('project-card')[0]).toHaveTextContent('Copy of Alpha');
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  test('confirms the clone by name and links straight to the new project', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('Created Copy of Alpha.');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toHaveAttribute(
      'href',
      '/dashboard/projects/clone-1',
    );
  });

  // That the user really is still on /dashboard afterwards is asserted end to end, where a
  // navigation would be visible; from here the router is a mock, so all this can pin is that the
  // page never asks it to move. Read it as a tripwire, not as evidence about today's code: the page
  // takes only useSearchParams from next/navigation, so the router mock is unreachable by
  // construction and these two assertions cannot fail until someone reaches for it.
  test('never asks the router to navigate when a clone completes', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await screen.findByRole('status');
    // The dashboard is still the dashboard: its own heading is what a navigation would have taken
    // away, and unlike the two router assertions below it can actually fail against today's code.
    expect(screen.getByRole('heading', { name: 'Your Projects' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('reports a clone that failed after its dialog was dismissed', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-failure-p1'));

    expect(await screen.findByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
    // Nothing was created, so the listing must not have grown.
    expect(screen.getAllByTestId('project-card')).toHaveLength(1);
  });

  test('retires a standing refusal when the user starts another attempt', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-failure-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-start-p1'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('keeps a copy that landed on screen when the user starts another attempt', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));
    await screen.findByRole('status');

    // The confirmation is not the status of an attempt — it names a project that now exists. A
    // second attempt takes nothing away from the first, and that attempt may well report only into
    // its own dialog, leaving this page nothing to put in the confirmation's place.
    fireEvent.click(screen.getByTestId('clone-start-p1'));

    expect(screen.getByRole('status')).toHaveTextContent('Created Copy of Alpha.');
  });

  // Two attempts overlap, which is what the dialog's dismissable busy state allows: the first was
  // left running when its dialog was closed, and the second was started before it answered. One
  // copy really was made and one really was refused, so the page owes the user both facts — and it
  // cannot know which of the two will answer first, so neither order may drop one of them.
  test.each([
    ['the copy answers first', ['clone-p1', 'clone-failure-p1']],
    ['the refusal answers first', ['clone-failure-p1', 'clone-p1']],
  ])('reports a copy that landed and a refusal together when %s', async (_order, outcomes) => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    for (const outcome of outcomes) {
      fireEvent.click(screen.getByTestId(outcome));
    }

    expect(await screen.findByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
    expect(screen.getByRole('status')).toHaveTextContent('Created Copy of Alpha.');
  });

  // The confirmation holds one copy at a time, so when a second lands it has to be the second one
  // that is named and linked. Keeping the first would leave the page describing a copy the user has
  // just been told about while offering the route to a different one.
  test('names and links the copy that landed most recently, not the one before it', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));
    await screen.findByRole('status');

    fireEvent.click(screen.getByTestId('clone-alt-p1'));

    const confirmation = screen.getByRole('status');
    expect(confirmation).toHaveTextContent('Created Second copy of Alpha.');
    expect(
      within(confirmation).getByRole('link', { name: 'Open Second copy of Alpha' }),
    ).toHaveAttribute('href', '/dashboard/projects/clone-2');
  });

  // The refusal notice holds one reason at a time, and the reason the user needs is the one that
  // arrived last: the earlier attempt has already been answered.
  test('shows the refusal that arrived most recently, not the one before it', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-failure-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-failure-alt-p1'));

    expect(screen.getByRole('alert')).toHaveTextContent(IN_PROGRESS_FAILURE.message);
    expect(screen.queryByText(CLONE_FAILURE.message)).not.toBeInTheDocument();
  });

  // The refusal says a clone is still running, and this is the copy it was talking about. Left up it
  // would sit under a fresh confirmation telling the user to wait for something already finished.
  // Dismissing it is possible but beside the point: the page knows it is false, so it withdraws it.
  test('withdraws a wait-for-the-other-clone refusal once that clone lands', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-failure-alt-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-p1'));

    expect(await screen.findByRole('status')).toHaveTextContent('Created Copy of Alpha.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The retirement above only reaches a refusal already on screen. Arriving in the other order —
  // the copy first, its refusal afterwards — the page cannot tell a stale claim from a true one,
  // because a clone running in another tab refuses this one just the same. It shows the refusal
  // rather than swallowing it, and lets the user clear it.
  test('lets the user dismiss a refusal the page cannot judge for itself', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-p1'));
    fireEvent.click(screen.getByTestId('clone-failure-alt-p1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A clone is already running.');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Dismissing the refusal says nothing about the copy, which still exists.
    expect(screen.getByRole('status')).toHaveTextContent('Created Copy of Alpha.');
  });

  // Every other refusal outlives the copy. Losing access to the source is not a claim about what is
  // running, so a copy landing says nothing about it and dropping it would report both attempts as
  // successful.
  test('keeps a refusal a landing copy cannot disprove', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-failure-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-p1'));

    expect(await screen.findByRole('status')).toHaveTextContent('Created Copy of Alpha.');
    expect(screen.getByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
  });

  test('renders the loading skeleton before the projects resolve', () => {
    mockList.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DashboardPage />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });
});
