import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';

// The hook is mocked so the test drives the rendered HTML directly (the click delegation is under test,
// not the worker render).
jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
const mockUsePreview = useAsciidocPreview as jest.Mock;
const fakeReference: React.RefObject<HTMLDivElement> = { current: null };

function withHtml(html: string): void {
  mockUsePreview.mockReturnValue({
    html,
    state: 'up-to-date',
    error: null,
    previewRef: fakeReference,
    mathPresent: false,
  });
}

function renderPreview(onNavigateToSource: jest.Mock) {
  return render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      onNavigateToSource={onNavigateToSource}
    />,
  );
}

beforeEach(() => mockUsePreview.mockReset());

describe('AsciiDocPreview click-to-source and link following', () => {
  it('navigates to a clicked block’s source line', () => {
    withHtml('<p id="b1" data-source-line="7">Body</p>');
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview(onNavigateToSource);
    fireEvent.click(container.querySelector('#b1')!);
    expect(onNavigateToSource).toHaveBeenCalledWith(7);
  });

  it('navigates using the nearest ancestor carrying data-source-line', () => {
    withHtml('<div data-source-line="3"><span id="inner">word</span></div>');
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview(onNavigateToSource);
    fireEvent.click(container.querySelector('#inner')!);
    expect(onNavigateToSource).toHaveBeenCalledWith(3);
  });

  it('does not navigate when the clicked block has no source line', () => {
    withHtml('<p id="b1">Body</p>');
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview(onNavigateToSource);
    fireEvent.click(container.querySelector('#b1')!);
    expect(onNavigateToSource).not.toHaveBeenCalled();
  });

  it('follows an internal cross-reference by scrolling to its target, not jumping to source', () => {
    withHtml(
      '<a id="lnk" href="#sec2" data-source-line="4">see</a><h2 id="sec2" data-source-line="9">Section</h2>',
    );
    const onNavigateToSource = jest.fn();
    // jsdom does not implement scrollIntoView, so install a mock rather than spying on it.
    const scrollSpy = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const { container } = renderPreview(onNavigateToSource);
    fireEvent.click(container.querySelector('#lnk')!);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(onNavigateToSource).not.toHaveBeenCalled();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it('opens an external link in a hardened new tab and does not jump to source', () => {
    withHtml('<a id="ext" href="https://example.com/docs" data-source-line="4">site</a>');
    const onNavigateToSource = jest.fn();
    const openSpy = jest.spyOn(globalThis, 'open').mockImplementation(() => null);
    const { container } = renderPreview(onNavigateToSource);
    fireEvent.click(container.querySelector('#ext')!);
    expect(openSpy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(onNavigateToSource).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
