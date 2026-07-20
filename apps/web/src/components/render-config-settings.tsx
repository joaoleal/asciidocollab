'use client';

/**
 * Project render-configuration editor: the AsciiDoc / Asciidoctor-PDF options a project applies to
 * every render (HTML preview + PDF export). Curated controls for the known options plus a free-form
 * custom-attributes table and an appended custom-font-directories list. Engine-pinned/unsafe attribute
 * names (base_dir, pdf-fontsdir, source-highlighter, …) are intentionally NOT exposed — see the shared
 * `PINNED_ATTRIBUTE_KEYS`; custom attributes colliding with them are dropped server-side. The document
 * language is NOT set here: it is the project's own "Language" setting (spell checker + render `lang`).
 *
 * These options are spread across several sections of the options page, but they are ONE stored
 * document: `PUT /render-config` is a full replace, so a section that PUT only its own fields would
 * wipe every sibling section's settings. That is why the draft lives in a provider above the sections
 * rather than inside each of them — every section reads the same draft, and saving from any section
 * sends the merged whole and re-seeds all of them from the response (FR-006).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Baseline,
  BookMarked,
  FileType,
  FlaskConical,
  Image as ImageIcon,
  Info,
  ListOrdered,
  ListTree,
  Monitor,
  Palette,
  Plus,
  Quote,
  RectangleHorizontal,
  Ruler,
  Scaling,
  SortAsc,
  Trash2,
  Type,
  WrapText,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderTreeSelect } from '@/components/folder-tree-select';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { useProjectFolders, type FolderNode } from '@/hooks/use-project-folders';
import {
  PDF_PAGE_SIZES,
  THEME_FILENAME_CONVENTION,
  resolveThemePath,
  themeFilePaths,
  type RenderConfig,
} from '@asciidocollab/shared';

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';

const NO_FOLDERS_LABEL = 'No folders in this project yet.';

const DOCTYPE_OPTIONS = ['article', 'book'] as const;
const ICONS_OPTIONS = ['font', 'image'] as const;
const MEDIA_OPTIONS = ['screen', 'print', 'prepress'] as const;
const PAGE_LAYOUT_OPTIONS = ['portrait', 'landscape'] as const;
const BIBTEX_ORDER_OPTIONS = ['appearance', 'alphabetical'] as const;
const FOLIO_PLACEMENT_OPTIONS = ['virtual', 'physical', 'physical-inverted'] as const;

/** Return `value` when it is one of `options`, else undefined — narrows a select value without a cast. */
function pick<T extends string>(value: string, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

/** Parse a numeric select/input value, dropping the option when it is blank or not a number. */
function pickNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** One editable custom-attribute row. The list keeps a trailing blank row so a new one can be appended. */
interface AttributeRow {
  name: string;
  value: string;
}

/** Turn a stored config's custom attributes into editable rows (plus one blank row to append). */
function toRows(config: RenderConfig): AttributeRow[] {
  const rows = Object.entries(config.customAttributes ?? {}).map(([name, value]) => ({ name, value }));
  return [...rows, { name: '', value: '' }];
}

/** Collapse editable rows back into a custom-attributes record (blank names dropped). */
function fromRows(rows: readonly AttributeRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length > 0) {
      result[name] = row.value;
    }
  }
  return result;
}

