import { render, screen, fireEvent } from '@testing-library/react';
import { RulesPanel } from '@/components/grammar/rules-panel';

const config = { SpellCheck: null, LongSentences: false, OxfordComma: true };

describe('RulesPanel', () => {
  test('renders the engine-reported rules (data-driven, not a hardcoded list)', () => {
    render(<RulesPanel config={config} onToggle={() => {}} onResetDefaults={() => {}} />);
    expect(screen.getByText('SpellCheck')).toBeInTheDocument();
    expect(screen.getByText('LongSentences')).toBeInTheDocument();
    expect(screen.getByText('OxfordComma')).toBeInTheDocument();
  });

  test('reflects a rule’s off state and toggles it', () => {
    const onToggle = jest.fn();
    render(<RulesPanel config={config} onToggle={onToggle} onResetDefaults={() => {}} />);
    const longSentences = screen.getByText('LongSentences').closest('label')!.querySelector('input')!;
    expect(longSentences).not.toBeChecked(); // explicitly false
    fireEvent.click(longSentences);
    expect(onToggle).toHaveBeenCalledWith('LongSentences', true);
  });

  test('filters rules by the search query', () => {
    render(<RulesPanel config={config} onToggle={() => {}} onResetDefaults={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search rules'), { target: { value: 'oxford' } });
    expect(screen.getByText('OxfordComma')).toBeInTheDocument();
    expect(screen.queryByText('SpellCheck')).not.toBeInTheDocument();
  });

  test('resets to defaults', () => {
    const onResetDefaults = jest.fn();
    render(<RulesPanel config={config} onToggle={() => {}} onResetDefaults={onResetDefaults} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onResetDefaults).toHaveBeenCalledTimes(1);
  });

  test('shows a loading hint when no rules are present yet', () => {
    render(<RulesPanel config={{}} onToggle={() => {}} onResetDefaults={() => {}} />);
    expect(screen.getByText('Rules load with the checker.')).toBeInTheDocument();
  });

  test('a rule left at the engine default is indeterminate, not ticked', () => {
    // `null` means "whatever Harper decides". Rendering it ticked claims we know it is on, and for the
    // rules Harper disables by default that claim is wrong — the box would say on while the rule is off.
    render(<RulesPanel config={config} onToggle={() => {}} onResetDefaults={() => {}} />);
    const spellCheck = screen.getByText('SpellCheck').closest('label')!.querySelector('input')!;
    expect(spellCheck).not.toBeChecked();
    expect(spellCheck.indeterminate).toBe(true);
    expect(spellCheck).toHaveAttribute('aria-checked', 'mixed');
  });

  test('an explicitly enabled rule is ticked and not indeterminate', () => {
    render(<RulesPanel config={config} onToggle={() => {}} onResetDefaults={() => {}} />);
    const oxford = screen.getByText('OxfordComma').closest('label')!.querySelector('input')!;
    expect(oxford).toBeChecked();
    expect(oxford.indeterminate).toBe(false);
    expect(oxford).not.toHaveAttribute('aria-checked');
  });

  test('clicking a defaulted rule commits an explicit choice', () => {
    const onToggle = jest.fn();
    render(<RulesPanel config={config} onToggle={onToggle} onResetDefaults={() => {}} />);
    fireEvent.click(screen.getByText('SpellCheck').closest('label')!.querySelector('input')!);
    expect(onToggle).toHaveBeenCalledWith('SpellCheck', true);
  });

  // A reader who cannot edit the document is offered no control that changes how it is checked. The
  // rule list itself stays readable — only the mutating controls go inert.
  describe('read-only', () => {
    const renderReadOnly = (onToggle = jest.fn(), onResetDefaults = jest.fn()) => {
      render(<RulesPanel config={config} onToggle={onToggle} onResetDefaults={onResetDefaults} readOnly />);
      return { onToggle, onResetDefaults };
    };

    test('every rule toggle is disabled', () => {
      renderReadOnly();
      for (const rule of ['SpellCheck', 'LongSentences', 'OxfordComma']) {
        expect(screen.getByText(rule).closest('label')!.querySelector('input')!).toBeDisabled();
      }
    });

    test('Reset is disabled', () => {
      renderReadOnly();
      expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    });

    test('clicking a toggle does not call onToggle', () => {
      const { onToggle } = renderReadOnly();
      fireEvent.click(screen.getByText('SpellCheck').closest('label')!.querySelector('input')!);
      expect(onToggle).not.toHaveBeenCalled();
    });

    test('clicking Reset does not call onResetDefaults', () => {
      const { onResetDefaults } = renderReadOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
      expect(onResetDefaults).not.toHaveBeenCalled();
    });

    // Defence in depth: `disabled` suppresses the browser-generated event, so the handler guard is
    // what a stale render or a programmatic dispatch actually meets. Fire the change directly.
    test('a change event dispatched past the disabled attribute is still refused', () => {
      const { onToggle } = renderReadOnly();
      const input = screen.getByText('SpellCheck').closest('label')!.querySelector('input')!;
      fireEvent.change(input, { target: { checked: true } });
      expect(onToggle).not.toHaveBeenCalled();
    });

    test('the rules stay listed and searchable', () => {
      renderReadOnly();
      expect(screen.getByText('SpellCheck')).toBeInTheDocument();
      expect(screen.getByLabelText('Search rules')).toBeEnabled();
    });

    test('the controls are live again when not read-only', () => {
      const onToggle = jest.fn();
      render(<RulesPanel config={config} onToggle={onToggle} onResetDefaults={() => {}} />);
      const input = screen.getByText('SpellCheck').closest('label')!.querySelector('input')!;
      expect(input).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
      fireEvent.click(input);
      expect(onToggle).toHaveBeenCalledWith('SpellCheck', true);
    });
  });

});
