import { render, screen } from '@testing-library/react';
import { GrammarStatus } from '@/components/grammar/grammar-status';

describe('GrammarStatus', () => {
  test('renders nothing when the engine is not active', () => {
    const { container } = render(<GrammarStatus counts={{ spelling: 3, grammar: 1, style: 0 }} engineReady={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the on-device indicator and per-category counts when active', () => {
    render(<GrammarStatus counts={{ spelling: 3, grammar: 1, style: 2 }} engineReady />);
    expect(screen.getByText('On-device')).toBeInTheDocument();
    expect(screen.getByTitle('Spelling issues')).toHaveTextContent('3');
    expect(screen.getByTitle('Grammar issues')).toHaveTextContent('1');
    expect(screen.getByTitle('Style issues')).toHaveTextContent('2');
  });
});
