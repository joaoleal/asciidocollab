import { Suspense } from "react";
import { getProjectAccess } from "@/lib/get-project-access";
import { SettingsClient } from "./settings-client";

interface SettingsPageProperties {
  params: Promise<{ id: string }>;
}

/** Server component page for viewing and editing settings of a specific project. */
export default async function ProjectSettingsPage({ params }: SettingsPageProperties) {
  const { id } = await params;
  const { project, currentUserRole } = await getProjectAccess(id, "owner");

  // The client reads `?section=` to choose which section to show, so it must sit under a Suspense
  // boundary: `useSearchParams` opts its subtree out of prerendering, and Next refuses to build a
  // server page whose client child does that unbounded.
  return (
    <Suspense fallback={null}>
      <SettingsClient project={project} currentUserRole={currentUserRole} />
    </Suspense>
  );
}