/** The one render-config draft every options section reads and writes. */
interface RenderConfigDraft {
  /** The project being edited. */
  projectId: string;
  /** False when the project is archived or the viewer may not change settings. */
  canEdit: boolean;
  /** True while the stored config is being fetched; sections render a placeholder until then. */
  loading: boolean;
  /**
   * True once the stored config has been read. See `useProjectRenderConfig`: a failed fetch also
   * ends `loading`, but leaves the draft empty, and saving is a whole-document replace — so editing
   * must stay closed until this is true or one failed request plus one edit erases the project's
   * settings.
   */
  loaded: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** True when the draft carries edits not yet persisted, so the page can warn before leaving. */
  dirty: boolean;
  /** True once a save has succeeded and nothing has been edited since. */
  saved: boolean;
  /** The last load/save error, or null. */
  error: string | null;
  /** The working configuration. */
  draft: RenderConfig;
  /**
   * Set (or, for an empty value, clear) one option.
   *
   * @param key - The option to change.
   * @param value - The new value; `undefined` or `''` removes the option from the draft entirely.
   */
  set: <K extends keyof RenderConfig>(key: K, value: RenderConfig[K]) => void;
  /** The project's folders, for the folder pickers. */
  tree: FolderNode[];
  folders: string[];
  /** Every project file path, for resolving which theme file applies. */
  files: string[];
  foldersLoading: boolean;
  /**
   * Why the project's file list is unavailable, or null.
   *
   * Load-bearing: without it an unreadable tree looks like an EMPTY project, and the page then tells
   * the owner their stored theme "is not in this project" and offers to remove font directories that
   * exist. Not knowing must not be reported as knowing something is absent.
   */
  foldersError: string | null;
  /** The custom font directories currently selected. */
  fontDirectories: string[];
  toggleFontDirectory: (folder: string) => void;
  /** The editable custom-attribute rows. */
  rows: AttributeRow[];
  updateRow: (index: number, field: keyof AttributeRow, value: string) => void;
  removeRow: (index: number) => void;
  addRow: () => void;
  /** Persist the merged whole configuration. */
  save: () => Promise<void>;
  /**
   * Throw away every unsaved edit, returning the draft to what is stored.
   *
   * This draft OUTLIVES the section switch by design (so a save from any section carries the
   * others' edits), which means "discard and leave" cannot work by unmounting anything — without
   * this the edits the viewer was told were discarded simply stayed, and the next save from any
   * section wrote them.
   */
  discard: () => void;
}

const RenderConfigContext = createContext<RenderConfigDraft | null>(null);

/** Access the shared render-config draft. Throws outside a {@link RenderConfigProvider}. */
export function useRenderConfigDraft(): RenderConfigDraft {
  const value = useContext(RenderConfigContext);
  if (value === null) {
    throw new Error('useRenderConfigDraft must be used within a RenderConfigProvider.');
  }
  return value;
}

interface RenderConfigProviderProperties {
  /** The project whose render config is edited. */
  projectId: string;
  /** When false, all controls are read-only (such as an archived project). */
  canEdit: boolean;
  children: React.ReactNode;
}

/**
 * Owns the render-config draft for every section of the options page.
 *
 * Mounted ABOVE the section switch, so the draft survives moving between sections and a save from any
 * one of them carries the others' edits with it.
 */
export function RenderConfigProvider({
  projectId,
  canEdit,
  children,
}: RenderConfigProviderProperties): React.JSX.Element {
  const { config, loading, loaded, saving, error, save } = useProjectRenderConfig(projectId);
  const {
    tree,
    folders,
    files,
    loading: foldersLoading,
    error: foldersError,
  } = useProjectFolders(projectId);
  const [draft, setDraft] = useState<RenderConfig>({});
  const [fontDirectories, setFontDirectories] = useState<string[]>([]);
  const [rows, setRows] = useState<AttributeRow[]>([{ name: '', value: '' }]);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  /** Return every section's view of the draft to what is stored. */
  const seedFromStored = useCallback((): void => {
    setDraft(config);
    setFontDirectories(config.extraFontDirs ?? []);
    setRows(toRows(config));
    setDirty(false);
  }, [config]);

  // Seed every section's view of the draft from the stored config — on first load, and again from the
  // response after each save, so no section is left showing a value the server did not keep.
  useEffect(() => {
    seedFromStored();
  }, [seedFromStored]);

  /** Record that the draft diverged from what is stored. */
  function touch(): void {
    setSaved(false);
    setDirty(true);
  }

  const value = useMemo<RenderConfigDraft>(() => {
    function set<K extends keyof RenderConfig>(key: K, next: RenderConfig[K]): void {
      touch();
      setDraft((current) => {
        const updated = { ...current };
        if (next === undefined || next === '') {
          delete updated[key];
        } else {
          updated[key] = next;
        }
        return updated;
      });
    }

    return {
      projectId,
      canEdit,
      loading,
      loaded,
      saving,
      dirty,
      saved,
      error,
      draft,
      set,
      discard: seedFromStored,
      tree,
      folders,
      files,
      foldersLoading,
      foldersError,
      fontDirectories,
      toggleFontDirectory(folder: string): void {
        touch();
        setFontDirectories((current) =>
          current.includes(folder) ? current.filter((entry) => entry !== folder) : [...current, folder],
        );
      },
      rows,
      updateRow(index: number, field: keyof AttributeRow, next: string): void {
        touch();
        setRows((current) =>
          current.map((row, position) => (position === index ? { ...row, [field]: next } : row)),
        );
      },
      removeRow(index: number): void {
        touch();
        setRows((current) => {
          const next = current.filter((_row, position) => position !== index);
          return next.length > 0 ? next : [{ name: '', value: '' }];
        });
      },
      addRow(): void {
        touch();
        setRows((current) => [...current, { name: '', value: '' }]);
      },
      async save(): Promise<void> {
        const customAttributes = fromRows(rows);
        // The merged WHOLE: `draft` already holds every section's options, and the two collection
        // fields are rebuilt from their own editors. A payload assembled per-section would drop the
        // sections the viewer never opened.
        const payload: RenderConfig = { ...draft };
        delete payload.extraFontDirs;
        delete payload.customAttributes;
        if (fontDirectories.length > 0) {
          payload.extraFontDirs = fontDirectories;
        }
        if (Object.keys(customAttributes).length > 0) {
          payload.customAttributes = customAttributes;
        }
        const ok = await save(payload);
        setSaved(ok);
        if (ok) setDirty(false);
      },
    };
    // `touch` is intentionally absent: it is a local closure over setState calls, stable in effect.
  }, [
    projectId,
    canEdit,
    loading,
    loaded,
    saving,
    dirty,
    saved,
    error,
    draft,
    tree,
    folders,
    files,
    foldersLoading,
    foldersError,
    fontDirectories,
    rows,
    save,
    seedFromStored,
  ]);

  return <RenderConfigContext.Provider value={value}>{children}</RenderConfigContext.Provider>;
}

