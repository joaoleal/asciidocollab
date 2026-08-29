/**
 * A per-provider "where do I get this?" link shown under the Access token field in the git
 * connect/initialize/import dialogs. The remote URL and token are the two things a person has to
 * supply by hand, and the token is the one they most often don't know how to create — so this points
 * straight at the selected provider's official page for generating the exact credential this form
 * asks for. Keyed off the same `provider` the radio group already drives, so it follows the
 * selection with no extra state.
 */
import { ExternalLink } from 'lucide-react';
import type { GitProvider } from '@asciidocollab/shared';

interface ProviderTokenDoc {
  /** The provider's official page for creating the credential (a PAT, or a Bitbucket API token). */
  href: string;
  /** The link's own words — "{Provider}'s guide", so the sentence reads "Read GitHub's guide". */
  label: string;
}

/**
 * Each provider's current, official documentation for creating the access token this form needs.
 * Verified live (August 2026):
 *  - GitHub   → personal access tokens (fine-grained or classic).
 *  - GitLab   → personal access tokens (needs the read_repository + write_repository scopes).
 *  - Bitbucket→ API tokens. Atlassian retired App passwords, and the old create-an-app-password page
 *               now redirects here, so this points at the API-token guide rather than that dead page.
 */
const PROVIDER_TOKEN_DOCS: Record<GitProvider, ProviderTokenDoc> = {
  github: {
    href: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    label: "GitHub's guide",
  },
  gitlab: {
    href: 'https://docs.gitlab.com/user/profile/personal_access_tokens/',
    label: "GitLab's guide",
  },
  bitbucket: {
    href: 'https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/',
    label: "Bitbucket's guide",
  },
};

/** Props for {@link TokenDocLink}. */
export interface TokenDocLinkProperties {
  /** The currently selected provider, whose token guide the link points to. */
  provider: GitProvider;
}

/**
 * The helper line under the Access token input. Opens the provider's guide in a new tab — the visible
 * external-link glyph plus a screen-reader-only "opens in a new tab" spell that out, and
 * `rel="noopener noreferrer"` keeps the opened page from reaching back through `window.opener`.
 */
export function TokenDocLink({ provider }: TokenDocLinkProperties) {
  const { href, label } = PROVIDER_TOKEN_DOCS[provider];
  return (
    <p className="text-xs text-muted-foreground">
      Need a token?{' '}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        Read {label}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </p>
  );
}
