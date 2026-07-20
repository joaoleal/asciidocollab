import { fireEvent, render, screen } from '@testing-library/react';
import { ExtensionComparisonToggle } from '@/components/theme-editor/extension-comparison-toggle';

const EXTENSIONS = [
  { id: 'paragraph-numbering', displayName: 'Paragraph numbering' },
  { id: 'narrow-contents', displayName: 'Narrow contents' },
];

describe('ExtensionComparisonToggle — absent when there is nothing to compare (FR-031b3)', () => {
  it('renders nothing when no extension is enabled', () => {
    // An inert dropdown reading "compare without…" over an empty list is worse than no control: the
    // author tries it, nothing happens, and they have no way to tell whether it is broken.
    const { container } = render(
      <ExtensionComparisonToggle extensions={[]} withheldId={null} onWithhold={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders once an extension is enabled', () => {
    render(
      <ExtensionComparisonToggle extensions={EXTENSIONS} withheldId={null} onWithhold={jest.fn()} />,
    );
    expect(screen.getByTestId('extension-comparison-toggle')).toBeInTheDocument();
  });
});

describe('ExtensionComparisonToggle — selecting one extension to hold out (FR-031b1)', () => {
  it('offers every enabled extension by the name the author sees', () => {
    render(
      <ExtensionComparisonToggle extensions={EXTENSIONS} withheldId={null} onWithhold={jest.fn()} />,
    );
    expect(screen.getByRole('option', { name: 'without Paragraph numbering' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'without Narrow contents' })).toBeInTheDocument();
  });

  it('defaults to holding nothing out, so the preview shows what the project renders', () => {
    render(
      <ExtensionComparisonToggle extensions={EXTENSIONS} withheldId={null} onWithhold={jest.fn()} />,
    );
    expect(screen.getByTestId<HTMLSelectElement>('extension-comparison-toggle').value).toBe('');
  });

  it('reports the extension to hold out', () => {
    const onWithhold = jest.fn();
    render(
      <ExtensionComparisonToggle extensions={EXTENSIONS} withheldId={null} onWithhold={onWithhold} />,
    );
    fireEvent.change(screen.getByTestId('extension-comparison-toggle'), {
      target: { value: 'narrow-contents' },
    });
    expect(onWithhold).toHaveBeenCalledWith('narrow-contents');
  });

  it('reports null when the author goes back to showing all of them', () => {
    const onWithhold = jest.fn();
    render(
      <ExtensionComparisonToggle
        extensions={EXTENSIONS}
        withheldId="narrow-contents"
        onWithhold={onWithhold}
      />,
    );
    fireEvent.change(screen.getByTestId('extension-comparison-toggle'), { target: { value: '' } });
    expect(onWithhold).toHaveBeenCalledWith(null);
  });

  it('says plainly that the comparison affects only the preview (FR-031b1)', () => {
    // The control does not write to the project's selection, and an author who thought it did would
    // avoid using it on a document that matters.
    render(
      <ExtensionComparisonToggle
        extensions={EXTENSIONS}
        withheldId="narrow-contents"
        onWithhold={jest.fn()}
      />,
    );
    expect(screen.getByTestId('extension-comparison-state')).toHaveTextContent('Preview only');
  });

  it('shows no held-out state while everything is applied', () => {
    render(
      <ExtensionComparisonToggle extensions={EXTENSIONS} withheldId={null} onWithhold={jest.fn()} />,
    );
    expect(screen.queryByTestId('extension-comparison-state')).not.toBeInTheDocument();
  });
});

describe('ExtensionComparisonToggle — a selection that stopped being valid', () => {
  it('falls back to holding nothing out when the held id is no longer enabled', () => {
    // An extension disabled in settings while it was held out here would otherwise leave the control
    // naming something that is not on offer, while the preview quietly showed everything.
    render(
      <ExtensionComparisonToggle
        extensions={EXTENSIONS}
        withheldId="removed-extension"
        onWithhold={jest.fn()}
      />,
    );
    expect(screen.getByTestId<HTMLSelectElement>('extension-comparison-toggle').value).toBe('');
    expect(screen.queryByTestId('extension-comparison-state')).not.toBeInTheDocument();
  });
});