/** Which group of render options a {@link RenderConfigSection} renders. */
export type RenderConfigSectionId = 'rendering' | 'pdf';

/**
 * One section's worth of render options, plus the save control that persists the merged whole.
 *
 * Every section carries its own save button because a viewer who edited only this section should not
 * have to hunt for a save elsewhere — but each one sends the same complete payload.
 */
export function RenderConfigSection({ section }: { section: RenderConfigSectionId }): React.JSX.Element {
  const state = useRenderConfigDraft();

  if (state.loading) {
    return <p className="text-sm text-muted-foreground">Loading render options…</p>;
  }

  // The stored options could not be read. The form is NOT offered: every control would show "Not
  // set" — indistinguishable from a project that stores nothing — and saving replaces the whole
  // document, so one edit would erase the doctype, theme, font directories and attributes this
  // project actually has. Showing the error alone is the only safe thing to do with a draft that
  // does not describe the server.
  if (!state.loaded) {
    return (
      <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
        {state.error ?? 'Render options could not be loaded.'} Reload the page to try again — they
        are not shown here because editing them now would overwrite the settings already stored.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {state.error && (
        <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">{state.error}</div>
      )}
      {state.saved && (
        <div className="rounded-md border p-3 text-sm border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]">
          Render options saved.
        </div>
      )}

      <fieldset className="space-y-6" disabled={!state.canEdit || state.saving}>
        {section === 'rendering' ? <RenderingFields /> : <PdfFields />}
      </fieldset>

      {state.canEdit && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => void state.save()} disabled={state.saving}>
            {state.saving ? 'Saving…' : 'Save render options'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The AsciiDoc options that shape every render, HTML preview and PDF alike. */
function RenderingFields(): React.JSX.Element {
  const { draft, set, tree, folders, foldersLoading, canEdit, saving, rows, updateRow, removeRow, addRow } =
    useRenderConfigDraft();
  const disabled = !canEdit || saving;

  // Folder selections are validated against folders that EXIST; a stored value whose folder was
  // renamed/deleted is preserved (shown as a "not found" note) rather than silently lost.
  const imagesDirectory = draft.imagesdir;
  const imagesDirectorySelected = new Set(imagesDirectory ? [imagesDirectory] : []);
  const imagesDirectoryMissing =
    imagesDirectory !== undefined && imagesDirectory !== '' && !folders.includes(imagesDirectory);

  return (
    <>
      <div className="space-y-4">
        <SectionHeading>Document</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-doctype" icon={FileType}>
              Document type
            </FieldLabel>
            <select
              id="rc-doctype"
              className={SELECT_CLASS}
              value={draft.doctype ?? ''}
              onChange={(event) => set('doctype', pick(event.target.value, DOCTYPE_OPTIONS))}
            >
              <option value="">Not set (article)</option>
              <option value="article">Article</option>
              <option value="book">Book</option>
            </select>
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="rc-icons" icon={Info}>
              Admonition icons
            </FieldLabel>
            <select
              id="rc-icons"
              className={SELECT_CLASS}
              value={draft.icons ?? ''}
              onChange={(event) => set('icons', pick(event.target.value, ICONS_OPTIONS))}
            >
              <option value="">Not set</option>
              <option value="font">Font icons</option>
              <option value="image">Image icons</option>
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <GroupLabel icon={ImageIcon}>Images directory</GroupLabel>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              className="h-4 w-4"
              checked={imagesDirectory === undefined || imagesDirectory === ''}
              disabled={disabled || foldersLoading}
              onChange={() => set('imagesdir', undefined)}
              aria-label="Project root (no images directory)"
            />
            Project root (none)
          </label>
          {foldersLoading ? (
            <p className="text-sm text-muted-foreground">Loading folders…</p>
          ) : (
            <FolderTreeSelect
              tree={tree}
              selected={imagesDirectorySelected}
              onToggle={(path) => set('imagesdir', path)}
              multi={false}
              disabled={disabled}
              ariaLabel="Images directory"
              emptyLabel={NO_FOLDERS_LABEL}
            />
          )}
          {imagesDirectoryMissing && (
            <p className="text-xs text-muted-foreground">
              Current: <code>{imagesDirectory}</code> — folder not found.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <CheckField
            label="Table of contents"
            icon={ListTree}
            checked={draft.toc === true}
            onChange={(checked) => set('toc', checked || undefined)}
          />
          <CheckField
            label="Number sections"
            icon={ListOrdered}
            checked={draft.sectnums === true}
            onChange={(checked) => set('sectnums', checked || undefined)}
          />
          <CheckField
            label="Experimental macros"
            icon={FlaskConical}
            checked={draft.experimental === true}
            onChange={(checked) => set('experimental', checked || undefined)}
          />
          <CheckField
            label="Hard line breaks"
            icon={WrapText}
            checked={draft.hardbreaks === true}
            onChange={(checked) => set('hardbreaks', checked || undefined)}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-toclevels" icon={ListTree}>
              Contents depth
            </FieldLabel>
            <select
              id="rc-toclevels"
              className={SELECT_CLASS}
              value={draft.toclevels?.toString() ?? ''}
              onChange={(event) => set('toclevels', pickNumber(event.target.value))}
            >
              <option value="">Not set (2)</option>
              {[1, 2, 3, 4, 5].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-sectnumlevels" icon={ListOrdered}>
              Numbering depth
            </FieldLabel>
            <select
              id="rc-sectnumlevels"
              className={SELECT_CLASS}
              value={draft.sectnumlevels?.toString() ?? ''}
              onChange={(event) => set('sectnumlevels', pickNumber(event.target.value))}
            >
              <option value="">Not set (3)</option>
              {[0, 1, 2, 3, 4, 5].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeading>Bibliography</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Citation settings for projects using <code>cite:[…]</code> references. Leave the source file
          unset to use the first <code>.bib</code> file found in the project.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-bibtex-file" icon={BookMarked}>
              Bibliography file
            </FieldLabel>
            <Input
              id="rc-bibtex-file"
              value={draft.bibtexFile ?? ''}
              onChange={(event) => set('bibtexFile', event.target.value)}
              placeholder="references.bib"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-bibtex-style" icon={Quote}>
              Citation style
            </FieldLabel>
            <Input
              id="rc-bibtex-style"
              value={draft.bibtexStyle ?? ''}
              onChange={(event) => set('bibtexStyle', event.target.value)}
              placeholder="apa"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-bibtex-order" icon={SortAsc}>
              Reference order
            </FieldLabel>
            <select
              id="rc-bibtex-order"
              className={SELECT_CLASS}
              value={draft.bibtexOrder ?? ''}
              onChange={(event) => set('bibtexOrder', pick(event.target.value, BIBTEX_ORDER_OPTIONS))}
            >
              <option value="">Not set</option>
              <option value="appearance">Order of appearance</option>
              <option value="alphabetical">Alphabetical</option>
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeading>Custom attributes</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Shared AsciiDoc attributes applied to every document (a document header still overrides
          them). Reserved engine attributes are ignored.
        </p>
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex gap-2">
              <Input
                aria-label={`Attribute name ${index + 1}`}
                value={row.name}
                placeholder="company"
                onChange={(event) => updateRow(index, 'name', event.target.value)}
              />
              <Input
                aria-label={`Attribute value ${index + 1}`}
                value={row.value}
                placeholder="Acme Corp"
                onChange={(event) => updateRow(index, 'value', event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove attribute ${index + 1}`}
                onClick={() => removeRow(index)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            Add attribute
          </Button>
        </div>
      </div>
    </>
  );
}

/** The Asciidoctor-PDF options: page setup, theme selection and the font search path. */
function PdfFields(): React.JSX.Element {
  const {
    draft,
    set,
    tree,
    folders,
    files,
    foldersLoading,
    foldersError,
    canEdit,
    saving,
    fontDirectories,
    toggleFontDirectory,
  } = useRenderConfigDraft();
  const disabled = !canEdit || saving;

  const fontDirectoriesSelected = new Set(fontDirectories);
  // Empty when the folder list could not be read: an unreadable tree is not evidence that a stored
  // font directory is gone, and offering to Remove one on that basis invites deleting real settings.
  const missingFontDirectories =
    foldersError === null ? fontDirectories.filter((folder) => !folders.includes(folder)) : [];

  return (
    <>
      <div className="space-y-4">
        <SectionHeading>Theme</SectionHeading>
        <ThemeField themeFiles={themeFilePaths(files)} filesLoading={foldersLoading} />
      </div>

      <div className="space-y-4">
        <SectionHeading>Page setup</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-media" icon={Monitor}>
              Output target
            </FieldLabel>
            <select
              id="rc-media"
              className={SELECT_CLASS}
              value={draft.media ?? ''}
              onChange={(event) => set('media', pick(event.target.value, MEDIA_OPTIONS))}
            >
              <option value="">Not set (screen)</option>
              <option value="screen">Screen</option>
              <option value="print">Print</option>
              <option value="prepress">Prepress</option>
            </select>
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-page-size" icon={Ruler}>
              Page size
            </FieldLabel>
            <select
              id="rc-page-size"
              className={SELECT_CLASS}
              value={draft.pdfPageSize ?? ''}
              onChange={(event) => set('pdfPageSize', pick(event.target.value, PDF_PAGE_SIZES))}
            >
              <option value="">Not set</option>
              {PDF_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-page-layout" icon={RectangleHorizontal}>
              Orientation
            </FieldLabel>
            <select
              id="rc-page-layout"
              className={SELECT_CLASS}
              value={draft.pdfPageLayout ?? ''}
              onChange={(event) => set('pdfPageLayout', pick(event.target.value, PAGE_LAYOUT_OPTIONS))}
            >
              <option value="">Not set</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="rc-folio-placement" icon={RectangleHorizontal}>
              Folio placement
            </FieldLabel>
            <select
              id="rc-folio-placement"
              className={SELECT_CLASS}
              value={draft.pdfFolioPlacement ?? ''}
              onChange={(event) =>
                set('pdfFolioPlacement', pick(event.target.value, FOLIO_PLACEMENT_OPTIONS))
              }
            >
              <option value="">Not set</option>
              <option value="virtual">Virtual</option>
              <option value="physical">Physical</option>
              <option value="physical-inverted">Physical, inverted</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Which page side carries recto/verso furniture. Meaningful with a prepress output target.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <CheckField
            label="Hyphenation"
            icon={Baseline}
            checked={draft.hyphens === true}
            onChange={(checked) => set('hyphens', checked || undefined)}
          />
          <CheckField
            label="Auto-fit wide blocks"
            icon={Scaling}
            checked={draft.autofit === true}
            onChange={(checked) => set('autofit', checked || undefined)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <GroupLabel icon={Type}>Custom font directories</GroupLabel>
        <p className="text-sm text-muted-foreground">
          Existing project folders to add to the PDF font search path (appended — they never replace the
          built-in fonts). Pick folders that contain your <code>.ttf</code>/<code>.otf</code> files.
        </p>
        {foldersLoading ? (
          <p className="text-sm text-muted-foreground">Loading folders…</p>
        ) : (
          <FolderTreeSelect
            tree={tree}
            selected={fontDirectoriesSelected}
            onToggle={toggleFontDirectory}
            multi
            disabled={disabled}
            ariaLabel="Custom font directories"
            emptyLabel={NO_FOLDERS_LABEL}
          />
        )}
        {missingFontDirectories.length > 0 && (
          <ul className="space-y-1">
            {missingFontDirectories.map((folder) => (
              <li key={folder} className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  <code>{folder}</code> — folder not found
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove font directory ${folder}`}
                  onClick={() => toggleFontDirectory(folder)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The theme selection, and — the point of the control — which theme file the project ACTUALLY renders
 * with (FR-025).
 *
 * The selection names a file in the project's own tree rather than an abstract theme name, because
 * that is what the renderer resolves it to; offering a free-text name let an owner save a value that
 * matched nothing and get an unthemed PDF with no indication why. Resolution here runs through the
 * same `resolveThemePath` the renderer uses, so this cannot advertise a theme the export ignores.
 */
function ThemeField({
  themeFiles,
  filesLoading,
}: {
  themeFiles: readonly string[];
  filesLoading: boolean;
}): React.JSX.Element {
  const { draft, set, foldersError } = useRenderConfigDraft();
  const selected = draft.pdfTheme ?? '';
  const resolved = resolveThemePath(selected, [...themeFiles]);
  // A stored selection whose file was renamed or deleted is PRESERVED as an option rather than
  // silently reset — the owner should be told it is missing and decide, not discover it in an export.
  //
  // But only when the file list is actually KNOWN. A failed tree fetch yields an empty list, which
  // would otherwise make every stored theme look deleted and state, falsely and in red, that the
  // export falls back to the default — while the export in fact applies the theme perfectly well.
  const selectionMissing = foldersError === null && selected !== '' && !themeFiles.includes(selected);

  return (
    <div className="space-y-2">
      <FieldLabel htmlFor="rc-theme" icon={Palette}>
        PDF theme file
      </FieldLabel>
      {filesLoading ? (
        <p className="text-sm text-muted-foreground">Loading theme files…</p>
      ) : (
        <select
          id="rc-theme"
          className={SELECT_CLASS}
          value={selected}
          onChange={(event) => set('pdfTheme', event.target.value)}
        >
          <option value="">Automatic (first theme file in the project)</option>
          {themeFiles.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
          {selectionMissing && <option value={selected}>{selected} (missing)</option>}
        </select>
      )}
      {!filesLoading && foldersError !== null && (
        <p className="text-sm text-muted-foreground">
          This project’s files could not be listed, so the theme shown here could not be checked
          against them. Whatever is stored is still applied when the PDF is exported.
        </p>
      )}
      {!filesLoading && foldersError === null && themeFiles.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This project has no theme file. Add one named <code>{THEME_FILENAME_CONVENTION}</code> to
          style the exported PDF.
        </p>
      )}
      {!filesLoading && (
        <p className="text-sm" data-testid="resolved-theme">
          <ResolvedTheme resolved={resolved} missing={selectionMissing} />
        </p>
      )}
    </div>
  );
}

/** Which theme the export will actually apply, stated plainly rather than left to be inferred. */
function ResolvedTheme({
  resolved,
  missing,
}: {
  resolved: string | undefined;
  missing: boolean;
}): React.JSX.Element {
  if (resolved === undefined) {
    return <span className="text-muted-foreground">Renders with the built-in default theme.</span>;
  }
  if (missing) {
    return (
      <span className="text-destructive">
        Selected <code>{resolved}</code> — that file is not in this project, so the built-in default
        theme is used instead.
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      Renders with <code>{resolved}</code>.
    </span>
  );
}

/** A plain section heading, matching the icon-less headings elsewhere on the settings page. */
function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

/** A field label with a leading icon, associated with an input by id (keeps `getByLabel` text). */
function FieldLabel({
  htmlFor,
  icon: Icon,
  children,
}: {
  htmlFor: string;
  icon: LucideIcon;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {children}
    </Label>
  );
}

/** A group label with a leading icon for a control group (radios/tree) that has no single input id. */
function GroupLabel({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {children}
    </p>
  );
}

/** A labelled checkbox styled to match the settings forms. */
function CheckField({
  label,
  icon: Icon,
  checked,
  onChange,
}: {
  label: string;
  icon: LucideIcon;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-input"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {label}
    </label>
  );
}
