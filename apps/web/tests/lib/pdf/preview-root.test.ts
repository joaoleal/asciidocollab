import { isOpenFileOutsideMainTree, resolvePreviewRoot } from '@/lib/pdf/preview-root';

const read = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('isOpenFileOutsideMainTree', () => {
  it('is false when no main document is configured (open file is its own document)', () => {
    expect(isOpenFileOutsideMainTree(undefined, 'open.adoc', () => null)).toBe(false);
  });

  it('is false when the open file is unresolved', () => {
    expect(isOpenFileOutsideMainTree('main.adoc', undefined, () => null)).toBe(false);
  });

  it('is false when the open file IS the main document', () => {
    expect(isOpenFileOutsideMainTree('main.adoc', 'main.adoc', () => null)).toBe(false);
  });

  it('is false when the open file is included by the main document', () => {
    const files = {
      'main.adoc': '= Title\n\ninclude::chapter.adoc[]\n',
      'chapter.adoc': '== Chapter\n',
    };
    expect(isOpenFileOutsideMainTree('main.adoc', 'chapter.adoc', read(files))).toBe(false);
  });

  it('is false when the main document content is not yet loaded (cannot assemble; must not go standalone)', () => {
    // Regression (collab main-file change): the project main switched to a file this client has not
    // fetched, so its content is unavailable. Reachability cannot be assembled — the open child must
    // stay rooted at the main (keeping its inherited attribute scope), not flip to a standalone preview.
    const files = { 'child.adoc': '= Child\n\nProduct is {productName}.\n' }; // alt.adoc (the main) absent
    expect(isOpenFileOutsideMainTree('alt.adoc', 'child.adoc', read(files))).toBe(false);
  });

  it('is true when a main document is configured but the open file is unreachable from it', () => {
    const files = {
      'main.adoc': '= Title\n\ninclude::chapter.adoc[]\n',
      'chapter.adoc': '== Chapter\n',
      'orphan.adoc': '= Orphan\n',
    };
    expect(isOpenFileOutsideMainTree('main.adoc', 'orphan.adoc', read(files))).toBe(true);
  });
});

describe('resolvePreviewRoot', () => {
  it('roots at the open file (main path null) when it is outside the main tree', () => {
    expect(
      resolvePreviewRoot({
        outsideMainTree: true,
        mainPath: 'main.adoc',
        mainRootFileId: 'id-main',
        openFileId: 'id-open',
      }),
    ).toEqual({ mainPath: null, rootFileId: 'id-open' });
  });

  it('mirrors the main root when the open file is inside the main tree', () => {
    expect(
      resolvePreviewRoot({
        outsideMainTree: false,
        mainPath: 'main.adoc',
        mainRootFileId: 'id-main',
        openFileId: 'id-open',
      }),
    ).toEqual({ mainPath: 'main.adoc', rootFileId: 'id-main' });
  });

  it('carries a null main path through unchanged when inside the tree with no main configured', () => {
    expect(
      resolvePreviewRoot({
        outsideMainTree: false,
        mainPath: null,
        mainRootFileId: 'id-open',
        openFileId: 'id-open',
      }),
    ).toEqual({ mainPath: null, rootFileId: 'id-open' });
  });
});
