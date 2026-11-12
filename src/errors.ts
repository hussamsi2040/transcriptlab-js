/** Error codes the API can return, from the OpenAPI spec. */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'insufficient_credits'
  | 'forbidden'
  | 'not_found'
  | 'video_not_found'
  | 'job_not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'transcript_unavailable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_error'
  | 'upstream_schema_error'
  | 'upstream_rejected'
  | 'upstream_unavailable'
  | 'upstream_rate_limited'
  | 'upstream_timeout'
  | 'internal_error';

/**
 * Error thrown for any non-2xx API response. `code` is the API's machine
 * code; `requestId` matches the gateway logs.
 */
export class TranscriptLabError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly requestId?: string | undefined;
  readonly retryAfter?: number | undefined;

  constructor(
    message: string,
    init: { status: number; code: ApiErrorCode | string; requestId?: string | undefined; retryAfter?: number | undefined },
  ) {
    super(message);
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
  }
}

export class InvalidRequestError extends TranscriptLabError {}
export class AuthenticationError extends TranscriptLabError {}
export class InsufficientCreditsError extends TranscriptLabError {}
export class ForbiddenError extends TranscriptLabError {}
export class NotFoundError extends TranscriptLabError {}
export class ConflictError extends TranscriptLabError {}
/** 422 — the transcript could not be produced or is not ready on a read route. */
export class TranscriptUnavailableError extends TranscriptLabError {}
export class RateLimitedError extends TranscriptLabError {}
export class QuotaExceededError extends TranscriptLabError {}
export class UpstreamError extends TranscriptLabError {}
export class InternalApiError extends TranscriptLabError {}

/** Network failure or per-request timeout — no response reached the client. */
export class NetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Thrown by `getTranscript`/`waitForJob`/`waitForTranscript` when the wait
 * budget runs out while the resource is still being produced. `resume` holds
 * enough information to keep polling later.
 */
export class StillProcessingError extends Error {
  readonly resume:
    | { kind: 'transcript'; videoId: string }
    | { kind: 'job'; jobId: string }
    | { kind: 'media'; mediaId: string };
  constructor(message: string, resume: StillProcessingError['resume']) {
    super(message);
    this.name = 'StillProcessingError';
    this.resume = resume;
  }
}

/** Map an HTTP status + parsed error body onto the right subclass. */
export function apiError(
  status: number,
  body: { error?: { code?: string; message?: string; request_id?: string } },
  retryAfter?: number,
): TranscriptLabError {
  const code = body.error?.code ?? 'internal_error';
  const message = body.error?.message ?? `HTTP ${status}`;
  const init = { status, code, requestId: body.error?.request_id, retryAfter };

  if (status === 401 || code === 'unauthorized') return new AuthenticationError(message, init);
  if (status === 403 || code === 'forbidden') return new ForbiddenError(message, init);
  if (status === 404 || code === 'not_found' || code === 'video_not_found' || code === 'job_not_found')
    return new NotFoundError(message, init);
  if (status === 409 || code === 'conflict') return new ConflictError(message, init);
  if (status === 422 || code === 'transcript_unavailable') return new TranscriptUnavailableError(message, init);
  if (status === 429 || code === 'rate_limited') return new RateLimitedError(message, init);
  if (status >= 500 || code === 'internal_error' || code.startsWith('upstream_'))
    return code === 'internal_error' && status < 500
      ? new TranscriptLabError(message, init)
      : status >= 500
        ? new InternalApiError(message, init)
        : new UpstreamError(message, init);

  switch (code) {
    case 'invalid_request':
      return new InvalidRequestError(message, init);
    case 'insufficient_credits':
      return new InsufficientCreditsError(message, init);
    case 'quota_exceeded':
      return new QuotaExceededError(message, init);
    default:
      return new TranscriptLabError(message, init);
  }
}
