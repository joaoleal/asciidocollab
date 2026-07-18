import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { ProjectMember, ProjectMemberRole, Project } from './api';
import { API_BASE_URL } from '@/lib/api/base-url';

/** Resolved access context for a project page, containing the project, its members, and the current user's identity and role. */
export interface ProjectAccess {
  /** The project being accessed. */
  project: Project;
  /** All members belonging to the project. */
  members: ProjectMember[];
  /** Unique identifier of the currently authenticated user. */
  currentUserId: string;
  /** Role of the currently authenticated user within this project. */
  currentUserRole: ProjectMemberRole;
  /** Whether the current user has admin privileges. */
  isAdmin: boolean;
}

async function fetchJson<T>(response: Response): Promise<T> {
  return response.json();
}

/**
 * Server-side helper for project pages. Fetches the project and the caller's
 * membership in a single pass. Redirects to /403 if the caller's role does not
 * meet `minRole`, or to /login if the session has expired.
 *
 * Role hierarchy: viewer < editor < owner.
 */
export async function getProjectAccess(
  projectId: string,
  minRole: ProjectMemberRole = 'viewer',
): Promise<ProjectAccess> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');

  const requestHeaders = { Cookie: cookieHeader, 'Content-Type': 'application/json' };

  const [meResponse, projectResponse, membersResponse] = await Promise.all([
    fetch(`${API_BASE_URL}/auth/me`, { headers: requestHeaders, cache: 'no-store' }),
    fetch(`${API_BASE_URL}/api/projects/${projectId}`, { headers: requestHeaders, cache: 'no-store' }),
    fetch(`${API_BASE_URL}/api/projects/${projectId}/members`, { headers: requestHeaders, cache: 'no-store' }),
  ]);

  if (meResponse.status === 401) redirect('/login?reason=expired');
  if (projectResponse.status === 404) redirect('/404');
  if (!meResponse.ok || !projectResponse.ok || !membersResponse.ok) redirect('/403');

  const me = await fetchJson<{ userId: string; displayName: string; email: string; isAdmin: boolean }>(meResponse);
  const { data: project } = await fetchJson<{ data: Project }>(projectResponse);
  const { data: { members } } = await fetchJson<{ data: { members: ProjectMember[] } }>(membersResponse);

  const currentMember = members.find((m) => m.userId === me.userId);
  if (!currentMember) redirect('/403');

  const roleRank: Record<ProjectMemberRole, number> = {
    viewer: 0, editor: 1, owner: 2,
  };

  if (roleRank[currentMember.role] < roleRank[minRole]) redirect('/403');

  return {
    project,
    members,
    currentUserId: me.userId,
    currentUserRole: currentMember.role,
    isAdmin: me.isAdmin ?? false,
  };
}
