import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConflictPanel, conflictBadgeStyle, describeCompleteFailure, describeConflictFailure } from '@/components/git/conflict-panel';
import { ApiError } from '@/lib/api/transport';
import type { ConflictSummaryDto } from '@asciidocollab/shared';

const mockGetConflictStages = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getConflictStages: (...parameters: unknown[]) => mockGetConflictStages(...parameters),
}));

// Same light DOM stand-in as `conflict-merge-editor.test.tsx` — the nested `ConflictMergeEditor`
// mounts a real `MergeView` when "Edit merge…" is chosen for a non-binary file, and CodeMirror's real
// merge view needs layout APIs jsdom does not implement.
jest.mock('@codemirror/merge', () => {
  class MockMergeView {
    a: { state: { doc: { toString: () => string } } };
    dom: HTMLElement;
    private oursField: HTMLTextAreaElement;

    constructor(config: { a: { doc?: string }; b: { doc?: string }; parent: Element | DocumentFragment }) {
      this.dom = document.createElement('div');
      this.oursField = document.createElement('textarea');
      this.oursField.dataset['testid'] = 'merge-ours';
      this.oursField.value = typeof config.a.doc === 'string' ? config.a.doc : '';
      this.dom.append(this.oursField);
      this.a = { state: { doc: { toString: () => this.oursField.value } } };
      config.parent.append(this.dom);
    }

    destroy() {
      this.dom.remove();
    }
  }

  return { MergeView: MockMergeView };
});

const FILES: ConflictSummaryDto[] = [
  { path: 'a.adoc', isBinary: false, resolved: false },
  { path: 'logo.png', isBinary: true, resolved: true },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof ConflictPanel>> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const resolve = overrides.resolve ?? jest.fn().mockResolvedValue(undefined);
  const complete = overrides.complete ?? jest.fn();
  const undo = overrides.undo ?? jest.fn();
  render(
    <ConflictPanel
      projectId="proj1"
      open={overrides.open ?? true}
      onOpenChange={onOpenChange}
      files={overrides.files ?? FILES}
      loading={overrides.loading ?? false}
      error={overrides.error ?? null}
      allResolved={overrides.allResolved ?? false}
      resolve={resolve}
      complete={complete}
      undo={undo}
      completing={overrides.completing ?? false}
      message={overrides.message ?? null}
    />,
  );
  return { onOpenChange, resolve, complete, undo };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ConflictPanel loading/empty/error states', () => {
  it('shows a loading state', () => {
    renderPanel({ loading: true, files: [] });
    expect(screen.getByText(/loading conflicts/i)).toBeInTheDocument();
  });

  it('shows an HTTP-error state, not stuck on loading', () => {
    renderPanel({ loading: false, error: 'Failed to load conflicts.', files: [] });
    expect(screen.queryByText(/loading conflicts/i)).not.toBeInTheDocument();
    expect(screen.getByText('Failed to load conflicts.')).toBeInTheDocument();
  });

  it('shows an empty state once loaded with nothing to resolve', () => {
    renderPanel({ loading: false, files: [] });
    expect(screen.getByText(/no conflicting files/i)).toBeInTheDocument();
  });

  it('shows the network-failure error state the same way as any other unexpected load failure', () => {
    renderPanel({ loading: false, error: 'Failed to load conflicts.', files: [] });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load conflicts.');
  });
});

