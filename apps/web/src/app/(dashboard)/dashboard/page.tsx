"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, Archive, GitBranch } from "lucide-react";
import { projectsApi, Project } from "@/lib/api";
import { CLONE_IN_PROGRESS_CODE } from "@/lib/api/projects";
import { ProjectCard } from "@/components/project-card";
import type { CloneFailure } from "@/components/clone-project-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ImportRepositoryDialog } from "@/components/git/import-repository-dialog";

/** Renders the main dashboard page listing all projects for the current user. */
export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletedNotice, setDeletedNotice] = useState(false);
  const [clonedProject, setClonedProject] = useState<Project | null>(null);
  const [cloneFailure, setCloneFailure] = useState<CloneFailure | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const searchParameters = useSearchParams();

  /**
   * Pressing Clone retires a standing refusal, and only that. A refusal describes an attempt the
   * user is visibly retrying, so leaving it up beside a running copy reads as though the retry has
   * already failed too.
   *
   * The confirmation is deliberately left alone. It is not the status of an attempt — it names a
   * project that exists and links to it, and starting a second copy takes nothing away from the
   * first. Clearing it here would blank the page whenever the new attempt then failed while its own
   * dialog was still open, since that failure is reported inside the dialog and never reaches this
   * page at all.
   */
  const handleCloneStarted = () => {
    setCloneFailure(null);
  };

  /**
   * The clone response and this insert are a single decision, not two: the clone route answers with
   * the same full project shape the list route emits, which is the only reason the new card can be
   * built from the response instead of costing a second round trip. Narrow that body and this has
   * to become a refetch, or the card renders with blank member and file counts.
   *
   * A refusal on screen is left standing, with one exception. Two attempts can be in flight at once
   * — one dismissed mid-copy, one started after it — so a refusal aimed at the other one is still
   * true after this copy lands, and clearing it would report both as successful and silently lose
   * the one that was not.
   *
   * The exception is the refusal whose whole content is that another copy was still running, which
   * is also the one this situation reliably produces: the server serialises clones per user, so the
   * second of two overlapping attempts is turned away with exactly that. This copy landing is what
   * makes it false. Left alone it would sit under a fresh confirmation telling the user to wait for
   * a clone that has already finished, and announce itself while doing so. The notice does carry a
   * Dismiss control, but a refusal the page can already tell is false should not wait on the user to
   * clear it.
   *
   * @param created - The project the server just created.
   */
  const handleCloned = (created: Project) => {
    setProjects((current) => [created, ...current]);
    setClonedProject(created);
    setCloneFailure((current) => (current?.code === CLONE_IN_PROGRESS_CODE ? null : current));
  };

  /**
   * The dialog only reports here when it was dismissed before its request failed, so its own message
   * area is gone. It deliberately leaves any confirmation standing, for the mirror of the reason
   * above: a refusal aimed at one attempt says nothing about the copy another really created, and
   * wiping it would deny a project that exists.
   *
   * @param failure - The dialog's explanation of why the copy failed, and the code it came from.
   */
  const handleCloneFailed = (failure: CloneFailure) => {
    setCloneFailure(failure);
  };

  useEffect(() => {
    if (searchParameters.get("deleted") === "1") {
      setDeletedNotice(true);
      const timer = setTimeout(() => setDeletedNotice(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [searchParameters]);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const response = await projectsApi.list({ page: 1, limit: 20 });
        setProjects(response.data);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to load projects");
      } finally {
        setLoading(false);
      }
    }
    fetchProjects();
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((index) => (
          <div key={index} className="h-48 rounded-lg border bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto text-center py-12">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {deletedNotice && (
        <div className="rounded-md border p-3 text-sm border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]">
          Project deleted successfully.
        </div>
      )}

      {clonedProject && (
        // Deliberately has no dismiss timer, unlike the deleted notice above: this one carries the
        // direct route to the new project, and a timer would take that away mid-reach.
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]"
        >
          <span>
            Created <strong>{clonedProject.name}</strong>.
          </span>
          <Link
            href={`/dashboard/projects/${clonedProject.id}`}
            className="font-medium underline underline-offset-2"
          >
            Open {clonedProject.name}
          </Link>
        </div>
      )}

      {cloneFailure && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span>{cloneFailure.message}</span>
          <button
            type="button"
            onClick={() => setCloneFailure(null)}
            className="font-medium underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Your Projects</h2>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/archived">
              <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
              Archived projects
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <GitBranch className="mr-2 h-4 w-4" aria-hidden="true" />
            Import from Git
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/projects/new">
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              New Project
            </Link>
          </Button>
        </div>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create your first project to get started with collaborative documentation."
          actionLabel="Create Project"
          actionHref="/dashboard/projects/new"
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onCloneStarted={handleCloneStarted}
              onCloned={handleCloned}
              onCloneFailed={handleCloneFailed}
            />
          ))}
        </div>
      )}

      <ImportRepositoryDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
