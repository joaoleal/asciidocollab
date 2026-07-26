import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionPopover } from '@/components/grammar/suggestion-popover';
import type { GrammarDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';

function diagnostic(overrides: Partial<GrammarDiagnostic> = {}): GrammarDiagnostic {
  return {
    from: 2,
    to: 7,
    severity: 'info',
    message: '“wrold” may be misspelled',
    category: 'spelling',
    grammarSuggestions: [
      { text: 'world', kind: 'replace' },
      { text: 'word', kind: 'replace' },
    ],
    // Required by GrammarDiagnostic and populated by `lintToDiagnostic` in production. Omitting them
    // here used to go unnoticed because tsc excludes tests/ — until the popover started reading the
    // lint's rule to name it, at which point every case threw. Keep fixtures faithful.
    grammarSegmentText: 'the wrold is round',
    grammarLint: {
      span: { start: 4, end: 9 },
      kind: 'Spelling',
      rule: 'SpellCheck',
      message: '“wrold” may be misspelled',
      suggestions: [
        { text: 'world', kind: 'replace' },
        { text: 'word', kind: 'replace' },
      ],
    },
    ...overrides,
  };
}

describe('SuggestionPopover', () => {
  test('shows the message and a chip per suggestion', () => {
    render(<SuggestionPopover diagnostic={diagnostic()} onApply={() => {}} />);
    expect(screen.getByText('“wrold” may be misspelled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'world' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'word' })).toBeInTheDocument();
  });

  test('applies the chosen suggestion in one click', () => {
    const onApply = jest.fn();
    render(<SuggestionPopover diagnostic={diagnostic()} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'world' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ text: 'world', kind: 'replace' });
  });

  test('renders add-to-dictionary and ignore only when their handlers are provided', () => {
    const onAddToDictionary = jest.fn();
    const onIgnore = jest.fn();
    const { rerender } = render(<SuggestionPopover diagnostic={diagnostic()} onApply={() => {}} />);
    expect(screen.queryByRole('button', { name: /add to dictionary/i })).not.toBeInTheDocument();

    rerender(
      <SuggestionPopover
        diagnostic={diagnostic()}
        onApply={() => {}}
        onAddToDictionary={onAddToDictionary}
        onIgnore={onIgnore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add to dictionary/i }));
    fireEvent.click(screen.getByRole('button', { name: /ignore/i }));
    expect(onAddToDictionary).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  test('names the rule that fired, verbatim, so it matches the Rules list', () => {
    render(<SuggestionPopover diagnostic={diagnostic()} onApply={() => {}} />);
    const chip = screen.getByTestId('grammar-issue-rule');
    expect(chip).toHaveTextContent('SpellCheck');
    // Without a description loaded, hovering still says what the identifier is.
    expect(chip).toHaveAttribute('title', 'Rule: SpellCheck');
  });

  test('explains the rule on hover once its description is known', () => {
    render(
      <SuggestionPopover
        diagnostic={diagnostic()}
        ruleDescription="Looks for words that are misspelled."
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('grammar-issue-rule')).toHaveAttribute(
      'title',
      'Rule: SpellCheck — Looks for words that are misspelled.',
    );
  });

  test('keeps the rule off the message’s own line so the message gets the full width', () => {
    // The bug this pins: beside the message, a long rule name (which must not shrink, or it elides to
    // something unsearchable) took a third of the narrow panel and wrapped the message every few words.
    // It belongs in the footer row with the actions — and still outside the message control, so it does
    // not join its accessible name.
    render(<SuggestionPopover diagnostic={diagnostic()} onApply={() => {}} onSelect={() => {}} />);
    const message = screen.getByRole('button', { name: '“wrold” may be misspelled' });
    const chip = screen.getByTestId('grammar-issue-rule');
    expect(message).not.toContainElement(chip);
    expect(screen.getByTestId('grammar-issue-actions')).toContainElement(chip);
  });

  test('still names the rule when the issue has no fixes or actions to sit beside', () => {
    render(<SuggestionPopover diagnostic={diagnostic({ grammarSuggestions: [] })} onApply={() => {}} />);
    expect(screen.getByTestId('grammar-issue-rule')).toHaveTextContent('SpellCheck');
  });

  test('adds no footer row when there is neither a rule to name nor anything to do', () => {
    render(
      <SuggestionPopover
        diagnostic={diagnostic({
          grammarSuggestions: [],
          grammarLint: { span: { start: 4, end: 9 }, kind: 'Spelling', rule: '', message: 'x', suggestions: [] },
        })}
        onApply={() => {}}
      />,
    );
    expect(screen.queryByTestId('grammar-issue-actions')).not.toBeInTheDocument();
  });

  test('shows no rule chip at all when the lint names no rule', () => {
    // A chip reading "" or "Unknown" would claim an identity the engine never gave.
    render(
      <SuggestionPopover
        diagnostic={diagnostic({
          grammarLint: { span: { start: 4, end: 9 }, kind: 'Spelling', rule: '', message: 'x', suggestions: [] },
        })}
        onApply={() => {}}
      />,
    );
    expect(screen.queryByTestId('grammar-issue-rule')).not.toBeInTheDocument();
  });

  test('renders no chips when the issue has no suggestions', () => {
    render(<SuggestionPopover diagnostic={diagnostic({ grammarSuggestions: [] })} onApply={() => {}} />);
    expect(screen.getByText('“wrold” may be misspelled')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
