import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const { default: ForbiddenPage } = require('@/app/403/page');

describe('ForbiddenPage', () => {
  test('states the refusal rather than showing a blank page', () => {
    render(<ForbiddenPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('403');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Not Authorised');
    expect(screen.getByText(/do not have permission to access this page/i)).toBeInTheDocument();
  });

  test('offers a way back to the dashboard', () => {
    render(<ForbiddenPage />);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });
});
