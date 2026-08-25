import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/require-auth';
import { requireEmailVerified } from '../plugins/require-email-verified';
import { healthRoute } from '../routes/health';
import { loginRoute } from '../routes/auth/login';
import { registerRoute } from '../routes/auth/register';
import { logoutRoute } from '../routes/auth/logout';
import { meRoute } from '../routes/auth/me';
import { passwordChangeRoute } from '../routes/auth/password/change';
import { profileUpdateRoute } from '../routes/auth/me/profile';
import { emailChangeRequestRoute } from '../routes/auth/email/change-request';
import { emailConfirmRoute } from '../routes/auth/email/confirm';
import { passwordResetRequestRoute } from '../routes/auth/password/reset-request';
import { passwordResetRoute } from '../routes/auth/password/reset';
import { projectRoutes } from '../routes/projects';
import { memberRoutes } from '../routes/projects/members';
import { usersSearchRoute } from '../routes/projects/users-search';
import { setupStatusRoute } from '../routes/auth/setup-status';
import { sessionStatusRoute } from '../routes/auth/session-status';
import { acceptInviteRoute } from '../routes/auth/accept-invite';
import { usersInviteRoute } from '../routes/admin/users-invite';
import { usersRoute } from '../routes/admin/users';
import { usersAdminStatusRoute } from '../routes/admin/users-admin-status';
import { usersRemoveRoute } from '../routes/admin/users-remove';
import { verifyEmailRoute } from '../routes/auth/verify-email';
import { resendVerificationRoute } from '../routes/auth/resend-verification';
import { openRegistrationStatusRoute } from '../routes/auth/open-registration-status';
import { adminSettingsRoute } from '../routes/admin/settings';
import { accessDeniedRoute } from '../routes/admin/access-denied';
import { auditLogsRoute } from '../routes/admin/audit-logs';
import { failedSignInsRoute } from '../routes/admin/failed-sign-ins';
import { projectDownloadRoute } from '../routes/projects/download';
import { fileDownloadRoute } from '../routes/projects/file-download';
import { fileContentRoutes } from '../routes/projects/file-content';
import { fileTreeRoutes } from '../routes/projects/file-tree';
import { projectMainFileRoutes } from '../routes/projects/main-file';
import { renderConfigRoutes } from '../routes/projects/render-config';
import { gitIgnorePatternsRoutes } from '../routes/projects/git-ignore-patterns';
import { gitOperationStatusRoutes } from '../routes/projects/git/operation-status';
import { gitStatusRoutes } from '../routes/projects/git/status';
import { gitTreeStatusRoutes } from '../routes/projects/git/tree-status';
import { gitStageRoutes } from '../routes/projects/git/stage';
import { gitUnstageRoutes } from '../routes/projects/git/unstage';
import { gitCommitRoutes } from '../routes/projects/git/commit';
import { gitPushRoutes } from '../routes/projects/git/push';
import { cloneRoutes } from '../routes/projects/clone';
import { gitImportRoutes } from '../routes/git/import';
import { dictionaryRoutes } from '../routes/grammar/dictionary';
import { ignoredLintsRoutes } from '../routes/grammar/ignored-lints';
import { pdfExtensionRoutes } from '../routes/projects/pdf-extensions';
import { projectRefactoringRoutes } from '../routes/projects/refactoring';
import { projectSearchRoutes } from '../routes/projects/search';
import { assetsRoutes } from '../routes/projects/assets';
import { eventsRoutes } from '../routes/projects/events';
import { reviewRoutes } from '../routes/review';
import { keybindingsRoutes } from '../routes/auth/me/keybindings';
import { editorPreferencesRoutes } from '../routes/auth/me/editor-preferences';

/**
 * Registers all application routes on a fully-built server instance in the exact
 * order and nesting (public, then authenticated, then email-verified) required
 * by the server bootstrap.
 *
 * @param app - The fully-built Fastify instance to register routes onto.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Public routes — no auth required
  await app.register(healthRoute);
  await app.register(setupStatusRoute);
  await app.register(sessionStatusRoute);
  await app.register(emailConfirmRoute);

  // Public auth routes — protected by SameSite=Strict + Origin check (replaces old CSRF tokens)
  await app.register(loginRoute);
  await app.register(registerRoute);
  await app.register(logoutRoute);
  await app.register(passwordResetRequestRoute);
  await app.register(passwordResetRoute);
  await app.register(acceptInviteRoute);
  await app.register(verifyEmailRoute);
  await app.register(openRegistrationStatusRoute);

  // Protected routes — require authentication
  await app.register(async function protectedRoutes(scopedApp: FastifyInstance) {
    scopedApp.addHook('preHandler', requireAuth);

    // Resend-verification is accessible to authenticated but UNVERIFIED users —
    // exempting it from the email-verification gate avoids a circular dependency.
    await scopedApp.register(resendVerificationRoute);

    // All remaining protected routes additionally require a verified email address.
    await scopedApp.register(async function verifiedRoutes(innerApp: FastifyInstance) {
      innerApp.addHook('preHandler', requireEmailVerified);
      await innerApp.register(meRoute);
      await innerApp.register(passwordChangeRoute);
      await innerApp.register(profileUpdateRoute);
      await innerApp.register(emailChangeRequestRoute);
      await innerApp.register(projectRoutes);
      await innerApp.register(memberRoutes);
      await innerApp.register(fileContentRoutes);
      await innerApp.register(fileTreeRoutes);
      await innerApp.register(projectMainFileRoutes);
      await innerApp.register(renderConfigRoutes);
      await innerApp.register(gitIgnorePatternsRoutes);
      await innerApp.register(gitOperationStatusRoutes);
      await innerApp.register(gitStatusRoutes);
      await innerApp.register(gitTreeStatusRoutes);
      await innerApp.register(gitStageRoutes);
      await innerApp.register(gitUnstageRoutes);
      await innerApp.register(gitCommitRoutes);
      await innerApp.register(gitPushRoutes);
      await innerApp.register(cloneRoutes);
      await innerApp.register(gitImportRoutes);
      await innerApp.register(dictionaryRoutes);
      await innerApp.register(ignoredLintsRoutes);
      await innerApp.register(pdfExtensionRoutes);
      await innerApp.register(projectRefactoringRoutes);
      await innerApp.register(projectSearchRoutes);
      await innerApp.register(assetsRoutes);
      await innerApp.register(eventsRoutes);
      await innerApp.register(reviewRoutes);
      await innerApp.register(keybindingsRoutes);
      await innerApp.register(editorPreferencesRoutes);
      await innerApp.register(usersSearchRoute);
      await innerApp.register(usersInviteRoute);
      await innerApp.register(usersRoute);
      await innerApp.register(usersAdminStatusRoute);
      await innerApp.register(usersRemoveRoute);
      await innerApp.register(adminSettingsRoute);
      await innerApp.register(accessDeniedRoute);
      await innerApp.register(auditLogsRoute);
      await innerApp.register(failedSignInsRoute);
      await innerApp.register(projectDownloadRoute);
      await innerApp.register(fileDownloadRoute);
    });
  });
}
