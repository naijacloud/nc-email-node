/**
 * The error taxonomy of SDK-CONTRACT.md §3, which is identical in every
 * Naijamail SDK.
 *
 * One base class carrying the whole server envelope, so a caller can write a
 * single `catch` and still discriminate with `instanceof` where it matters.
 * Failures raised before a request leaves the process use the same classes with
 * `statusCode: 0` rather than a second, parallel hierarchy — a caller should
 * not need two catch blocks to tell "you gave me a bad address" from "the
 * server refused it".
 */

export interface NaijamailErrorOptions {
  /** HTTP status; 0 for a failure with no response. */
  statusCode?: number;
  /** The server's short label, e.g. "Bad Request". */
  error?: string;
  /** `x-request-id`, when the response carried one. */
  requestId?: string;
  /** Parsed JSON body, or the raw text when it was not JSON. */
  body?: unknown;
  cause?: unknown;
}

/**
 * Base of every error this SDK throws.
 *
 * Never put the API key in `message`: these strings end up in logs, error
 * trackers and support tickets (§5.3).
 */
export class NaijamailError extends Error {
  override readonly name: string = 'NaijamailError';

  /** HTTP status, or 0 when the failure never reached a response. */
  readonly statusCode: number;
  /** The server's short label ("Forbidden"), when it sent one. */
  readonly error: string | undefined;
  /** Quote this in a support ticket — it identifies the exact request. */
  readonly requestId: string | undefined;
  /** The response body, parsed if it was JSON, raw text otherwise. */
  readonly body: unknown;

  constructor(message: string, options: NaijamailErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.statusCode = options.statusCode ?? 0;
    this.error = options.error;
    this.requestId = options.requestId;
    this.body = options.body;
    // Restores the prototype chain when this bundle is consumed by a build that
    // downlevels below ES2015, where `extends Error` otherwise breaks
    // `instanceof` and turns a caught RateLimitError into a bare Error.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 400/422 from the server, or input this SDK refused to put on the wire
 * (`statusCode: 0`) — a malformed key, a plaintext base URL, a CRLF in a
 * header, a payload over a documented limit.
 */
export class ValidationError extends NaijamailError {
  override readonly name = 'ValidationError';
}

/** 401. Missing, malformed, unknown or revoked key — the server does not say which. */
export class AuthenticationError extends NaijamailError {
  override readonly name = 'AuthenticationError';
}

/**
 * 403. Authenticated but not allowed: a test key on the live send path, an
 * unverified From domain, a paused domain, or the daily quota. Never retried —
 * an unverified domain does not become verified between two attempts.
 */
export class PermissionError extends NaijamailError {
  override readonly name = 'PermissionError';
}

/**
 * 404, and the server's 400 `message not found` (see §2 — the retrieve endpoint
 * answers 400 for an unknown id).
 */
export class NotFoundError extends NaijamailError {
  override readonly name = 'NotFoundError';
}

/** 409. */
export class ConflictError extends NaijamailError {
  override readonly name = 'ConflictError';
}

/** 429. Retried automatically, honouring `Retry-After` when the server sets it. */
export class RateLimitError extends NaijamailError {
  override readonly name = 'RateLimitError';

  /** Seconds to wait, from `Retry-After`, when the server sent a usable one. */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    options: NaijamailErrorOptions & { retryAfter?: number } = {},
  ) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/**
 * 5xx, and any response the SDK cannot make sense of — including a 3xx, which
 * this SDK refuses to follow (§5.2).
 */
export class ServerError extends NaijamailError {
  override readonly name = 'ServerError';
}

/** DNS, TCP or TLS failure — the request never got an answer. Retried. */
export class ConnectionError extends NaijamailError {
  override readonly name = 'ConnectionError';
}

/** A client-side deadline (`statusCode: 0`) or the server's 408. Retried. */
export class TimeoutError extends NaijamailError {
  override readonly name = 'TimeoutError';
}

/**
 * A webhook whose signature, timestamp or header shape did not check out.
 *
 * The message never names the expected signature: handing an attacker the
 * value they failed to guess turns a rejected forgery into a working one.
 */
export class WebhookVerificationError extends NaijamailError {
  override readonly name = 'WebhookVerificationError';
}
