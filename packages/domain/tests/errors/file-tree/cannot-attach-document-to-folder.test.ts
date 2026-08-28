import { CannotAttachDocumentToFolderError } from '../../../src/errors/file-tree/cannot-attach-document-to-folder';
import { DomainError } from '../../../src/errors/domain-error';

describe('CannotAttachDocumentToFolderError', () => {
  it('names the folder node that was targeted', () => {
    const error = new CannotAttachDocumentToFolderError('node-42');

    expect(error.name).toBe('CannotAttachDocumentToFolderError');
    expect(error.message).toBe('Cannot attach a document to folder FileNode: node-42');
  });

  it('is a domain error that survives instanceof checks', () => {
    const error = new CannotAttachDocumentToFolderError('node-42');

    expect(error).toBeInstanceOf(CannotAttachDocumentToFolderError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });
});
