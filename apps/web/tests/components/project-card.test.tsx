import React from 'react';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from '@/components/project-card';
import type { Project } from '@/lib/api';

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

// Render the dropdown inline so its items are queryable without opening the Radix menu.
jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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

  test('non-owners do not get the options menu', () => {
    render(<ProjectCard project={makeProject({ role: 'editor' })} />);
    expect(screen.queryByRole('button', { name: /project options/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  test('falls back to "No description" when none is set', () => {
    render(<ProjectCard project={makeProject({ description: '' })} />);
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  test('hides the role badge when role is absent', () => {
    render(<ProjectCard project={makeProject({ role: undefined })} />);
    expect(screen.queryByRole('button', { name: /project options/i })).not.toBeInTheDocument();
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

  test('stops propagation when the options button is clicked', () => {
    render(<ProjectCard project={makeProject({ role: 'owner' })} />);
    const optionsButton = screen.getByRole('button', { name: /project options/i });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stopPropagation = jest.spyOn(event, 'stopPropagation');
    optionsButton.dispatchEvent(event);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});
