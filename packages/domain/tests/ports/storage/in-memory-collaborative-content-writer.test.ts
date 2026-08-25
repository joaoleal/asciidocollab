import { InMemoryCollaborativeContentWriter } from './in-memory-collaborative-content-writer';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';

const projectId = ProjectId.create('880e8400-e29b-41d4-a716-446655440004');
const otherProjectId = ProjectId.create('990e8400-e29b-41d4-a716-446655440005');
const documentId = YjsStateId.create('cc0e8400-e29b-41d4-a716-446655440008');
const otherDocumentId = YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440009');

describe('InMemoryCollaborativeContentWriter', () => {
  let writer: InMemoryCollaborativeContentWriter;

  beforeEach(() => {
    writer = new InMemoryCollaborativeContentWriter();
  });

  it('stores the target content, readable back via contentFor', async () => {
    const result = await writer.replaceContent(projectId, documentId, 'hello world');

    expect(result).toEqual({ success: true, value: undefined });
    expect(writer.contentFor(projectId, documentId)).toBe('hello world');
  });

  it('overwrites on a second replaceContent for the same key (full replace, not append)', async () => {
    await writer.replaceContent(projectId, documentId, 'first content');
    await writer.replaceContent(projectId, documentId, 'second content');

    expect(writer.contentFor(projectId, documentId)).toBe('second content');
  });

  it('isolates different (projectId, yjsStateId) keys', async () => {
    await writer.replaceContent(projectId, documentId, 'content A');
    await writer.replaceContent(projectId, otherDocumentId, 'content B');
    await writer.replaceContent(otherProjectId, documentId, 'content C');

    expect(writer.contentFor(projectId, documentId)).toBe('content A');
    expect(writer.contentFor(projectId, otherDocumentId)).toBe('content B');
    expect(writer.contentFor(otherProjectId, documentId)).toBe('content C');
  });

  it('contentFor returns undefined for a key that was never written', () => {
    expect(writer.contentFor(projectId, documentId)).toBeUndefined();
  });

  it('a forced failure returns Result.err and does not mutate the store', async () => {
    const failure = new Error('collaboration server unreachable');
    writer.failNext(failure);

    const result = await writer.replaceContent(projectId, documentId, 'should not land');

    expect(result).toEqual({ success: false, error: failure });
    expect(writer.contentFor(projectId, documentId)).toBeUndefined();
  });

  it('only fails the next call — the one after it succeeds normally', async () => {
    writer.failNext(new Error('one-shot failure'));
    await writer.replaceContent(projectId, documentId, 'ignored');

    const result = await writer.replaceContent(projectId, documentId, 'landed');

    expect(result).toEqual({ success: true, value: undefined });
    expect(writer.contentFor(projectId, documentId)).toBe('landed');
  });
});
