import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Seconds to advertise before the caller may retry a rate-limited request.
 *
 * The number lives on the REPLY, not on the error. `@fastify/rate-limit` sets the `retry-after`
 * header from the bucket's own remaining time and then throws an error that carries no headers at
 * all, so reading the error was reading something that is never there: every 429 in the application
 * advertised the fallback, and most of this application's windows are an hour, not a minute. The
 * sign-in form was the visible casualty — it divides the advertised seconds by sixty and told users
 * to try again in one minute when its own window is fifteen, silently overriding the correct
 * fallback its author had written.
 *
 * The error's own headers are still consulted, for a 429 raised by something other than the rate
 * limiter — a custom `errorResponseBuilder`, or another plugin — since nothing guarantees that such
 * an error stamps the reply. The final 60 is a conservative guess, and it is a guess rather than a
 * claim.
 *
 * @param error - The error being handled, consulted only if the reply carries no header.
 * @param reply - The reply the rate limiter has already stamped with the real remaining time.
 * @returns Whole seconds, always positive.
 */
function extractRetryAfterSeconds(error: FastifyError | Error, reply: FastifyReply): number {
  const fromReply = toPositiveSeconds(reply.getHeader('retry-after'));
  if (fromReply !== null) return fromReply;

  if ('headers' in error) {
    const { headers } = error;
    if (typeof headers === 'object' && headers !== null && 'retry-after' in headers) {
      const fromError = toPositiveSeconds(headers['retry-after']);
      if (fromError !== null) return fromError;
    }
  }

  return 60;
}

/**
 * Reads a `retry-after` header value as whole positive seconds.
 *
 * Header values arrive as a string, a number, or an array of strings depending on how they were set,
 * and the HTTP form of this header is also allowed to be an absolute date — which this never parses,
 * because the rate limiter only ever writes a delta and a misparsed date would produce a confidently
 * wrong number rather than an honest fallback.
 *
 * @param raw - Whatever the header lookup returned.
 * @returns The seconds, or null when the value is absent or not a usable count.
 */
function toPositiveSeconds(raw: unknown): number | null {
  const single = Array.isArray(raw) ? raw[0] : raw;
  if (typeof single !== 'string' && typeof single !== 'number') return null;
  const seconds = Number(single);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds);
}

/**
 * Global error handler for unhandled errors in routes.
 *
 * @param error - The error that occurred.
 * @param request - The incoming request.
 * @param reply - Fastify reply used to send the formatted error response.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  request.log.error({ err: error, statusCode }, 'Unhandled error in route');

  if (statusCode === 429) {
    const retryAfter = extractRetryAfterSeconds(error, reply);
    reply.status(429).send({
      error: { code: 'RATE_LIMITED', message: 'Too many requests', retryAfter },
    });
    return;
  }

  reply.status(statusCode).send({
    error: {
      code: statusCode === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

/**
 * Handler for requests to non-existent routes.
 *
 * @param _request - The incoming request (unused).
 * @param reply - Fastify reply used to send the 404 response.
 */
export function notFoundHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
}
