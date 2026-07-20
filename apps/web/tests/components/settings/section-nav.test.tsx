import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionNav } from '@/components/settings/section-nav';
import { visibleSettingsSections } from '@/components/settings/sections';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...rest }: React.ComponentProps<'a'>) => <a {...rest}>{children}</a>,
}));

const BASE = '/dashboard/projects/p1/settings';

function renderNav(overrides: Partial<React.ComponentProps<typeof SectionNav>> = {}) {
  const onSelect = overrides.onSelect ?? jest.fn();
  render(
    <SectionNav
      sections={overrides.sections ?? visibleSettingsSections(true)}
      current={overrides.current ?? 'general'}
      basePath={overrides.basePath ?? BASE}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe('SectionNav', () => {
  it('renders one entry per offered section', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: /sections/i });
    expect(nav).toBeInTheDocument();
    for (const section of visibleSettingsSections(true)) {
      expect(screen.getByRole('link', { name: section.label })).toBeInTheDocument();
    }
  });

  it('omits sections it was not given', () => {
    renderNav({ sections: visibleSettingsSections(false) });
    expect(screen.queryByRole('link', { name: 'Danger Zone' })).not.toBeInTheDocument();
  });

  it('links each section to its addressable URL', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'PDF Layout & Theme' })).toHaveAttribute('href', `${BASE}?section=pdf`);
  });

  it('marks the current section for assistive technology', () => {
    renderNav({ current: 'pdf' });
    expect(screen.getByRole('link', { name: 'PDF Layout & Theme' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'General' })).not.toHaveAttribute('aria-current');
  });

  it('reports a plain click to the page instead of navigating', () => {
    const onSelect = renderNav();
    const link = screen.getByRole('link', { name: 'AsciiDoc' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, event);
    expect(onSelect).toHaveBeenCalledWith('rendering');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a modified click to the browser so a section can open in a new tab', () => {
    const onSelect = renderNav();
    const link = screen.getByRole('link', { name: 'AsciiDoc' });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    fireEvent(link, event);
    expect(onSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
