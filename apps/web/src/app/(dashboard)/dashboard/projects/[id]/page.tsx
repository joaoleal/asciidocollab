import { getProjectAccess } from "@/lib/get-project-access";
import { ProjectEditorLayout } from "./project-editor-layout";

interface ProjectPageProperties {
  params: Promise<{ id: string }>;
}

/** Server component that delegates to the client-side project editor layout. */
export default async function ProjectPage({ params }: ProjectPageProperties) {
  const { id } = await params;
  const { project, currentUserId, currentUserRole, isAdmin } = await getProjectAccess(id, "viewer");
  const canManage = currentUserRole === "owner";
  const canEdit = currentUserRole === "editor" || currentUserRole === "owner" || isAdmin;
  // Whether the user may MUTATE the project's file structure (create/rename/move/delete/upload). Unlike
  // `canEdit`, this excludes the global-admin bypass, because the file-tree use-cases authorize purely
  // on project role (viewer < editor < owner) and do NOT special-case admins. Threading the admin-
  // inclusive `canEdit` to the file tree would show a global admin — who is only a viewer of this
  // project (e.g. the read-only demo) — New File / Upload buttons that the API then rejects with 403.
  // The document editor needs no equivalent split: the collaboration server already forces a viewer's
  // session to read-only (observer) regardless of admin, so its affordances match the server there.
  const canModifyFiles = currentUserRole === "editor" || currentUserRole === "owner";
  // The project's shared dictionary is the same shape of permission as the file tree, and needs the
  // same narrowing: `requireDictionaryEditor` authorizes on project membership alone (editor/owner)
  // with no admin bypass, so passing the admin-inclusive `canEdit` would offer a global admin who is
  // only a viewer here an Add-to-dictionary control the API then rejects with 403. Unlike the file
  // tree, the collaboration server does NOT cover this case — a dictionary write is a project-scoped
  // REST call with no collab session in the path, so nothing else forces the admin read-only.
  const canManageDictionary = canModifyFiles;

  return (
    <ProjectEditorLayout
      projectId={id}
      projectName={project.name}
      projectDescription={project.description ?? null}
      projectLanguage={project.language ?? null}
      mainFileNodeId={project.mainFileNodeId ?? null}
      canManage={canManage}
      canEdit={canEdit}
      canModifyFiles={canModifyFiles}
      canManageDictionary={canManageDictionary}
      userId={currentUserId}
    />
  );
}
