import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditorPreferencesCard } from '@/app/(dashboard)/dashboard/settings/editor-preferences-card';

const setFontSize = jest.fn();
const setTheme = jest.fn();
const setScrollSyncEnabled = jest.fn();
const setSoftWrap = jest.fn();
const setPreviewStyle = jest.fn();
const setSpellcheckEnabled = jest.fn();
const setMinimapEnabled = jest.fn();
const setPrivateCommitEmail = jest.fn();

const preferences = {
  fontSize: 14,
  theme: 'default',
  scrollSyncEnabled: false,
  softWrap: true,
  previewStyle: 'asciidocollab',
  spellIgnore: [],
  spellcheckEnabled: true,
  minimapEnabled: false,
  privateCommitEmail: false,
  setFontSize,
  setTheme,
  setScrollSyncEnabled,
  setSoftWrap,
  setPreviewStyle,
  addSpellIgnore: jest.fn(),
  setSpellcheckEnabled,
  setMinimapEnabled,
  setPrivateCommitEmail,
};

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => preferences,
}));

jest.mock('@/components/preview-style-control', () => ({
  PreviewStyleControl: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    ariaLabel: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onChange('github')}>
      preview:{value}
    </button>
  ),
}));

describe('EditorPreferencesCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    preferences.fontSize = 14;
    preferences.theme = 'default';
    preferences.scrollSyncEnabled = false;
    preferences.softWrap = true;
    preferences.minimapEnabled = false;
    preferences.privateCommitEmail = false;
  });

  test('renders the font-size select with the current value', () => {
    render(<EditorPreferencesCard />);
    expect(screen.getByLabelText(/font size/i)).toHaveValue('14');
  });

  test('calls setFontSize with a number when the select changes', () => {
    render(<EditorPreferencesCard />);
    fireEvent.change(screen.getByLabelText(/font size/i), { target: { value: '18' } });
    expect(setFontSize).toHaveBeenCalledWith(18);
  });

  test('renders all editor theme options and marks the active one', () => {
    preferences.theme = 'dracula';
    render(<EditorPreferencesCard />);
    for (const label of ['Default', 'High Contrast', 'Dracula', 'Tomorrow', 'Espresso']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Dracula' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('calls setTheme when an editor theme button is clicked', () => {
    render(<EditorPreferencesCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    expect(setTheme).toHaveBeenCalledWith('tomorrow');
  });

  test('wires the preview style control to setPreviewStyle', () => {
    render(<EditorPreferencesCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview style' }));
    expect(setPreviewStyle).toHaveBeenCalledWith('github');
  });

  test('toggles scroll sync', () => {
    render(<EditorPreferencesCard />);
    fireEvent.click(screen.getByLabelText('Scroll Sync'));
    expect(setScrollSyncEnabled).toHaveBeenCalledWith(true);
  });

  test('toggles soft wrap off when currently enabled', () => {
    render(<EditorPreferencesCard />);
    const softWrap = screen.getByLabelText('Soft Wrap');
    expect(softWrap).toBeChecked();
    fireEvent.click(softWrap);
    expect(setSoftWrap).toHaveBeenCalledWith(false);
  });

  test('toggles spell check off', () => {
    render(<EditorPreferencesCard />);
    const toggle = screen.getByLabelText('Spell Check');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);
  });

  test('no longer offers a spell-check language selector (now a project setting)', () => {
    render(<EditorPreferencesCard />);
    expect(screen.queryByLabelText('Spell Check Language')).not.toBeInTheDocument();
  });

  test('text preview is off by default and toggling it on calls setMinimapEnabled', () => {
    render(<EditorPreferencesCard />);
    const toggle = screen.getByLabelText('Text Preview');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setMinimapEnabled).toHaveBeenCalledWith(true);
  });

  test('privacy-preserving commit email is off by default and reflects the loaded value', () => {
    preferences.privateCommitEmail = true;
    render(<EditorPreferencesCard />);
    expect(screen.getByLabelText('Privacy-Preserving Commit Email')).toBeChecked();
  });

  test('toggling privacy-preserving commit email on calls setPrivateCommitEmail', () => {
    render(<EditorPreferencesCard />);
    const toggle = screen.getByLabelText('Privacy-Preserving Commit Email');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setPrivateCommitEmail).toHaveBeenCalledWith(true);
  });
});
