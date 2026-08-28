import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReviewItemDto } from '@asciidocollab/shared';
import { DetachedTray, type DetachedTrayEntry } from '@/components/review/detached-tray';
import { resolveReviewItem } from '@/lib/api/review';

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName, avatarKey }: { displayName: string; avatarKey: string | null }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'data-avatar-key': avatarKey ?? '', 'aria-label': displayName }),
}));

jest.mock('@/lib/api/review', () => ({
  resolveReviewItem: jest.fn().mockResolvedValue({}),
  reactToItem: jest.fn(),
  createReviewItem: jest.fn(),
  replyToThread: jest.fn(),
}));

const mockResolve = resolveReviewItem as jest.MockedFunction<typeof resolveReviewItem>;

const item = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: 'r1',
  documentId: 'd1',
  projectId: 'p1',
  kind: 'comment',
  body: 'Orphaned note',
  author: { id: 'u1', displayName: 'Alice', avatarKey: null },
  reactions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const entries: DetachedTrayEntry[] = [{ item: item(), state: 'detached' }];

describe('DetachedTray', () => {
  beforeEach(() => mockResolve.mockClear());

  test('renders nothing when there are no entries', () => {
    const { container } = render(<DetachedTray projectId="p1" entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('lists detached items and invokes onReattach', () => {
    const onReattach = jest.fn();
    render(<DetachedTray projectId="p1" entries={entries} onReattach={onReattach} />);
    expect(screen.getByTestId('detached-tray')).toBeInTheDocument();
    expect(screen.getByText('Orphaned note')).toBeInTheDocument();
    expect(screen.getByTestId('detached-tray-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('detached-reattach'));
    expect(onReattach).toHaveBeenCalledWith('r1');
  });

  test('Resolve calls resolveReviewItem and then onChanged', async () => {
    const onChanged = jest.fn();
    render(<DetachedTray projectId="p1" entries={entries} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('detached-resolve'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith('p1', 'r1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('readOnly hides Reattach and Resolve', () => {
    render(<DetachedTray projectId="p1" entries={entries} onReattach={jest.fn()} readOnly />);
    expect(screen.queryByTestId('detached-reattach')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detached-resolve')).not.toBeInTheDocument();
  });

  test('a section-degraded entry shows the "On section" indicator instead of "Detached"', () => {
    render(<DetachedTray projectId="p1" entries={[{ item: item(), state: 'section' }]} />);
    expect(screen.getByText('On section')).toBeInTheDocument();
    expect(screen.queryByText('Detached', { selector: 'span' })).not.toBeInTheDocument();
  });

  test('truncates a long body to a single-line preview', () => {
    const longBody = `${'word '.repeat(40)}tail`;
    render(<DetachedTray projectId="p1" entries={[{ item: item({ body: longBody }), state: 'detached' }]} />);

    const preview = screen.getByText(/^word word/);
    expect(preview.textContent).toHaveLength(80);
    expect(preview.textContent?.endsWith('…')).toBe(true);
  });

  test('resolving without a change listener still calls the API', async () => {
    render(<DetachedTray projectId="p1" entries={entries} />);
    fireEvent.click(screen.getByTestId('detached-resolve'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith('p1', 'r1'));
  });

  test('collapsing the tray hides its rows', () => {
    render(<DetachedTray projectId="p1" entries={entries} />);
    expect(screen.getByText('Orphaned note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('Orphaned note')).not.toBeInTheDocument();
  });
});
