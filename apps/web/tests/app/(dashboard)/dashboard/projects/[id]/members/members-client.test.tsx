import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MembersClient } from '@/app/(dashboard)/dashboard/projects/[id]/members/members-client';
import type { ProjectMember } from '@/lib/api';

interface MemberListProperties {
  members: Array<{ userId: string; role: string }>;
  onUpdateRole?: (userId: string, role: string) => void;
  onRemove?: (userId: string) => void;
}

interface InviteFormProperties {
  onSuccess?: (member: { userId: string; email: string; displayName: string; role: string; joinedAt: string }) => void;
}

jest.mock('@/components/member-list', () => ({
  MemberList: ({ members, onUpdateRole, onRemove }: MemberListProperties) => (
    <div data-testid="member-list">
      <span data-testid="member-count">{members.length}</span>
      <ul>
        {members.map((member) => (
          <li key={member.userId}>{`${member.userId}:${member.role}`}</li>
        ))}
      </ul>
      <button type="button" onClick={() => onUpdateRole?.('user-2', 'owner')}>
        promote-user-2
      </button>
      <button type="button" onClick={() => onUpdateRole?.('user-2', 'bogus')}>
        bogus-role-user-2
      </button>
      <button type="button" onClick={() => onRemove?.('user-2')}>
        remove-user-2
      </button>
    </div>
  ),
}));

jest.mock('@/components/invite-member-form', () => ({
  InviteMemberForm: ({ onSuccess }: InviteFormProperties) => (
    <button
      type="button"
      onClick={() =>
        onSuccess?.({
          userId: 'user-3',
          email: 'carol@example.com',
          displayName: 'Carol',
          role: 'viewer',
          joinedAt: '',
        })
      }
    >
      invite-carol
    </button>
  ),
}));

const OWNER: ProjectMember = { userId: 'user-1', email: 'a@example.com', displayName: 'Alice', role: 'owner', joinedAt: '' };
const EDITOR: ProjectMember = { userId: 'user-2', email: 'b@example.com', displayName: 'Bob', role: 'editor', joinedAt: '' };

function renderClient(overrides: Partial<React.ComponentProps<typeof MembersClient>> = {}) {
  const properties: React.ComponentProps<typeof MembersClient> = {
    projectId: 'proj-1',
    projectName: 'My Project',
    members: [OWNER, EDITOR],
    currentUserId: 'user-1',
    currentUserRole: 'owner',
    isArchived: false,
    ...overrides,
  };
  return render(<MembersClient {...properties} />);
}

describe('MembersClient — rendering', () => {
  test('shows the project name in the description', () => {
    renderClient();
    expect(screen.getByText(/invite and manage members for my project/i)).toBeInTheDocument();
  });

  test('passes the initial members to the member list', () => {
    renderClient();
    expect(screen.getByTestId('member-count')).toHaveTextContent('2');
  });

  test('renders the invite form when the project is active', () => {
    renderClient();
    expect(screen.getByRole('button', { name: /invite-carol/i })).toBeInTheDocument();
  });
});

describe('MembersClient — archived state', () => {
  test('shows the archived banner and hides the invite form', () => {
    renderClient({ isArchived: true });
    expect(screen.getByText(/member management is read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite-carol/i })).not.toBeInTheDocument();
  });
});

describe('MembersClient — sole owner warning', () => {
  test('warns when the current owner is the only owner', () => {
    renderClient({ members: [OWNER, EDITOR], currentUserRole: 'owner' });
    expect(screen.getByText(/sole owner of this project/i)).toBeInTheDocument();
  });

  test('does not warn when there are multiple owners', () => {
    const secondOwner: ProjectMember = { ...EDITOR, role: 'owner' };
    renderClient({ members: [OWNER, secondOwner] });
    expect(screen.queryByText(/sole owner of this project/i)).not.toBeInTheDocument();
  });

  test('does not warn when the current user is not an owner', () => {
    renderClient({ currentUserRole: 'editor', currentUserId: 'user-2' });
    expect(screen.queryByText(/sole owner of this project/i)).not.toBeInTheDocument();
  });
});

describe('MembersClient — member mutations', () => {
  test('updating a role rewrites that member in the list', () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /promote-user-2/i }));
    expect(screen.getByText('user-2:owner')).toBeInTheDocument();
  });

  test('an unknown role falls back to viewer', () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /bogus-role-user-2/i }));
    expect(screen.getByText('user-2:viewer')).toBeInTheDocument();
  });

  test('removing a member drops it from the list', () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /remove-user-2/i }));
    expect(screen.getByTestId('member-count')).toHaveTextContent('1');
    expect(screen.queryByText(/^user-2:/)).not.toBeInTheDocument();
  });

  test('a successful invite appends the new member', () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /invite-carol/i }));
    expect(screen.getByTestId('member-count')).toHaveTextContent('3');
    expect(screen.getByText('user-3:viewer')).toBeInTheDocument();
  });
});
