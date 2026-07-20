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
 *  - It does not change sections while the section being left holds unsaved edits without asking
 *    first (FR-005). The General form's state is local to its own fields and genuinely would be lost.
 */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/back-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { projectsApi, Project, ProjectMemberRole } from "@/lib/api";
import { updateProjectSchema, type UpdateProjectInput } from "@asciidocollab/shared";
import { ArchiveButton } from "@/components/archive-button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DeleteProjectButton } from "@/components/delete-project-button";
import { EditorMainFilePicker } from "@/components/editor/editor-main-file-picker";
import {
  RenderConfigProvider,
  RenderConfigSection,
  useRenderConfigDraft,
} from "@/components/render-config-settings";
import { ExtensionsSection } from "@/components/settings/extensions-section";
import { SectionNav } from "@/components/settings/section-nav";
import {
  resolveSettingsSection,
  settingsSection,
  visibleSettingsSections,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { SPELLCHECK_LANGUAGE_OPTIONS } from "@/lib/codemirror/spellcheck-languages";

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
 * Moving between them loses nothing, because the draft outlives the switch; leaving the group is
 * what discards. Extensions is a member — its toggles write to the same draft as the others.
 */
const RENDER_CONFIG_SECTIONS: ReadonlySet<SettingsSectionId> = new Set<SettingsSectionId>([
  "rendering",
  "pdf",
  "extensions",
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

  /** True when leaving `section` right now would lose edits the viewer made and has not saved. */
  function hasUnsavedEdits(leaving: SettingsSectionId): boolean {
    if (leaving === "general") return generalDirty;
    // The AsciiDoc, PDF and Extensions sections share one draft that OUTLIVES the section change, so
    // moving between them loses nothing. Leaving the group entirely does, since the save control goes
    // with them. Extensions belongs in this list: its toggles write to the SAME draft, so omitting it
    // let a viewer leave with unsaved extension changes unwarned — which then rode along on the next
    // save from any other section.
    if (RENDER_CONFIG_SECTIONS.has(leaving)) return renderConfig.dirty;
    return false;
  }

  function requestSection(next: SettingsSectionId): void {
    if (next === section) return;
    const staysInRenderConfig =
      RENDER_CONFIG_SECTIONS.has(section) && RENDER_CONFIG_SECTIONS.has(next);
    if (!staysInRenderConfig && hasUnsavedEdits(section)) {
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
        {(section === "rendering" || section === "pdf") && <RenderConfigSection section={section} />}
        {section === "extensions" && <ExtensionsSection />}
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
            // just confirmed — and be written by the next save from any section.
            renderConfig.discard();
            onNavigate(next);
          }
        }}
      />
    </div>
  );
}

/** The project's own identity: name, description, tags, language and main file. */
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState<UpdateProjectInput>({
    name: project.name,
    description: project.description || "",
    tags: project.tags,
  });
  const [language, setLanguage] = useState<string | null>(project.language);

  /** Apply an edit and report the section as holding unsaved changes. */
  function edit(next: Partial<UpdateProjectInput>): void {
    setSuccess(false);
    onDirtyChange(true);
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
    <div className="space-y-8">
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
              setSuccess(false);
              onDirtyChange(true);
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

      {!isArchived && (
        <div className="space-y-2 pt-4 border-t">
          <h3 className="text-sm font-semibold">Main file</h3>
          <p className="text-sm text-muted-foreground">
            The main file scopes cross-file resolution (include graph, symbols, diagnostics, and
            heading levels) for the whole project. Leave it unset to resolve each file on its own.
          </p>
          <EditorMainFilePicker
            projectId={project.id}
            canEdit={!isArchived}
            currentMainFileNodeId={project.mainFileNodeId}
          />
        </div>
      )}
    </div>
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
