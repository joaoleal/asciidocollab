import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import type { Logger } from 'pino';
import {
  InsufficientRoleError,
  GitOperationInProgressError,
  RepositoryNotConnectedError,
  EmptyCommitMessageError,
  NothingStagedError,
  LiveContentFlushFailedError,
  ValidationError,
  GitCommandFailedError,
  UnresolvedConflictsError,
  NothingToUndoError,
} from '@asciidocollab/domain';
import {
  GIT_STATUS_PATH,
  GIT_BEHIND_AHEAD_PATH,
  GIT_STAGE_PATH,
  GIT_UNSTAGE_PATH,
  GIT_COMMIT_PATH,
  GIT_BRANCHES_PATH,
  GIT_BRANCH_CREATE_PATH,
  GIT_PULL_COMPLETE_PATH,
  GIT_UNDO_PULL_PATH,
  createGitOpsRequestHandler,
  parseGitStatusBody,
  parseStageChangesBody,
  parseCommitChangesBody,
  parseCreateBranchBody,
  startInternalGitServer,
  type GitOpsHandlerDeps,
} from '../src/internal-git-server.js';

const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440003';
const ACTOR_ID = '11111111-e29b-41d4-a716-446655440111';

/** Mirrors the source's hard body cap so the boundary can be exercised. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const silentLogger = { info: () => {}, error: () => {} } as unknown as Logger;

const JSON_HEADERS = { 'content-type': 'application/json' };

type FakeRequest = PassThrough & { method: string; url: string; headers: IncomingHttpHeaders };

interface RecordedResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  headersSent: boolean;
  ended: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => RecordedResponse;
  end: (chunk?: string) => RecordedResponse;
}

function fakeRequest(method: string, url: string, headers: IncomingHttpHeaders = {}): FakeRequest {
  const request = new PassThrough() as FakeRequest;
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

function recordingResponse(headersSent = false): RecordedResponse {
  const response: RecordedResponse = {
    headersSent,
    ended: false,
    writeHead: (status, headers) => {
      response.statusCode = status;
      response.headers = headers;
      response.headersSent = true;
      return response;
    },
    end: (chunk) => {
      response.body = chunk;
      response.ended = true;
      return response;
    },
  };
  return response;
}

function fakeLogger(): { info: jest.Mock; error: jest.Mock } {
  return { info: jest.fn(), error: jest.fn() };
}

function asLogger(logger: { info: jest.Mock; error: jest.Mock }): Logger {
  return logger as unknown as Logger;
}

interface HandlerDoubles {
  getStatus: jest.Mock;
  getBehindAhead: jest.Mock;
  stage: jest.Mock;
  unstage: jest.Mock;
  commit: jest.Mock;
  getBranches: jest.Mock;
  createBranch: jest.Mock;
  completePull: jest.Mock;
  undoPull: jest.Mock;
  logger: { info: jest.Mock; error: jest.Mock };
  secret?: string;
}

function handlerDoubles(): HandlerDoubles {
  return {
    getStatus: jest.fn(async () => ({ success: true, value: { currentBranch: 'main', changes: [], syncStatus: 'up_to_date', defaultBranch: 'main', lastKnownRemoteHead: null, lastSyncAt: null } })),
    getBehindAhead: jest.fn(async () => ({ success: true, value: { behind: 0, ahead: 0 } })),
    stage: jest.fn(async () => ({ success: true, value: { staged: ['a.adoc'] } })),
    unstage: jest.fn(async () => ({ success: true, value: { staged: [] } })),
    commit: jest.fn(async () => ({ success: true, value: { commit: { hash: 'abc123', message: 'msg', authoredAt: new Date('2026-01-01T00:00:00.000Z') } } })),
    getBranches: jest.fn(async () => ({ success: true, value: { current: 'main', branches: ['main'] } })),
    createBranch: jest.fn(async () => ({ success: true, value: { branch: { name: 'feature/x' } } })),
    completePull: jest.fn(async () => ({
      success: true,
      value: { status: 'resolved', operationId: '990e8400-e29b-41d4-a716-446655440010', headCommit: 'abc123' },
    })),
    undoPull: jest.fn(async () => ({
      success: true,
      value: { operationId: '990e8400-e29b-41d4-a716-446655440011', headCommit: 'def456' },
    })),
    logger: fakeLogger(),
  };
}

function asDeps(doubles: HandlerDoubles): GitOpsHandlerDeps {
  return doubles as unknown as GitOpsHandlerDeps;
}

function startHandling(doubles: HandlerDoubles, request: FakeRequest, response: RecordedResponse): Promise<void> {
  const handler = createGitOpsRequestHandler(asDeps(doubles));
  return handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
}

async function handle(
  doubles: HandlerDoubles,
  request: FakeRequest,
  response: RecordedResponse,
  body = '',
): Promise<RecordedResponse> {
  const done = startHandling(doubles, request, response);
  request.end(body);
  await done;
  return response;
}

describe('parseGitStatusBody', () => {
  it('accepts a well-formed body', () => {
    expect(parseGitStatusBody(JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID }))).toEqual({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseGitStatusBody('{not json')).toBeNull();
  });

  it('rejects a JSON null body', () => {
    expect(parseGitStatusBody('null')).toBeNull();
  });

  it('rejects non-UUID ids', () => {
    expect(parseGitStatusBody(JSON.stringify({ projectId: '../etc', actorId: ACTOR_ID }))).toBeNull();
    expect(parseGitStatusBody(JSON.stringify({ projectId: PROJECT_ID, actorId: 'x' }))).toBeNull();
  });

  it('rejects a missing field', () => {
    expect(parseGitStatusBody(JSON.stringify({ projectId: PROJECT_ID }))).toBeNull();
  });

  it('rejects a non-string id that stringifies to a UUID', () => {
    expect(parseGitStatusBody(JSON.stringify({ projectId: [PROJECT_ID], actorId: ACTOR_ID }))).toBeNull();
  });
});

describe('parseStageChangesBody', () => {
  const valid = { projectId: PROJECT_ID, actorId: ACTOR_ID, paths: ['a.adoc', 'b.adoc'] };

  it('accepts a well-formed body', () => {
    expect(parseStageChangesBody(JSON.stringify(valid))).toEqual(valid);
  });

  it('accepts an empty paths array (the use case itself rejects an empty set)', () => {
    expect(parseStageChangesBody(JSON.stringify({ ...valid, paths: [] }))).toEqual({ ...valid, paths: [] });
  });

  it('rejects malformed JSON and a JSON null body', () => {
    expect(parseStageChangesBody('{bad')).toBeNull();
    expect(parseStageChangesBody('null')).toBeNull();
  });

  it('rejects non-UUID ids', () => {
    expect(parseStageChangesBody(JSON.stringify({ ...valid, projectId: '../etc' }))).toBeNull();
    expect(parseStageChangesBody(JSON.stringify({ ...valid, actorId: 'x' }))).toBeNull();
  });

  it('rejects a missing paths field', () => {
    const withoutPaths = { projectId: PROJECT_ID, actorId: ACTOR_ID };
    expect(parseStageChangesBody(JSON.stringify(withoutPaths))).toBeNull();
  });

  it('rejects a non-array paths and a non-string entry', () => {
    expect(parseStageChangesBody(JSON.stringify({ ...valid, paths: 'nope' }))).toBeNull();
    expect(parseStageChangesBody(JSON.stringify({ ...valid, paths: [1] }))).toBeNull();
  });
});

describe('parseCommitChangesBody', () => {
  const valid = { projectId: PROJECT_ID, actorId: ACTOR_ID, message: 'a commit message' };

  it('accepts a well-formed body', () => {
    expect(parseCommitChangesBody(JSON.stringify(valid))).toEqual(valid);
  });

  it('accepts an empty message (the use case itself rejects an empty/whitespace message)', () => {
    expect(parseCommitChangesBody(JSON.stringify({ ...valid, message: '' }))).toEqual({ ...valid, message: '' });
  });

  it('rejects malformed JSON and a JSON null body', () => {
    expect(parseCommitChangesBody('{bad')).toBeNull();
    expect(parseCommitChangesBody('null')).toBeNull();
  });

  it('rejects non-UUID ids', () => {
    expect(parseCommitChangesBody(JSON.stringify({ ...valid, projectId: '../etc' }))).toBeNull();
    expect(parseCommitChangesBody(JSON.stringify({ ...valid, actorId: 'x' }))).toBeNull();
  });

  it('rejects a missing or non-string message', () => {
    const withoutMessage = { projectId: PROJECT_ID, actorId: ACTOR_ID };
    expect(parseCommitChangesBody(JSON.stringify(withoutMessage))).toBeNull();
    expect(parseCommitChangesBody(JSON.stringify({ ...valid, message: 5 }))).toBeNull();
  });
});

describe('parseCreateBranchBody', () => {
  const valid = { projectId: PROJECT_ID, actorId: ACTOR_ID, name: 'feature/x' };

  it('accepts a well-formed body', () => {
    expect(parseCreateBranchBody(JSON.stringify(valid))).toEqual(valid);
  });

  it('accepts an empty name (the use case itself rejects an empty/whitespace name)', () => {
    expect(parseCreateBranchBody(JSON.stringify({ ...valid, name: '' }))).toEqual({ ...valid, name: '' });
  });

  it('rejects malformed JSON and a JSON null body', () => {
    expect(parseCreateBranchBody('{bad')).toBeNull();
    expect(parseCreateBranchBody('null')).toBeNull();
  });

  it('rejects non-UUID ids', () => {
    expect(parseCreateBranchBody(JSON.stringify({ ...valid, projectId: '../etc' }))).toBeNull();
    expect(parseCreateBranchBody(JSON.stringify({ ...valid, actorId: 'x' }))).toBeNull();
  });

  it('rejects a missing or non-string name', () => {
    const withoutName = { projectId: PROJECT_ID, actorId: ACTOR_ID };
    expect(parseCreateBranchBody(JSON.stringify(withoutName))).toBeNull();
    expect(parseCreateBranchBody(JSON.stringify({ ...valid, name: 5 }))).toBeNull();
  });
});

describe('createGitOpsRequestHandler', () => {
  const statusBody = JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  const stageBody = JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID, paths: ['a.adoc'] });
  const commitBody = JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID, message: 'msg' });
  const createBranchBody = JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID, name: 'feature/x' });

  it('answers status with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_STATUS_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(JSON.parse(response.body!)).toEqual({
      ok: true,
      data: { currentBranch: 'main', changes: [], syncStatus: 'up_to_date', defaultBranch: 'main', lastKnownRemoteHead: null, lastSyncAt: null },
    });
    expect(doubles.getStatus).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  });

  it('answers behind-ahead with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    doubles.getBehindAhead = jest.fn(async () => ({ success: true, value: { behind: 2, ahead: 5 } }));
    const response = await handle(doubles, fakeRequest('POST', GIT_BEHIND_AHEAD_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(JSON.parse(response.body!)).toEqual({ ok: true, data: { behind: 2, ahead: 5 } });
    expect(doubles.getBehindAhead).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  });

  it('answers 400 for behind-ahead on a malformed/non-UUID body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_BEHIND_AHEAD_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.getBehindAhead).not.toHaveBeenCalled();
  });

  it('rejects a behind-ahead request without the shared secret, same guard as the other endpoints', async () => {
    const doubles = handlerDoubles();
    doubles.secret = 'top-secret';
    const response = await handle(doubles, fakeRequest('POST', GIT_BEHIND_AHEAD_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(401);
    expect(doubles.getBehindAhead).not.toHaveBeenCalled();
  });

  it('answers {ok:false,error} for RepositoryNotConnectedError from behind-ahead', async () => {
    const doubles = handlerDoubles();
    doubles.getBehindAhead = jest.fn(async () => ({ success: false, error: new RepositoryNotConnectedError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_BEHIND_AHEAD_PATH), recordingResponse(), statusBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('answers stage with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_STAGE_PATH), recordingResponse(), stageBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ ok: true, data: { staged: ['a.adoc'] } });
    expect(doubles.stage).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, paths: ['a.adoc'] });
  });

  it('answers unstage with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_UNSTAGE_PATH), recordingResponse(), stageBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ ok: true, data: { staged: [] } });
    expect(doubles.unstage).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, paths: ['a.adoc'] });
  });

  it('answers commit with {ok:true,data} on a success Result, serializing the date as ISO-8601', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({
      ok: true,
      data: { commit: { hash: 'abc123', message: 'msg', authoredAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect(doubles.commit).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, message: 'msg' });
  });

  it('answers branches with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCHES_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ ok: true, data: { current: 'main', branches: ['main'] } });
    expect(doubles.getBranches).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  });

  it('answers 400 for branches on a malformed/non-UUID body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCHES_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(doubles.getBranches).not.toHaveBeenCalled();
  });

  it('answers branch-create with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCH_CREATE_PATH), recordingResponse(), createBranchBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ ok: true, data: { branch: { name: 'feature/x' } } });
    expect(doubles.createBranch).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, name: 'feature/x' });
  });

  it('answers 400 for branch-create on a malformed/non-UUID body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCH_CREATE_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(doubles.createBranch).not.toHaveBeenCalled();
  });

  it('answers {ok:false,error} for ValidationError from branch-create', async () => {
    const doubles = handlerDoubles();
    doubles.createBranch = jest.fn(async () => ({ success: false, error: new ValidationError('Branch name must not be empty') }));
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCH_CREATE_PATH), recordingResponse(), createBranchBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'ValidationError' });
  });

  it('answers pull-complete with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_PULL_COMPLETE_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({
      ok: true,
      data: { status: 'resolved', operationId: '990e8400-e29b-41d4-a716-446655440010', headCommit: 'abc123' },
    });
    expect(doubles.completePull).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  });

  it('answers 400 for pull-complete on a malformed/non-UUID body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_PULL_COMPLETE_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(doubles.completePull).not.toHaveBeenCalled();
  });

  it('answers {ok:false,error} for UnresolvedConflictsError from pull-complete', async () => {
    const doubles = handlerDoubles();
    doubles.completePull = jest.fn(async () => ({ success: false, error: new UnresolvedConflictsError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_PULL_COMPLETE_PATH), recordingResponse(), statusBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'UnresolvedConflictsError' });
  });

  it('answers undo-pull with {ok:true,data} on a success Result', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_UNDO_PULL_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({
      ok: true,
      data: { operationId: '990e8400-e29b-41d4-a716-446655440011', headCommit: 'def456' },
    });
    expect(doubles.undoPull).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });
  });

  it('answers 400 for undo-pull on a malformed/non-UUID body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_UNDO_PULL_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(doubles.undoPull).not.toHaveBeenCalled();
  });

  it('answers {ok:false,error} for NothingToUndoError from undo-pull', async () => {
    const doubles = handlerDoubles();
    doubles.undoPull = jest.fn(async () => ({ success: false, error: new NothingToUndoError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_UNDO_PULL_PATH), recordingResponse(), statusBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'NothingToUndoError' });
  });

  it('answers {ok:false,error} for RepositoryNotConnectedError from branches', async () => {
    const doubles = handlerDoubles();
    doubles.getBranches = jest.fn(async () => ({ success: false, error: new RepositoryNotConnectedError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_BRANCHES_PATH), recordingResponse(), statusBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('answers {ok:false,error} for InsufficientRoleError', async () => {
    const doubles = handlerDoubles();
    doubles.commit = jest.fn(async () => ({ success: false, error: new InsufficientRoleError('editor') }));
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'InsufficientRoleError' });
  });

  it('answers {ok:false,error} for GitOperationInProgressError', async () => {
    const doubles = handlerDoubles();
    doubles.stage = jest.fn(async () => ({ success: false, error: new GitOperationInProgressError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_STAGE_PATH), recordingResponse(), stageBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'GitOperationInProgressError' });
  });

  it('answers {ok:false,error} for RepositoryNotConnectedError', async () => {
    const doubles = handlerDoubles();
    doubles.getStatus = jest.fn(async () => ({ success: false, error: new RepositoryNotConnectedError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_STATUS_PATH), recordingResponse(), statusBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'RepositoryNotConnectedError' });
  });

  it('answers {ok:false,error} for EmptyCommitMessageError', async () => {
    const doubles = handlerDoubles();
    doubles.commit = jest.fn(async () => ({ success: false, error: new EmptyCommitMessageError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'EmptyCommitMessageError' });
  });

  it('answers {ok:false,error} for NothingStagedError', async () => {
    const doubles = handlerDoubles();
    doubles.commit = jest.fn(async () => ({ success: false, error: new NothingStagedError() }));
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'NothingStagedError' });
  });

  it('answers {ok:false,error} for ValidationError', async () => {
    const doubles = handlerDoubles();
    doubles.stage = jest.fn(async () => ({ success: false, error: new ValidationError('no files specified') }));
    const response = await handle(doubles, fakeRequest('POST', GIT_STAGE_PATH), recordingResponse(), stageBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'ValidationError' });
  });

  it('answers {ok:false,error} for GitCommandFailedError, without leaking its raw message', async () => {
    const doubles = handlerDoubles();
    doubles.commit = jest.fn(async () => ({ success: false, error: new GitCommandFailedError('rm -rf /secret/path failed') }));
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    const parsed = JSON.parse(response.body!);
    expect(parsed).toEqual({ ok: false, error: 'GitCommandFailedError' });
    expect(response.body).not.toContain('secret/path');
  });

  it('answers {ok:false,error,path} for LiveContentFlushFailedError, carrying the offending path', async () => {
    const doubles = handlerDoubles();
    doubles.commit = jest.fn(async () => ({ success: false, error: new LiveContentFlushFailedError('chapters/intro.adoc') }));
    const response = await handle(doubles, fakeRequest('POST', GIT_COMMIT_PATH), recordingResponse(), commitBody);
    expect(JSON.parse(response.body!)).toEqual({ ok: false, error: 'LiveContentFlushFailedError', path: 'chapters/intro.adoc' });
  });

  it('answers 400 with a JSON error object on an invalid body, without calling the op fn', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', GIT_STATUS_PATH), recordingResponse(), '{bad');
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(response.body).toBe('{"error":"Invalid body"}');
    expect(doubles.getStatus).not.toHaveBeenCalled();
  });

  it('answers 404 with no body for a wrong method and an unknown path', async () => {
    const doubles = handlerDoubles();
    const wrongMethod = await handle(doubles, fakeRequest('GET', GIT_STATUS_PATH), recordingResponse(), statusBody);
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.headers).toBeUndefined();
    expect(wrongMethod.body).toBeUndefined();

    const unknownPath = await handle(doubles, fakeRequest('POST', '/internal/git/nope'), recordingResponse(), statusBody);
    expect(unknownPath.statusCode).toBe(404);
    expect(doubles.getStatus).not.toHaveBeenCalled();
  });

  it('matches the route with a query string appended', async () => {
    const doubles = handlerDoubles();
    const response = await handle(doubles, fakeRequest('POST', `${GIT_STATUS_PATH}?revision=7`), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(200);
  });

  it('logs the cause and answers a JSON 500 when the op fn throws unexpectedly', async () => {
    const doubles = handlerDoubles();
    const boom = new Error('boom');
    doubles.getStatus = jest.fn(async () => {
      throw boom;
    });
    const response = await handle(doubles, fakeRequest('POST', GIT_STATUS_PATH), recordingResponse(), statusBody);
    expect(response.statusCode).toBe(500);
    expect(response.headers).toEqual(JSON_HEADERS);
    expect(JSON.parse(response.body!)).toEqual({ error: 'status failed' });
    expect(doubles.logger.error).toHaveBeenCalledWith({ err: boom }, 'status failed');
  });

  it('never echoes the configured secret in any response body', async () => {
    const doubles = handlerDoubles();
    doubles.secret = 'super-secret-value';
    const response = await handle(
      doubles,
      fakeRequest('POST', GIT_STATUS_PATH, { 'x-git-worker-internal-secret': 'wrong' }),
      recordingResponse(),
      statusBody,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body ?? '').not.toContain('super-secret-value');
  });

  it('rejects a secret of a different length and accepts the exact one', async () => {
    const shortSecret = handlerDoubles();
    shortSecret.secret = 'top-secret';
    const rejected = await handle(
      shortSecret,
      fakeRequest('POST', GIT_STATUS_PATH, { 'x-git-worker-internal-secret': 'short' }),
      recordingResponse(),
      statusBody,
    );
    expect(rejected.statusCode).toBe(401);
    expect(shortSecret.getStatus).not.toHaveBeenCalled();

    const exact = handlerDoubles();
    exact.secret = 'top-secret';
    const accepted = await handle(
      exact,
      fakeRequest('POST', GIT_STATUS_PATH, { 'x-git-worker-internal-secret': 'top-secret' }),
      recordingResponse(),
      statusBody,
    );
    expect(accepted.statusCode).toBe(200);
  });

  it('rejects a same-length but wrong secret (constant-time compare still denies)', async () => {
    const doubles = handlerDoubles();
    doubles.secret = 'top-secret';
    const response = await handle(
      doubles,
      fakeRequest('POST', GIT_STATUS_PATH, { 'x-git-worker-internal-secret': 'TOP-SECRET' }),
      recordingResponse(),
      statusBody,
    );
    expect(response.statusCode).toBe(401);
  });

  it('answers 413 and closes the connection once the body passes the cap', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', GIT_STATUS_PATH);
    const response = recordingResponse();
    const done = startHandling(doubles, request, response);
    request.write(Buffer.alloc(MAX_BODY_BYTES + 1, 120));
    await done;
    expect(response.statusCode).toBe(413);
    expect(response.headers).toEqual({ connection: 'close' });
    expect(request.listenerCount('data')).toBe(0);
    expect(request.isPaused()).toBe(true);
    request.destroy();
  });

  it('does not write a second time when the response head is already out', async () => {
    const doubles = handlerDoubles();
    const request = fakeRequest('POST', GIT_STATUS_PATH);
    const response = recordingResponse(true);
    const done = startHandling(doubles, request, response);
    request.destroy(new Error('socket reset'));
    await done;
    expect(response.statusCode).toBeUndefined();
    expect(response.ended).toBe(false);
  });
});

describe('internal git server (HTTP)', () => {
  let server: Server;
  let baseUrl: string;

  async function waitListening(target: Server): Promise<void> {
    if (target.listening) return;
    await new Promise<void>((resolve) => target.once('listening', () => resolve()));
  }

  async function startWith(options: { secret?: string } = {}): Promise<void> {
    const doubles = handlerDoubles();
    server = await startInternalGitServer({
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger,
      getStatus: doubles.getStatus,
      getBehindAhead: doubles.getBehindAhead,
      stage: doubles.stage,
      unstage: doubles.unstage,
      commit: doubles.commit,
      getBranches: doubles.getBranches,
      createBranch: doubles.createBranch,
      completePull: doubles.completePull,
      undoPull: doubles.undoPull,
      ...options,
    });
    await waitListening(server);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 404 for the wrong method or path', async () => {
    await startWith();
    const wrongMethod = await fetch(`${baseUrl}${GIT_STATUS_PATH}`, { method: 'GET' });
    expect(wrongMethod.status).toBe(404);
    const wrongPath = await fetch(`${baseUrl}/nope`, { method: 'POST', body: '{}' });
    expect(wrongPath.status).toBe(404);
  });

  it('answers a real request end to end', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${GIT_STATUS_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { currentBranch: 'main', changes: [], syncStatus: 'up_to_date', defaultBranch: 'main', lastKnownRemoteHead: null, lastSyncAt: null },
    });
  });

  it('answers a real behind-ahead request end to end', async () => {
    await startWith();
    const response = await fetch(`${baseUrl}${GIT_BEHIND_AHEAD_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ projectId: PROJECT_ID, actorId: ACTOR_ID }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { behind: 0, ahead: 0 } });
  });

  it('rejects (does not crash) when the port is already in use', async () => {
    await startWith();
    const inUsePort = (server.address() as AddressInfo).port;
    const doubles = handlerDoubles();
    await expect(
      startInternalGitServer({
        host: '127.0.0.1',
        port: inUsePort,
        logger: silentLogger,
        getStatus: doubles.getStatus,
        getBehindAhead: doubles.getBehindAhead,
        stage: doubles.stage,
        unstage: doubles.unstage,
        commit: doubles.commit,
        getBranches: doubles.getBranches,
        createBranch: doubles.createBranch,
        completePull: doubles.completePull,
        undoPull: doubles.undoPull,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('startInternalGitServer wiring', () => {
  let listening: Server | undefined;

  afterEach(async () => {
    const running = listening;
    listening = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  it('logs the bind details and keeps exactly one late-error listener', async () => {
    const logger = fakeLogger();
    const doubles = handlerDoubles();
    const server = await startInternalGitServer({
      host: '127.0.0.1',
      port: 0,
      logger: asLogger(logger),
      getStatus: doubles.getStatus,
      getBehindAhead: doubles.getBehindAhead,
      stage: doubles.stage,
      unstage: doubles.unstage,
      commit: doubles.commit,
      getBranches: doubles.getBranches,
      createBranch: doubles.createBranch,
      completePull: doubles.completePull,
      undoPull: doubles.undoPull,
    });
    listening = server;
    expect(logger.info).toHaveBeenCalledWith(
      { port: 0, host: '127.0.0.1', tls: false },
      'Git-worker internal RPC server listening',
    );
    expect(server.listenerCount('error')).toBe(1);
    const late = new Error('late failure');
    server.emit('error', late);
    expect(logger.error).toHaveBeenCalledWith({ err: late }, 'Git-worker internal RPC server error');
  });
});
