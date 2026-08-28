import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ReviewViewStateProvider,
  useReviewViewState,
  useReviewViewStateOptional,
} from '@/components/review/view-state';

/** Reads the required view-state and exposes both signals plus controls to change them. */
function RequiredConsumer() {
  const { hoveredItemId, setHoveredItemId, activeThreadId, setActiveThreadId } = useReviewViewState();
  return (
    <div>
      <span data-testid="hovered">{hoveredItemId ?? 'none'}</span>
      <span data-testid="active">{activeThreadId ?? 'none'}</span>
      <button type="button" onClick={() => setHoveredItemId('item-1')}>
        hover item
      </button>
      <button type="button" onClick={() => setHoveredItemId(null)}>
        clear hover
      </button>
      <button type="button" onClick={() => setActiveThreadId('thread-9')}>
        focus thread
      </button>
      <button type="button" onClick={() => setActiveThreadId(null)}>
        clear thread
      </button>
    </div>
  );
}

/** Reads the optional view-state, reporting whether a provider was found. */
function OptionalConsumer() {
  const viewState = useReviewViewStateOptional();
  return <span data-testid="optional">{viewState === null ? 'standalone' : 'linked'}</span>;
}

describe('ReviewViewStateProvider', () => {
  test('starts with nothing hovered and no active thread', () => {
    render(
      <ReviewViewStateProvider>
        <RequiredConsumer />
      </ReviewViewStateProvider>,
    );
    expect(screen.getByTestId('hovered')).toHaveTextContent('none');
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });

  test('publishes the hovered item id to consumers and clears it again', () => {
    render(
      <ReviewViewStateProvider>
        <RequiredConsumer />
      </ReviewViewStateProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'hover item' }));
    expect(screen.getByTestId('hovered')).toHaveTextContent('item-1');
    fireEvent.click(screen.getByRole('button', { name: 'clear hover' }));
    expect(screen.getByTestId('hovered')).toHaveTextContent('none');
  });

  test('publishes the active thread id independently of the hovered item', () => {
    render(
      <ReviewViewStateProvider>
        <RequiredConsumer />
      </ReviewViewStateProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'focus thread' }));
    expect(screen.getByTestId('active')).toHaveTextContent('thread-9');
    expect(screen.getByTestId('hovered')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'clear thread' }));
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });
});

describe('useReviewViewState', () => {
  test('throws when no provider is mounted above it', () => {
    // React logs the thrown render error; silence it so the expected failure does not read as noise.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<RequiredConsumer />)).toThrow(
      /must be used within a ReviewViewStateProvider/,
    );
    consoleError.mockRestore();
  });
});

describe('useReviewViewStateOptional', () => {
  test('reports the ambient view-state when a provider is mounted', () => {
    render(
      <ReviewViewStateProvider>
        <OptionalConsumer />
      </ReviewViewStateProvider>,
    );
    expect(screen.getByTestId('optional')).toHaveTextContent('linked');
  });

  test('renders standalone when no provider is mounted', () => {
    render(<OptionalConsumer />);
    expect(screen.getByTestId('optional')).toHaveTextContent('standalone');
  });
});
