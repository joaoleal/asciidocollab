import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

/**
 * @file Static description of the bundled "Guided Tour" demo project.
 *
 * WHY a manifest module (data), separate from the provisioner (behaviour):
 *   The demo project is seeded on every API startup and must be *idempotent* —
 *   re-running the seeder can never mint a second copy or duplicate a file. That
 *   is only possible if every row it creates has a STABLE identity. So every id
 *   below is a fixed, hand-frozen UUID v4 rather than a `randomUUID()`: the same
 *   install always produces the same project/file/document ids, and "does it
 *   already exist?" is a single primary-key lookup.
 *
 * WHY UUID v4 specifically:
 *   The domain `Uuid` base class validates the v4 shape (version nibble `4`,
 *   variant `[89ab]`). A derived/namespaced (v5) id would be rejected at
 *   construction, so deterministic ids are pre-generated valid v4 constants.
 *
 * The AsciiDoc/YAML/SVG bytes themselves are NOT embedded here — they live as
 * real, syntax-highlightable files under `apps/api/data/demo-project/` and are
 * read at provision time (see {@link loadDemoAssetBytes}). `apps/api/data` is the
 * established home for bundled runtime data (cf. `data/common-passwords.txt`) and
 * is copied into the production image by the Dockerfile.
 */

/**
 * Well-known identifier of the demo project. Deliberately a compile-time
 * constant so the login/registration access hook and the provisioner agree on
 * exactly one project without a lookup-by-name (names are not unique).
 */
export const DEMO_PROJECT_ID = '90017438-14d6-4395-8dca-4460324d9462';

/** Display name shown in the project list and as the file-tree root folder name. */
export const DEMO_PROJECT_NAME = 'Guided Tour — AsciidoCollab';

/** Short description surfaced on the project card. */
export const DEMO_PROJECT_DESCRIPTION =
  'A read-only, hands-on tour of AsciiDoc and AsciidoCollab. Open any file to read; ' +
  'export it to PDF to see the bundled showcase theme.';

/**
 * Categorisation tags. `demo`/`tutorial` make the project easy to recognise and
 * filter; they carry no access meaning (access is membership-based — see the
 * provisioner).
 */
export const DEMO_PROJECT_TAGS: readonly string[] = ['demo', 'tutorial', 'getting-started'];

/**
 * Project render configuration seeded for the demo. Its primary job is to select
 * the bundled PDF theme by project-relative path; the page size is set to make
 * the render-config feature visible in project settings. Every value here is a
 * member of the shared `renderConfigSchema`; the provisioner re-validates it
 * through that schema before persisting, mirroring the API route boundary.
 */
export const DEMO_RENDER_CONFIG: Readonly<Record<string, unknown>> = {
  pdfTheme: 'theme/showcase-theme.yml',
  pdfPageSize: 'A4',
  toc: true,
  toclevels: 3,
  sectnums: true,
  icons: 'font',
};

/** A folder node in the demo file tree. */
export interface DemoFolderSpec {
  /** Fixed UUID v4 of the folder's `FileNode`. */
  readonly id: string;
  /** Project-relative POSIX path of the folder (always starts with `/`). */
  readonly path: string;
  /** Display name of the folder. */
  readonly name: string;
  /** `id` of the parent folder, or `null` for the tree root. */
  readonly parentId: string | null;
}

/** Fields shared by every file node in the demo tree, regardless of kind. */
interface DemoFileSpecBase {
  /** Fixed UUID v4 of the file's `FileNode` (also the `Asset` id for `kind: 'asset'`). */
  readonly id: string;
  /** `id` of the containing folder. */
  readonly parentId: string;
  /** Display name / basename of the file. */
  readonly name: string;
  /** Project-relative POSIX path of the file (always starts with `/`). */
  readonly path: string;
  /** Path of the source bytes relative to `apps/api/data/demo-project/`. */
  readonly source: string;
  /** MIME type stored on the `Document`/`Asset`. */
  readonly mimeType: string;
  /** When `true`, this file is set as the project's main/root include file. */
  readonly isMain?: boolean;
}

/**
 * A text file: becomes a collaborative `Document` (editable in the CodeMirror
 * editor, seeded into Yjs from the file store on first open). The document,
 * content and Yjs-state ids are required so the seeder never invents them.
 */
export interface DemoTextFileSpec extends DemoFileSpecBase {
  /** Discriminant: a collaborative text document. */
  readonly kind: 'text';
  /** Fixed UUID v4 of the backing `Document`. */
  readonly documentId: string;
  /** Fixed UUID v4 of the document's content pointer. */
  readonly contentId: string;
  /** Fixed UUID v4 of the document's Yjs state pointer. */
  readonly yjsStateId: string;
}

