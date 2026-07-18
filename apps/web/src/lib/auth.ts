import { cache } from 'react';
import { cookies } from 'next/headers';
import { API_BASE_URL } from '@/lib/api/base-url';

/** Minimal session data returned by /auth/me. */
export interface SessionData {
  /** The authenticated user's ID. */
  userId: string;
}

/** Full profile data returned by /auth/me. */
export interface ProfileData {
  /** Unique identifier of the authenticated user. */
  userId: string;
  /** Display name of the authenticated user. */
  displayName: string;
  /** Email address of the authenticated user. */
  email: string;
  /** Whether the user has administrator privileges. */
  isAdmin: boolean;
  /** Whether the user has verified their email address. */
  emailVerified: boolean;
  /** DiceBear avatar style key, or null for the default. */
  avatarKey: string | null;
  /** UI theme preference: 'light', 'dark', or 'system'. */
  appTheme: string;
}

/**
 * Fetches /auth/me and parses the JSON body, forwarding the browser's session cookies.
 * Memoized with React.cache() so layout and page share a single HTTP round-trip per render.
 * For use in Next.js Server Components only.
 */
const fetchMeData = cache(async (): Promise<ProfileData | null> => {
  try {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
});

/**
 * Returns the current session by forwarding the browser's cookies to the API.
 * For use in Next.js Server Components only.
 */
export async function getSession(): Promise<SessionData | null> {
  const profile = await fetchMeData();
  if (!profile) return null;
  return { userId: profile.userId };
}

/**
 * Returns the full user profile by forwarding the browser's cookies to the API.
 * For use in Next.js Server Components only.
 */
export async function getProfile(): Promise<ProfileData | null> {
  return fetchMeData();
}
