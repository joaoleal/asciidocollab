import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import ArchivedProjectsPage from '@/app/(dashboard)/dashboard/archived/page';

const mockList = jest.fn();
jest.mock('@/lib/api', () => ({
  projectsApi: {
    list: (...arguments_: unknown[]) => mockList(...arguments_),
  },
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

  test('renders the empty state when there are no archived projects', async () => {
    mockList.mockResolvedValue({ data: [] });
    render(<ArchivedProjectsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/no archived projects/i);
    });
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

  test('leaves the user on the archived page after a clone', async () => {
    await renderWithOneArchivedProject();

    fireEvent.click(screen.getByTestId('clone-p1'));

    await screen.findByRole('status');
    expect(screen.getByRole('heading', { name: 'Archived Projects' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('renders the loading skeleton before the projects resolve', () => {
    mockList.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ArchivedProjectsPage />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
    expect(screen.getByText('Archived Projects')).toBeInTheDocument();
  });
});
