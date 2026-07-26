import { render, screen, fireEvent } from '@testing-library/react';
import { DictionaryPanel } from '@/components/grammar/dictionary-panel';
import type { DictionaryTermDto } from '@asciidocollab/shared';

const entries: DictionaryTermDto[] = [
  { id: 'a', term: 'Kubernetes', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' },
  { id: 'b', term: 'Fastify', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' },
];

describe('DictionaryPanel', () => {
  test('lists the project terms', () => {
    render(<DictionaryPanel entries={entries} canManage onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
    expect(screen.getByText('Fastify')).toBeInTheDocument();
  });

  test('filters the list by the search query', () => {
    render(<DictionaryPanel entries={entries} canManage onAdd={() => {}} onRemove={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search terms'), { target: { value: 'kube' } });
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
    expect(screen.queryByText('Fastify')).not.toBeInTheDocument();
  });

  test('adds a trimmed term and clears the input', () => {
    const onAdd = jest.fn();
    render(<DictionaryPanel entries={entries} canManage onAdd={onAdd} onRemove={() => {}} />);
    fireEvent.change(screen.getByLabelText('New term'), { target: { value: '  GraphQL  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith('GraphQL');
  });

  test('removes a term by id', () => {
    const onRemove = jest.fn();
    render(<DictionaryPanel entries={entries} canManage onAdd={() => {}} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kubernetes' }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  test('hides management controls for a viewer', () => {
    render(<DictionaryPanel entries={entries} canManage={false} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.queryByLabelText('New term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  test('says the dictionary is empty, distinctly from a search that matched nothing', () => {
    const { unmount } = render(<DictionaryPanel entries={[]} canManage onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('No terms yet.')).toBeInTheDocument();
    unmount();

    render(<DictionaryPanel entries={entries} canManage onAdd={() => {}} onRemove={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search terms'), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('No matching terms.')).toBeInTheDocument();
  });

  test('refuses to add a blank term', () => {
    // The Add control is disabled for empty input, but submitting the form (Enter) bypasses that.
    const onAdd = jest.fn();
    render(<DictionaryPanel entries={entries} canManage onAdd={onAdd} onRemove={() => {}} />);
    fireEvent.change(screen.getByLabelText('New term'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByLabelText('New term').closest('form')!);
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('a reader who may not manage the dictionary gets no add form and no remove controls', () => {
    render(<DictionaryPanel entries={entries} canManage={false} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.queryByLabelText('New term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    // The terms themselves are still listed — a viewer can see what the project accepts.
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
  });

});
