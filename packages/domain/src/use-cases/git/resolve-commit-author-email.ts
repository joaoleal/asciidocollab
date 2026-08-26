import type { User } from '../../entities/user';
import type { EditorPreferences } from '../../entities/editor-preferences';

/**
 * Fixed noreply domain a privacy-preserving commit email is minted under. Not a real, reachable
 * mailbox — `.invalid` is the same reserved TLD the platform's own service commit identity
 * (`SERVICE_COMMIT_IDENTITY` in the git worker) already uses for exactly this reason: a commit
 * author address that must never be a delivery target.
 */
const PRIVATE_COMMIT_EMAIL_DOMAIN = 'users.noreply.asciidocollab.invalid';

/**
 * Resolves the email address to record as a git commit's author.
 *
 * By default this is the user's real account email. When the user's editor preferences opt into a
 * privacy-preserving commit email ({@link EditorPreferences.privateCommitEmail}), a deterministic
 * per-user address is used instead: `<userId>@users.noreply.asciidocollab.invalid`. Deriving it
 * from the user's own id (rather than, say, a random token) means it needs no extra storage and is
 * stable across commits, while still disclosing nothing about the user's real address. The author
 * NAME is unaffected either way — it is always {@link User.displayName}.
 *
 * @param user - The commit's author.
 * @param preferences - The author's editor preferences, or null when none are stored (equivalent
 *   to every preference, including the opt-in, being at its default of off).
 * @returns The email address to pass as the commit author's `email`.
 */
export function resolveCommitAuthorEmail(user: User, preferences: EditorPreferences | null): string {
  if (preferences?.privateCommitEmail) {
    return `${user.id.value}@${PRIVATE_COMMIT_EMAIL_DOMAIN}`;
  }
  return user.email.value;
}
