import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainFileField } from '@/components/settings/main-file-field';
import { fetchProjectFileTree } from '@/lib/api/file-tree';

jest.mock('@/lib/api/file-tree', () => ({ fetchProjectFileTree: jest.fn() }));

const mockFetchTree = jest.mocked(fetchProjectFileTree);

// A project file tree: root → docs/ (guide.adoc, image.png) + readme.adoc.
const TREE = {
  id: 'root',
  name: '',
  type: 'folder' as const,
  path: '',
  parentId: null,
  children: [
    {
      id: 'docs',
      name: 'docs',
      type: 'folder' as const,
      path: 'docs',
      parentId: 'root',
      children: [
        {
          id: 'guide',
          name: 'guide.adoc',
          type: 'file' as const,
          path: 'docs/guide.adoc',
          parentId: 'docs',
          children: [],
        },
        {
          id: 'img',
          name: 'image.png',
          type: 'file' as const,
          path: 'docs/image.png',
          parentId: 'docs',
          children: [],
        },
      ],
    },
    {
      id: 'readme',
      name: 'readme.adoc',
      type: 'file' as const,
      path: 'readme.adoc',
      parentId: 'root',
      children: [],
    },
  ],
};

beforeEach(() => {
  mockFetchTree.mockReset();
  mockFetchTree.mockResolvedValue(TREE);
});

describe('MainFileField', () => {
  test('lists only the AsciiDoc files, with an option that clears the setting', async () => {
    render(<MainFileField projectId="p1" value={null} disabled={false} onChange={() => {}} />);
    await screen.findByRole('option', { name: 'docs/guide.adoc' });

    const select = screen.getByLabelText('Main file');
    const values = [...select.querySelectorAll('option')].map((option) => option.value);
    expect(values).toContain('guide');
    expect(values).toContain('readme');
    expect(values).not.toContain('img'); // image.png is not an AsciiDoc file
    expect(values).not.toContain('docs'); // folders cannot be the main file
    expect(values).toContain(''); // the "not set" option
  });

  test('shows the staged selection', async () => {
    render(<MainFileField projectId="p1" value="readme" disabled={false} onChange={() => {}} />);
    await screen.findByRole('option', { name: 'readme.adoc' });
    expect(screen.getByLabelText('Main file')).toHaveValue('readme');
  });

  test('reports a chosen file to the enclosing form instead of storing it', async () => {
    const onChange = jest.fn();
    render(<MainFileField projectId="p1" value={null} disabled={false} onChange={onChange} />);
    await screen.findByRole('option', { name: 'docs/guide.adoc' });

    fireEvent.change(screen.getByLabelText('Main file'), { target: { value: 'guide' } });
    expect(onChange).toHaveBeenCalledWith('guide');
  });

  test('reports clearing the main file as null', async () => {
    const onChange = jest.fn();
    render(<MainFileField projectId="p1" value="guide" disabled={false} onChange={onChange} />);
    await screen.findByRole('option', { name: 'docs/guide.adoc' });

    fireEvent.change(screen.getByLabelText('Main file'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('keeps the stored main file selected when the file tree cannot be read', async () => {
    // A select whose value matches no option renders blank, which would say the project has no main
    // file — and a save made from that state would clear one the project actually has.
    mockFetchTree.mockRejectedValue(new Error('tree unavailable'));
    render(<MainFileField projectId="p1" value="node-9" disabled={false} onChange={() => {}} />);
    expect(await screen.findByRole('option', { name: /current main file/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Main file')).toHaveValue('node-9');
  });

  test('refuses edits when the field is disabled', async () => {
    render(<MainFileField projectId="p1" value={null} disabled onChange={() => {}} />);
    await screen.findByRole('option', { name: 'docs/guide.adoc' });
    expect(screen.getByLabelText('Main file')).toBeDisabled();
  });
});
