/**
 * @file Names a downloadable artifact after its PROJECT: `<project-slug>-<YYYY-MM-DD>.<extension>`.
 *
 * Every export — PDF, single-file HTML, zip — is named after the PROJECT, not after whichever file
 * happened to be open when the button was pressed. An export always renders the whole document from
 * the configured main file, so naming it after the open file described something that was never what
 * came out; and the open file changes minute to minute, which made the same export land under a
 * different name each time. The project name is the one label the author already uses for the thing.
 *
 * The date is part of the name because exports accumulate in a downloads folder and are re-exported
 * often: without it, every export of a project overwrites (or, worse, silently gets suffixed by the
 * browser as `(1)`, `(2)`) and the author cannot tell which copy is current.
 *
 * It lives in `shared` rather than in the web app because the API names the project source archive by
 * the same convention (`GET /projects/:id/download`). Two copies of a sanitiser drift, and the one the
 * user notices is whichever disagrees — so this is the single tested decision both sides call.
 *
 * Pure and dependency-free: no React, no export pipeline, no clock read of its own.
 */

/** The artifacts an export can produce, as their file extensions (no leading dot). */
export type ExportExtension = 'pdf' | 'html' | 'zip';

/**
 * The slug used when a project name yields no usable characters at all.
 *
 * A project can legitimately be named in a script that NFD decomposition cannot reduce to ASCII
 * (Cyrillic, Chinese, Japanese, Korean, emoji), or in nothing but punctuation — and a project may have
 * no name yet at all. All of those would otherwise produce an empty stem and a dot-leading file name
 * (`.pdf`), which is a hidden file on Unix and rejected outright by some download handlers. A stable,
 * boring fallback keeps the result a real file; the date still distinguishes successive exports.
 */
export const FALLBACK_SLUG = 'project';

/**
 * Longest slug kept, in characters.
 *
 * Not a filesystem limit but a usability one: the whole name has to stay comfortably inside the
 * strictest common budget (255 BYTES per component on ext4/APFS, and ~260 chars for a full path on
 * Windows) once the date, the extension, and the download folder's own path are added — and a
 * 200-character file name is unusable in a file picker long before any of those limits bite. 60 is
 * generous enough that no realistic project name is cut mid-word.
 */
export const MAX_SLUG_LENGTH = 60;

/**
 * ASCII stand-ins for Latin letters that NFD cannot decompose.
 *
 * Stripping combining marks handles every accent, but a handful of Latin letters are single code points
 * with no decomposition, so the mark-stripping pass leaves them intact and the `[a-z0-9-]` filter then
 * deletes them outright. That mangles the word instead of simplifying it: `Straße` would slug to
 * `strae`, `Łódź` to `odz`, `Grøn` to `grn`. These are the conventional ASCII fallbacks (`ß` → `ss` is
 * the standard German transliteration, not a guess), which is the difference between a name a user
 * recognises and one they do not.
 *
 * Deliberately Latin-only and deliberately short: romanising other scripts is a different problem with
 * no single correct answer, and those names still land on {@link FALLBACK_SLUG}.
 */
const LATIN_FALLBACKS: ReadonlyMap<string, string> = new Map([
  ['ß', 'ss'],
  ['ø', 'o'],
  ['ł', 'l'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['þ', 'th'],
  ['ħ', 'h'],
  ['ı', 'i'],
  ['ŋ', 'n'],
  ['ſ', 's'],
]);

/**
 * Reduce a project name to a file-name-safe slug: lower case, ASCII, dash-separated.
 *
 * Accented letters are transliterated by decomposing to NFD and dropping the combining marks
 * (`é` → `e`, `ç` → `c`, `ñ` → `n`), which covers the Latin-script accents without pulling in a
 * transliteration dependency. Latin letters that carry no decomposition (`ß`, `ø`, `ł`, `æ`…) are
 * handled by {@link LATIN_FALLBACKS} instead, because dropping them mangles the word rather than
 * simplifying it. Everything non-Latin has no ASCII equivalent to fall back to, so it is dropped like
 * any other unsupported character — and a name made entirely of it lands on {@link FALLBACK_SLUG}.
 *
 * Whitespace becomes the separator; anything else outside `[a-z0-9]` is dropped rather than replaced,
 * so `Q1 (draft)` reads as `q1-draft` and not `q1--draft-`. Runs of separators then collapse to a
 * single dash and the edges are trimmed, so the result never starts, ends, or doubles up on `-`.
 *
 * @param projectName - The project's display name, exactly as the user typed it.
 * @returns A slug matching `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, or {@link FALLBACK_SLUG}.
 */
export function exportSlug(projectName: string): string {
  const reduced = projectName
    .normalize('NFD')
    // Combining marks left behind by the decomposition — this is the transliteration step.
    .replaceAll(/\p{Mark}/gu, '')
    .toLowerCase()
    // Applied AFTER lowercasing so the uppercase forms (Ø, Ł, Æ, ẞ) are covered by the same table.
    .replaceAll(new RegExp(`[${[...LATIN_FALLBACKS.keys()].join('')}]`, 'gu'), (letter) => LATIN_FALLBACKS.get(letter) ?? '')
    // Whitespace is the one character class that means "separator" rather than "unsupported".
    .replaceAll(/\s+/gu, '-')
    .replaceAll(/[^a-z0-9-]+/g, '');
  // Collapsing separator runs and trimming the edges as one split/join rather than a `-+` pass: an
  // unbounded-repetition regex over user-supplied text is a ReDoS shape (and the lint rule that
  // rejects it is right — this input comes straight from a project's name).
  const collapsed = reduced
    .split('-')
    .filter((part) => part !== '')
    .join('-');
  // The cap can land on the separator between two words; a single trailing dash is all that can
  // survive the collapse above, so one conditional trim is enough.
  const capped = collapsed.slice(0, MAX_SLUG_LENGTH);
  const slug = capped.endsWith('-') ? capped.slice(0, -1) : capped;
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** Formats a Date as a local `YYYY-MM-DD` day key (no time, no timezone shift). */
function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The file name to offer for one exported artifact.
 *
 * ISO `YYYY-MM-DD`, so the date is unambiguous in every locale and a folder of exports sorts
 * chronologically by name. It is the LOCAL calendar day (not `toISOString()`, which is UTC and would
 * label a morning export in Auckland or an evening one in Los Angeles with the wrong date).
 *
 * `today` is a parameter rather than a `new Date()` read inside the sanitiser so the whole naming rule
 * stays a pure function of its inputs and can be pinned in tests; production call sites take the
 * default and read the clock at export time.
 *
 * @param projectName - The project's display name.
 * @param extension - The artifact's extension, without a dot.
 * @param today - The date to stamp; defaults to now.
 * @returns A name of the form `project-slug-2026-07-25.pdf`.
 */
export function exportFileName(
  projectName: string,
  extension: ExportExtension,
  today: Date = new Date(),
): string {
  return `${exportSlug(projectName)}-${localDayKey(today)}.${extension}`;
}
