import { createLinkHandler, xrefHoverPreview } from '@/lib/codemirror/asciidoc-link-handler';
import { buildProjectSymbolIndex, makeIncludeResolver } from '@/lib/codemirror/asciidoc-symbol-index';
import type { EditorView } from '@codemirror/view';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';

type MockView = Pick<EditorView, 'state' | 'posAtCoords'>;

function createMockView(content: string, clickPosition: number): MockView {
  return {
    state: {
      doc: {
        toString: () => content,
        lineAt: (position: number) => {
          const lines = content.split('\n');
          let offset = 0;
          for (const line of lines) {
            if (offset + line.length >= position) {
              return { from: offset, to: offset + line.length, number: 1, text: line };
            }
            offset += line.length + 1;
          }
          return { from: 0, to: content.length, number: 1, text: content };
        },
      },
    } as EditorView['state'],
    posAtCoords: (_coords: { x: number; y: number }) => clickPosition,
  };
}

describe('createLinkHandler', () => {
  test('Ctrl+click on include:: path calls onNavigateToFile', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    const content = 'include::chapters/intro.adoc[]\nSome text';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onNavigateToFile).toHaveBeenCalledWith('chapters/intro.adoc');
  });

  test('Ctrl+click on link: URL calls onOpenUrl', () => {
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onOpenUrl });
    const content = 'Visit link:https://example.com[text]';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com');
  });

  test('Ctrl+click on bare URL calls onOpenUrl', () => {
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onOpenUrl });
    const content = 'Go to https://example.com for info';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 15),
    );

    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com');
  });

  test('Ctrl+click on include:: path with .. does not call either callback', () => {
    const onNavigateToFile = jest.fn();
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onOpenUrl });
    const content = 'include::../secret.adoc[]\nSome text';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onNavigateToFile).not.toHaveBeenCalled();
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  test('Ctrl+click on absolute include path does not call either callback', () => {
    const onNavigateToFile = jest.fn();
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onOpenUrl });
    const content = 'include::/etc/passwd[]\nSome text';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onNavigateToFile).not.toHaveBeenCalled();
  });

  test('plain click (no Ctrl) does not trigger navigation', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    const content = 'include::chapters/intro.adoc[]';

    handler.handleMousedown(
      { ctrlKey: false, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onNavigateToFile).not.toHaveBeenCalled();
  });

  test('Ctrl+click on non-navigable content does not call either callback', () => {
    const onNavigateToFile = jest.fn();
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onOpenUrl });
    const content = 'Hello world this is plain text';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 5),
    );

    expect(onNavigateToFile).not.toHaveBeenCalled();
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  test('unresolvable include:: path calls onUnresolvedPath', () => {
    const onNavigateToFile = jest.fn();
    const onUnresolvedPath = jest.fn();
    const availablePaths = ['chapters/intro.adoc'];
    const handler = createLinkHandler({ onNavigateToFile, onUnresolvedPath }, availablePaths);
    const content = 'include::missing/file.adoc[]';

    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, 10),
    );

    expect(onNavigateToFile).not.toHaveBeenCalled();
    expect(onUnresolvedPath).toHaveBeenCalledWith('missing/file.adoc');
  });

  // Issue 8: the `extension()` factory was dead code — the editor wires the
  // handler via addEventListener; exposing extension() created a double-handler
  // risk. It must not appear on the returned object.
  test('createLinkHandler does not expose an extension() factory', () => {
    const handler = createLinkHandler({});
    expect('extension' in handler).toBe(false);
  });

  test('Cmd/Meta+click also triggers navigation', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    handler.handleMousedown(
      { metaKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::chapters/intro.adoc[]\nSome text', 10),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('chapters/intro.adoc');
  });

  test('returns early when the click is not over a document position', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    const view = createMockView('include::chapters/intro.adoc[]', 10);
    view.posAtCoords = () => null as unknown as number;
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      view,
    );
    expect(onNavigateToFile).not.toHaveBeenCalled();
  });

  test('availablePaths supplied as a getter function is read on each click', () => {
    const onUnresolvedPath = jest.fn();
    const handler = createLinkHandler({ onUnresolvedPath }, () => ['chapters/other.adoc']);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::missing.adoc[]', 10),
    );
    expect(onUnresolvedPath).toHaveBeenCalledWith('missing.adoc');
  });

  test('unresolved include with no onUnresolvedPath callback is a no-op', () => {
    const handler = createLinkHandler({}, ['chapters/intro.adoc']);
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('include::missing.adoc[]', 10),
      ),
    ).not.toThrow();
  });

  test('include navigation tolerates absent callback and absent preventDefault', () => {
    const handler = createLinkHandler({});
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('include::chapters/intro.adoc[]', 10),
      ),
    ).not.toThrow();
  });

  test('link: macro tolerates absent onOpenUrl and preventDefault', () => {
    const handler = createLinkHandler({});
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('Visit link:https://example.com[text]', 10),
      ),
    ).not.toThrow();
  });

  test('bare URL tolerates absent onOpenUrl and preventDefault', () => {
    const handler = createLinkHandler({});
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('Go to https://example.com for info', 15),
      ),
    ).not.toThrow();
  });

  test('Ctrl+click after a bare URL does not open it', () => {
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onOpenUrl });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('https://example.com   trailing', 25),
    );
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  test('Ctrl+click before a bare URL does not open it', () => {
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onOpenUrl });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('go    https://example.com', 1),
    );
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  test('Ctrl+click on a block image:: path navigates to the file', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::New Folder/pic.png[alt]', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('New Folder/pic.png');
  });

  test('Ctrl+click on an inline image: path navigates to the file', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('see image:icon.png[icon] here', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('icon.png');
  });

  test('Ctrl+click on an absolute-URL image opens the URL instead of navigating', () => {
    const onNavigateToFile = jest.fn();
    const onOpenUrl = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onOpenUrl });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::https://cdn.example.com/a.png[]', 12),
    );
    expect(onOpenUrl).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(onNavigateToFile).not.toHaveBeenCalled();
  });

  test('block image navigation tolerates absent onNavigateToFile and preventDefault', () => {
    const handler = createLinkHandler({});
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('image::pic.png[]', 8),
      ),
    ).not.toThrow();
  });

  test('absolute-URL image tolerates absent onOpenUrl and preventDefault', () => {
    const handler = createLinkHandler({});
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('image::https://cdn.example.com/a.png[]', 12),
      ),
    ).not.toThrow();
  });

  test('an out-of-sandbox image path (..) does not navigate', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::../escape.png[]', 10),
    );
    expect(onNavigateToFile).not.toHaveBeenCalled();
  });

  test('unresolved image with no onUnresolvedPath callback is a no-op', () => {
    const handler = createLinkHandler({}, ['ok.png']);
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('image::missing.png[]', 8),
      ),
    ).not.toThrow();
  });

  test('an unresolved image path reports onUnresolvedPath when a paths list is supplied', () => {
    const onNavigateToFile = jest.fn();
    const onUnresolvedPath = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onUnresolvedPath }, ['New Folder/pic.png']);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::missing.png[]', 10),
    );
    expect(onNavigateToFile).not.toHaveBeenCalled();
    expect(onUnresolvedPath).toHaveBeenCalledWith('missing.png');
  });
});

