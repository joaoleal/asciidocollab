import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import ArchivedProjectsPage from '@/app/(dashboard)/dashboard/archived/page';
import type { CloneFailure } from '@/components/clone-project-dialog';

const mockList = jest.fn();
jest.mock('@/lib/api', () => ({
  projectsApi: {
    list: (...arguments_: unknown[]) => mockList(...arguments_),
  },
}));

const CREATED_COPY = { id: 'clone-1', name: 'Copy of Alpha' };
// A second copy, distinct in both id and name. On this page the confirmation's link is the only
// route to a copy, so the two have to be distinguishable by where that link goes and not just by
// what the sentence says.
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

// The router is mocked although the page never asks for it: a clone must leave the user where they
// are, and an unused push/replace is what proves the page did not start navigating.
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));

function project(id: string, name: string) {
  return { id, name };
}

describe('ArchivedProjectsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function renderWithOneArchivedProject() {
    mockList.mockResolvedValue({ data: [project('p1', 'Alpha')] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('project-card')).toBeInTheDocument();
    });
  }

  test('requests archived projects from the API', async () => {
    mockList.mockResolvedValue({ data: [] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledWith({ page: 1, limit: 50, archived: true });
    });
  });

  test('renders the archived projects and a singular count', async () => {
    mockList.mockResolvedValue({ data: [project('p1', 'Alpha')] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('project-card')).toBeInTheDocument();
    });
    expect(screen.getByText('1 archived project')).toBeInTheDocument();
  });

  test('uses the plural count when more than one archived project exists', async () => {
    mockList.mockResolvedValue({ data: [project('p1', 'Alpha'), project('p2', 'Beta')] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByText('2 archived projects')).toBeInTheDocument();
    });
  });

  test('renders the empty state under the page heading when there are no archived projects', async () => {
    mockList.mockResolvedValue({ data: [] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/no archived projects/i);
    });
    expect(screen.getByRole('heading', { name: 'Archived Projects' })).toBeInTheDocument();
  });

  test('renders the error message when the API rejects with an Error', async () => {
    mockList.mockRejectedValue(new Error('Boom'));
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
  });

  test('renders a fallback error message when the API rejects with a non-Error', async () => {
    mockList.mockRejectedValue('nope');
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load projects/i)).toBeInTheDocument();
    });
  });

  test('keeps the active copy out of the archived listing', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await screen.findByRole('status');
    expect(screen.getAllByTestId('project-card')).toHaveLength(1);
    expect(screen.getByText('1 archived project')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  test('confirms the clone by name and links straight to the new project', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('Created Copy of Alpha.');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toHaveAttribute(
      'href',
      '/dashboard/projects/clone-1',
    );
  });

  // That the user really is still on the archived listing afterwards is asserted end to end, where
  // a navigation would be visible; from here the router is a mock, so all this can pin is that the
  // page never asks it to move. Read this as a tripwire, not as evidence about today's code: the
  // page imports nothing from next/navigation, so the mock below is unreachable by construction and
  // these two assertions cannot fail until someone reaches for the router.
  test('never asks the router to navigate when a clone completes', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await screen.findByRole('status');
    // Still the archived listing, heading and all. This covers the branch that renders alongside
    // the cards, which the empty-state test cannot reach — and unlike the two router assertions
    // below it can actually fail against today's code.
    expect(screen.getByRole('heading', { name: 'Archived Projects' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('reports a clone that failed after its dialog was dismissed', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-failure-p1'));

    expect(await screen.findByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
    expect(screen.getAllByTestId('project-card')).toHaveLength(1);
  });

  test('retires a standing refusal when the user starts another attempt', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-failure-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-start-p1'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('keeps the link to a copy that landed when the user starts another attempt', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-p1'));
    await screen.findByRole('status');

    // Starting a second copy must not strand the first. That attempt may report only into its own
    // dialog, and this page would then hold nothing at all — having thrown away the one link to a
    // project no listing here will ever show.
    fireEvent.click(screen.getByTestId('clone-start-p1'));

    const confirmation = screen.getByRole('status');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toHaveAttribute(
      'href',
      '/dashboard/projects/clone-1',
    );
  });

  // Two attempts overlap, which is what the dialog's dismissable busy state allows: the first was
  // left running when its dialog was closed, and the second was started before it answered. The
  // confirmation is the only route to the copy that was made — nothing here will ever list it — so
  // neither arrival order may drop it, and the refusal is owed to the user just the same.
  test.each([
    ['the copy answers first', ['clone-p1', 'clone-failure-p1']],
    ['the refusal answers first', ['clone-failure-p1', 'clone-p1']],
  ])('keeps the link to a copy alongside a refusal when %s', async (_order, outcomes) => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    for (const outcome of outcomes) {
      fireEvent.click(screen.getByTestId(outcome));
    }

    expect(await screen.findByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
    const confirmation = screen.getByRole('status');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toHaveAttribute(
      'href',
      '/dashboard/projects/clone-1',
    );
  });

  // The confirmation holds one copy at a time, and here it is the only route to the copy at all.
  // Keeping the first would leave the page naming the copy just made while its link led to another.
  test('names and links the copy that landed most recently, not the one before it', async () => {
    await renderWithOneArchivedProject();

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
    await renderWithOneArchivedProject();

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
    await renderWithOneArchivedProject();

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
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-p1'));
    fireEvent.click(screen.getByTestId('clone-failure-alt-p1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A clone is already running.');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Dismissing the refusal must not take the copy's link with it — on this page it is the only one.
    const confirmation = screen.getByRole('status');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toBeInTheDocument();
  });

  // Every other refusal outlives the copy. Losing access to the source is not a claim about what is
  // running, so a copy landing says nothing about it and dropping it would report both attempts as
  // successful.
  test('keeps a refusal a landing copy cannot disprove', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-start-p1'));
    fireEvent.click(screen.getByTestId('clone-failure-p1'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('clone-p1'));

    expect(await screen.findByRole('status')).toHaveTextContent('Created Copy of Alpha.');
    expect(screen.getByRole('alert')).toHaveTextContent(CLONE_FAILURE.message);
  });

  // The notices belong to the page, not to the listing, so an empty listing must not take them with
  // it — on this page especially, where the confirmation carries the only route to the copy.
  //
  // Emptying the array the page is holding is how an emptied listing is reached from here: the page
  // fetches once and never shrinks the result itself, so nothing else can put it in the state a
  // later refresh would. The clone that follows re-renders the page, which then reads the listing as
  // empty — exactly what it would find had the refresh returned nothing.
  test('reports a clone whose listing has emptied since the page loaded', async () => {
    const listing = [project('p1', 'Alpha')];
    mockList.mockResolvedValue({ data: listing });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('project-card')).toBeInTheDocument();
    });

    listing.length = 0;
    fireEvent.click(screen.getByTestId('clone-p1'));

    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    const confirmation = screen.getByRole('status');
    expect(within(confirmation).getByRole('link', { name: 'Open Copy of Alpha' })).toHaveAttribute(
      'href',
      '/dashboard/projects/clone-1',
    );
  });

  test('renders the loading skeleton before the projects resolve', () => {
    mockList.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ArchivedProjectsPage />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
    expect(screen.getByText('Archived Projects')).toBeInTheDocument();
  });
});
