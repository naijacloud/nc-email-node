/**
 * The retry policy of SDK-CONTRACT.md §4, kept in its own module so the maths
 * can be unit-tested without waiting out a single real sleep.
 */

/** First backoff step. */
export const RETRY_BASE_MS = 500;
/** Ceiling on the computed backoff. */
export const RETRY_CAP_MS = 8_000;
/** Ceiling on an honoured `Retry-After`. A server asking for an hour gets a minute. */
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Which responses are worth trying again.
 *
 * Deliberately keyed on the status rather than on the error class: a 3xx also
 * becomes a `ServerError` (§5.2), and re-issuing a request that was answered
 * with a redirect would just produce the same redirect. Anything else in the
 * 4xx range is the caller's request being wrong, and a 403 on an unverified
 * domain will not start working on the second attempt.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/**
 * Full jitter: `random(0, min(cap, base * 2^attempt))`.
 *
 * Not "exponential backoff plus a bit of noise" — the whole interval is random.
 * Fixed backoff re-synchronises every client that failed at the same instant
 * and hits the recovering server with the same thundering herd that knocked it
 * over, which is exactly the shape of a rate-limit incident.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Parse `Retry-After`, which RFC 9110 allows to be either a delay in seconds or
 * an HTTP date. Both turn up in the wild — a CDN or WAF in front of the API
 * will happily answer with a date where the origin sends seconds.
 *
 * Returns milliseconds, never negative, and uncapped: the caller clamps the
 * sleep, while the error surfaced to the user reports what the server actually
 * asked for.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;

  const raw = value.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;

  // A date already in the past means "retry now", not "retry in the past".
  return Math.max(0, at - now);
}

/**
 * The delay before the next attempt.
 *
 * The server's own number wins over ours when it sent one — it knows when the
 * bucket refills — but only up to a minute. An unclamped Retry-After lets a
 * misconfigured proxy park a request for an hour inside somebody's HTTP
 * handler, which looks like a hang, not a rate limit.
 */
export function retryDelay(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
  return backoffDelay(attempt, random);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
