import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { API_BASE_URL } from '@/lib/api/base-url';

/**
 * Next.js proxy (middleware) that enforces authentication and email verification
 * on dashboard routes by consulting the API's /auth/session-status endpoint.
 *
 * @param request - Incoming Next.js request.
 * @returns A redirect or pass-through response.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const cookieHeader = request.headers.get("cookie") ?? "";

  try {
    const response = await fetch(`${API_BASE_URL}/auth/session-status`, {
      headers: { Cookie: cookieHeader },
      cache: "no-store",
    });

    if (!response.ok) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      loginUrl.searchParams.set("reason", "unauthenticated");
      return NextResponse.redirect(loginUrl);
    }

    const session = await response.json();
    const authenticated: boolean = Boolean(session?.authenticated);
    const emailVerified: boolean = Boolean(session?.emailVerified);

    if (!authenticated) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      loginUrl.searchParams.set("reason", "unauthenticated");
      return NextResponse.redirect(loginUrl);
    }

    if (!emailVerified) {
      return NextResponse.redirect(new URL("/verify-email-required", request.url));
    }

    return NextResponse.next();
  } catch {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("reason", "unauthenticated");
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
