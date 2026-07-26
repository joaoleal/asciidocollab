import { render, screen, fireEvent } from '@testing-library/react';
import { GrammarRail } from '@/components/grammar/grammar-rail';
import type { PositionedGrammarDiagnostic } from '@/lib/codemirror/harper/grammar-diagnostics';
import type { GrammarCategory } from '@/lib/codemirror/harper/category-colors';
import { resetDocumentScope, setDocumentScope } from '@/lib/codemirror/harper/document-scope-store';

/** The engine `lint_kind()` a category plausibly comes from, so fixtures name a realistic kind. */
const KIND_FOR_CATEGORY: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'Spelling',
  grammar: 'Agreement',
  style: 'WordChoice',
};

/** A real Harper rule name that produces each category, so fixtures name a rule the engine could. */
const RULE_FOR_CATEGORY: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'SpellCheck',
  grammar: 'PronounVerbAgreement',
  style: 'Hedging',
};

function entry(
  from: number,
  category: GrammarCategory,
  message: string,
  suggestions: { text: string; kind: 'replace' }[] = [],
  rule: string = RULE_FOR_CATEGORY[category],
  kind: string = KIND_FOR_CATEGORY[category],
): PositionedGrammarDiagnostic {
  return {
    from,
    to: from + 5,
    diagnostic: {
      from,
      to: from + 5,
      severity: 'info',
      source: 'harper',
      message,
      category,
      grammarSuggestions: suggestions,
      // Required by GrammarDiagnostic and always set in production by `lintToDiagnostic`; tsc excludes
      // tests/, so an incomplete fixture here fails only at runtime.
      grammarSegmentText: message,
      grammarLint: { span: { start: 0, end: 5 }, kind, rule, message, suggestions },
    },
  };
}

