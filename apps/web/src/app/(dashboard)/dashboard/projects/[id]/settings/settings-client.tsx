"use client";

/**
 * The project options page.
 *
 * The page presents one section at a time, selected by `?section=` so a section can be linked to
 * directly (FR-003). Two things it deliberately does NOT do:
 *
 *  - It does not unmount the render-config draft when the section changes. That draft lives in a
 *    provider wrapping the whole switch, so options edited in AsciiDoc survive a trip to PDF and a
 *    save from either one carries both (FR-006).
 *  - It does not change sections while the section being left holds unsaved edits that the move would
 *    genuinely lose, without asking first (FR-005). The General form's own fields are local state and
 *    do get lost; the shared draft — which General also writes, through the grammar controls beside
 *    Language — does not, until the viewer leaves every section that can save it.
 */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/back-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { projectsApi, Project, ProjectMemberRole } from "@/lib/api";
import { setProjectMainFile } from "@/lib/api/projects";
import { updateProjectSchema, type UpdateProjectInput } from "@asciidocollab/shared";
import { ArchiveButton } from "@/components/archive-button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DeleteProjectButton } from "@/components/delete-project-button";
import { MainFileField } from "@/components/settings/main-file-field";
import {
  RenderConfigProvider,
  RenderConfigSection,
  useRenderConfigDraft,
} from "@/components/render-config-settings";
import { ExtensionsSection } from "@/components/settings/extensions-section";
import { RepositorySection } from "@/components/git/repository-section";
import { SectionNav } from "@/components/settings/section-nav";
import {
  resolveSettingsSection,
  settingsSection,
  visibleSettingsSections,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { SPELLCHECK_LANGUAGE_OPTIONS } from "@/lib/codemirror/spellcheck-languages";
import { GrammarSettingsSection } from "@/components/settings/grammar-settings-section";
import { DEFAULT_GRAMMAR_DIALECT } from "@/lib/codemirror/harper/dialect";

interface SettingsClientProperties {
  project: Project;
  currentUserRole: ProjectMemberRole;
}

/** Client component for editing project settings. */
export function SettingsClient({ project, currentUserRole }: SettingsClientProperties) {
  const router = useRouter();
  const searchParameters = useSearchParams();
  const isArchived = !!project.archivedAt;
  const isOwner = currentUserRole === "owner";

  const basePath = `/dashboard/projects/${project.id}/settings`;
  const section = resolveSettingsSection(searchParameters?.get("section"), isOwner);
  const definition = settingsSection(section);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <BackButton href={`/dashboard/projects/${project.id}`} label="Back to project" />
        <div>
          <h1 className="text-2xl font-bold">Project Settings</h1>
          <p className="text-muted-foreground">Update {project.name} settings.</p>
        </div>
      </div>
      {isArchived && (
        <div className="p-4 rounded-md border text-sm font-medium border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]">
          This project is archived. Settings are read-only. Restore the project to make changes.
        </div>
      )}

      <RenderConfigProvider projectId={project.id} canEdit={!isArchived}>
        <SectionedSettings
          project={project}
          isOwner={isOwner}
          isArchived={isArchived}
          section={section}
          sectionLabel={definition.label}
          sectionDescription={definition.description}
          basePath={basePath}
          onNavigate={(next) => router.replace(`${basePath}?section=${next}`, { scroll: false })}
          router={router}
        />
      </RenderConfigProvider>
    </div>
  );
}

interface SectionedSettingsProperties {
  project: Project;
  isOwner: boolean;
  isArchived: boolean;
  section: SettingsSectionId;
  sectionLabel: string;
  sectionDescription: string;
  basePath: string;
  onNavigate: (next: SettingsSectionId) => void;
  router: ReturnType<typeof useRouter>;
}

/**
 * The navigation plus the selected section's content.
 *
 * Split out from {@link SettingsClient} so it sits INSIDE the render-config provider and can consult
 * the draft's dirty state when deciding whether a section change needs confirming.
 */
/**
 * The sections backed by the ONE shared render-config draft.
 *
 * Moving between them loses nothing, because the draft outlives the switch and every one of them can
 * still save it; leaving the group is what discards. Extensions is a member — its toggles write to
 * the same draft as the others. So is General, since the grammar-checking controls that sit with
 * Language write to that draft too and General's Save flushes it.
 */
const RENDER_CONFIG_SECTIONS: ReadonlySet<SettingsSectionId> = new Set<SettingsSectionId>([
  "general",
  "rendering",
  "pdf",
  "extensions",
  "html",
]);