describe('createLinkHandler — include resolution is relative to the open file', () => {
  // The open file lives inside "New Folder"; an index supplies its path so include targets
  // resolve relative to that directory (Asciidoctor semantics), matching the preview/diagnostics.
  const FILES: Record<string, { path: string; content: string }> = {
    open: { path: 'New Folder/new-document-2.adoc', content: 'include::new-document.adoc[]\n' },
    sibling: { path: 'New Folder/new-document.adoc', content: '== Sibling\n' },
  };
  const PATH_OF: Record<string, string> = { open: FILES.open.path, sibling: FILES.sibling.path };
  const PATH_TO_ID = Object.fromEntries(Object.entries(PATH_OF).map(([id, p]) => [p, id]));
  const availablePaths = Object.values(PATH_OF);

  function nestedIndex() {
    return buildProjectSymbolIndex(
      'open',
      (id) => FILES[id]?.content ?? null,
      makeIncludeResolver((id) => PATH_OF[id] ?? null, (p) => PATH_TO_ID[p] ?? null),
      'open',
      (id) => PATH_OF[id] ?? null,
    );
  }

  test('a sibling include (no folder prefix) resolves to its project-relative path', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile }, availablePaths, nestedIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::new-document.adoc[]', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('New Folder/new-document.adoc');
  });

  test('a root-relative include written inside a nested file is now flagged unresolved', () => {
    // Consistency with diagnostics/preview: from "New Folder/…", this target means
    // "New Folder/New Folder/new-document.adoc", which does not exist.
    const onNavigateToFile = jest.fn();
    const onUnresolvedPath = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile, onUnresolvedPath }, availablePaths, nestedIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::New Folder/new-document.adoc[]', 12),
    );
    expect(onNavigateToFile).not.toHaveBeenCalled();
    expect(onUnresolvedPath).toHaveBeenCalledWith('New Folder/new-document.adoc');
  });

  test('an image is resolved relative to the project root, not the open file folder', () => {
    // The macro sits in a nested file, but image targets resolve relative to the project root (no
    // imagesdir here), so a root-level image is found — and a folder-prefixed one keeps its prefix.
    const onNavigateToFile = jest.fn();
    const onUnresolvedPath = jest.fn();
    const paths = [...availablePaths, 'gummy.jpg', 'New Folder/Screenshot.png'];
    const handler = createLinkHandler({ onNavigateToFile, onUnresolvedPath }, paths, nestedIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::gummy.jpg[]', 8),
    );
    expect(onNavigateToFile).toHaveBeenLastCalledWith('gummy.jpg');
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::New Folder/Screenshot.png[]', 8),
    );
    expect(onNavigateToFile).toHaveBeenLastCalledWith('New Folder/Screenshot.png');
    expect(onUnresolvedPath).not.toHaveBeenCalled();
  });
});