/** A binary asset such as an image, served by the image endpoint. Carries no document ids. */
export interface DemoAssetFileSpec extends DemoFileSpecBase {
  /** Discriminant: a binary asset. */
  readonly kind: 'asset';
}

/** A file node in the demo file tree — either a collaborative text document or a binary asset. */
export type DemoFileSpec = DemoTextFileSpec | DemoAssetFileSpec;

/** Root folder id — the `parentId: null` node that anchors the tree. */
export const DEMO_ROOT_FOLDER_ID = '7ad1fdd8-d311-483a-9a48-293d12b9a3e6';
const CHAPTERS_FOLDER_ID = '80d01282-ed26-4ccb-8044-23be4c7b163b';
const IMAGES_FOLDER_ID = 'c8e63f68-4b31-4970-86f0-a84a7be5243c';
const THEME_FOLDER_ID = 'cf329c3a-0506-406e-a157-449470550173';

/** The main/root AsciiDoc file id, referenced when setting `Project.mainFileNodeId`. */
export const DEMO_MAIN_FILE_ID = 'b184a70c-a5a2-432f-b620-d74438fa87d2';

/** Folders of the demo project, ordered parent-before-child so creation is a simple forward pass. */
export const DEMO_FOLDERS: readonly DemoFolderSpec[] = [
  { id: DEMO_ROOT_FOLDER_ID, path: '/', name: DEMO_PROJECT_NAME, parentId: null },
  { id: CHAPTERS_FOLDER_ID, path: '/chapters', name: 'chapters', parentId: DEMO_ROOT_FOLDER_ID },
  { id: IMAGES_FOLDER_ID, path: '/images', name: 'images', parentId: DEMO_ROOT_FOLDER_ID },
  { id: THEME_FOLDER_ID, path: '/theme', name: 'theme', parentId: DEMO_ROOT_FOLDER_ID },
];

/** Files of the demo project. Text documents plus one SVG asset and the PDF theme. */
export const DEMO_FILES: readonly DemoFileSpec[] = [
  {
    id: DEMO_MAIN_FILE_ID,
    parentId: DEMO_ROOT_FOLDER_ID,
    name: 'index.adoc',
    path: '/index.adoc',
    source: 'index.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: '35816081-53df-444b-8299-501b96cf9bef',
    contentId: 'bd872ebd-b6b8-4ab5-9084-7ce24be786d1',
    yjsStateId: '634bd01e-06f4-4560-8f8f-34b1ac22f507',
    isMain: true,
  },
  {
    id: 'd2ede0ce-d381-4fec-901c-a5e3b0aa6b25',
    parentId: CHAPTERS_FOLDER_ID,
    name: '01-welcome.adoc',
    path: '/chapters/01-welcome.adoc',
    source: 'chapters/01-welcome.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: '2a4ec64b-2797-4cc2-af69-80c2c85d5ed6',
    contentId: '7b9b5928-5b45-4cb1-a43e-ee634bfeeacb',
    yjsStateId: 'd54fa4ab-ae17-4dc8-af90-697888425017',
  },
  {
    id: '729a81fe-1eea-4ab6-9fe1-a1274e99b6d0',
    parentId: CHAPTERS_FOLDER_ID,
    name: '02-asciidoc-essentials.adoc',
    path: '/chapters/02-asciidoc-essentials.adoc',
    source: 'chapters/02-asciidoc-essentials.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: 'd07c5844-9ed8-4d41-853a-90f0994ffcda',
    contentId: '1c5423a7-25de-4dc9-8421-2dedc85c8925',
    yjsStateId: '03f1eab2-a09e-46f0-8d11-f214452194da',
  },
  {
    id: '01514c9a-f4f8-4a39-aba2-a28b4043554b',
    parentId: CHAPTERS_FOLDER_ID,
    name: '03-structure-and-includes.adoc',
    path: '/chapters/03-structure-and-includes.adoc',
    source: 'chapters/03-structure-and-includes.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: 'fd0b6995-ea15-4ac8-9a27-225a99e356db',
    contentId: '46febbe7-cd7b-4a05-861b-a7fdc6b4af4b',
    yjsStateId: '48ebcde3-47fa-4782-b2db-b4f8bdba3251',
  },
  {
    id: '02ce708a-cd26-4fb7-97d6-c0b4158b7b77',
    parentId: CHAPTERS_FOLDER_ID,
    name: '04-collaborating.adoc',
    path: '/chapters/04-collaborating.adoc',
    source: 'chapters/04-collaborating.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: 'c7279193-9c0a-4086-90ad-8dacf964c376',
    contentId: 'acd14f60-9ada-41f5-aa61-de47d5b29527',
    yjsStateId: '640877ae-5f92-4b6f-bc7e-f62de5154778',
  },
  {
    id: '2ff01bbb-ef4c-4341-9f57-c6956da81d8b',
    parentId: CHAPTERS_FOLDER_ID,
    name: '05-exporting-and-themes.adoc',
    path: '/chapters/05-exporting-and-themes.adoc',
    source: 'chapters/05-exporting-and-themes.adoc',
    mimeType: 'text/asciidoc',
    kind: 'text',
    documentId: 'cf91d8b9-2875-48a4-8edb-d94282e132b7',
    contentId: '9e6406ba-b207-402c-ae0f-bee1613f9f75',
    yjsStateId: 'fd9753fe-242f-4754-821e-ca2dd3d1190c',
  },
  {
    id: 'c887483f-32d2-4534-b518-a04d42fe0cd6',
    parentId: THEME_FOLDER_ID,
    name: 'showcase-theme.yml',
    path: '/theme/showcase-theme.yml',
    source: 'theme/showcase-theme.yml',
    mimeType: 'text/yaml',
    kind: 'text',
    documentId: 'f5ffa1f1-6544-4457-8999-4b36a57bfd50',
    contentId: '78465af8-a6cd-4beb-9655-bdafdc0d687c',
    yjsStateId: 'bc2d58ee-e740-4a7d-bc20-388c35d80326',
  },
  {
    id: 'a4e964cb-9a9e-424a-88e1-34ab7f3d2e96',
    parentId: IMAGES_FOLDER_ID,
    name: 'workflow.svg',
    path: '/images/workflow.svg',
    source: 'images/workflow.svg',
    mimeType: 'image/svg+xml',
    kind: 'asset',
  },
];

