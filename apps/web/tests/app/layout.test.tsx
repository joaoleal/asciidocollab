import React from 'react';
import { render, screen } from '@testing-library/react';

// next/font/google runs a build-time font loader that has no meaning under jest; every family the
// layout pulls in is stubbed with the class/variable shape the layout reads back.
jest.mock('next/font/google', () => ({
  Inter: () => ({ className: 'font-inter', variable: '--font-inter' }),
  Urbanist: () => ({ className: 'font-urbanist', variable: '--font-urbanist' }),
  Open_Sans: () => ({ className: 'font-open-sans', variable: '--font-asciidoctor-sans' }),
  Noto_Serif: () => ({ className: 'font-noto-serif', variable: '--font-asciidoctor-serif' }),
  Ubuntu_Mono: () => ({ className: 'font-ubuntu-mono', variable: '--font-asciidoctor-mono' }),
}));

// The `@/*` path mapping wins over the stylesheet mapping for `@/styles/globals.css`, so the raw
// Tailwind file would reach the transform; the layout only imports it for its side effect.
jest.mock('@/styles/globals.css', () => ({}));

const mockCookies = jest.fn();
jest.mock('next/headers', () => ({
  cookies: () => mockCookies(),
}));

jest.mock('@/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
}));

const { default: RootLayout, metadata } = require('@/app/layout');

/** Makes `cookies()` resolve to a store returning the given theme cookie, or none when null. */
function withThemeCookie(value: string | null) {
  mockCookies.mockResolvedValue({
    get: (name: string) => (name === 'asciidocollab-theme' && value !== null ? { name, value } : undefined),
  });
}

/**
 * The layout returns the document shell itself, which React will not mount inside a test container,
 * so the html/body elements are read off the returned element tree.
 */
async function shellFor(theme: string | null) {
  withThemeCookie(theme);
  const html = await RootLayout({ children: <span data-testid="child">page</span> });
  return { html, body: html.props.children };
}

describe('RootLayout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('wraps its children in the theme provider', async () => {
    const { body } = await shellFor(null);
    render(body.props.children);
    expect(screen.getByTestId('theme-provider')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  test('marks the document dark when the theme cookie says dark', async () => {
    const { html } = await shellFor('dark');
    expect(html.type).toBe('html');
    expect(html.props.className).toBe('dark');
  });

  test('leaves the document undarkened for a light theme cookie', async () => {
    const { html } = await shellFor('light');
    expect(html.props.className).toBe('');
  });

  test('falls back to the system theme when no cookie has been set', async () => {
    const { html } = await shellFor(null);
    expect(html.props.className).toBe('');
  });

  test('puts every font class and variable on the body', async () => {
    const { body } = await shellFor(null);
    expect(body.type).toBe('body');
    expect(body.props.className).toContain('font-inter');
    expect(body.props.className).toContain('--font-urbanist');
    expect(body.props.className).toContain('--font-asciidoctor-sans');
    expect(body.props.className).toContain('--font-asciidoctor-serif');
    expect(body.props.className).toContain('--font-asciidoctor-mono');
  });

  test('declares the application title and description as page metadata', () => {
    expect(metadata.title).toBe('AsciiDoCollab');
    expect(metadata.description).toBe('Collaborative AsciiDoc editor for technical publishing');
  });
});