describe('GrammarRail', () => {
  test('shows an empty state and the on-device indicator when there are no issues', () => {
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('No writing issues found.')).toBeInTheDocument();
    expect(screen.getByText('On-device')).toBeInTheDocument();
  });

  test('groups issues by category with per-category counts', () => {
    render(
      <GrammarRail
        diagnostics={[entry(0, 'spelling', '“wrold” misspelled'), entry(10, 'spelling', '“teh” misspelled'), entry(20, 'style', 'Wordy')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
      />,
    );
    expect(screen.getByRole('region', { name: 'Spelling' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Style' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Grammar' })).not.toBeInTheDocument();
  });

  test('gives each issue its own card so adjacent issues are visually distinct', () => {
    render(
      <GrammarRail
        diagnostics={[entry(0, 'spelling', '“wrold” misspelled'), entry(10, 'spelling', '“teh” misspelled')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
      />,
    );
    expect(screen.getAllByTestId('grammar-issue-card')).toHaveLength(2);
  });

  test('names the specific rule behind each issue, not its category', () => {
    // The category is already the section heading, so repeating it here would say nothing. What the
    // reader cannot see otherwise is WHICH rule fired — and it is spelled exactly as the Rules tab
    // lists it, so it can be searched for and switched off there.
    render(
      <GrammarRail
        diagnostics={[entry(0, 'style', 'Wordy', [], 'Hedging')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('grammar-issue-rule')).toHaveTextContent('Hedging');
  });

  test('hovering a rule shows the engine’s description of it', () => {
    render(
      <GrammarRail
        diagnostics={[entry(0, 'style', 'Wordy', [], 'Hedging')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
        ruleDescriptions={{ Hedging: 'Flags hedging language.' }}
      />,
    );
    expect(screen.getByTestId('grammar-issue-rule')).toHaveAttribute(
      'title',
      'Rule: Hedging — Flags hedging language.',
    );
  });

  test('keeps the rule out of the issue button’s accessible name', () => {
    // The chip must not join the control's name — activating it navigates to the issue; it does not do
    // anything "Hedging"-shaped.
    render(
      <GrammarRail
        diagnostics={[entry(0, 'style', 'Wordy', [], 'Hedging')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Wordy' })).toBeInTheDocument();
  });

  test('selecting an issue navigates to its position', () => {
    const onNavigate = jest.fn();
    render(<GrammarRail diagnostics={[entry(4, 'spelling', '“wrold” misspelled')]} status="ready" onNavigate={onNavigate} onApply={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '“wrold” misspelled' }));
    expect(onNavigate).toHaveBeenCalledWith(4, 9);
  });

  test('applying a fix chip resolves the issue via onApply', () => {
    const onApply = jest.fn();
    render(
      <GrammarRail
        diagnostics={[entry(4, 'spelling', '“wrold” misspelled', [{ text: 'world', kind: 'replace' }])]}
        status="ready"
        onNavigate={() => {}}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'world' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toEqual({ text: 'world', kind: 'replace' });
  });

  // The panel is the second surface offering a one-click fix, and it is driven by React state rather
  // than by the editor, so it needs the same gate — a viewer could otherwise rewrite the document from
  // the Writing panel while the editor beside it sat read-only.
  describe('a reader who may not edit the document', () => {
    function readOnlyRail(onApply = jest.fn()) {
      render(
        <GrammarRail
          diagnostics={[entry(4, 'spelling', '“wrold” misspelled', [{ text: 'world', kind: 'replace' }])]}
          status="ready"
          onNavigate={() => {}}
          onApply={onApply}
          readOnly
        />,
      );
      return onApply;
    }

    test('still lists the issues and what the checker would change them to', () => {
      readOnlyRail();
      expect(screen.getByText('“wrold” misspelled')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'world' })).toBeInTheDocument();
    });

    test('cannot apply a fix from the panel', () => {
      const onApply = readOnlyRail();
      const chip = screen.getByRole('button', { name: 'world' });
      expect(chip).toBeDisabled();
      fireEvent.click(chip);
      expect(onApply).not.toHaveBeenCalled();
    });

    test('refuses the fix even if the chip is re-enabled behind its back', () => {
      const onApply = readOnlyRail();
      const chip = screen.getByRole('button', { name: 'world' });
      chip.removeAttribute('disabled');
      fireEvent.click(chip);
      expect(onApply).not.toHaveBeenCalled();
    });

    test('still navigates to an issue, which reads the document rather than writing it', () => {
      const onNavigate = jest.fn();
      render(
        <GrammarRail
          diagnostics={[entry(4, 'spelling', 'Wordy phrase')]}
          status="ready"
          onNavigate={onNavigate}
          onApply={() => {}}
          readOnly
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Wordy phrase' }));
      expect(onNavigate).toHaveBeenCalledWith(4, 9);
    });
  });

  test('shows a loading state while the engine warms up', () => {
    render(<GrammarRail diagnostics={[]} status="loading" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('Starting the checker…')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  test('shows a failure state (not an eternal loading) when the engine could not start', () => {
    render(<GrammarRail diagnostics={[]} status="failed" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/could not start/i)).toBeInTheDocument();
    expect(screen.queryByText('Starting the checker…')).not.toBeInTheDocument();
  });

  test('shows a disabled state when grammar is off for the project', () => {
    render(<GrammarRail diagnostics={[]} status="disabled" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText(/off for this project/i)).toBeInTheDocument();
    expect(screen.queryByText('Starting the checker…')).not.toBeInTheDocument();
  });
});

describe('GrammarRail whole-document scope', () => {
  const issue = {
    fileId: 'id:chapters/intro.adoc',
    path: 'chapters/intro.adoc',
    line: 5,
    category: 'spelling' as const,
    message: '“wrold” may be misspelled',
    rule: 'SpellCheck',
  };

  afterEach(() => {
    resetDocumentScope();
  });

  test('shows nothing about other files while the panel is scoped to this file', () => {
    render(<GrammarRail diagnostics={[entry(0, 'spelling', 'x')]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Other files' })).not.toBeInTheDocument();
  });

  test('lists an issue found in another file with its file and line', () => {
    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByRole('region', { name: 'Other files' })).toBeInTheDocument();
    expect(screen.getByText('chapters/intro.adoc:5')).toBeInTheDocument();
    // A clean open file must not read as "nothing to fix" when another file has issues.
    expect(screen.queryByText('No writing issues found.')).not.toBeInTheDocument();
    expect(screen.getByText('No writing issues in this file.')).toBeInTheDocument();
  });

  test('selecting an issue in another file opens it there instead of moving this editor', () => {
    const reveal = jest.fn();
    const onNavigate = jest.fn();
    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={onNavigate} onApply={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /wrold/ }));
    expect(reveal).toHaveBeenCalledWith(issue);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('offers no fix chips for another file, which this editor cannot safely edit', () => {
    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.queryByRole('button', { name: 'world' })).not.toBeInTheDocument();
  });

  test('names the rule behind a cross-file issue without renaming its button', () => {
    // Same reason as the issue cards: the chip is a sibling of the row control, so the row still
    // announces "open this issue", not the rule.
    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal: null });
    render(
      <GrammarRail
        diagnostics={[]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
        ruleDescriptions={{ SpellCheck: 'Looks for words that are misspelled.' }}
      />,
    );
    const chip = screen.getByTestId('grammar-issue-rule');
    expect(chip).toHaveTextContent('SpellCheck');
    expect(chip).toHaveAttribute('title', 'Rule: SpellCheck — Looks for words that are misspelled.');
    expect(screen.getByRole('button', { name: /wrold/ })).toBeInTheDocument();
  });

  test('says this file is the whole document when it pulls in no other file', () => {
    setDocumentScope({ state: 'alone', fileCount: 0, issues: [], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText(/includes no other files/i)).toBeInTheDocument();
  });

  test('says so when this file is not part of the main document', () => {
    setDocumentScope({ state: 'outside-main', fileCount: 0, issues: [], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText(/not part of the main document/i)).toBeInTheDocument();
  });

  test('reports progress while the other files are being checked', () => {
    setDocumentScope({ state: 'scanning', fileCount: 3, issues: [], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('Checking 3 other files…')).toBeInTheDocument();
  });

  test('reports a clean result over the other files', () => {
    setDocumentScope({ state: 'checked', fileCount: 1, issues: [], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText('No writing issues in the other 1 file.')).toBeInTheDocument();
  });

  test('offers Ignore per issue when a dismissal can be stored', () => {
    const onIgnore = jest.fn();
    const item = entry(0, 'style', 'Wordy');
    render(<GrammarRail diagnostics={[item]} status="ready" onNavigate={() => {}} onApply={() => {}} onIgnore={onIgnore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(onIgnore).toHaveBeenCalledWith(item);
  });

  test('leaves Ignore out when there is nowhere to store the dismissal', () => {
    // Better absent than a control that appears to work and is forgotten on the next reload.
    render(<GrammarRail diagnostics={[entry(0, 'style', 'Wordy')]} status="ready" onNavigate={() => {}} onApply={() => {}} onIgnore={null} />);
    expect(screen.queryByRole('button', { name: 'Ignore' })).not.toBeInTheDocument();
  });

  test('offers Add to dictionary for a spelling issue only', () => {
    const onAddToDictionary = jest.fn();
    const misspelling = entry(0, 'spelling', '“wrold” misspelled');
    render(
      <GrammarRail
        diagnostics={[misspelling, entry(20, 'style', 'Wordy')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
        onAddToDictionary={onAddToDictionary}
      />,
    );
    // One button, in the Spelling section: a grammar or style lint has no word to accept.
    const buttons = screen.getAllByRole('button', { name: 'Add to dictionary' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onAddToDictionary).toHaveBeenCalledWith(misspelling);
  });

  test('omits Add to dictionary for a reader who may not manage it', () => {
    render(
      <GrammarRail
        diagnostics={[entry(0, 'spelling', '“wrold” misspelled')]}
        status="ready"
        onNavigate={() => {}}
        onApply={() => {}}
        onAddToDictionary={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add to dictionary' })).not.toBeInTheDocument();
  });

  test('stops claiming to be working when the cross-file pass could not finish', () => {
    // The pass gives up after a bounded number of attempts. Publishing nothing left this reading
    // "Checking 2 other files…" for the rest of the mount, which is indistinguishable from a slow pass.
    setDocumentScope({ state: 'incomplete', fileCount: 2, issues: [], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.queryByText(/Checking 2 other files/)).not.toBeInTheDocument();
    expect(screen.getByText(/Could not finish checking the other 2 files/)).toBeInTheDocument();
  });

  test('lists what an unfinished pass did reach, labelled as partial', () => {
    setDocumentScope({ state: 'incomplete', fileCount: 2, issues: [issue], reveal: null });
    render(<GrammarRail diagnostics={[]} status="ready" onNavigate={() => {}} onApply={() => {}} />);
    expect(screen.getByText(issue.message)).toBeInTheDocument();
    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
  });

});
