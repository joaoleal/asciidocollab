import { render, screen, fireEvent } from '@testing-library/react';
import { GrammarScopeToggle } from '@/components/grammar/grammar-scope-toggle';

describe('GrammarScopeToggle', () => {
  test('marks the current scope and switches on click', () => {
    const onScopeChange = jest.fn();
    render(<GrammarScopeToggle scope="this-file" onScopeChange={onScopeChange} />);
    expect(screen.getByRole('radio', { name: 'This file' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Whole document' }));
    expect(onScopeChange).toHaveBeenCalledWith('whole-document');
  });

  test('offers exactly the two document scopes, this file first', () => {
    render(<GrammarScopeToggle scope="whole-document" onScopeChange={() => {}} />);
    const options = screen.getAllByRole('radio').map((option) => option.textContent);
    expect(options).toEqual(['This file', 'Whole document']);
    expect(screen.getByRole('radio', { name: 'Whole document' })).toHaveAttribute('aria-checked', 'true');
  });
});
