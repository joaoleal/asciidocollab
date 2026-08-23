"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, Archive } from "lucide-react";
import { projectsApi, Project } from "@/lib/api";
import { ProjectCard } from "@/components/project-card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

/** Renders the main dashboard page listing all projects for the current user. */
export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletedNotice, setDeletedNotice] = useState(false);
  const [clonedProject, setClonedProject] = useState<Project | null>(null);
  const searchParameters = useSearchParams();

  /**
   * The clone response and this insert are a single decision, not two: the clone route answers with
   * the same full project shape the list route emits, which is the only reason the new card can be
   * built from the response instead of costing a second round trip. Narrow that body and this has
   * to become a refetch, or the card renders with blank member and file counts.
   */
  const handleCloned = (created: Project) => {
    setProjects((current) => [created, ...current]);
    setClonedProject(created);
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

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Your Projects</h2>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/archived">
              <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
              Archived projects
            </Link>
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
            <ProjectCard key={project.id} project={project} onCloned={handleCloned} />
          ))}
        </div>
      )}
    </div>
  );
}
