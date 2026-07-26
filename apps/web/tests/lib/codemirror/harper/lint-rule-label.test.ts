import { lintRuleLabel } from '@/lib/codemirror/harper/lint-rule-label';

describe('lintRuleLabel', () => {
  test('shows an engine rule name verbatim, so it matches the Rules list', () => {
    // These are the keys of the engine's own rule configuration. Prettifying `SpelledNumbers` into
    // "Spelled numbers" would break the one thing the name is for: finding the rule in the Rules tab.
    expect(lintRuleLabel('Albeit')).toBe('Albeit');
    expect(lintRuleLabel('SpelledNumbers')).toBe('SpelledNumbers');
    expect(lintRuleLabel('SpellCheck')).toBe('SpellCheck');
  });

  test('keeps a rule name it has never seen', () => {
    // The rule set is engine-defined and grows with every Harper release, so a new name must still
    // appear rather than fall off the UI.
    expect(lintRuleLabel('SomeBrandNewRule')).toBe('SomeBrandNewRule');
  });

  test('trims surrounding whitespace', () => {
    expect(lintRuleLabel('  Albeit  ')).toBe('Albeit');
  });

  test('returns null when there is no rule to name, so nothing is rendered', () => {
    // A chip reading "" or "Unknown" would be worse than no chip: it claims a rule exists and names it
    // wrongly. The caller renders nothing on null.
    expect(lintRuleLabel('')).toBeNull();
    expect(lintRuleLabel('   ')).toBeNull();
  });
});
