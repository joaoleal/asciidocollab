/**
 * The naming rule for every exported artifact. It is pure and it decides what lands in the user's
 * downloads folder, so the whole surface is pinned here: the transliteration, the separator handling,
 * the length cap, the fallback, and the date stamp.
 */
import {
  exportFileName,
  exportSlug,
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
} from '../src/export-naming';

/** A fixed local date, so every name assertion is independent of when the suite runs. */
const TODAY = new Date(2026, 6, 25); // 2026-07-25, local time

describe('exportSlug — the basics', () => {
  it('lower-cases the project name', () => {
    expect(exportSlug('Annual Report')).toBe('annual-report');
  });

  it('replaces spaces with dashes', () => {
    expect(exportSlug('my great project')).toBe('my-great-project');
  });

  it('keeps digits and existing dashes', () => {
    expect(exportSlug('Release 2026-Q3')).toBe('release-2026-q3');
  });

  it('leaves an already-clean slug untouched', () => {
    expect(exportSlug('user-guide')).toBe('user-guide');
  });
});

describe('exportSlug — transliteration', () => {
  it('reduces accented Latin letters to their ASCII base', () => {
    expect(exportSlug('Manuel Café')).toBe('manuel-cafe');
    expect(exportSlug('Ação')).toBe('acao');
    expect(exportSlug('Über Grüße')).toBe('uber-grusse'); // ß → ss via the Latin fallback table
    expect(exportSlug('Mañana Niño')).toBe('manana-nino');
  });

  it('handles a name that is entirely accented letters', () => {
    expect(exportSlug('Ééé')).toBe('eee');
  });

  it('handles pre-composed and pre-decomposed spellings identically', () => {
    // "é" as one code point vs. "e" + combining acute: the same project name, typed on two keyboards.
    expect(exportSlug('résumé')).toBe(exportSlug('résumé'));
    expect(exportSlug('résumé')).toBe('resume');
  });

  it('substitutes Latin letters that carry no decomposition instead of dropping them', () => {
    // ø/ł/ß are single code points, not base+mark, so NFD leaves them intact and the ASCII filter would
    // delete them — turning "Straße" into "strae" and "Łódź" into "odz", which is a different word.
    // The fallback table gives each a conventional ASCII stand-in.
    expect(exportSlug('Grøn Straße Łódź')).toBe('gron-strasse-lodz');
    expect(exportSlug('Æther Œuvre')).toBe('aether-oeuvre');
    expect(exportSlug('Þorn Ðelta')).toBe('thorn-delta');
  });

  it('still falls back for names made entirely of unromanisable script', () => {
    // The fallback table is deliberately Latin-only: romanising other scripts has no single correct
    // answer, so those names keep landing on the generic slug rather than being guessed at.
    expect(exportSlug('プロジェクト')).toBe('project');
  });
});

describe('exportSlug — separators collapse', () => {
  it('collapses a run of spaces into one dash', () => {
    expect(exportSlug('too    many     spaces')).toBe('too-many-spaces');
  });

  it('collapses tabs and newlines like any other whitespace', () => {
    expect(exportSlug('line\tone\nline two')).toBe('line-one-line-two');
  });

  it('collapses dashes the user typed themselves', () => {
    expect(exportSlug('a---b')).toBe('a-b');
  });

  it('trims leading and trailing separators', () => {
    expect(exportSlug('  spaced out  ')).toBe('spaced-out');
    expect(exportSlug('---edged---')).toBe('edged');
  });

  it('does not leave a dash where a dropped character sat between words', () => {
    expect(exportSlug('Q1 (draft)')).toBe('q1-draft');
    expect(exportSlug('Docs & Specs')).toBe('docs-specs');
  });
});

