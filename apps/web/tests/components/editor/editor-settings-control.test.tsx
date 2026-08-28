import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  EditorSettingsButton,
  EditorSettingsControl,
  EditorSettingsSurface,
} from '@/components/editor/editor-settings-control';

// The panel itself is exercised by its own suite; stubbing it here keeps this suite about the
// button/panel wiring rather than about Radix Select's portal behaviour.
jest.mock('@/components/editor/editor-settings-panel', () => ({
  EditorSettingsPanel: ({ fontSize, theme }: { fontSize: number; theme: string }) => (
    <div data-testid="settings-panel">{`${theme}:${fontSize}`}</div>
  ),
}));

const settings = {
  fontSize: 14,
  theme: 'default' as const,
  setFontSize: jest.fn(),
  setTheme: jest.fn(),
};

describe('EditorSettingsButton', () => {
  test('reports a click and reflects the open state on the button', () => {
    const onToggle = jest.fn();
    // The button carries a tooltip; a toolbar host supplies the provider it needs.
    const { rerender } = render(
      <Tooltip.Provider>
        <EditorSettingsButton open={false} onToggle={onToggle} />
      </Tooltip.Provider>,
    );
    const button = screen.getByRole('button', { name: /editor settings/i });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <Tooltip.Provider>
        <EditorSettingsButton open onToggle={onToggle} />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('button', { name: /editor settings/i })).toBeInTheDocument();
  });
});

describe('EditorSettingsSurface', () => {
  test('renders the settings panel with the values it was handed', () => {
    render(<EditorSettingsSurface {...settings} />);
    expect(screen.getByTestId('settings-panel')).toHaveTextContent('default:14');
  });
});

describe('EditorSettingsControl', () => {
  test('keeps the panel closed until the settings button is pressed', () => {
    render(<EditorSettingsControl {...settings} />);
    expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /editor settings/i }));
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
  });

  test('a second press on the settings button closes the panel again', () => {
    render(<EditorSettingsControl {...settings} />);
    const button = screen.getByRole('button', { name: /editor settings/i });
    fireEvent.click(button);
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByTestId('settings-panel')).not.toBeInTheDocument();
  });

  test('renders the leading content opposite the settings button', () => {
    render(<EditorSettingsControl {...settings} leading={<span>theme.yml</span>} />);
    expect(screen.getByText('theme.yml')).toBeInTheDocument();
  });
});
