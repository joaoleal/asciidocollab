import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalError from '@/app/global-error';

const THROWN = Object.assign(new Error('root layout exploded'), { digest: 'abc123' });

describe('GlobalError', () => {
  test('tells the reader something went wrong instead of leaving a blank document', () => {
    render(<GlobalError error={THROWN} reset={jest.fn()} />);
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  test('offers a retry that resets the error boundary', () => {
    const reset = jest.fn();
    render(<GlobalError error={THROWN} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test('does not surface the thrown error text or its digest to the reader', () => {
    render(<GlobalError error={THROWN} reset={jest.fn()} />);
    expect(screen.queryByText(/root layout exploded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/abc123/)).not.toBeInTheDocument();
  });
});
