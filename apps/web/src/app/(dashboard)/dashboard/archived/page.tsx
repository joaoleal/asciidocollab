"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi, Project } from "@/lib/api";
import { CLONE_IN_PROGRESS_CODE } from "@/lib/api/projects";
import { ProjectCard } from "@/components/project-card";
import type { CloneFailure } from "@/components/clone-project-dialog";
import { EmptyState } from "@/components/empty-state";

/**
 * Page displaying archived projects.
 */
export default function ArchivedProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clonedProject, setClonedProject] = useState<Project | null>(null);
  const [cloneFailure, setCloneFailure] = useState<CloneFailure | null>(null);

  /**
   * Pressing Clone retires a standing refusal, and only that. A refusal describes an attempt the
   * user is visibly retrying, so leaving it up beside a running copy reads as though the retry has
   * already failed too.
   *
   * The confirmation is deliberately left alone, and on this page that matters more than on the
   * active listing: it holds the only link to a copy that will never appear here. Clearing it at
   * the start of a second attempt would strand the first copy the moment that attempt failed inside
   * its own still-open dialog, because such a failure is shown there and never reaches this page.
   */
  const handleCloneStarted = () => {
    setCloneFailure(null);
  };

  /**
   * A copy is always active, so it can never belong in this listing — inserting it would make the
   * page claim an active project is archived. The listing is therefore left exactly as the server
   * described it, and the confirmation alone carries the new project: it is named there and reached
   * through the link beside it. Like the active listing, this reads the response body directly,
   * which the clone route can supply only because it answers with the same full project shape.
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
    setClonedProject(created);
    setCloneFailure((current) => (current?.code === CLONE_IN_PROGRESS_CODE ? null : current));
  };

  /**
   * The dialog only reports here when it was dismissed before its request failed, so its own message
   * area is gone. It deliberately leaves any confirmation standing: two attempts can be in flight at
   * once — one dismissed mid-copy, one started after it — and a refusal aimed at the second says
   * nothing about the copy the first really created. Wiping it here would be worse than misleading,
   * because the confirmation holds the only link to a project this listing will never show.
   *
   * @param failure - The dialog's explanation of why the copy failed, and the code it came from.
   */
  const handleCloneFailed = (failure: CloneFailure) => {
    setCloneFailure(failure);
  };

  useEffect(() => {
    async function fetchProjects() {
      try {
        const response = await projectsApi.list({ page: 1, limit: 50, archived: true });
        setProjects(response.data);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to load projects");
      } finally {
        setLoading(false);
      }
    }

    fetchProjects();
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Archived Projects</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-48 rounded-lg border bg-muted animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Archived Projects</h1>
        <div className="text-center py-12">
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  // An empty listing is a branch inside this return rather than an early one above it, so that the
  // two notices below sit above everything the listing can turn into. The confirmation is the only
  // route to a copy made from here, and returning early for an empty list would throw it away for
  // any reason the list could later become empty in place.
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {clonedProject && (
        // Deliberately persistent: it carries the only direct route to a project that, being
        // active, will never appear in the listing below it.
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
      {projects.length === 0 ? (
        <>
          <h1 className="text-2xl font-bold">Archived Projects</h1>
          <EmptyState
            title="No archived projects"
            description="Projects you archive will appear here."
          />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Archived Projects</h1>
            <p className="text-sm text-muted-foreground">
              {projects.length} archived project{projects.length === 1 ? "" : "s"}
            </p>
          </div>
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
        </>
      )}
    </div>
  );
}
