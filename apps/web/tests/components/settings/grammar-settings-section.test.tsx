import { render, screen, fireEvent } from '@testing-library/react';
import { GrammarSettingsSection } from '@/components/settings/grammar-settings-section';

describe('GrammarSettingsSection', () => {
  test('toggles enabled and changes dialect for an English project', () => {
    const onEnabledChange = jest.fn();
    const onDialectChange = jest.fn();
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish
        canEdit
        onEnabledChange={onEnabledChange}
        onDialectChange={onDialectChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onEnabledChange).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText('English dialect'), { target: { value: 'en-US' } });
    expect(onDialectChange).toHaveBeenCalledWith('en-US');
  });

  test('disables the controls and explains why for a non-English project', () => {
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish={false}
        canEdit
        onEnabledChange={() => {}}
        onDialectChange={() => {}}
      />,
    );
    expect(screen.getByText(/Set the project language to English/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByLabelText('English dialect')).toBeDisabled();
  });

  test('makes the whole section inert and visibly disabled for a non-English project', () => {
    // Disabling only the two inputs left the heading and description at full contrast, so the
    // section still read as an active setting that simply refused to move.
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish={false}
        canEdit
        onEnabledChange={() => {}}
        onDialectChange={() => {}}
      />,
    );

    const group = screen.getByRole('group', { name: 'Grammar checking' });
    // A disabled fieldset takes its heading, description and both controls out of the tab order and
    // refuses clicks — nothing inside it can be reached, not just the inputs.
    expect(group).toBeDisabled();
    expect(group).toHaveAttribute('aria-disabled', 'true');
    expect(group).toHaveClass('disabled:opacity-60');
    expect(group).toContainElement(screen.getByRole('heading', { name: /grammar & spelling/i }));
    expect(screen.getByRole('heading', { name: /grammar & spelling/i })).toHaveClass(
      'text-muted-foreground',
    );
  });

  test('keeps the disabled controls out of the tab order', () => {
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish={false}
        canEdit
        onEnabledChange={() => {}}
        onDialectChange={() => {}}
      />,
    );
    const toggle = screen.getByRole('checkbox');
    toggle.focus();
    expect(toggle).not.toHaveFocus();

    const dialect = screen.getByLabelText('English dialect');
    dialect.focus();
    expect(dialect).not.toHaveFocus();
  });

  test('leaves the section active and undimmed for an English project', () => {
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish
        canEdit
        onEnabledChange={() => {}}
        onDialectChange={() => {}}
      />,
    );
    const group = screen.getByRole('group', { name: 'Grammar checking' });
    expect(group).not.toBeDisabled();
    expect(group).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('heading', { name: /grammar & spelling/i })).not.toHaveClass(
      'text-muted-foreground',
    );
    expect(screen.queryByText(/Set the project language to English/i)).not.toBeInTheDocument();
  });

  test('disables the controls for a viewer', () => {
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish
        canEdit={false}
        onEnabledChange={() => {}}
        onDialectChange={() => {}}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByLabelText('English dialect')).toBeDisabled();
    expect(screen.getByRole('group', { name: 'Grammar checking' })).toBeDisabled();
  });

  test('writes nothing for a viewer even if the controls are re-enabled behind its back', () => {
    // These settings are project-wide: the dialect and the enable flag change what every collaborator
    // checks against. `disabled` is only a rendering decision, so both handlers refuse as well — and
    // the server independently requires editor/owner on the render-config PUT that carries them.
    const onEnabledChange = jest.fn();
    const onDialectChange = jest.fn();
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish
        canEdit={false}
        onEnabledChange={onEnabledChange}
        onDialectChange={onDialectChange}
      />,
    );
    const toggle = screen.getByRole('checkbox');
    const dialect = screen.getByLabelText('English dialect');
    toggle.removeAttribute('disabled');
    dialect.removeAttribute('disabled');
    fireEvent.click(toggle);
    fireEvent.change(dialect, { target: { value: 'en-US' } });
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onDialectChange).not.toHaveBeenCalled();
  });

  test('writes nothing for a non-English project either, however the change arrives', () => {
    const onEnabledChange = jest.fn();
    const onDialectChange = jest.fn();
    render(
      <GrammarSettingsSection
        enabled
        dialect="en-GB"
        languageIsEnglish={false}
        canEdit
        onEnabledChange={onEnabledChange}
        onDialectChange={onDialectChange}
      />,
    );
    const toggle = screen.getByRole('checkbox');
    toggle.removeAttribute('disabled');
    fireEvent.click(toggle);
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onDialectChange).not.toHaveBeenCalled();
  });
});
