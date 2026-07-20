import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pdfExtensionRoutes } from '../../../src/routes/projects/pdf-extensions';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

// The shipped set is read from the gem's directory at module load, so leaving it real would tie every
// assertion here to whichever extensions happen to ship. Mocking it also makes the
// shipped-manifest-without-a-source case reachable, which on disk it never is — the loader writes the
// two together — but which the route defends against anyway.
jest.mock('../../../src/lib/pdf-extensions', () => ({
  SHIPPED_PDF_EXTENSION_MANIFESTS: [
    {
      id: 'paragraph-numbering',
      displayName: 'Paragraph numbering',
      description: 'Numbers each paragraph.',
      targeting: '[.numbered]',
      themeKeys: [],
      sampleContent: '[.numbered]\nA paragraph.\n',
    },
    {
      id: 'sourceless',
      displayName: 'Sourceless',
      description: 'A manifest whose Ruby is missing.',
      targeting: '',
      themeKeys: [],
      sampleContent: '',
    },
  ],
  SHIPPED_PDF_EXTENSION_SOURCES: { 'paragraph-numbering': '# paragraph numbering ruby\n' },
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const CATALOGUE_URL = `/api/projects/${PROJECT_ID}/pdf-extensions`;

/** An administrator-provided extension as the drop-folder adapter reports it. */
function discovered(id: string) {
  return {
    manifest: {
      id,
      displayName: id,
      description: `The ${id} extension.`,
      targeting: '',
      themeKeys: [],
      sampleContent: '',
    },
    handle: `${id}-handle`,
  };
}

interface ServerOptions {
  /** Membership for each successive lookup. `null` means "not a member". */
  readonly roles?: readonly (string | null)[];
  /** The project's stored render config, or `null` when nothing is stored. */
  readonly stored?: Record<string, unknown> | null;
  /** What the administrator drop folder reports. */
  readonly listing?: { success: boolean; value?: unknown };
  /**
   * A distinct listing per `list()` call, when a test needs the folder to CHANGE mid-request.
   *
   * The source route reads the folder twice — once to assemble the catalogue, once to resolve the
   * handle — so an administrator editing the mount between the two is a real interleaving, and the
   * route's two not-found branches exist for exactly it.
   */
  readonly listings?: readonly { success: boolean; value?: unknown }[];
  /** What reading an administrator source returns. */
  readonly source?: { success: boolean; value?: string };
}

async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const {
    roles = ['editor'],
    stored = null,
    listing = { success: true, value: { extensions: [], excluded: [] } },
    listings,
    source = { success: true, value: '# administrator ruby\n' },
  } = options;

  // Membership is looked up once per use case, and a request runs at most two of them. Indexing the
  // roles list by call lets a test say "a member for the config read, no longer one by the time the
  // catalogue is assembled", which is the only way the catalogue's permission failure is reachable.
  let lookups = 0;
  let listCalls = 0;
  const instance = Fastify();
  await instance.register(rateLimit, { global: false });
  instance.decorate('config', {
    project: {
      pdfExtensions: {
        rateLimitMax: 120,
        rateLimitWindow: 60_000,
        sourceRateLimitMax: 120,
        sourceRateLimitWindow: 60_000,
      },
    },
  } as never);
  instance.decorate('repos', {
    projectRenderConfig: {
      findByProjectId: jest.fn(async () =>
        stored === null ? null : { config: stored, projectId: { value: PROJECT_ID } },
      ),
    },
    projectMember: {
      findByCompositeKey: jest.fn(async () => {
        const role = roles[Math.min(lookups, roles.length - 1)];
        lookups += 1;
        return role === null ? null : { role: { value: role } };
      }),
    },
  } as never);
  instance.decorate('stores', {
    pdfExtensionSource: {
      list: jest.fn(async () => {
        if (listings === undefined) return listing;
        const next = listings[Math.min(listCalls, listings.length - 1)];
        listCalls += 1;
        return next;
      }),
      readSource: jest.fn(async () => source),
    },
  } as never);
  await instance.register(pdfExtensionRoutes);
  return instance;
}

/** Run one request against a server built for it, and always close the server. */
async function get(url: string, options: ServerOptions = {}) {
  const instance = await buildServer(options);
  try {
    return await instance.inject({ method: 'GET', url });
  } finally {
    await instance.close();
  }
}

describe('GET /projects/:projectId/pdf-extensions', () => {
  it('offers the shipped set to a member with nothing stored', async () => {
    const response = await get(CATALOGUE_URL);
    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.entries.map((entry: { manifest: { id: string } }) => entry.manifest.id)).toEqual([
      'paragraph-numbering',
      'sourceless',
    ]);
    expect(data.staleSelections).toEqual([]);
  });

  it('merges the administrator folder in beside the shipped set', async () => {
    const response = await get(CATALOGUE_URL, {
      listing: { success: true, value: { extensions: [discovered('watermark')], excluded: [] } },
    });
    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.entries.map((entry: { origin: string }) => entry.origin)).toContain(
      'administrator-provided',
    );
  });

  it('reports a stored selection nothing offers any more as stale', async () => {
    // FR-030: an administrator can remove an extension a project still names, and the owner has to be
    // told rather than have their output quietly change.
    const response = await get(CATALOGUE_URL, {
      stored: { extensions: { enabled: ['paragraph-numbering', 'departed'] } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.staleSelections).toEqual(['departed']);
  });

  it('treats a stored config that no longer parses as no selection at all', async () => {
    // The stored config is untyped JSON. Reading it through the shared schema means a config written
    // by an older version degrades to "nothing enabled" instead of crashing the options page.
    const response = await get(CATALOGUE_URL, { stored: { doctype: 'not-a-doctype' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.staleSelections).toEqual([]);
  });

  it('treats a valid config with no extensions block as no selection', async () => {
    const response = await get(CATALOGUE_URL, { stored: { doctype: 'book' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.staleSelections).toEqual([]);
  });

  it('refuses a non-member', async () => {
    const response = await get(CATALOGUE_URL, { roles: [null] });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('refuses when membership is gone by the time the catalogue is assembled', async () => {
    const response = await get(CATALOGUE_URL, { roles: ['editor', null] });
    expect(response.statusCode).toBe(403);
  });

  it('still offers the shipped set when the administrator folder cannot be read', async () => {
    // A misconfigured mount must not make every project's options page unusable.
    const response = await get(CATALOGUE_URL, { listing: { success: false } });
    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.entries.length).toBe(2);
    expect(data.excluded).toHaveLength(1);
  });
});

/** The source endpoint for one extension id. */
function sourceUrl(id: string): string {
  return `${CATALOGUE_URL}/${id}/source`;
}

describe('GET /projects/:projectId/pdf-extensions/:extensionId/source', () => {
  it('serves a shipped extension’s Ruby as plain text', async () => {
    const response = await get(sourceUrl('paragraph-numbering'));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toBe('# paragraph numbering ruby\n');
  });

  it('serves an administrator extension by the handle the listing gave', async () => {
    const response = await get(sourceUrl('watermark'), {
      listing: { success: true, value: { extensions: [discovered('watermark')], excluded: [] } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# administrator ruby\n');
  });

  it('resolves the id by catalogue lookup, so a path-like id is simply not found', async () => {
    // THE SECURITY PROPERTY (FR-034/FR-035). `:extensionId` is matched against entries the server
    // assembled and is never joined onto a filesystem path, so what a client sends cannot escape
    // anywhere — a traversal attempt is indistinguishable from any other unknown id.
    const response = await get(sourceUrl(encodeURIComponent('../../etc/passwd')));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('does not serve an unavailable entry, even though the catalogue lists it', async () => {
    // A stale selection is kept in the catalogue so the owner can see it, marked unavailable. Serving
    // its source would contradict that: there is no code behind the name any more.
    const response = await get(sourceUrl('departed'), {
      stored: { extensions: { enabled: ['departed'] } },
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports a shipped manifest with no source as not found rather than serving nothing', async () => {
    const response = await get(sourceUrl('sourceless'));
    expect(response.statusCode).toBe(404);
  });

  it('refuses a non-member', async () => {
    const response = await get(sourceUrl('paragraph-numbering'), { roles: [null] });
    expect(response.statusCode).toBe(403);
  });

  it('refuses when membership is gone by the time the catalogue is assembled', async () => {
    const response = await get(sourceUrl('paragraph-numbering'), { roles: ['editor', null] });
    expect(response.statusCode).toBe(403);
  });

  it('reports not-found when the folder becomes unreadable after the catalogue listed it', async () => {
    // `list()` is called twice — once to assemble the catalogue, once to resolve the handle. A folder
    // that fails the second time degrades the catalogue to the shipped set, so the id no longer
    // resolves at all.
    const response = await get(sourceUrl('watermark'), { listing: { success: false } });
    expect(response.statusCode).toBe(404);
  });

  it('reports not-found when the folder stops being readable between the two reads', async () => {
    const available = { success: true, value: { extensions: [discovered('watermark')], excluded: [] } };
    const response = await get(sourceUrl('watermark'), {
      listings: [available, { success: false }],
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports not-found when the extension is removed between the two reads', async () => {
    const available = { success: true, value: { extensions: [discovered('watermark')], excluded: [] } };
    const emptied = { success: true, value: { extensions: [], excluded: [] } };
    const response = await get(sourceUrl('watermark'), { listings: [available, emptied] });
    expect(response.statusCode).toBe(404);
  });

  it('reports not-found when the source behind a listed handle cannot be read', async () => {
    const response = await get(sourceUrl('watermark'), {
      listing: { success: true, value: { extensions: [discovered('watermark')], excluded: [] } },
      source: { success: false },
    });
    expect(response.statusCode).toBe(404);
  });
});
