"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi, Project } from "@/lib/api";
import { ProjectCard } from "@/components/project-card";
import { EmptyState } from "@/components/empty-state";

/**
 * Page displaying archived projects.
 */
export default function ArchivedProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clonedProject, setClonedProject] = useState<Project | null>(null);

  /**
   * A copy is always active, so it can never belong in this listing — inserting it would make the
   * page claim an active project is archived. The listing is therefore left exactly as the server
   * described it, and the confirmation alone carries the new project: it is named there and reached
   * through the link beside it. Like the active listing, this reads the response body directly,
   * which the clone route can supply only because it answers with the same full project shape.
   *
   * @param created - The project the server just created.
   */
  const handleCloned = (created: Project) => {
    setClonedProject(created);
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

  if (projects.length === 0) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Archived Projects</h1>
        <EmptyState
          title="No archived projects"
          description="Projects you archive will appear here."
        />
      </div>
    );
  }

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Archived Projects</h1>
        <p className="text-sm text-muted-foreground">
          {projects.length} archived project{projects.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onCloned={handleCloned} />
        ))}
      </div>
    </div>
  );
}
