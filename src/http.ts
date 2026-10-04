import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NaijamailError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors';
import { isRetryableStatus, parseRetryAfter, retryDelay, sleep } from './retry';
import { redactKey } from './validate';

/**
 * The HTTP layer: one `fetch` per attempt, the retry loop from §4, and the
 * error mapping from §3.
 *
 * Built on global `fetch` and nothing else. Every third-party runtime
 * dependency in a package that holds a live sending credential is supply-chain
 * risk taken on the customer's behalf (§5.9), and an HTTP client is the last
 * place to take it.
 */

export interface RequestSpec {
  method: 'GET' | 'POST';
  /** Absolute path, already URL-encoded, starting with `/`. */
  path: string;
  /** Serialized JSON. Absent for GET. */
  body?: string;
  /** Sent as `Idempotency-Key` on every attempt of this call. */
  idempotencyKey?: string;
}

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  userAgent: string;
}

type Attempt =
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: NaijamailError; retryable: boolean; retryAfterMs?: number };

export class Transport {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly userAgent: string;

  // A true private field, so the key is not reachable by property enumeration,
  // is not serialized by JSON.stringify, and is not printed by util.inspect
  // even with showHidden. The custom inspect below is the second layer.
  readonly #apiKey: string;

  constructor(options: TransportOptions) {
    this.#apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
    this.userAgent = options.userAgent;
  }

