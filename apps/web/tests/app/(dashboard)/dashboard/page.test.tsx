import React from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/dashboard/page';

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
// The router is mocked although the page never asks for it: a clone must leave the user where they
// are, and an unused push/replace is what proves the page did not start navigating.
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useSearchParams: () => stableSearchParameters,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const CREATED_COPY = { id: 'clone-1', name: 'Copy of Alpha' };

// The stand-in card exposes the success callback the real card fires once its dialog reports a
// created copy, so the listing's own reaction can be driven without the dialog.
jest.mock('@/components/project-card', () => ({
  ProjectCard: ({
    project,
    onCloned,
  }: {
    project: { id: string; name: string };
    onCloned?: (created: { id: string; name: string }) => void;
  }) => (
    <div data-testid="project-card">
      {project.name}
      <button
        type="button"
        data-testid={`clone-${project.id}`}
        aria-label={`clone ${project.name}`}
        onClick={() => onCloned?.(CREATED_COPY)}
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

  test('leaves the user on the dashboard after a clone', async () => {
    await renderWithOneProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await screen.findByRole('status');
    expect(screen.getByRole('heading', { name: 'Your Projects' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('renders the loading skeleton before the projects resolve', () => {
    mockList.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DashboardPage />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });
});
