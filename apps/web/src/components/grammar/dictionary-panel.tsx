'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utilities';
import type { DictionaryTermDto } from '@asciidocollab/shared';

/** Props for {@link DictionaryPanel}. */
export interface DictionaryPanelProperties {
  /** The project's accepted term records. */
  entries: DictionaryTermDto[];
  /** Whether the caller may add/remove terms (editor/owner). */
  canManage: boolean;
  /**
   * Add a term to the project dictionary.
   *
   * @param term - The term to add.
   */
  onAdd: (term: string) => void;
  /**
   * Remove a term from the project dictionary.
   *
   * @param termId - The id of the term to remove.
   */
  onRemove: (termId: string) => void;
  /** Extra class names for the container. */
  className?: string;
}

/**
 * The Grammar panel's Dictionary tab: a searchable list of the project's accepted terms, an add field
 * (editor/owner only), and per-term removal. Adding a domain term stops it being flagged for every
 * collaborator across all of the project's documents (spec US5 / SC-005).
 *
 * @param properties - The term records and management callbacks.
 * @returns The panel element.
 */
export function DictionaryPanel({ entries, canManage, onAdd, onRemove, className }: DictionaryPanelProperties): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? entries.filter((entry) => entry.term.toLowerCase().includes(needle)) : entries;
  }, [entries, query]);

  function submitAdd(): void {
    const term = draft.trim();
    if (!term) return;
    onAdd(term);
    setDraft('');
  }

  return (
    <div className={cn('flex h-full flex-col gap-2 p-2 text-xs', className)} aria-label="Project dictionary">
      <Input
        type="search"
        placeholder="Search terms…"
        aria-label="Search terms"
        className="h-7 px-2"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {canManage && (
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          <Input
            placeholder="Add a term…"
            aria-label="New term"
            className="h-7 px-2"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={draft.trim().length === 0}>
            Add
          </Button>
        </form>
      )}
      {filtered.length === 0 ? (
        <p className="px-2 py-2 text-muted-foreground">{entries.length === 0 ? 'No terms yet.' : 'No matching terms.'}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 overflow-y-auto">
          {filtered.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent">
              <span className="flex-1 truncate">{entry.term}</span>
              {canManage && (
                <button
                  type="button"
                  aria-label={`Remove ${entry.term}`}
                  className="text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(entry.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
