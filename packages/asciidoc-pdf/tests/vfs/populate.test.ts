import {
  clearOutput,
  OUT_ROOT,
  PROJECT_ROOT,
  populateProject,
  readOutput,
  type PopulateResult,
  type VfsWritePort,
} from '../../src/vfs/populate';
import type { ProjectSnapshot } from '../../src/protocol';

// ---------------------------------------------------------------------------
// In-memory fake of the narrow VFS port. It stores files by absolute path and
// derives directory listings/existence from the flat key space — enough to
// exercise nesting, read-back and clear semantics without the real bridge.
// ---------------------------------------------------------------------------

class FakeVfs implements VfsWritePort {
  readonly files = new Map<string, Uint8Array>();

  writeFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }

  readFile(path: string): Uint8Array {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new Error(`No file at ${path}`);
    }
    return data;
  }

  removeFile(path: string): void {
    this.files.delete(path);
  }

  exists(path: string): boolean {
    if (this.files.has(path)) {
      return true;
    }
    const prefix = `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  readdir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0];
        if (head !== undefined && head.length > 0) {
          names.add(head);
        }
      }
    }
    return [...names];
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function makeSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    files: {},
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    ...overrides,
  };
}

function reasonFor(result: PopulateResult, path: string): string | undefined {
  return result.rejected.find((r) => r.path === path)?.reason;
}

describe('populateProject', () => {
  it('writes text and binary files under /project preserving nesting', () => {
    const vfs = new FakeVfs();
    const logo = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const snapshot = makeSnapshot({
      files: {
        'main.adoc': '= Title\n',
        'chapters/intro.adoc': '== Intro\n',
      },
      binaryAssets: {
        'images/logo.png': logo,
      },
      rootPath: 'main.adoc',
    });

    const result = populateProject(vfs, snapshot);

    expect(decoder.decode(vfs.readFile(`${PROJECT_ROOT}/main.adoc`))).toBe('= Title\n');
    expect(decoder.decode(vfs.readFile(`${PROJECT_ROOT}/chapters/intro.adoc`))).toBe('== Intro\n');
    expect([...vfs.readFile(`${PROJECT_ROOT}/images/logo.png`)]).toEqual([...logo]);
    expect(result.rejected).toHaveLength(0);
    expect(result.rootPresent).toBe(true);
    expect(result.written).toEqual(
      expect.arrayContaining([
        `${PROJECT_ROOT}/main.adoc`,
        `${PROJECT_ROOT}/chapters/intro.adoc`,
        `${PROJECT_ROOT}/images/logo.png`,
      ]),
    );
  });

  it('rejects and reports traversal, absolute, remote and NUL paths without writing them', () => {
    const vfs = new FakeVfs();
    const snapshot = makeSnapshot({
      files: {
        'main.adoc': '= Ok\n',
        '../escape.adoc': 'nope',
        '/etc/passwd': 'nope',
        'deep/../../up.adoc': 'nope',
      },
      binaryAssets: {
        'http://evil.example/logo.png': new Uint8Array([1]),
        'bad\u0000name.png': new Uint8Array([2]),
      },
      rootPath: 'main.adoc',
    });

    const result = populateProject(vfs, snapshot);

    expect(reasonFor(result, '../escape.adoc')).toBe('traversal');
    expect(reasonFor(result, '/etc/passwd')).toBe('absolute');
    expect(reasonFor(result, 'deep/../../up.adoc')).toBe('traversal');
    expect(reasonFor(result, 'http://evil.example/logo.png')).toBe('remote');
    expect(reasonFor(result, 'bad\u0000name.png')).toBe('nul');
    expect(result.rejected).toHaveLength(5);

    // Nothing malicious landed; only the clean file was written.
    expect([...vfs.files.keys()]).toEqual([`${PROJECT_ROOT}/main.adoc`]);
  });

  it('rejects an empty snapshot key as "empty" without writing it', () => {
    const vfs = new FakeVfs();
    const snapshot = makeSnapshot({
      files: { '': 'orphan', 'main.adoc': '= Ok\n' },
      rootPath: 'main.adoc',
    });

    const result = populateProject(vfs, snapshot);

    expect(reasonFor(result, '')).toBe('empty');
    expect([...vfs.files.keys()]).toEqual([`${PROJECT_ROOT}/main.adoc`]);
  });

  it('reports an invalid root path as a rejected "root" entry', () => {
    const vfs = new FakeVfs();
    const snapshot = makeSnapshot({
      files: { 'main.adoc': '= Ok\n' },
      rootPath: '../escape.adoc',
    });

    const result = populateProject(vfs, snapshot);

    const rootReject = result.rejected.find((r) => r.kind === 'root');
    expect(rootReject).toEqual({ path: '../escape.adoc', reason: 'traversal', kind: 'root' });
    expect(result.rootPresent).toBe(false);
  });

  it('reports rootPresent=false when the root path never lands under /project', () => {
    const vfs = new FakeVfs();
    const snapshot = makeSnapshot({
      files: { 'other.adoc': '= Other\n' },
      rootPath: 'missing.adoc',
    });

    const result = populateProject(vfs, snapshot);
    expect(result.rootPresent).toBe(false);
  });

  it('in delta mode rewrites only the changed paths and leaves the rest untouched', () => {
    const vfs = new FakeVfs();
    const first = makeSnapshot({
      files: {
        'main.adoc': '= V1\n',
        'chapters/intro.adoc': '== Intro V1\n',
      },
      rootPath: 'main.adoc',
    });
    populateProject(vfs, first);

    const second = makeSnapshot({
      files: {
        'main.adoc': '= V2\n',
        'chapters/intro.adoc': '== Intro V2\n',
      },
      rootPath: 'main.adoc',
    });
    const result = populateProject(vfs, second, { changedPaths: ['chapters/intro.adoc'] });

    // main was NOT in changedPaths → old content retained.
    expect(decoder.decode(vfs.readFile(`${PROJECT_ROOT}/main.adoc`))).toBe('= V1\n');
    // intro WAS in changedPaths → rewritten.
    expect(decoder.decode(vfs.readFile(`${PROJECT_ROOT}/chapters/intro.adoc`))).toBe('== Intro V2\n');
    expect(result.written).toEqual([`${PROJECT_ROOT}/chapters/intro.adoc`]);
    // Root already present from the cold populate.
    expect(result.rootPresent).toBe(true);
  });

  it('still validates paths in delta mode', () => {
    const vfs = new FakeVfs();
    const snapshot = makeSnapshot({
      files: { '../escape.adoc': 'nope' },
      rootPath: 'main.adoc',
    });
    const result = populateProject(vfs, snapshot, { changedPaths: ['../escape.adoc'] });
    expect(reasonFor(result, '../escape.adoc')).toBe('traversal');
    expect(vfs.files.size).toBe(0);
  });
});

describe('readOutput / clearOutput', () => {
  it('reads produced PDF bytes back from /out', () => {
    const vfs = new FakeVfs();
    const pdf = encoder.encode('%PDF-1.7');
    vfs.writeFile(`${OUT_ROOT}/report.pdf`, pdf);

    expect([...readOutput(vfs, 'report.pdf')]).toEqual([...pdf]);
  });

  it('empties /out via clearOutput', () => {
    const vfs = new FakeVfs();
    vfs.writeFile(`${OUT_ROOT}/a.pdf`, new Uint8Array([1]));
    vfs.writeFile(`${OUT_ROOT}/b.pdf`, new Uint8Array([2]));
    // A stray project file must be left alone.
    vfs.writeFile(`${PROJECT_ROOT}/keep.adoc`, new Uint8Array([3]));

    clearOutput(vfs);

    expect(vfs.exists(`${OUT_ROOT}/a.pdf`)).toBe(false);
    expect(vfs.exists(`${OUT_ROOT}/b.pdf`)).toBe(false);
    expect(vfs.readdir(OUT_ROOT)).toHaveLength(0);
    expect(vfs.exists(`${PROJECT_ROOT}/keep.adoc`)).toBe(true);
  });

  it('clearOutput is a no-op when /out is absent', () => {
    const vfs = new FakeVfs();
    // Nothing under /out exists yet — clearOutput must return without touching the VFS.
    expect(() => clearOutput(vfs)).not.toThrow();
    expect(vfs.files.size).toBe(0);
  });
});