describe('ConflictPanel file list', () => {
  it('lists every conflicting file with a resolved/unresolved badge', () => {
    renderPanel();
    expect(screen.getByText('a.adoc')).toBeInTheDocument();
    expect(screen.getByText('logo.png')).toBeInTheDocument();
    expect(screen.getByText('Unresolved')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('shows no Edit merge affordance for a binary file', () => {
    renderPanel();
    const logoRow = screen.getByText('logo.png').closest('li')!;
    expect(within(logoRow).queryByText(/edit merge/i)).not.toBeInTheDocument();
  });

  it('shows an Edit merge affordance for a non-binary file', () => {
    renderPanel();
    const textRow = screen.getByText('a.adoc').closest('li')!;
    expect(within(textRow).getByText(/edit merge/i)).toBeInTheDocument();
  });

  it('Keep ours calls resolve with the ours resolution', () => {
    const { resolve } = renderPanel();
    const textRow = screen.getByText('a.adoc').closest('li')!;
    fireEvent.click(within(textRow).getByRole('button', { name: /keep ours/i }));
    expect(resolve).toHaveBeenCalledWith('a.adoc', 'ours', undefined);
  });

  it('Take theirs calls resolve with the theirs resolution', () => {
    const { resolve } = renderPanel();
    const textRow = screen.getByText('a.adoc').closest('li')!;
    fireEvent.click(within(textRow).getByRole('button', { name: /take theirs/i }));
    expect(resolve).toHaveBeenCalledWith('a.adoc', 'theirs', undefined);
  });

  it('surfaces a mapped error when a resolve attempt fails', async () => {
    const resolve = jest.fn().mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    renderPanel({ resolve });
    const textRow = screen.getByText('a.adoc').closest('li')!;
    fireEvent.click(within(textRow).getByRole('button', { name: /keep ours/i }));

    expect(await screen.findByText('You need editor access to resolve conflicts.')).toBeInTheDocument();
  });

  it('opens the merge editor for a non-binary file and saves through resolve', async () => {
    mockGetConflictStages.mockResolvedValue({ base: null, ours: 'ours text', theirs: 'theirs text', isBinary: false });
    const { resolve } = renderPanel();
    const textRow = screen.getByText('a.adoc').closest('li')!;
    fireEvent.click(within(textRow).getByRole('button', { name: /edit merge/i }));

    const oursField = await screen.findByTestId('merge-ours');
    fireEvent.change(oursField, { target: { value: 'final merged text' } });
    fireEvent.click(screen.getByRole('button', { name: /save merge/i }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith('a.adoc', 'merged', 'final merged text'));
  });
});

describe('ConflictPanel Complete gate', () => {
  it('disables Complete while any file is unresolved', () => {
    renderPanel({ allResolved: false });
    expect(screen.getByRole('button', { name: /^complete$/i })).toBeDisabled();
  });

  it('enables Complete once every file is resolved', () => {
    renderPanel({ allResolved: true });
    expect(screen.getByRole('button', { name: /^complete$/i })).toBeEnabled();
  });

  it('disables Complete while completing even if all files are resolved', () => {
    renderPanel({ allResolved: true, completing: true });
    for (const button of screen.getAllByRole('button', { name: /working/i })) {
      expect(button).toBeDisabled();
    }
  });

  it('calls complete when Complete is clicked', () => {
    const { complete } = renderPanel({ allResolved: true });
    fireEvent.click(screen.getByRole('button', { name: /^complete$/i }));
    expect(complete).toHaveBeenCalled();
  });
});

describe('ConflictPanel undo', () => {
  it('calls undo when Undo pull is clicked', () => {
    const { undo } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /undo pull/i }));
    expect(undo).toHaveBeenCalled();
  });

  it('shows the outcome message from a completed/undone attempt', () => {
    renderPanel({ message: { tone: 'error', text: 'There is no paused pull to undo.' } });
    expect(screen.getByText('There is no paused pull to undo.')).toBeInTheDocument();
  });
});

describe('ConflictPanel accessibility', () => {
  it('renders a real Dialog.Description', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/resolve each conflicting file/i);
  });

  it('stays open on Escape', () => {
    const { onOpenChange } = renderPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cannot be dismissed by an outside click', () => {
    const { onOpenChange } = renderPanel();
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('conflictBadgeStyle', () => {
  it('maps resolved/unresolved to distinct tokenized styles', () => {
    expect(conflictBadgeStyle(true).label).toBe('Resolved');
    expect(conflictBadgeStyle(false).label).toBe('Unresolved');
  });
});

describe('describeCompleteFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to do this.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['unresolved_conflicts', 'Every conflicting file must be resolved first.'],
    ['nothing_to_undo', 'There is no paused pull to undo.'],
    ['some_unmapped_code', "Couldn't complete the pull."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describeCompleteFailure(new ApiError(409, code, 'server said so'))).toBe(expectedMessage);
  });

  it('falls back to the generic message for a non-ApiError', () => {
    expect(describeCompleteFailure(new Error('boom'))).toBe("Couldn't complete the pull.");
  });
});

describe('describeConflictFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to resolve conflicts.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['validation_error', 'Enter the merged content before saving.'],
    ['some_unmapped_code', "Couldn't resolve this file."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describeConflictFailure(new ApiError(422, code, 'server said so'))).toBe(expectedMessage);
  });

  it('falls back to the generic message for a non-ApiError', () => {
    expect(describeConflictFailure(new Error('boom'))).toBe("Couldn't resolve this file.");
  });
});
