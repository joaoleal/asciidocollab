/**
 * The `git` attribute pattern (`filter=lfs`) that marks a path as tracked by Large File Storage. A
 * pointer under such a path is a small text stub `git` checked out in place of the real object
 * bytes, until something smudges it back into the file it stands in for.
 */
const LFS_FILTER_ATTRIBUTE_PATTERN = /(?:^|\s)filter=lfs(?:\s|$)/m;

/**
 * Reports whether a `.gitattributes` file's contents declare any path tracked by Large File
 * Storage (any line setting `filter=lfs`). A working tree with no such declaration has nothing for
 * `git lfs pull` to smudge, so a clone can skip invoking LFS entirely rather than requiring the
 * `git-lfs` extension to be installed for a repository that never uses it.
 *
 * A pure text check (no filesystem or `git` access) so it can be exercised without a working tree
 * or the `git-lfs` binary at all.
 *
 * @param gitattributesContent - The `.gitattributes` file's contents, or an empty string when the
 *   working tree has none.
 * @returns True if the content declares at least one `filter=lfs` attribute.
 */
export function declaresLfsFilter(gitattributesContent: string): boolean {
  return LFS_FILTER_ATTRIBUTE_PATTERN.test(gitattributesContent);
}

/**
 * The exact prefix an LFS pointer file's first line always carries. Not currently consulted by
 * the clone path (a `.gitattributes` declaration alone decides whether to invoke LFS — see
 * {@link declaresLfsFilter}), but recognizing an individual pointer's shape is kept as its own
 * pure check since a future caller may need to tell a genuinely small text file apart from an
 * unsmudged pointer standing in for a large one.
 */
const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';

/**
 * Reports whether `content` is (the start of) an unsmudged LFS pointer file rather than real
 * object bytes.
 *
 * @param content - A candidate file's bytes.
 * @returns True if `content` begins with the LFS pointer signature.
 */
export function isUnsmudgedLfsPointer(content: Buffer): boolean {
  return content.subarray(0, LFS_POINTER_SIGNATURE.length).toString('utf8') === LFS_POINTER_SIGNATURE;
}