function SectionedSettings({
  project,
  isOwner,
  isArchived,
  section,
  sectionLabel,
  sectionDescription,
  basePath,
  onNavigate,
  router,
}: SectionedSettingsProperties) {
  const renderConfig = useRenderConfigDraft();
  const [generalDirty, setGeneralDirty] = useState(false);
  const [pendingSection, setPendingSection] = useState<SettingsSectionId | null>(null);

  /**
   * True when moving from `leaving` to `next` right now would lose edits the viewer made and has not
   * saved. The two kinds of state on this page die at different moments, so the destination matters:
   *
   *  - General's own form fields (name, description, tags, language, main file) are local component
   *    state that unmounts with the section, so they are lost whatever the destination.
   *  - The render-config draft lives in a provider ABOVE the section switch and every section in
   *    {@link RENDER_CONFIG_SECTIONS} carries a save that sends the merged whole, so it is only lost
   *    when the viewer leaves that group. Warning on a move inside the group would be a lie — and the
   *    confirmation discards, which would destroy edits that were never at risk.
   */
  function leavingLosesEdits(leaving: SettingsSectionId, next: SettingsSectionId): boolean {
    if (leaving === "general" && generalDirty) return true;
    if (RENDER_CONFIG_SECTIONS.has(leaving) && !RENDER_CONFIG_SECTIONS.has(next)) {
      return renderConfig.dirty;
    }
    return false;
  }

  function requestSection(next: SettingsSectionId): void {
    if (next === section) return;
    if (leavingLosesEdits(section, next)) {
      setPendingSection(next);
      return;
    }
    onNavigate(next);
  }

  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
      <SectionNav
        sections={visibleSettingsSections(isOwner)}
        current={section}
        basePath={basePath}
        onSelect={requestSection}
      />

      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{sectionLabel}</h2>
          <p className="text-sm text-muted-foreground">{sectionDescription}</p>
        </div>

        {section === "general" && (
          <GeneralSection
            project={project}
            isArchived={isArchived}
            router={router}
            onDirtyChange={setGeneralDirty}
          />
        )}
        {(section === "rendering" || section === "pdf" || section === "html") && (
          <RenderConfigSection section={section} />
        )}
        {section === "extensions" && <ExtensionsSection />}
        {section === "repository" && isOwner && <RepositorySection projectId={project.id} />}
        {section === "danger" && isOwner && <DangerSection project={project} router={router} />}
      </div>

      <ConfirmationDialog
        open={pendingSection !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSection(null);
        }}
        title="Discard unsaved changes?"
        description="This section has changes you have not saved. Leaving it now discards them."
        confirmLabel="Discard and leave"
        cancelLabel="Stay here"
        onConfirm={() => {
          const next = pendingSection;
          setPendingSection(null);
          if (next !== null) {
            setGeneralDirty(false);
            // The render-config draft lives in a provider ABOVE the section switch, so nothing
            // unmounts on navigation and its edits would otherwise survive the discard the viewer
            // just confirmed — and be written by the next save from any section. It is thrown away
            // only when the destination cannot save it: a prompt raised by General's own form
            // fields must not take the grammar/AsciiDoc/PDF edits down with it, since those are
            // still live and still savable where the viewer is going.
            if (!RENDER_CONFIG_SECTIONS.has(next)) renderConfig.discard();
            onNavigate(next);
          }
        }}
      />
    </div>
  );
}

/**
 * The project's own identity: name, description, tags, language, grammar checking and main file.
 *
 * Every field here is a DRAFT until the viewer saves, whichever document it ends up in. Name,
 * description, tags and language go to the project row; the main file goes to the project row too but
 * through its own endpoint; grammar checking is stored on the render config, so its two controls write
 * the shared draft and the submit flushes that draft as well — see {@link GrammarPanel} for why they
 * sit here at all. The submit is what writes all three, so a Cancel or a discarded section change
 * leaves every one of them untouched.
 */