/**
 * Reads the on-disk source bytes for a demo file.
 *
 * The path is resolved and confirmed to stay inside `dataDir` before reading, so
 * a malformed manifest entry can never escape the bundled data directory.
 *
 * @param dataDirectory - Absolute path of the bundled `apps/api/data/demo-project` directory.
 * @param source - The file's `source` path, relative to the data directory.
 * @returns The raw file contents.
 * @throws {Error} If the resolved path would escape the data directory.
 */
export async function loadDemoAssetBytes(dataDirectory: string, source: string): Promise<Buffer> {
  const resolved = path.resolve(dataDirectory, source);
  const root = path.resolve(dataDirectory);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Demo asset path escapes the data directory: ${source}`);
  }
  return fs.readFile(resolved);
}

/**
 * `SystemSetting` key under which the hash of the currently-seeded demo content is
 * stored. On start-up the provisioner compares the live bundled hash against this
 * value to decide whether the demo is out of date and must be re-seeded.
 */
export const DEMO_CONTENT_HASH_KEY = 'demo.guidedTour.contentHash';

/**
 * Computes a stable SHA-256 fingerprint of everything that defines the demo
 * project: its structural manifest (ids, names, tags, render config, folder/file
 * layout) and the raw bytes of every bundled file. Any edit to the tutorial
 * content, the theme, the render config, or the tree shape changes the hash,
 * which is how the start-up reconciler detects that a previously-seeded demo is
 * outdated and rebuilds it.
 *
 * @param dataDirectory - Absolute path of the bundled `apps/api/data/demo-project` directory.
 * @returns The lowercase hex SHA-256 digest of the demo's content and structure.
 */
export async function computeDemoContentHash(dataDirectory: string): Promise<string> {
  const hash = createHash('sha256');
  // Structural metadata first — a rename, a new file, or a render-config tweak
  // all change the fingerprint even if no existing file's bytes changed.
  hash.update(
    JSON.stringify({
      id: DEMO_PROJECT_ID,
      name: DEMO_PROJECT_NAME,
      description: DEMO_PROJECT_DESCRIPTION,
      tags: DEMO_PROJECT_TAGS,
      renderConfig: DEMO_RENDER_CONFIG,
      mainFileId: DEMO_MAIN_FILE_ID,
      folders: DEMO_FOLDERS,
      files: DEMO_FILES,
    }),
  );
  // File bytes in a deterministic (path-sorted) order, each domain-separated by
  // its path so moving content between files still changes the digest.
  const ordered = DEMO_FILES.toSorted((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    const bytes = await loadDemoAssetBytes(dataDirectory, file.source);
    hash.update(` ${file.path} `);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
