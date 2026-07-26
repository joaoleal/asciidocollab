'use client';
import { GrammarRail } from '@/components/grammar/grammar-rail';
import { GrammarScopeToggle } from '@/components/grammar/grammar-scope-toggle';
import { DictionaryPanel } from '@/components/grammar/dictionary-panel';
import { RulesPanel } from '@/components/grammar/rules-panel';
import type { EditorGrammarState } from './asciidoc-editor';
import { PanelViewHeader } from './panel-view-header';
import { PanelViewTabs, type PanelViewTab } from './panel-view-tabs';

/** Which writing surface is showing: the live issues, the project dictionary, or the rule list. */
export type WritingSubView = 'issues' | 'dictionary' | 'rules';

const TABS: readonly PanelViewTab<WritingSubView>[] = [
  { id: 'issues', label: 'Issues', testId: 'writing-view-issues' },
  { id: 'dictionary', label: 'Dictionary', testId: 'writing-view-dictionary' },
  { id: 'rules', label: 'Rules', testId: 'writing-view-rules' },
];

interface WritingPanelViewProperties {
  /** The sub-view currently showing. */
  view: WritingSubView;
  /**
   * Called with the sub-view the user selected.
   *
   * @param view - The newly selected sub-view.
   */
  onViewChange: (view: WritingSubView) => void;
  /**
   * The live checker state published by the open editor, or null before an editor is mounted. This
   * is one already-typed handle rather than a dozen separately-threaded callbacks: it is produced
   * whole by the editor, every member is documented on {@link EditorGrammarState}, and keeping it
   * whole confines the "no editor yet" fallbacks to this component instead of the layout.
   */
  grammar: EditorGrammarState | null;
}

/**
 * The right panel's Writing view: a "Writing" section header, an Issues / Dictionary / Rules control
 * row, the check-scope toggle on its own row while Issues is showing, and the selected surface
 * filling the rest of the panel.
 *
 * It is the structural mirror of a left-panel view (Files, Outline, Search): the view owns its own
 * header, so the panel adds none and the view's name appears exactly once. The scope toggle sits
 * below the tabs rather than beside the header because — unlike the Outline view's icon-only scope
 * button — it is a two-label control that would crowd the title out at the panel's minimum width.
 *
 * @param properties - The sub-view state and the editor's checker handle.
 * @returns The Writing view element.
 */
export function WritingPanelView({ view, onViewChange, grammar }: WritingPanelViewProperties) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelViewHeader title="Writing" />

      <PanelViewTabs label="Writing views" tabs={TABS} active={view} onChange={onViewChange} />

      {grammar && view === 'issues' && (
        <div className="shrink-0 border-b px-2 py-1">
          <GrammarScopeToggle scope={grammar.lintScope} onScopeChange={grammar.setLintScope} className="w-full" />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'issues' && (
          <GrammarRail
            diagnostics={grammar?.diagnostics ?? []}
            status={grammar?.status ?? 'disabled'}
            onNavigate={(from, to) => grammar?.navigate(from, to)}
            onApply={(entry, suggestion) => grammar?.apply(entry, suggestion)}
            // Accepting a fix is the only writing action that changes the shared document, so it is
            // gated on the editor's effective edit permission — which, unlike the project role alone,
            // accounts for an observer session and for a file with no collaborative backing. With no
            // editor mounted there is nothing to apply a fix to, so read-only is also the honest
            // default. The issues themselves stay listed either way.
            readOnly={!grammar?.canEditDocument}
            // Passed straight through as null when unavailable, so the rail leaves the control out
            // rather than rendering one that no-ops.
            onIgnore={grammar?.ignore ?? null}
            onAddToDictionary={grammar && grammar.canManageDictionary ? grammar.addIssueWordToDictionary : null}
            // Empty until the engine has loaded them: each issue still names its rule, it just has no
            // hover text explaining it yet.
            ruleDescriptions={grammar?.ruleDescriptions ?? {}}
          />
        )}
        {view === 'dictionary' && (
          <DictionaryPanel
            entries={grammar?.dictionary ?? []}
            canManage={grammar?.canManageDictionary ?? false}
            onAdd={(term) => grammar?.addDictionaryTerm(term)}
            onRemove={(termId) => grammar?.removeDictionaryTerm(termId)}
          />
        )}
        {view === 'rules' && (
          <RulesPanel
            config={grammar?.ruleConfig ?? {}}
            onToggle={(rule, enabled) => grammar?.setRule(rule, enabled)}
            onResetDefaults={() => grammar?.resetRules()}
            // The rule config is view-local, so this is consistency rather than authorization: a
            // reader who cannot apply a suggestion should not be able to change which checks run
            // either. Gated on the reader's ROLE (`canConfigureRules`) and not on the document's
            // effective edit permission — the latter also folds in a missing collaborative backing,
            // which is a per-file transport condition that would otherwise disable these toggles for
            // a project owner. With no editor mounted there are no rules to change, so read-only is
            // the honest default.
            readOnly={!grammar?.canConfigureRules}
          />
        )}
      </div>
    </div>
  );
}
