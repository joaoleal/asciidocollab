import { CannotRemoveLastAdminError } from '../src/errors/members/cannot-remove-last-admin';
import { InvalidProjectNameError } from '../src/errors/project/invalid-project-name';
import { PermissionDeniedError } from '../src/errors/common/permission-denied';
import { CloneAlreadyInProgressError } from '../src/errors/project/clone-already-in-progress';
import { LiveContentUnavailableError } from '../src/errors/project/live-content-unavailable';
import { CloneFailedError } from '../src/errors/project/clone-failed';

describe('CannotRemoveLastAdminError', () => {
  it('uses system-level message when no context is provided', () => {
    const error = new CannotRemoveLastAdminError();
    expect(error.message).toContain('system administrator');
    expect(error.name).toBe('CannotRemoveLastAdminError');
  });

  it('uses project-scoped message when context is provided', () => {
    const error = new CannotRemoveLastAdminError('project-abc');
    expect(error.message).toContain('project-abc');
    expect(error.name).toBe('CannotRemoveLastAdminError');
  });
});

describe('InvalidProjectNameError', () => {
  it('uses the default "Invalid project name" message when none is provided', () => {
    const error = new InvalidProjectNameError();
    expect(error.message).toBe('Invalid project name');
    expect(error.name).toBe('InvalidProjectNameError');
  });

  it('uses a custom message when one is provided', () => {
    const error = new InvalidProjectNameError('Project name must not exceed 100 characters');
    expect(error.message).toBe('Project name must not exceed 100 characters');
  });
});

describe('PermissionDeniedError', () => {
  it('uses defaults and leaves optional context undefined when not provided', () => {
    const error = new PermissionDeniedError();
    expect(error.message).toBe('Permission denied');
    expect(error.name).toBe('PermissionDeniedError');
    expect(error.resourceType).toBeUndefined();
    expect(error.resourceId).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it('stores the optional resource context when provided', () => {
    const error = new PermissionDeniedError('Nope', 'FileNode', 'file-1', 'role:viewer');
    expect(error.message).toBe('Nope');
    expect(error.resourceType).toBe('FileNode');
    expect(error.resourceId).toBe('file-1');
    expect(error.reason).toBe('role:viewer');
  });
});

describe('CloneAlreadyInProgressError', () => {
  it('explains that the caller already has a clone running', () => {
    const error = new CloneAlreadyInProgressError();
    expect(error.name).toBe('CloneAlreadyInProgressError');
    expect(error.message).toBe('A clone is already running for this user');
  });
});

describe('LiveContentUnavailableError', () => {
  it('names the project-relative path of the document that could not be read', () => {
    const error = new LiveContentUnavailableError('/chapters/intro.adoc');
    expect(error.name).toBe('LiveContentUnavailableError');
    expect(error.path).toBe('/chapters/intro.adoc');
    expect(error.message).toContain('/chapters/intro.adoc');
  });
});

describe('CloneFailedError', () => {
  it('keeps the underlying failure reachable as the error cause', () => {
    const underlying = new Error('disk full');
    const error = new CloneFailedError(underlying);
    expect(error.name).toBe('CloneFailedError');
    expect(error.cause).toBe(underlying);
  });

  it('does not put the underlying failure into the message, which reaches the caller', () => {
    const error = new CloneFailedError(new Error('/srv/storage/projects/abc: EACCES'));
    expect(error.message).toBe('The clone could not be completed');
  });
});
