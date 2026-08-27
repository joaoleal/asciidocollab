import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConflictMergeEditor } from '@/components/git/conflict-merge-editor';
import { getConflictStages } from '@/lib/api/git';
import type { ConflictStagesDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({
  getConflictStages: jest.fn(),
}));

// CodeMirror's real MergeView needs layout APIs jsdom does not implement, so it is mocked here (same
// spirit as the asciidoc-editor test's `@codemirror/view` mock) — a light DOM stand-in exposing just
// the surface this component actually uses: an editable "ours" field, a read-only "theirs" display,
// and `.a.state.doc.toString()` for reading the edited buffer back out on save.
jest.mock('@codemirror/merge', () => {
  class MockMergeView {
    a: { state: { doc: { toString: () => string } } };
    b: { state: { doc: { toString: () => string } } };
    dom: HTMLElement;
    private oursField: HTMLTextAreaElement;

    constructor(config: {
      a: { doc?: string };
      b: { doc?: string };
      parent: Element | DocumentFragment;
    }) {
      this.dom = document.createElement('div');
      this.oursField = document.createElement('textarea');
      this.oursField.dataset['testid'] = 'merge-ours';
      this.oursField.value = typeof config.a.doc === 'string' ? config.a.doc : '';
      this.oursField.addEventListener('input', () => {
        // Reflects edits back onto the field itself — read via `.value` below.
      });
      this.dom.append(this.oursField);

      const theirsField = document.createElement('pre');
      theirsField.dataset['testid'] = 'merge-theirs';
      theirsField.textContent = typeof config.b.doc === 'string' ? config.b.doc : '';
      this.dom.append(theirsField);

      this.a = { state: { doc: { toString: () => this.oursField.value } } };
      this.b = { state: { doc: { toString: () => theirsField.textContent ?? '' } } };
      config.parent.append(this.dom);
    }

    destroy() {
      this.dom.remove();
    }
  }

  return { MergeView: MockMergeView };
});

const mockGetConflictStages = getConflictStages as jest.MockedFunction<typeof getConflictStages>;

const STAGES: ConflictStagesDto = {
  base: 'base text',
  ours: 'ours text',
  theirs: 'theirs text',
  isBinary: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

function oursField(): HTMLTextAreaElement {
  return screen.getByTestId('merge-ours');
}

describe('ConflictMergeEditor loading', () => {
  it('shows a loading state, then the editor once stages resolve', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByText(/loading merge editor/i)).toBeInTheDocument();
    await waitFor(() => expect(oursField()).toHaveValue('ours text'));
    expect(screen.getByTestId('merge-theirs')).toHaveTextContent('theirs text');
    expect(mockGetConflictStages).toHaveBeenCalledWith('proj1', 'a.adoc');
  });

  it('shows an error state on an HTTP failure, not stuck on loading', async () => {
    mockGetConflictStages.mockRejectedValue(new Error('boom'));
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(screen.queryByText(/loading merge editor/i)).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load/i);
  });

  it('shows an error state on a network failure, not stuck on loading', async () => {
    mockGetConflictStages.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(screen.queryByText(/loading merge editor/i)).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load/i);
  });

  it('shows binary guidance with no editor for a binary conflict', async () => {
    mockGetConflictStages.mockResolvedValue({ base: null, ours: '', theirs: '', isBinary: true });
    render(<ConflictMergeEditor projectId="proj1" path="logo.png" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/binary file/i)).toBeInTheDocument());
    expect(screen.queryByTestId('merge-ours')).not.toBeInTheDocument();
  });

  it('shows modify/delete guidance with no editor when "ours" deleted the file', async () => {
    mockGetConflictStages.mockResolvedValue({ base: 'base text', ours: null, theirs: 'theirs text', isBinary: false });
    render(<ConflictMergeEditor projectId="proj1" path="gone.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/modified on one side and deleted on the other/i)).toBeInTheDocument());
    expect(screen.queryByTestId('merge-ours')).not.toBeInTheDocument();
  });

  it('shows modify/delete guidance with no editor when "theirs" deleted the file', async () => {
    mockGetConflictStages.mockResolvedValue({ base: 'base text', ours: 'ours text', theirs: null, isBinary: false });
    render(<ConflictMergeEditor projectId="proj1" path="gone.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/modified on one side and deleted on the other/i)).toBeInTheDocument());
    expect(screen.queryByTestId('merge-ours')).not.toBeInTheDocument();
  });
});

describe('ConflictMergeEditor save', () => {
  it('calls onSave with the edited "ours" buffer', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    const onSave = jest.fn();
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={onSave} onCancel={jest.fn()} />);

    await waitFor(() => expect(oursField()).toHaveValue('ours text'));
    fireEvent.change(oursField(), { target: { value: 'the final merged text' } });
    fireEvent.click(screen.getByRole('button', { name: /save merge/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('the final merged text'));
  });

  it('keeps the Save button disabled while the resolve promise is pending, re-enabling once it settles', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    let settleResolve: (() => void) | undefined;
    const onSave = jest.fn(
      () =>
        new Promise<void>((resolveSave) => {
          settleResolve = resolveSave;
        }),
    );
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={onSave} onCancel={jest.fn()} />);

    await waitFor(() => expect(oursField()).toHaveValue('ours text'));
    const saveButton = screen.getByRole('button', { name: /save merge/i });
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    // While the resolve promise is still in flight the button must stay disabled, so a second click
    // cannot start a duplicate concurrent resolve.
    await waitFor(() => expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled());
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /saving/i }));
    expect(onSave).toHaveBeenCalledTimes(1);

    // Only once the resolve settles may the button re-enable.
    settleResolve?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /save merge/i })).toBeEnabled());
  });

  it('re-enables the Save button after a rejected resolve so the author can retry', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    let rejectResolve: ((reason: unknown) => void) | undefined;
    const onSave = jest.fn(
      () =>
        new Promise<void>((_resolveSave, reject) => {
          rejectResolve = reject;
        }),
    );
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={onSave} onCancel={jest.fn()} />);

    await waitFor(() => expect(oursField()).toHaveValue('ours text'));
    fireEvent.click(screen.getByRole('button', { name: /save merge/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled());

    rejectResolve?.(new Error('resolve failed'));
    await waitFor(() => expect(screen.getByRole('button', { name: /save merge/i })).toBeEnabled());
  });

  it('calls onCancel without saving', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    const onSave = jest.fn();
    const onCancel = jest.fn();
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={onSave} onCancel={onCancel} />);

    await waitFor(() => expect(oursField()).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the base content for reference when a merge base exists', async () => {
    mockGetConflictStages.mockResolvedValue(STAGES);
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(oursField()).toBeInTheDocument());
    expect(screen.getByText(/base \(common ancestor\)/i)).toBeInTheDocument();
    expect(screen.getByText('base text')).toBeInTheDocument();
  });

  it('omits the base section for an add/add conflict with no merge base', async () => {
    mockGetConflictStages.mockResolvedValue({ ...STAGES, base: null });
    render(<ConflictMergeEditor projectId="proj1" path="a.adoc" onSave={jest.fn()} onCancel={jest.fn()} />);

    await waitFor(() => expect(oursField()).toBeInTheDocument());
    expect(screen.queryByText(/base \(common ancestor\)/i)).not.toBeInTheDocument();
  });
});
