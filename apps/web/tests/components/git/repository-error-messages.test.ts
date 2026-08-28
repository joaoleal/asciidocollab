import {
  describeConnectFailure,
  describeDisconnectFailure,
  describeInitializeStartFailure,
  describeOAuthStartFailure,
  describeOperationFailure,
  describeRotateFailure,
} from '@/components/git/repository-error-messages';
import { ApiError } from '@/lib/api/transport';

/** Builds a refused-request error carrying the backend's typed code. */
function apiError(code: string): ApiError {
  return new ApiError(400, code, 'server prose that must not be shown');
}

describe('describeOperationFailure', () => {
  it('advises checking the remote URL when the repository could not be reached', () => {
    expect(describeOperationFailure('repository_unreachable')).toBe(
      'The repository could not be reached. Check the remote URL and try again.',
    );
  });

  it('advises checking the token when authentication was rejected', () => {
    expect(describeOperationFailure('authentication_failed')).toBe('The token was rejected. Check it and try again.');
  });

  it('falls back to generic wording for an unrecognised error code', () => {
    expect(describeOperationFailure('something_new')).toBe('The initialize failed.');
  });

  it('falls back to generic wording when no error code was reported', () => {
    expect(describeOperationFailure(null)).toBe('The initialize failed.');
  });
});

describe('describeConnectFailure', () => {
  it('asks for owner access when the role is insufficient', () => {
    expect(describeConnectFailure(apiError('insufficient_role'))).toBe(
      'You need owner access to connect a repository.',
    );
  });

  it('reports that a repository is already connected', () => {
    expect(describeConnectFailure(apiError('already_connected'))).toBe(
      'This project already has a connected repository.',
    );
  });

  it('advises checking the remote URL when the repository is unreachable', () => {
    expect(describeConnectFailure(apiError('repository_unreachable'))).toBe(
      'The repository could not be reached. Check the remote URL and try again.',
    );
  });

  it('advises checking the token when authentication failed', () => {
    expect(describeConnectFailure(apiError('authentication_failed'))).toBe(
      'The token was rejected. Check it and try again.',
    );
  });

  it('advises retrying shortly when the git service is unavailable', () => {
    expect(describeConnectFailure(apiError('git_worker_unavailable'))).toBe(
      'The git service is unavailable. Try again shortly.',
    );
  });

  it('falls back to generic wording for an unrecognised typed code', () => {
    expect(describeConnectFailure(apiError('teapot'))).toBe("Couldn't connect the repository.");
  });

  it('falls back to generic wording for a network failure that is not an API error', () => {
    expect(describeConnectFailure(new TypeError('Failed to fetch'))).toBe("Couldn't connect the repository.");
  });
});

describe('describeOAuthStartFailure', () => {
  it('asks for owner access when the role is insufficient', () => {
    expect(describeOAuthStartFailure(apiError('insufficient_role'))).toBe(
      'You need owner access to connect a repository.',
    );
  });

  it('reports that guided connect is unavailable for the provider', () => {
    expect(describeOAuthStartFailure(apiError('oauth_not_configured'))).toBe(
      'Guided connect is not available for this provider.',
    );
  });

  it('asks for a valid remote URL when the request failed validation', () => {
    expect(describeOAuthStartFailure(apiError('validation_error'))).toBe('Enter a valid remote URL first.');
  });

  it('falls back to generic wording for an unrecognised typed code', () => {
    expect(describeOAuthStartFailure(apiError('teapot'))).toBe("Couldn't start the guided connection.");
  });

  it('falls back to generic wording for a network failure that is not an API error', () => {
    expect(describeOAuthStartFailure(new TypeError('Failed to fetch'))).toBe("Couldn't start the guided connection.");
  });
});

describe('describeInitializeStartFailure', () => {
  it('asks for owner access when the role is insufficient', () => {
    expect(describeInitializeStartFailure(apiError('insufficient_role'))).toBe(
      'You need owner access to initialize a repository.',
    );
  });

  it('reports that a repository is already connected', () => {
    expect(describeInitializeStartFailure(apiError('already_connected'))).toBe(
      'This project already has a connected repository.',
    );
  });

  it('advises retrying shortly when the git service is unavailable', () => {
    expect(describeInitializeStartFailure(apiError('git_worker_unavailable'))).toBe(
      'The git service is unavailable. Try again shortly.',
    );
  });

  it('falls back to generic wording for an unrecognised typed code', () => {
    expect(describeInitializeStartFailure(apiError('teapot'))).toBe("Couldn't start the initialize.");
  });

  it('falls back to generic wording for a network failure that is not an API error', () => {
    expect(describeInitializeStartFailure(new TypeError('Failed to fetch'))).toBe("Couldn't start the initialize.");
  });
});

describe('describeDisconnectFailure', () => {
  it('asks for owner access when the role is insufficient', () => {
    expect(describeDisconnectFailure(apiError('insufficient_role'))).toBe(
      'You need owner access to disconnect this repository.',
    );
  });

  it('reports that the project has no connected repository', () => {
    expect(describeDisconnectFailure(apiError('repository_not_connected'))).toBe(
      'This project has no connected repository.',
    );
  });

  it('falls back to generic wording for an unrecognised typed code', () => {
    expect(describeDisconnectFailure(apiError('teapot'))).toBe("Couldn't disconnect the repository.");
  });

  it('falls back to generic wording for a network failure that is not an API error', () => {
    expect(describeDisconnectFailure(new TypeError('Failed to fetch'))).toBe("Couldn't disconnect the repository.");
  });
});

describe('describeRotateFailure', () => {
  it('asks for owner access when the role is insufficient', () => {
    expect(describeRotateFailure(apiError('insufficient_role'))).toBe(
      'You need owner access to rotate this credential.',
    );
  });

  it('reports that the project has no connected repository', () => {
    expect(describeRotateFailure(apiError('repository_not_connected'))).toBe(
      'This project has no connected repository.',
    );
  });

  it('falls back to generic wording for an unrecognised typed code', () => {
    expect(describeRotateFailure(apiError('teapot'))).toBe("Couldn't rotate the credential.");
  });

  it('falls back to generic wording for a network failure that is not an API error', () => {
    expect(describeRotateFailure(new TypeError('Failed to fetch'))).toBe("Couldn't rotate the credential.");
  });
});
