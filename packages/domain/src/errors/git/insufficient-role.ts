import { DomainError } from '../domain-error';

/**
 * Raised when the acting user's project role does not meet the minimum role a git action requires
 * (the VIEWER/EDITOR/OWNER authorization matrix — see `requireGitRole`). Also raised for a caller
 * with no membership at all, since that is simply a role below VIEWER. Carries only the required
 * tier — never anything about the project or the actor's actual role (Security Constitution).
 * Maps to the `insufficient_role` wire error code.
 */
export class InsufficientRoleError extends DomainError {
  readonly name = 'InsufficientRoleError';

  /**
   * @param requiredRole - The minimum role the action required.
   */
  constructor(public readonly requiredRole: 'viewer' | 'editor' | 'owner') {
    super(`This action requires the ${requiredRole} role or higher`);
  }
}