describe('createLinkHandler — attribute and imagesdir resolution', () => {
  const FILES: Record<string, { path: string; content: string }> = {
    open: {
      path: 'book/main.adoc',
      content: ':partsdir: parts\n:imagesdir: assets\n\ninclude::{partsdir}/intro.adoc[]\nimage::logo.png[]\n',
    },
    intro: { path: 'book/parts/intro.adoc', content: '== Intro\n' },
  };
  const PATH_OF: Record<string, string> = { open: FILES.open.path, intro: FILES.intro.path };
  const PATH_TO_ID = Object.fromEntries(Object.entries(PATH_OF).map(([id, p]) => [p, id]));
  // The image file is not part of the include graph, but is a navigable project path. It lives at
  // `assets/` (project root + imagesdir), NOT `book/assets/` — images are root-relative, unlike includes.
  const availablePaths = [...Object.values(PATH_OF), 'assets/logo.png'];

  function index() {
    return buildProjectSymbolIndex(
      'open',
      (id) => FILES[id]?.content ?? null,
      makeIncludeResolver((id) => PATH_OF[id] ?? null, (p) => PATH_TO_ID[p] ?? null),
      'open',
      (id) => PATH_OF[id] ?? null,
    );
  }

  test('an include target using {partsdir} resolves to its project-relative path', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile }, availablePaths, index);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::{partsdir}/intro.adoc[]', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('book/parts/intro.adoc');
  });

  test('an image target resolves to imagesdir relative to the project root (not the open file folder)', () => {
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile }, availablePaths, index);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('image::logo.png[]', 8),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('assets/logo.png');
  });
});

