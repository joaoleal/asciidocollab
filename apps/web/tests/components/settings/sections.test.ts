import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  settingsSection,
  visibleSettingsSections,
  type SettingsSectionId,
} from '@/components/settings/sections';

describe('settings section registry', () => {
  it('covers every section the options page offers, in navigation order', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'general',
      'rendering',
      'pdf',
      'extensions',
      'html',
      'repository',
      'danger',
    ]);
  });

  it('gives every section a label and a description', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
    }
  });

  it('uses ids that are safe to put in a URL unescaped', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.id).toMatch(/^[a-z]+$/);
    }
  });

  it('defaults to a section every viewer can see', () => {
    expect(visibleSettingsSections(false).map((s) => s.id)).toContain(DEFAULT_SETTINGS_SECTION);
  });
});

describe('visibleSettingsSections', () => {
  it('offers the danger zone only to owners', () => {
    expect(visibleSettingsSections(true).map((s) => s.id)).toContain('danger');
    expect(visibleSettingsSections(false).map((s) => s.id)).not.toContain('danger');
  });

  it('offers the git repository section only to owners', () => {
    expect(visibleSettingsSections(true).map((s) => s.id)).toContain('repository');
    expect(visibleSettingsSections(false).map((s) => s.id)).not.toContain('repository');
  });

  it('offers every other section to non-owners', () => {
    expect(visibleSettingsSections(false).map((s) => s.id)).toEqual([
      'general',
      'rendering',
      'pdf',
      'extensions',
      'html',
    ]);
  });
});

describe('resolveSettingsSection', () => {
  it('selects a section named in the query', () => {
    expect(resolveSettingsSection('pdf', false)).toBe('pdf');
  });

  it('falls back to the default when absent', () => {
    expect(resolveSettingsSection(null, true)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(resolveSettingsSection(undefined, true)).toBe(DEFAULT_SETTINGS_SECTION);
  });

  it('falls back to the default when the id is unknown', () => {
    expect(resolveSettingsSection('nonsense', true)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(resolveSettingsSection('', true)).toBe(DEFAULT_SETTINGS_SECTION);
  });

  it('falls back to the default when a non-owner links to the danger zone', () => {
    expect(resolveSettingsSection('danger', true)).toBe('danger');
    expect(resolveSettingsSection('danger', false)).toBe(DEFAULT_SETTINGS_SECTION);
  });
});

describe('settingsSection', () => {
  it('looks up each registered section', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsSection(section.id)).toBe(section);
    }
  });

  it('throws for an id outside the union', () => {
    expect(() => settingsSection('made-up' as SettingsSectionId)).toThrow(/Unknown settings section/);
  });
});
