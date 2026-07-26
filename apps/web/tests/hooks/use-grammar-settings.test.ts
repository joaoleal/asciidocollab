import { deriveGrammarSettings } from '@/hooks/use-grammar-settings';

describe('deriveGrammarSettings', () => {
  test('is enabled for an English project by default (grammarCheckEnabled unset)', () => {
    expect(deriveGrammarSettings({ language: 'en' })).toEqual({
      enabled: true,
      languageIsEnglish: true,
      dialect: 'en-GB',
    });
  });

  test('is inactive for a non-English project even when grammarCheckEnabled is true', () => {
    expect(deriveGrammarSettings({ language: 'fr', grammarCheckEnabled: true })).toMatchObject({
      enabled: false,
      languageIsEnglish: false,
    });
  });

  test('treats the Ukrainian language code "uk" as non-English (it is not UK English)', () => {
    expect(deriveGrammarSettings({ language: 'uk' }).languageIsEnglish).toBe(false);
  });

  test('an English project can disable checking via grammarCheckEnabled: false', () => {
    expect(deriveGrammarSettings({ language: 'en', grammarCheckEnabled: false }).enabled).toBe(false);
  });

  test('a null/absent project language is non-English and inactive', () => {
    expect(deriveGrammarSettings({ language: null }).enabled).toBe(false);
  });

  test('defaults the dialect to en-GB but honours an explicit dialect', () => {
    expect(deriveGrammarSettings({ language: 'en', dialect: 'en-US' }).dialect).toBe('en-US');
  });
});