  async request(spec: RequestSpec): Promise<unknown> {
    const url = this.baseUrl + spec.path;

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.#attempt(url, spec);
      if (outcome.kind === 'success') return outcome.value;

      if (!outcome.retryable || attempt >= this.maxRetries) {
        throw outcome.error;
      }

      await sleep(retryDelay(attempt, outcome.retryAfterMs));
    }
  }

  async #attempt(url: string, spec: RequestSpec): Promise<Attempt> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.idempotencyKey !== undefined) headers['Idempotency-Key'] = spec.idempotencyKey;

    // A fresh deadline per attempt, not one shared across the call: a retry
    // inheriting the exhausted deadline of the attempt that timed out would be
    // aborted before it ever reached the socket.
    const signal = AbortSignal.timeout(this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: spec.body }),
        // Never follow a redirect. fetch would re-send the Authorization header
        // to whatever host the Location names, which is precisely how bearer
        // tokens leak to a machine that should never have seen one. In Node's
        // undici, 'manual' hands back the real 3xx rather than an opaque
        // response, so it can be reported instead of silently swallowed.
        redirect: 'manual',
        signal,
      });
    } catch (cause) {
      return this.#transportFailure(url, signal, cause);
    }

    if (response.status >= 300 && response.status < 400) {
      // Nothing will read this body, and an unread one keeps the connection
      // pinned in undici until the response is collected.
      void response.body?.cancel().catch(() => undefined);

      return {
        kind: 'failure',
        error: new ServerError(
          `unexpected redirect (HTTP ${response.status}) — this SDK never follows redirects, because that would re-send your API key to another host`,
          { statusCode: response.status, requestId: requestIdOf(response) },
        ),
        retryable: false,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      // The body can still be cut off by the deadline or a dropped connection
      // after the status line has arrived.
      return this.#transportFailure(url, signal, cause);
    }

    if (response.ok) {
      return { kind: 'success', value: parseSuccessBody(text, response) };
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return {
      kind: 'failure',
      error: errorFromResponse(response, text, retryAfterMs),
      retryable: isRetryableStatus(response.status),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  /** A failure with no response: a timeout of ours, or DNS/TCP/TLS. Both retryable. */
  #transportFailure(url: string, signal: AbortSignal, cause: unknown): Attempt {
    // `signal.aborted` is the only reliable signal across Node 18 to 24: the
    // shape of the rejection from an aborted fetch has changed between undici
    // versions (AbortError, TimeoutError, a TypeError wrapping either), so the
    // error is not worth pattern-matching.
    if (signal.aborted) {
      return {
        kind: 'failure',
        error: new TimeoutError(`request timed out after ${this.timeout}ms`, { cause }),
        retryable: true,
      };
    }

    return {
      kind: 'failure',
      error: new ConnectionError(`could not reach ${hostOf(url)}: ${describeCause(cause)}`, {
        cause,
      }),
      retryable: true,
    };
  }

  /**
   * The key must not appear in `console.log(client)` output (§5.3), and the
   * client holds this object.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Transport { baseUrl: '${this.baseUrl}', apiKey: '${redactKey(this.#apiKey)}' }`;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, apiKey: redactKey(this.#apiKey) };
  }
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get('x-request-id') ?? undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Node nests the useful part of a fetch failure one or two levels down in `cause`. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    if (inner instanceof Error && inner.message) return inner.message;
    if (cause.message) return cause.message;
  }
  return 'connection failed';
}

function parseSuccessBody(text: string, response: Response): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A 2xx we cannot parse is not retryable — the message may well have been
    // accepted, and retrying it would risk a duplicate for no information gain.
    throw new ServerError('the server returned a non-JSON success response', {
      statusCode: response.status,
      requestId: requestIdOf(response),
      body: text,
    });
  }
}

/**
 * Turn a NestJS error envelope into one of our classes.
 *
 * `message` is a string on a hand-thrown exception and an array when a
 * validation pipe produced it, so both are handled and arrays joined. A body
 * that is not JSON at all — a proxy's HTML error page, an empty 502 — must not
 * crash the parser: an SDK that throws a SyntaxError while reporting an outage
 * sends the caller looking in entirely the wrong place.
 */
export function errorFromResponse(
  response: Response,
  text: string,
  retryAfterMs?: number,
): NaijamailError {
  const status = response.status;
  const parsed = parseErrorBody(text);
  const message =
    parsed.message ?? `HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}`;

  const base = {
    statusCode: status,
    error: parsed.error,
    requestId: requestIdOf(response),
    body: parsed.body,
  };

  switch (status) {
    case 400:
      // A known server quirk: the retrieve endpoint answers 400, not 404, for
      // an id that does not exist. Matching the message is unpleasant, but the
      // alternative is every caller writing the same string comparison.
      // Tracked in email-sdks/GAPS.md.
      return message.trim().toLowerCase() === 'message not found'
        ? new NotFoundError(message, base)
        : new ValidationError(message, base);
    case 401:
      return new AuthenticationError(message, base);
    case 403:
      return new PermissionError(message, base);
    case 404:
      return new NotFoundError(message, base);
    case 408:
      return new TimeoutError(message, base);
    case 409:
      return new ConflictError(message, base);
    case 413:
    // The server's body parser refusing an oversized request: the caller's
    // input, and no retry will shrink it.
    case 422:
      return new ValidationError(message, base);
    case 429:
      return new RateLimitError(message, {
        ...base,
        ...(retryAfterMs === undefined ? {} : { retryAfter: Math.round(retryAfterMs / 1000) }),
      });
    default:
      if (status >= 500) return new ServerError(message, base);
      // An unmapped 4xx (405, 413, 415…) is not the caller's payload being
      // wrong in a way we can name, so it stays as the base class rather than
      // being filed under a type that would mislead.
      return new NaijamailError(message, base);
  }
}

function parseErrorBody(text: string): {
  message: string | undefined;
  error: string | undefined;
  body: unknown;
} {
  if (!text.trim()) return { message: undefined, error: undefined, body: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { message: undefined, error: undefined, body: text };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { message: undefined, error: undefined, body: parsed };
  }

  const envelope = parsed as { message?: unknown; error?: unknown };
  let message: string | undefined;

  if (typeof envelope.message === 'string' && envelope.message) {
    message = envelope.message;
  } else if (Array.isArray(envelope.message)) {
    const parts = envelope.message.filter((part): part is string => typeof part === 'string');
    if (parts.length) message = parts.join('; ');
  }

  return {
    message,
    error: typeof envelope.error === 'string' ? envelope.error : undefined,
    body: parsed,
  };
}
