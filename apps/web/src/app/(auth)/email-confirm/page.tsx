import Link from "next/link";
import { redirect } from "next/navigation";
import { API_BASE_URL } from '@/lib/api/base-url';

interface EmailConfirmPageProperties {
  searchParams: Promise<{ token?: string }>;
}

/** Server component that handles email confirmation tokens and redirects on success. */
export default async function EmailConfirmPage({ searchParams }: EmailConfirmPageProperties) {
  const parameters = await searchParams;
  const token = parameters.token;

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-destructive">
          This confirmation link is invalid or has expired.
        </p>
        <Link href="/dashboard/account" className="text-sm underline">
          Back to account
        </Link>
      </div>
    );
  }

  let errorMessage: string | null = null;

  try {
    const response = await fetch(`${API_BASE_URL}/auth/email/confirm?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      errorMessage = data.error?.message ?? 'This confirmation link is invalid or has expired.';
    }
  } catch {
    errorMessage = 'Something went wrong. Please try again or request a new confirmation link.';
  }

  if (errorMessage) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-destructive">{errorMessage}</p>
        <Link href="/dashboard/account" className="text-sm underline">
          Back to account
        </Link>
      </div>
    );
  }

  redirect('/dashboard/account?confirmed=email');
}
