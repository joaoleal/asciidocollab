/**
 * Shared HTTP transport for the JSON API client.
 * CSRF protection is handled by SameSite=Strict cookies + server-side Origin header
 * validation. No manual CSRF tokens are needed.
 */
import { API_BASE_URL } from './base-url';

// Re-exported for the many call sites that already import it from here.
// `export…from` rather than exporting the local binding, per unicorn/prefer-export-from.
export { API_BASE_URL } from './base-url';

/**
 * Custom error class for API errors.
 */
export class ApiError extends Error {
  /** Constructs an ApiError with HTTP status, error code, human-readable message, and optional retry delay. */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Performs a JSON request against the backend, attaching credentials and
 * throwing an {@link ApiError} for any non-ok response.
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      // Only declare Content-Type when there is a body to describe.
      // Sending Content-Type: application/json on a bodyless POST causes
      // Fastify's JSON body parser to attempt to parse an empty body → 400.
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    // Our routes send `{ error: { code, message } }`, but a request rejected before our handler runs
    // (schema validation, rate limit, an unhandled 500) comes back in Fastify's native
    // `{ statusCode, error, message }` shape. Read both so the real cause surfaces instead of a
    // generic fallback — a wrong `op`/body then reads as the actual validation message.
    // `data.error?.message` is undefined when `data.error` is a string ('foo'.message) or absent, so
    // it selects the canonical envelope's message and falls through to Fastify's native top-level
    // `message`, then to a bare string `error`, then the generic fallback.
    const message =
      data?.error?.message ??
      (typeof data?.message === 'string' ? data.message : undefined) ??
      (typeof data?.error === 'string' ? data.error : undefined) ??
      'An unexpected error occurred';
    const code = data?.error?.code ?? (typeof data?.code === 'string' ? data.code : undefined) ?? 'UNKNOWN_ERROR';
    throw new ApiError(response.status, code, message, data?.error?.retryAfter);
  }

  return data;
}

/** Query parameters for paginated list endpoints. */
export interface PaginationParameters {
  /** The 1-based page number to retrieve. */
  page?: number;
  /** Maximum number of items to return per page. */
  limit?: number;
  /** When true, include only archived items; when false, only active items. */
  archived?: boolean;
}

/** Generic wrapper returned by paginated list endpoints. */
export interface PaginatedResponse<T> {
  /** The array of items on the current page. */
  data: T[];
  /** Pagination metadata describing the current page position and total counts. */
  pagination: {
    /** The current page number. */
    page: number;
    /** The maximum number of items returned per page. */
    limit: number;
    /** Total number of items across all pages. */
    total: number;
    /** Total number of pages available. */
    totalPages: number;
  };
}
