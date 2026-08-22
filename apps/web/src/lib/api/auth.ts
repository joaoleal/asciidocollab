/**
 * Authentication and profile API client (auth + current-user endpoints).
 */
import { apiRequest } from '@/lib/api/transport';

/** Fields that can be updated via the profile PATCH endpoint. */
export interface UpdateProfileData {
  /** Optional new display name. */
  displayName?: string;
  /** Avatar style key, or null to clear the preference. */
  avatarKey?: string | null;
  /** Theme preference: 'light', 'dark', or 'system'. */
  appTheme?: string;
}

export const authApi = {
  async login(email: string, password: string): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async register(
    email: string,
    password: string,
    displayName: string,
  ): Promise<{ /** Confirmation message from the server. */ message: string; /** True when email verification is required before login. */ requiresEmailVerification?: boolean }> {
    return apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
  },

  async logout(): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest<{ /** Confirmation message from the server. */
    message: string }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async setupStatus(): Promise<{
    /** Whether the application has been configured with an admin account. */
    configured: boolean;
    /** Password policy rules enforced by the server. */
    passwordPolicy: {
      /** Minimum required password length. */
      minLength: number;
      /** Whether the password must contain at least one uppercase letter. */
      requireUppercase: boolean;
      /** Whether the password must contain at least one lowercase letter. */
      requireLowercase: boolean;
      /** Whether the password must contain at least one digit. */
      requireDigits: boolean;
      /** Whether the password must contain at least one symbol character. */
      requireSymbols: boolean;
    };
  }> {
    return apiRequest('/auth/setup-status');
  },

  async me(): Promise<{ /** Unique identifier of the authenticated user. */
  userId: string; /** Display name of the authenticated user. */
  displayName: string; /** Email address of the authenticated user. */
  email: string }> {
    return apiRequest('/auth/me');
  },

  async requestPasswordReset(email: string): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest('/auth/password/reset/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  async resetPassword(token: string, newPassword: string): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest('/auth/password/change', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  async updateProfile(data: UpdateProfileData): Promise<{ /** Confirmation message from the server. */ message: string }> {
    return apiRequest('/auth/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async requestEmailChange(newEmail: string): Promise<{ /** Confirmation message from the server. */
  message: string }> {
    return apiRequest('/auth/email/change-request', {
      method: 'POST',
      body: JSON.stringify({ newEmail }),
    });
  },
};
