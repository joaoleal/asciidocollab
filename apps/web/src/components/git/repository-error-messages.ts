/**
 * The "Git Repository" settings section's failure wording, kept in one place and keyed by the
 * backend's typed error code rather than its prose — a reworded server message never silently
 * changes which advice a form or dialog shows. Shared by the connect/initialize, rotate, and
 * disconnect dialogs.
 */
import { ApiError } from '@/lib/api/transport';

/** Human wording for a queued initialize that finished `FAILED`, keyed by its typed error code. */
const OPERATION_FAILURE_MESSAGES: Record<string, string> = {
  repository_unreachable: 'The repository could not be reached. Check the remote URL and try again.',
  authentication_failed: 'The token was rejected. Check it and try again.',
};

/** Said for a `FAILED` initialize whose error code carries no specific wording of its own. */
const GENERIC_OPERATION_FAILURE = 'The initialize failed.';

/** Turns a terminal `FAILED` initialize's typed error code into the sentence shown on the dialog. */
export function describeOperationFailure(errorCode: string | null): string {
  if (errorCode && errorCode in OPERATION_FAILURE_MESSAGES) {
    return OPERATION_FAILURE_MESSAGES[errorCode];
  }
  return GENERIC_OPERATION_FAILURE;
}

/**
 * Turns a refused `POST …/git/connect` into the sentence shown on the form, keyed by the backend's
 * typed error code rather than its prose — a reworded server message never silently changes which
 * advice is shown.
 */
export function describeConnectFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't connect the repository.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to connect a repository.';
    }
    case 'already_connected': {
      return 'This project already has a connected repository.';
    }
    case 'repository_unreachable': {
      return 'The repository could not be reached. Check the remote URL and try again.';
    }
    case 'authentication_failed': {
      return 'The token was rejected. Check it and try again.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    default: {
      return "Couldn't connect the repository.";
    }
  }
}

/** Turns a refused `POST …/git/oauth/<provider>/start` into the sentence shown on the connect form. */
export function describeOAuthStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't start the guided connection.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to connect a repository.';
    }
    case 'oauth_not_configured': {
      return 'Guided connect is not available for this provider.';
    }
    case 'validation_error': {
      return 'Enter a valid remote URL first.';
    }
    default: {
      return "Couldn't start the guided connection.";
    }
  }
}

/** Turns a refused `POST …/git/initialize` (the initial queue request itself) into a shown sentence. */
export function describeInitializeStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't start the initialize.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to initialize a repository.';
    }
    case 'already_connected': {
      return 'This project already has a connected repository.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    default: {
      return "Couldn't start the initialize.";
    }
  }
}

/** Turns a refused `POST …/git/disconnect` into the sentence shown on the confirm dialog. */
export function describeDisconnectFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't disconnect the repository.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to disconnect this repository.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return "Couldn't disconnect the repository.";
    }
  }
}

/** Turns a refused `PUT …/git/credential` into the sentence shown on the rotate form. */
export function describeRotateFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't rotate the credential.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to rotate this credential.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return "Couldn't rotate the credential.";
    }
  }
}