function GeneralSection({
  project,
  isArchived,
  router,
  onDirtyChange,
}: {
  project: Project;
  isArchived: boolean;
  router: ReturnType<typeof useRouter>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const renderConfig = useRenderConfigDraft();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState<UpdateProjectInput>({
    name: project.name,
    description: project.description || "",
    tags: project.tags,
  });
  const [language, setLanguage] = useState<string | null>(project.language);
  const [mainFileNodeId, setMainFileNodeId] = useState<string | null>(project.mainFileNodeId);

  /** Report the section as holding unsaved changes, and retract any earlier success banner. */
  function markEdited(): void {
    setSuccess(false);
    onDirtyChange(true);
  }

  /** Apply an edit and report the section as holding unsaved changes. */
  function edit(next: Partial<UpdateProjectInput>): void {
    markEdited();
    setFormData((current) => ({ ...current, ...next }));
  }

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const validatedData = updateProjectSchema.parse({ ...formData, language });
      await projectsApi.update(project.id, {
        name: validatedData.name,
        description: validatedData.description || undefined,
        tags: validatedData.tags,
        language: validatedData.language ?? null,
      });
      // The main file has an endpoint of its own — it re-scopes every open document, so setting it
      // audits and broadcasts rather than patching a column. Sent only when the viewer actually
      // changed it, so an unrelated rename does not re-announce a main file nobody touched. A
      // rejection here (a file deleted since the page loaded, a permission lost) throws, so the
      // section reports the failure instead of claiming a save it did not make.
      if (mainFileNodeId !== project.mainFileNodeId) {
        await setProjectMainFile(project.id, mainFileNodeId);
      }
      // Grammar checking is stored on the render config — a different document behind a different
      // endpoint — so this section's one Save has to write both, or a toggled checkbox would look
      // saved and not be. Sent only when the draft actually diverged, and sent as the merged WHOLE
      // (see `RenderConfigProvider.save`), so a save from here cannot wipe the settings of the
      // sections the viewer never opened. A failed render-config save does not throw — it reports
      // `false` — so it is checked explicitly: half a save is a failed save, and the section has to
      // stay dirty so the viewer's toggle is not silently dropped on the next navigation.
      if (renderConfig.dirty && !(await renderConfig.save())) {
        setError(renderConfig.error ?? "Failed to save grammar and rendering settings");
        return;
      }
      setSuccess(true);
      onDirtyChange(false);
      router.refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to update project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
      )}
      {success && (
        <div className="rounded-md border p-3 text-sm border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]">
          Project settings updated successfully.
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="name">Project Name *</Label>
        <Input
          id="name"
          value={formData.name || ""}
          onChange={(event) => edit({ name: event.target.value })}
          placeholder="My Awesome Project"
          required
          maxLength={100}
          disabled={isArchived}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          value={formData.description || ""}
          onChange={(event) => edit({ description: event.target.value })}
          placeholder="Optional project description"
          className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          maxLength={1000}
          disabled={isArchived}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="tags">Tags (comma-separated)</Label>
        <Input
          id="tags"
          value={formData.tags?.join(", ") || ""}
          onChange={(event) =>
            edit({
              tags: event.target.value.split(",").map((t) => t.trim()).filter(Boolean),
            })
          }
          placeholder="documentation, api, guide"
          disabled={isArchived}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="language">Language</Label>
        <p className="text-sm text-muted-foreground">
          Document language for the editor&apos;s spell checker. Applies to everyone editing this
          project.
        </p>
        <select
          id="language"
          value={language ?? ""}
          onChange={(event) => {
            markEdited();
            setLanguage(event.target.value || null);
          }}
          disabled={isArchived}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">Not set</option>
          {SPELLCHECK_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/*
        Gated on the LIVE value of the select above, not the project's stored language: picking a
        different language greys these controls out and says why on the spot, which is the whole
        reason they sit here. It is also honest about what saving does — this form writes the
        language and the grammar settings together.
      */}
      <div className="rounded-md border p-4">
        <GrammarPanel languageIsEnglish={language === "en"} />
      </div>

      <MainFileField
        projectId={project.id}
        value={mainFileNodeId}
        disabled={isArchived}
        onChange={(next) => {
          markEdited();
          setMainFileNodeId(next);
        }}
      />

      {!isArchived && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * The grammar & spelling controls, shown with the Language setting.
 *
 * They belong beside Language because they are GATED on it: checking only runs for English projects
 * and the dialect is meaningless otherwise. Sitting in a section of their own, the dependency was
 * invisible — someone changed the language and had no way to know they had just turned checking off.
 *
 * The two settings are stored on the project's render config rather than the project row (they are
 * checker configuration, not Asciidoctor attributes), so this panel reads and writes the ONE shared
 * draft the AsciiDoc/PDF/HTML/Extensions sections use, and General's Save flushes it.
 *
 * @param properties - Whether the language currently selected in the form is English.
 * @returns The grammar panel element.
 */
function GrammarPanel({ languageIsEnglish }: { languageIsEnglish: boolean }): React.JSX.Element {
  const renderConfig = useRenderConfigDraft();

  if (renderConfig.loading) {
    return <p className="text-sm text-muted-foreground">Loading grammar options…</p>;
  }

  // The stored render config could not be READ, and saving it is a whole-document replace: a toggle
  // made against the empty default would erase every other option this project has. So the controls
  // are not offered at all — the same rule the render-config sections apply to their own fields.
  if (!renderConfig.loaded) {
    return (
      <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
        {renderConfig.error ?? "Render options could not be loaded."} Grammar checking is not shown
        here because saving it now would overwrite the options already stored.
      </div>
    );
  }

  return (
    <>
      {renderConfig.error !== null && (
        <div role="alert" className="mb-3 p-3 text-sm text-destructive bg-destructive/10 rounded-md">
          {renderConfig.error}
        </div>
      )}
      <GrammarSettingsSection
        enabled={renderConfig.draft.grammarCheckEnabled ?? true}
        dialect={renderConfig.draft.grammarDialect ?? DEFAULT_GRAMMAR_DIALECT}
        languageIsEnglish={languageIsEnglish}
        canEdit={renderConfig.canEdit && !renderConfig.saving}
        onEnabledChange={(next) => renderConfig.set("grammarCheckEnabled", next)}
        onDialectChange={(next) => renderConfig.set("grammarDialect", next)}
      />
    </>
  );
}

/** Archiving and deletion — owner-only, and the only section whose actions are irreversible. */
function DangerSection({
  project,
  router,
}: {
  project: Project;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <div className="flex items-center gap-4">
      <ArchiveButton
        projectId={project.id}
        projectName={project.name}
        isArchived={!!project.archivedAt}
        onArchive={() => router.push("/dashboard")}
        onRestore={() => router.refresh()}
      />
      <DeleteProjectButton
        projectId={project.id}
        projectName={project.name}
        onDeleted={() => router.push("/dashboard?deleted=1")}
      />
    </div>
  );
}
