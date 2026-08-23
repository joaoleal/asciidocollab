import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectCard } from '@/components/project-card';
import type { Project, ProjectMemberRole } from '@/lib/api';

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: '1',
  name: 'My Project',
  description: 'A description',
  owners: [{ userId: 'u1', displayName: 'Owner' }],
  tags: [],
  rootFolderId: null,
  mainFileNodeId: null,
  language: null,
  archivedAt: null,
  memberCount: 6,
  fileCount: 24,
  role: 'owner',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  MockLink.displayName = 'MockLink';
  return MockLink;
});

// Render the dropdown inline so its items are queryable without opening the Radix menu. The item
// forwards onSelect, so an action item (as opposed to a link item) can be chosen the way Radix
// would choose it.
jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (event: Event) => void;
  }) => (
    <div onClick={(event: React.MouseEvent) => onSelect?.(event.nativeEvent)}>{children}</div>
  ),
}));

const CREATED_COPY: Pick<Project, 'id' | 'name'> = { id: 'copy-1', name: 'Copy of My Project' };

// Stand in for the real dialog: it only has to report that it was opened for the right project and
// to hand a created copy back the way the real one does on success.
jest.mock('@/components/clone-project-dialog', () => ({
  CloneProjectDialog: ({
    open,
    projectId,
    projectName,
    onCloned,
  }: {
    open: boolean;
    projectId: string;
    projectName: string;
    onCloned: (project: Pick<Project, 'id' | 'name'>) => void;
  }) =>
    open ? (
      <div data-testid="clone-dialog" data-project-id={projectId} data-project-name={projectName}>
        <button type="button" onClick={() => onCloned(CREATED_COPY)}>
          finish clone
        </button>
      </div>
    ) : null,
}));

const EVERY_ROLE: ProjectMemberRole[] = ['viewer', 'editor', 'owner'];

describe('ProjectCard', () => {
  test('renders project name and description', () => {
    render(<ProjectCard project={makeProject()} />);
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('A description')).toBeInTheDocument();
  });

  test('shows the role badge', () => {
    render(<ProjectCard project={makeProject({ role: 'viewer' })} />);
    expect(screen.getByText('viewer')).toBeInTheDocument();
  });

  test('renders tags when present', () => {
    render(<ProjectCard project={makeProject({ tags: ['docs', 'internal'] })} />);
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('internal')).toBeInTheDocument();
  });

  test('shows the file count and member count', () => {
    render(<ProjectCard project={makeProject({ fileCount: 24, memberCount: 6 })} />);
    expect(screen.getByText(/24 files/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  test('uses the singular "file" for a single file', () => {
    render(<ProjectCard project={makeProject({ fileCount: 1 })} />);
    expect(screen.getByText(/^1 file$/)).toBeInTheDocument();
  });

  test('shows a relative last-updated label', () => {
    render(<ProjectCard project={makeProject({ updatedAt: new Date().toISOString() })} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  test('owners get an options menu with Members and Settings links', () => {
    render(<ProjectCard project={makeProject({ role: 'owner' })} />);
    expect(screen.getByRole('button', { name: /project options/i })).toBeInTheDocument();
    expect(screen.getByText('Members').closest('a')).toHaveAttribute('href', '/dashboard/projects/1/members');
    expect(screen.getByText('Settings').closest('a')).toHaveAttribute('href', '/dashboard/projects/1/settings');
  });

  test.each(EVERY_ROLE)('renders the options menu for the %s role', (role) => {
    render(<ProjectCard project={makeProject({ role })} />);
    expect(screen.getByRole('button', { name: 'Project options' })).toBeInTheDocument();
  });

  test.each(EVERY_ROLE)('offers Clone to the %s role', (role) => {
    render(<ProjectCard project={makeProject({ role })} />);
    expect(screen.getByText('Clone')).toBeInTheDocument();
  });

  // Both remaining items lead somewhere that refuses a non-owner: member management
  // requires an owner, and so does the settings page. Offering either to a viewer or
  // an editor would send them to a refusal, which is the one thing this menu must not
  // do — so the menu shows a non-owner exactly the one item that works for them.
  test.each(['viewer', 'editor'] as const)('withholds Members and Settings from the %s role', (role) => {
    render(<ProjectCard project={makeProject({ role })} />);
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  test('offers Members and Settings to the owner', () => {
    render(<ProjectCard project={makeProject({ role: 'owner' })} />);
    expect(screen.getByText('Members').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/projects/1/members',
    );
    expect(screen.getByText('Settings').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/projects/1/settings',
    );
  });

  test('falls back to "No description" when none is set', () => {
    render(<ProjectCard project={makeProject({ description: '' })} />);
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  test('hides the role badge when role is absent', () => {
    render(<ProjectCard project={makeProject({ role: undefined })} />);
    for (const role of EVERY_ROLE) {
      expect(screen.queryByText(role)).not.toBeInTheDocument();
    }
  });

  test('omits file and member counts when undefined', () => {
    render(
      <ProjectCard project={makeProject({ fileCount: undefined, memberCount: undefined })} />,
    );
    expect(screen.queryByText(/files?$/)).not.toBeInTheDocument();
  });

  test('renders the navigating stretched link to the project', () => {
    const { container } = render(<ProjectCard project={makeProject({ id: '42', name: 'Alpha' })} />);
    expect(container.querySelector('a[href="/dashboard/projects/42"]')).toBeInTheDocument();
  });

  test('choosing Clone opens the clone dialog for that card\'s project', () => {
    render(<ProjectCard project={makeProject({ id: '7', name: 'Alpha', role: 'viewer' })} />);
    expect(screen.queryByTestId('clone-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Clone'));

    const dialog = screen.getByTestId('clone-dialog');
    expect(dialog).toHaveAttribute('data-project-id', '7');
    expect(dialog).toHaveAttribute('data-project-name', 'Alpha');
  });

  test('hands the created copy to the listing that rendered the card', () => {
    const onCloned = jest.fn();
    render(<ProjectCard project={makeProject()} onCloned={onCloned} />);
    fireEvent.click(screen.getByText('Clone'));

    fireEvent.click(screen.getByRole('button', { name: 'finish clone' }));

    expect(onCloned).toHaveBeenCalledWith(CREATED_COPY);
  });

  test('survives a clone when no listener was supplied', () => {
    render(<ProjectCard project={makeProject()} />);
    fireEvent.click(screen.getByText('Clone'));

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'finish clone' })),
    ).not.toThrow();
  });

  test('stops propagation when the options button is clicked', () => {
    render(<ProjectCard project={makeProject({ role: 'owner' })} />);
    const optionsButton = screen.getByRole('button', { name: /project options/i });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stopPropagation = jest.spyOn(event, 'stopPropagation');
    optionsButton.dispatchEvent(event);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});