describe('exportSlug — special characters', () => {
  it('drops punctuation, symbols and emoji', () => {
    expect(exportSlug('Spec #4: "final"?!')).toBe('spec-4-final');
    expect(exportSlug('Rocket 🚀 Science')).toBe('rocket-science');
  });

  it('drops path separators, so a slug can never become a directory', () => {
    expect(exportSlug(String.raw`a/b\c`)).toBe('abc');
    expect(exportSlug('../../etc/passwd')).toBe('etcpasswd');
  });

  it('drops dots, so the slug can never introduce a second extension', () => {
    expect(exportSlug('v1.2.3')).toBe('v123');
  });

  it('drops underscores, keeping one separator character in the output', () => {
    expect(exportSlug('my_project')).toBe('myproject');
  });
});

describe('exportSlug — fallback', () => {
  it('falls back for an empty project name', () => {
    expect(exportSlug('')).toBe(FALLBACK_SLUG);
  });

  it('falls back for a name of only spaces', () => {
    expect(exportSlug('   ')).toBe(FALLBACK_SLUG);
  });

  it('falls back for a name of only special characters', () => {
    expect(exportSlug('???')).toBe(FALLBACK_SLUG);
    expect(exportSlug('***')).toBe(FALLBACK_SLUG);
    expect(exportSlug('---')).toBe(FALLBACK_SLUG);
    expect(exportSlug('.')).toBe(FALLBACK_SLUG);
  });

  it('falls back for non-Latin scripts, where mark-stripping yields nothing', () => {
    expect(exportSlug('Проект')).toBe(FALLBACK_SLUG); // Cyrillic
    expect(exportSlug('プロジェクト')).toBe(FALLBACK_SLUG); // Japanese
    expect(exportSlug('项目文档')).toBe(FALLBACK_SLUG); // Chinese
    expect(exportSlug('مشروع')).toBe(FALLBACK_SLUG); // Arabic
  });

  it('keeps the ASCII part of a mixed-script name rather than falling back', () => {
    expect(exportSlug('项目 Handbook')).toBe('handbook');
  });
});

describe('exportSlug — length cap', () => {
  it('caps the slug at the documented length', () => {
    const slug = exportSlug('a'.repeat(200));
    expect(slug).toHaveLength(MAX_SLUG_LENGTH);
  });

  it('caps a long multi-word name and never ends on a dash', () => {
    const slug = exportSlug('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('word-word')).toBe(true);
  });

  it('leaves a name at the cap exactly as it is', () => {
    const name = 'b'.repeat(MAX_SLUG_LENGTH);
    expect(exportSlug(name)).toBe(name);
  });

  it('produces a slug matching the documented shape for any input', () => {
    const inputs = ['', '???', '   ', 'Ação ⚡ 2026 ', 'x'.repeat(300), 'Проект', 'a---b'];
    for (const input of inputs) {
      expect(exportSlug(input)).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe('exportFileName', () => {
  it('appends the ISO date and the extension', () => {
    expect(exportFileName('Annual Report', 'pdf', TODAY)).toBe('annual-report-2026-07-25.pdf');
    expect(exportFileName('Annual Report', 'html', TODAY)).toBe('annual-report-2026-07-25.html');
    expect(exportFileName('Annual Report', 'zip', TODAY)).toBe('annual-report-2026-07-25.zip');
  });

  it('zero-pads month and day so the names sort chronologically', () => {
    expect(exportFileName('Docs', 'pdf', new Date(2026, 0, 3))).toBe('docs-2026-01-03.pdf');
  });

  it('stamps the LOCAL calendar day, not the UTC one', () => {
    // 23:30 local on the 31st: a UTC-based stamp would read as the 1st of the next month east of
    // Greenwich, labelling the export with a day the author never saw.
    expect(exportFileName('Docs', 'pdf', new Date(2026, 11, 31, 23, 30))).toBe('docs-2026-12-31.pdf');
  });

  it('never produces a dot-leading (hidden) name, whatever the project is called', () => {
    for (const name of ['', '???', '   ', 'Проект']) {
      expect(exportFileName(name, 'pdf', TODAY)).toBe(`${FALLBACK_SLUG}-2026-07-25.pdf`);
    }
  });

  it('defaults to the current date when none is supplied', () => {
    const name = exportFileName('Docs', 'pdf');
    expect(name).toMatch(/^docs-\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});
