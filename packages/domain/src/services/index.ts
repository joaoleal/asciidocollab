/** @file Barrel re-exports for domain services (interfaces + pure domain-service modules). */
// The reference/symbol extraction + include-graph engine now lives in the zero-dependency
// `@asciidocollab/asciidoc-core` leaf (imported directly by both the server and the editor); it is no
// longer re-exported through the domain barrel.
// Centralized include/image target resolution (attribute substitution + imagesdir + sandbox).
export {
  substitutePathAttributes,
  imagesDirectory,
  resolveIncludeTarget,
  resolveImageTarget,
} from './asciidoc-path';
export type { PasswordHasher } from './password-hasher';
export type { BreachChecker } from './breach-checker';
export type { EmailSender } from './email-sender';
export type { TokenGenerator, PasswordResetTokenData } from './token-generator';
export type { CommonPasswordChecker } from './common-password-checker';
export type { PasswordResetNotifier } from './password-reset-notifier';
export type { EmailChangeNotifier } from './email-change-notifier';
export type { RegistrationInvitationNotifier } from './registration-invitation-notifier';
export type { EmailVerificationNotifier } from './email-verification-notifier';
