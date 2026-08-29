import { render } from '@testing-library/react';
import { ProviderIcon } from '@/components/git/provider-icon';
import { GIT_PROVIDERS } from '@asciidocollab/shared';

describe('ProviderIcon', () => {
  test.each(GIT_PROVIDERS)('renders a distinct, decorative mark for %s', (provider) => {
    const { container } = render(<ProviderIcon provider={provider} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelector('path')).toHaveAttribute('d', expect.stringMatching(/.+/));
  });

  test('each provider renders a different path (no shared placeholder glyph)', () => {
    const paths = GIT_PROVIDERS.map((provider) => {
      const { container } = render(<ProviderIcon provider={provider} />);
      return container.querySelector('path')?.getAttribute('d');
    });
    expect(new Set(paths).size).toBe(GIT_PROVIDERS.length);
  });

  test('inherits color via currentColor so it flips with selected/unselected state', () => {
    const { container } = render(<ProviderIcon provider="github" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  test('defaults to h-4 w-4 to match the text-sm label, and accepts a className override', () => {
    const { container: withDefault } = render(<ProviderIcon provider="gitlab" />);
    expect(withDefault.querySelector('svg')).toHaveClass('h-4', 'w-4');

    const { container: withOverride } = render(<ProviderIcon provider="gitlab" className="h-5 w-5" />);
    expect(withOverride.querySelector('svg')).toHaveClass('h-5', 'w-5');
    expect(withOverride.querySelector('svg')).not.toHaveClass('h-4');
  });
});