describe('createLinkHandler — xref go-to-definition', () => {
  const FILES: Record<string, { path: string; content: string }> = {
    open: {
      path: 'open.adoc',
      content: 'include::other.adoc[]\n\n[[local]]\nSee <<local>> here.\nxref:remote[]\n<<missing>>\n',
    },
    other: { path: 'other.adoc', content: '[[remote]]\n== Remote\n' },
  };
  const PATH_OF: Record<string, string> = { open: 'open.adoc', other: 'other.adoc' };
  const PATH_TO_ID: Record<string, string> = { 'open.adoc': 'open', 'other.adoc': 'other' };

  function openIndex() {
    return buildProjectSymbolIndex(
      'open',
      (id) => FILES[id]?.content ?? null,
      makeIncludeResolver((id) => PATH_OF[id] ?? null, (p) => PATH_TO_ID[p] ?? null),
      'open',
      (id) => PATH_OF[id] ?? null,
    );
  }

  function clickAt(
    content: string,
    marker: string,
    onNavigateToXref: jest.Mock,
    getIndex: () => ProjectSymbolIndex | null = openIndex,
  ) {
    const handler = createLinkHandler({ onNavigateToXref }, undefined, getIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, content.indexOf(marker) + 3),
    );
  }

  test('Ctrl+click on a same-file <<xref>> reveals the definition in place', () => {
    const onNavigateToXref = jest.fn();
    clickAt(FILES.open.content, '<<local>>', onNavigateToXref);
    expect(onNavigateToXref).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'open', sameFile: true, line: 3 }),
    );
  });

  test('Ctrl+click on a cross-file xref: macro switches files at the definition', () => {
    const onNavigateToXref = jest.fn();
    clickAt(FILES.open.content, 'xref:remote', onNavigateToXref);
    // `[[remote]]` sits directly above `== Remote`, so it is that section's explicit id; the
    // definition resolves to the heading line (2), not the standalone anchor line.
    expect(onNavigateToXref).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'other', path: 'other.adoc', sameFile: false, line: 2 }),
    );
  });

  test('Ctrl+click on an unresolved xref is a no-op', () => {
    const onNavigateToXref = jest.fn();
    clickAt(FILES.open.content, '<<missing>>', onNavigateToXref);
    expect(onNavigateToXref).not.toHaveBeenCalled();
  });

  test('Ctrl+click on a path#frag xref resolves by the fragment after the hash', () => {
    const onNavigateToXref = jest.fn();
    // The `xref:other.adoc#remote[]` form carries a path before the `#`; the
    // resolver must use the id after the hash ("remote").
    clickAt('xref:other.adoc#remote[]\n', 'remote', onNavigateToXref);
    expect(onNavigateToXref).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'other', sameFile: false }),
    );
  });

  test('Ctrl+click with an index present but not over an xref falls through to other macros', () => {
    // The index is supplied, but the click is on an include:: line (no xref token
    // under the cursor), so the xref branch yields nothing and include nav fires.
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile }, undefined, openIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::other.adoc[]', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('other.adoc');
  });

  test('resolved xref navigation tolerates absent onNavigateToXref and preventDefault', () => {
    const handler = createLinkHandler({}, undefined, openIndex);
    expect(() =>
      handler.handleMousedown(
        { ctrlKey: true, clientX: 0, clientY: 0 } as unknown as MouseEvent,
        createMockView('See <<local>> here.', 8),
      ),
    ).not.toThrow();
  });

  test('xref click with no index supplied is a no-op (does not throw)', () => {
    const onNavigateToXref = jest.fn();
    expect(() => clickAt(FILES.open.content, '<<local>>', onNavigateToXref, () => null)).not.toThrow();
    expect(onNavigateToXref).not.toHaveBeenCalled();
  });

  test('xrefHoverPreview describes a cross-file definition location', () => {
    const line = 'xref:remote[]';
    const preview = xrefHoverPreview(line, line.indexOf('remote') + 1, openIndex());
    expect(preview).toEqual({ text: 'other.adoc · line 2', from: 0, to: line.length });
  });

  test('xrefHoverPreview marks a same-file definition', () => {
    const line = 'See <<local>> here.';
    const preview = xrefHoverPreview(line, line.indexOf('local') + 1, openIndex());
    expect(preview?.text).toBe('Definition in this file · line 3');
  });

  test('xrefHoverPreview reports an unknown cross-reference', () => {
    const line = '<<missing>>';
    expect(xrefHoverPreview(line, 3, openIndex())?.text).toBe('Unknown cross-reference: missing');
  });

  test('xrefHoverPreview returns null when the cursor is not over an xref', () => {
    expect(xrefHoverPreview('plain text', 2, openIndex())).toBeNull();
  });

  test('a malformed percent-encoded include path falls back to the raw path (decode catch)', () => {
    // decodeURIComponent throws on a lone "%"; normalizePath must catch and use the raw value.
    const onNavigateToFile = jest.fn();
    const handler = createLinkHandler({ onNavigateToFile });
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView('include::bad%path.adoc[]', 12),
    );
    expect(onNavigateToFile).toHaveBeenCalledWith('bad%path.adoc');
  });

  test('xrefHoverPreview labels a resolved definition with no known path as "Definition"', () => {
    // An index that resolves the symbol but whose pathOf returns null exercises the
    // `target.path ?? 'Definition'` fallback for a cross-file definition.
    const index = buildProjectSymbolIndex(
      'open',
      (id) => FILES[id]?.content ?? null,
      makeIncludeResolver((id) => PATH_OF[id] ?? null, (p) => PATH_TO_ID[p] ?? null),
      'open',
      () => null,
    );
    const line = 'xref:remote[]';
    const preview = xrefHoverPreview(line, line.indexOf('remote') + 1, index);
    expect(preview?.text).toBe('Definition · line 2');
  });
});

