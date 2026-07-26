/**
 * @file The project options page's section registry: which sections exist, what they are called, and
 * in what order they appear.
 *
 * The page used to be one long scroll of unrelated controls. Splitting it means two things need a
 * single answer rather than one per call site: the set of valid section ids (the navigation, the URL
 * parser and the content switch must agree, or a link can select a section nothing renders for), and
 * their order (the navigation and any "next section" affordance must not disagree). Both live here.
 *
 * A section is addressable by id — `?section=<id>` — so this module also owns the parse: anything
 * unrecognised, absent or malformed resolves to the default rather than rendering an empty page.
 */

/** The identifier of a project-options section, as it appears in the `?section=` query parameter. */
export type SettingsSectionId = 'general' | 'rendering' | 'pdf' | 'extensions' | 'html' | 'danger';

/** One navigable section of the project options page. */
export interface SettingsSection {
  /** Stable identifier used in the URL; never localised. */
  id: SettingsSectionId;
  /** Heading shown in the navigation and above the section's content. */
  label: string;
  /** One line explaining what the section governs, shown under its heading. */
  description: string;
  /**
   * When true the section is offered only to project owners. Access control itself is enforced where
   * the actions live (FR-007); this only decides whether the navigation offers the entry at all, so
   * a non-owner is not shown a section whose every control is refused.
   */
  ownerOnly?: boolean;
}

/**
 * Every section, in the order the navigation presents them: the identity of the project first, then
 * the settings that shape what it renders, then the irreversible actions last.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  {
    id: 'general',
    label: 'General',
    // Grammar checking is named here because it lives with Language rather than with the rendering
    // options it is stored alongside: the feature only runs for English projects, so the setting that
    // switches it off is the language one, and the two have to be read together.
    description:
      "The project's name, description, tags, language, grammar checking and main file.",
  },
  // The three sections below are named after the FORMAT each governs, because scope is the thing a
  // reader has to get right and the old names hid it. "Rendering" and "Extensions" both sounded
  // general, so nothing said that "Rendering" also shapes the live preview while the other two are
  // PDF-only — and with a "PDF" section already present, a separate "Extensions" entry read as if it
  // covered something broader than PDF conversion. Naming the format makes both the shared/PDF-only
  // split and the sibling relationship between the two PDF sections legible from the navigation.
  {
    id: 'rendering',
    label: 'AsciiDoc',
    description:
      'AsciiDoc options applied to every document in this project — in the live preview and the exported PDF. A document header still overrides any option set here.',
  },
  {
    id: 'pdf',
    label: 'PDF Layout & Theme',
    description: 'Page setup, theme and fonts for the exported PDF. The live HTML preview ignores these.',
  },
  {
    id: 'extensions',
    label: 'PDF Extensions',
    description: 'The converter extensions this project applies when it renders a PDF.',
  },
  {
    id: 'html',
    label: 'HTML Export',
    description:
      'How an exported HTML file is packaged and what colours it uses. These shape the exported file, not the live preview.',
  },
  {
    id: 'danger',
    label: 'Danger Zone',
    description: 'Archiving and deletion. These actions affect everyone with access to the project.',
    ownerOnly: true,
  },
] satisfies readonly SettingsSection[]);

/** The section shown when none is requested, and the fallback for an unknown one. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

/** The sections offered to a viewer, filtered by whether they own the project. */
export function visibleSettingsSections(isOwner: boolean): readonly SettingsSection[] {
  return isOwner ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((section) => section.ownerOnly !== true);
}

/**
 * Resolve a raw `?section=` value to a section a viewer may actually see.
 *
 * Unknown, absent and owner-only-but-not-owner values all resolve to {@link DEFAULT_SETTINGS_SECTION}
 * (FR-004) — a link to a section the viewer cannot see must land somewhere real rather than blank.
 *
 * @param raw - The query-parameter value, or null/undefined when absent.
 * @param isOwner - Whether the viewer owns the project.
 */
export function resolveSettingsSection(
  raw: string | null | undefined,
  isOwner: boolean,
): SettingsSectionId {
  const match = visibleSettingsSections(isOwner).find((section) => section.id === raw);
  return match?.id ?? DEFAULT_SETTINGS_SECTION;
}

/** Look up a section's definition by id. */
export function settingsSection(id: SettingsSectionId): SettingsSection {
  const match = SETTINGS_SECTIONS.find((section) => section.id === id);
  // Unreachable for a SettingsSectionId — the registry is exhaustive over the union.
  if (match === undefined) throw new Error(`Unknown settings section: ${id}`);
  return match;
}
