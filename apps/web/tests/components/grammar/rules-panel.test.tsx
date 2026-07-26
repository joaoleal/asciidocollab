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

});
