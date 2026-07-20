'use client';

/**
 * @file Navigation between the project options page's sections.
 *
 * Each entry is a real link to `?section=<id>` so a section can be copied, bookmarked and opened in a
 * new tab (FR-003) — the affordances a button would silently remove. Activation is nonetheless
 * intercepted for same-tab clicks, because the page owns the unsaved-edit prompt (FR-005) and a bare
 * link would navigate past it. Modified clicks (new tab, new window, download) are left to the
 * browser: the prompt exists to protect edits in THIS tab, which such a click does not disturb.
 *
 * The layout is a horizontal scrolling strip below `sm` and a vertical rail above it (FR-008), so
 * every section stays reachable on a narrow viewport without the labels wrapping into an unreadable
 * pile.
 */
import Link from 'next/link';
import type { SettingsSection, SettingsSectionId } from './sections';

interface SectionNavProperties {
  /** The sections to offer, already filtered for this viewer. */
  sections: readonly SettingsSection[];
  /** The currently selected section. */
  current: SettingsSectionId;
  /** Base path of the options page, used to build each entry's href. */
  basePath: string;
  /**
   * Called when an entry is activated in this tab; the page decides whether the change proceeds.
   *
   * @param id - The section the viewer asked for.
   */
  onSelect: (id: SettingsSectionId) => void;
}

/** True for a click the browser should handle itself (new tab/window, download, non-primary button). */
function isModifiedClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
  );
}

/** The project options page's section navigation. */
export function SectionNav({
  sections,
  current,
  basePath,
  onSelect,
}: SectionNavProperties): React.JSX.Element {
  return (
    <nav
      aria-label="Project settings sections"
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-2 sm:mx-0 sm:w-52 sm:shrink-0 sm:flex-col sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {sections.map((section) => {
        const selected = section.id === current;
        return (
          <Link
            key={section.id}
            href={`${basePath}?section=${section.id}`}
            aria-current={selected ? 'page' : undefined}
            className={[
              'shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors sm:shrink',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              selected
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              section.ownerOnly === true && !selected ? 'text-destructive/80 hover:text-destructive' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              onSelect(section.id);
            }}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