describe('createLinkHandler — attribute go-to-definition', () => {
  // `:localvar:` + `{set:setvar:…}` are defined in the open file; `:remotevar:` only in the included
  // file. Ctrl+clicking each `{name}` reference must jump to where it is defined.
  const FILES: Record<string, { path: string; content: string }> = {
    open: {
      path: 'open.adoc',
      content: ':localvar: L\n{set:setvar:S}\ninclude::other.adoc[]\n\nUse {localvar} {remotevar} {setvar} {nope}.\n',
    },
    other: { path: 'other.adoc', content: ':remotevar: R\n' },
  };
  const PATH_OF: Record<string, string> = { open: 'open.adoc', other: 'other.adoc' };
  const PATH_TO_ID: Record<string, string> = { 'open.adoc': 'open', 'other.adoc': 'other' };

  const openIndex = () =>
    buildProjectSymbolIndex(
      'open',
      (id) => FILES[id]?.content ?? null,
      makeIncludeResolver((id) => PATH_OF[id] ?? null, (p) => PATH_TO_ID[p] ?? null),
      'open',
      (id) => PATH_OF[id] ?? null,
    );

  function clickAttribute(marker: string, onNavigateToXref: jest.Mock, getIndex = openIndex) {
    const content = FILES.open.content;
    const handler = createLinkHandler({ onNavigateToXref }, undefined, getIndex);
    handler.handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      // index the LAST occurrence (the reference in the body, not a definition) + 3 (inside the token).
      createMockView(content, content.lastIndexOf(marker) + 3),
    );
  }

  test('Ctrl+click on {localvar} reveals the same-file `:name:` definition (line 1)', () => {
    const onNavigateToXref = jest.fn();
    clickAttribute('{localvar}', onNavigateToXref);
    expect(onNavigateToXref).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'open', sameFile: true, line: 1 }));
  });

  test('Ctrl+click on {remotevar} switches to the INCLUDED file where it is defined', () => {
    const onNavigateToXref = jest.fn();
    clickAttribute('{remotevar}', onNavigateToXref);
    expect(onNavigateToXref).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'other', path: 'other.adoc', sameFile: false, line: 1 }),
    );
  });

  test('Ctrl+click on a {set:}-defined attribute reference resolves to its inline-set definition', () => {
    const onNavigateToXref = jest.fn();
    clickAttribute('{setvar}', onNavigateToXref);
    expect(onNavigateToXref).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'open', sameFile: true, line: 2 }));
  });

  test('Ctrl+click on an undefined attribute reference is a no-op', () => {
    const onNavigateToXref = jest.fn();
    clickAttribute('{nope}', onNavigateToXref);
    expect(onNavigateToXref).not.toHaveBeenCalled();
  });

  test('attribute click is case-insensitive (a {MyVar} ref resolves to a `:myvar:` definition)', () => {
    const files: Record<string, string> = { m: ':myvar: V\n\nUse {MyVar} here.\n' };
    const index = () =>
      buildProjectSymbolIndex('m', (id) => files[id] ?? null,
        makeIncludeResolver((id) => ({ m: 'm.adoc' })[id] ?? null, (p) => ({ 'm.adoc': 'm' })[p] ?? null),
        'm', (id) => ({ m: 'm.adoc' })[id] ?? null);
    const onNavigateToXref = jest.fn();
    const content = files.m;
    createLinkHandler({ onNavigateToXref }, undefined, index).handleMousedown(
      { ctrlKey: true, clientX: 0, clientY: 0, preventDefault: jest.fn() } as unknown as MouseEvent,
      createMockView(content, content.indexOf('{MyVar}') + 3),
    );
    expect(onNavigateToXref).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'm', sameFile: true }));
  });
});
