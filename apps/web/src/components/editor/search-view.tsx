'use client';
import { useState } from 'react';
import { CaseSensitive, WholeWord, Regex, Replace, ReplaceAll } from 'lucide-react';
import type { FileMatchGroupDto, SearchMatchDto, SearchMode } from '@asciidocollab/shared';
import { useProjectSearch } from '@/hooks/use-project-search';
import { PanelViewHeader } from './panel-view-header';

/**
 * Expands a replacement template for the before/after PREVIEW only, using the capture groups the
 * search carried back — so `$1`/`${name}`/`$$`/`$&` show their real substitution instead of the raw
 * template. Literal mode inserts the text verbatim. Mirrors the server's `substitute` rules; the
 * authoritative replacement still happens server-side against live content.
 */
function expandReplacementPreview(replacement: string, match: SearchMatchDto, mode: SearchMode): string {
  if (mode === 'literal') return replacement;
  let out = '';
  let index = 0;
  while (index < replacement.length) {
    if (replacement[index] !== '$') {
      out += replacement[index];
      index += 1;
      continue;
    }
    const next = replacement[index + 1];
    if (next === '$') {
      out += '$';
      index += 2;
      continue;
    }
    if (next === '&') {
      out += match.groups[0] ?? '';
      index += 2;
      continue;
    }
    if (next === '{') {
      const close = replacement.indexOf('}', index + 2);
      if (close !== -1) {
        const name = replacement.slice(index + 2, close);
        // Unknown named group → keep the token verbatim (matches the server's lenient expansion).
        out += match.named && name in match.named ? (match.named[name] ?? '') : replacement.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    if (next !== undefined && next >= '0' && next <= '9') {
      const twoDigit = replacement.slice(index + 1, index + 3);
      if (/^\d\d$/.test(twoDigit) && Number(twoDigit) > 0 && Number(twoDigit) < match.groups.length) {
        out += match.groups[Number(twoDigit)] ?? '';
        index += 3;
        continue;
      }
      const oneNumber = Number(next);
      // Absent group → emit `$` + the digit literally, exactly as the server does.
      out += oneNumber > 0 && oneNumber < match.groups.length ? (match.groups[oneNumber] ?? '') : `$${next}`;
      index += 2;
      continue;
    }
    out += '$';
    index += 1;
  }
  return out;
}

/** Where a chosen result should open. */
export interface SearchResultTarget {
  /** The file node containing the match. */
  fileNodeId: string;
  /** Project-relative path of the file. */
  path: string;
  /** 1-based line of the match. */
  line: number;
  /** Char offset of the match start. */
  from: number;
  /** Char offset of the match end. */
  to: number;
}

interface SearchViewProperties {
  projectId: string;
  // Called when a result is activated so the layout opens the file and places the cursor on the match.
  onNavigate: (target: SearchResultTarget) => void;
}

/** Replace controls threaded down to each result row. */
interface ReplaceControls {
  replacement: string;
  mode: SearchMode;
  showReplace: boolean;
  isExcluded: (fileNodeId: string, ordinal: number) => boolean;
  toggleExcluded: (fileNodeId: string, ordinal: number) => void;
  onReplaceMatch: (fileNodeId: string, ordinal: number) => void;
  onReplaceFile: (fileNodeId: string) => void;
}

/** A small option toggle (case, whole-word, regex) sharing the rail's active-accent treatment. */
function OptionToggle({ label, pressed, onPressedChange, children }: { label: string; pressed: boolean; onPressedChange: (next: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={() => onPressedChange(!pressed)}
      className={`flex h-6 w-6 items-center justify-center rounded border text-muted-foreground transition-colors ${
        pressed ? 'bg-primary/10 text-primary border-primary' : 'border-transparent hover:bg-accent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** Renders one line snippet with the matched substring highlighted, and the replacement preview when replacing. */
function MatchSnippet({ match, replacement, mode, showReplace }: { match: SearchMatchDto; replacement: string; mode: SearchMode; showReplace: boolean }) {
  const start = Math.max(0, match.column - 1);
  const end = Math.min(match.lineText.length, start + match.matchText.length);
  const preview = showReplace ? expandReplacementPreview(replacement, match, mode) : '';
  return (
    <span className="truncate">
      <span className="text-muted-foreground">{match.lineText.slice(0, start)}</span>
      {showReplace ? (
        <>
          <mark className="rounded-sm bg-destructive/15 text-foreground line-through">{match.lineText.slice(start, end)}</mark>
          <mark className="rounded-sm bg-primary/20 text-foreground">{preview}</mark>
        </>
      ) : (
        <mark className="rounded-sm bg-primary/20 text-foreground">{match.lineText.slice(start, end)}</mark>
      )}
      <span className="text-muted-foreground">{match.lineText.slice(end)}</span>
    </span>
  );
}

/** A file group header plus its match rows. */
function ResultGroup({ group, onNavigate, replace }: { group: FileMatchGroupDto; onNavigate: (target: SearchResultTarget) => void; replace: ReplaceControls }) {
  return (
    <li>
      <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
        <span className="truncate text-xs font-medium text-foreground" title={group.path}>{group.path}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{group.matchCount}</span>
        {replace.showReplace && (
          <button
            type="button"
            aria-label={`Replace all in ${group.path}`}
            title="Replace all in this file"
            onClick={() => replace.onReplaceFile(group.fileNodeId)}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ReplaceAll className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <ul>
        {group.matches.map((match) => {
          const excluded = replace.isExcluded(group.fileNodeId, match.ordinal);
          return (
            <li key={match.ordinal} className="flex items-center gap-1 pr-3">
              {replace.showReplace && (
                <input
                  type="checkbox"
                  checked={!excluded}
                  onChange={() => replace.toggleExcluded(group.fileNodeId, match.ordinal)}
                  aria-label={excluded ? `Include match on line ${match.line}` : `Exclude match on line ${match.line}`}
                  className="ml-3 shrink-0 accent-primary"
                />
              )}
              <button
                type="button"
                aria-label={`Line ${match.line}: ${match.lineText}`}
                onClick={() => onNavigate({ fileNodeId: group.fileNodeId, path: group.path, line: match.line, from: match.from, to: match.to })}
                className={`flex flex-1 items-baseline gap-2 py-0.5 text-left text-xs hover:bg-accent ${replace.showReplace ? 'pl-1' : 'pl-5'} ${excluded ? 'opacity-50' : ''}`}
              >
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{match.line}</span>
                <MatchSnippet match={match} replacement={replace.replacement} mode={replace.mode} showReplace={replace.showReplace && !excluded} />
              </button>
              {replace.showReplace && !excluded && (
                <button
                  type="button"
                  aria-label={`Replace match on line ${match.line}`}
                  title="Replace this match"
                  onClick={() => replace.onReplaceMatch(group.fileNodeId, match.ordinal)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Replace className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/**
 * The left-panel Search tab: a project-wide find/replace over every text-decodable
 * file. The header (fixed h-9) matches Files/Outline; the query input, case /
 * whole-word / regex toggles, and replacement input are styled from design tokens.
 * Results are grouped by file with per-file and true-total counts; activating a
 * result opens its file with the cursor on the match. Each match can be
 * included/excluded and replaced individually, per file, or project-wide (with a
 * scope confirmation). An invalid regex shows an inline error and nothing runs.
 */
export function SearchView({ projectId, onNavigate }: SearchViewProperties) {
  const search = useProjectSearch(projectId);
  const { query, setQuery, result, status, error, replacement, setReplacement, replace, replaceStatus, replaceError, includedMatchCount } = search;
  const [confirmingAll, setConfirmingAll] = useState(false);
  // Enter "replace mode" once the user engages the replacement field, so replacing with an EMPTY
  // string (i.e. deleting matched text) is reachable — otherwise the controls would only appear when
  // the field has text. Sticky (no blur reset) so clicking a replace button never races the blur.
  const [replaceActive, setReplaceActive] = useState(false);

  const showReplace = replacement.length > 0 || replaceActive;
  const hasResults = status === 'success' && result !== null && result.totalMatches > 0;
  const replaceControls: ReplaceControls = {
    replacement,
    mode: query.mode,
    showReplace,
    isExcluded: search.isExcluded,
    toggleExcluded: search.toggleExcluded,
    onReplaceMatch: (fileNodeId, ordinal) => void replace({ scope: 'match', fileNodeId, ordinal }),
    onReplaceFile: (fileNodeId) => void replace({ scope: 'file', fileNodeId }),
  };

  const affectedFiles = result?.groups.filter((group) => group.matches.some((match) => !search.isExcluded(group.fileNodeId, match.ordinal))).length ?? 0;

  return (
    <div data-testid="search-view" className="flex h-full flex-col overflow-hidden">
      <PanelViewHeader title="Search" />

      <div className="flex flex-col gap-1 border-b px-2 py-2 shrink-0">
        <div className="flex items-center gap-1 rounded border bg-background px-2 py-1">
          <input
            type="text"
            value={query.query}
            onChange={(event) => setQuery({ query: event.target.value })}
            placeholder="Search project…"
            aria-label="Search query"
            aria-invalid={error?.code === 'INVALID_PATTERN'}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <OptionToggle label="Match case" pressed={query.caseSensitive} onPressedChange={(v) => setQuery({ caseSensitive: v })}>
            <CaseSensitive className="h-4 w-4" />
          </OptionToggle>
          <OptionToggle label="Whole word" pressed={query.wholeWord} onPressedChange={(v) => setQuery({ wholeWord: v })}>
            <WholeWord className="h-4 w-4" />
          </OptionToggle>
          <OptionToggle label="Use regular expression" pressed={query.mode === 'regex'} onPressedChange={(v) => setQuery({ mode: v ? 'regex' : 'literal' })}>
            <Regex className="h-4 w-4" />
          </OptionToggle>
        </div>

        <div className="flex items-center gap-1 rounded border bg-background px-2 py-1">
          <input
            type="text"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onFocus={() => setReplaceActive(true)}
            placeholder="Replace…"
            aria-label="Replacement text"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          {hasResults && showReplace && (
            <button
              type="button"
              aria-label="Replace all matches"
              onClick={() => setConfirmingAll(true)}
              disabled={replaceStatus === 'replacing' || includedMatchCount === 0}
              className="flex h-6 items-center gap-1 rounded border border-primary bg-primary/10 px-2 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              <ReplaceAll className="h-3.5 w-3.5" />
              Replace all
            </button>
          )}
        </div>

        {query.mode === 'regex' && (
          <p className="px-1 text-[11px] leading-snug text-muted-foreground">
            Use <code className="rounded bg-muted px-0.5">\b</code> for word boundaries. In{' '}
            <strong>Replace</strong>, insert capture groups with <code className="rounded bg-muted px-0.5">$1</code>{' '}
            <code className="rounded bg-muted px-0.5">$2</code>, named groups with{' '}
            <code className="rounded bg-muted px-0.5">{'${name}'}</code>, and a literal{' '}
            <code className="rounded bg-muted px-0.5">$</code> with <code className="rounded bg-muted px-0.5">$$</code>.
            Lookaround and backreferences are not supported.
          </p>
        )}
        {error && (
          <p role="alert" className="px-1 text-xs text-destructive">
            {error.code === 'INVALID_PATTERN' ? `Invalid pattern: ${error.message}` : error.message}
          </p>
        )}
        {replaceError && (
          <p role="alert" className="px-1 text-xs text-destructive">
            {replaceError.code === 'INVALID_REPLACEMENT' ? `Invalid replacement: ${replaceError.message}` : replaceError.message}
          </p>
        )}
      </div>

      {confirmingAll && (
        <div role="dialog" aria-label="Confirm replace all" className="flex flex-col gap-2 border-b bg-muted/40 px-3 py-2 text-xs shrink-0">
          <p>
            Replace <strong>{includedMatchCount}</strong> {includedMatchCount === 1 ? 'match' : 'matches'} across{' '}
            <strong>{affectedFiles}</strong> {affectedFiles === 1 ? 'file' : 'files'}?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setConfirmingAll(false); void replace({ scope: 'project' }); }}
              className="rounded border border-primary bg-primary/10 px-2 py-0.5 text-primary hover:bg-primary/20"
            >
              Replace all
            </button>
            <button type="button" onClick={() => setConfirmingAll(false)} className="rounded border px-2 py-0.5 text-muted-foreground hover:bg-accent">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === 'idle' && (
          <p className="px-3 py-4 text-xs text-muted-foreground">Type to search across every file in the project.</p>
        )}
        {status === 'loading' && (
          <p className="px-3 py-4 text-xs text-muted-foreground">Searching…</p>
        )}
        {status === 'success' && result && result.totalMatches === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No matches found.</p>
        )}
        {hasResults && result && (
          <>
            {result.capped && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Showing {result.returnedMatches} of {result.totalMatches} matches — refine your search to see more.
              </p>
            )}
            <ul>
              {result.groups.map((group) => (
                <ResultGroup key={group.fileNodeId} group={group} onNavigate={onNavigate} replace={replaceControls} />
              ))}
            </ul>
            {result.skippedFiles > 0 && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                {result.skippedFiles} file{result.skippedFiles === 1 ? '' : 's'} skipped (binary or too large).
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
