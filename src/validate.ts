import { ValidationError } from './errors';

/**
 * The client-side half of SDK-CONTRACT.md §5.
 *
 * Everything here fails *before* a request leaves the process. That is not
 * duplicated server validation for its own sake: a caller who gets
 * "to[2] contains a newline" locally, with a stack trace pointing at their own
 * code, fixes it in a minute; the same caller getting a 400 from a machine they
 * cannot see reads it as an outage. The header-injection and limit checks in
 * particular mirror the control plane exactly, so the two never disagree about
 * what is acceptable.
 */

/** Mirrors the server's SENDING_LIMITS. Exported so callers can pre-flight a batch. */
export const SENDING_LIMITS = {
  /** Across to + cc + bcc, per message. */
  MAX_RECIPIENTS: 50,
  /** Total encoded request body. Attachments are base64, so ~4/3 of their byte size. */
  MAX_BYTES: 10 * 1024 * 1024,
  MAX_HEADERS: 25,
  MAX_TAGS: 10,
  MAX_TAG_KEY_LENGTH: 64,
  MAX_TAG_VALUE_LENGTH: 256,
  /** The `Idempotency-Key` header's documented ceiling. */
  MAX_IDEMPOTENCY_KEY_LENGTH: 255,
} as const;

export const DEFAULT_BASE_URL = 'https://api.naijacloud.com';

/**
 * Headers a caller may not set.
 *
 * Overriding `From` would sidestep the domain authorisation the whole product
 * rests on — the server checks the From address against the team's verified
 * domains, and a custom `From:` header that reached the MIME builder would make
 * that check decorative. `dkim-signature` and `received` are refused for the
 * same reason: they are ours to write.
 */
const FORBIDDEN_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'dkim-signature',
  'received',
]);

/**
 * A key must look like a key before it is used.
 *
 * An empty string or a truncated paste is a local error now, rather than a 401
 * discovered in production an hour after deploy.
 *
 * Two families are accepted, because the API accepts two:
 *
 *   `nmail_live_` / `nmail_test_` — a Naijamail-only key, from the dashboard's
 *                  Email screen. The test variant is refused by the send path,
 *                  which is the point of it.
 *   `nc_live_`    — a workspace API key carrying the Email send scope, from
 *                  Settings → API keys. One credential for mail, deploys and
 *                  the platform API, so a customer who already has one does not
 *                  need a second.
 *
 * Kept as an allowlist rather than relaxed to "any non-empty string". The check
 * exists to catch the truncated paste and the wrong-variable-name deploy, and a
 * pattern that accepts anything catches neither.
 */
const API_KEY_PATTERN = /^(?:nmail_(?:live|test)|nc_live)_[A-Za-z0-9_-]{8,}$/;

/** The prefixes above, for redaction. Longest first so matching is unambiguous. */
const API_KEY_PREFIX = /^(?:nmail_(?:live|test)_|nc_live_)/;

/** CR, LF and NUL: the three characters that let a value break out of a header. */
const CONTROL_CHARS = /[\r\n\0]/;

/**
 * Reject anything that could break out of a MIME header.
 *
 * A `\n` inside a subject or an address is how a caller with a user-supplied
 * value ends up letting that user add a `Bcc:` line. The server's MimeBuilder
 * checks too — this check exists so the caller finds out at the call site.
 */
export function assertNoControlChars(value: string, label: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new ValidationError(
      `${label} must not contain a carriage return, line feed or NUL — that is a header-injection vector`,
    );
  }
}

export function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`);
  }
  return value;
}

/**
 * The only form of the key that may appear anywhere but the Authorization
 * header — logs, `inspect`, `toJSON`, an exception message (§5.3).
 */
export function redactKey(key: string): string {
  const prefix = API_KEY_PREFIX.exec(key)?.[0];
  return prefix ? `${prefix}***` : '***';
}

/** Resolve the key from the constructor or the environment, and check its shape. */
export function resolveApiKey(explicit?: string): string {
  const raw = explicit ?? process.env['NAIJAMAIL_API_KEY'] ?? '';
  // Trailing newlines arrive routinely from `cat secret | ...` and from CI
  // secret stores; they would otherwise corrupt the Authorization header.
  const key = raw.trim();

  if (!key) {
    throw new ValidationError(
      'no Naijamail API key: pass one to the Naijamail constructor or set NAIJAMAIL_API_KEY',
    );
  }
  if (!API_KEY_PATTERN.test(key)) {
    // The key itself is never quoted back — this message reaches logs.
    throw new ValidationError(
      'the API key is not shaped like a Naijamail key (expected nmail_live_…, nmail_test_… or nc_live_…)',
    );
  }
  return key;
}

/**
 * Resolve and vet the base URL.
 *
 * Plaintext is refused unless the host is loopback (§5.1). A live sending
 * credential on an `http://` URL is on the wire in clear for anyone on the
 * path; allowing it "just for staging" is how it reaches production. Loopback
 * is exempt because a dev control plane on localhost has no network to sniff —
 * and because the test suite needs it.
 */
export function resolveBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env['NAIJAMAIL_BASE_URL'] ?? DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`baseUrl is not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError(`baseUrl must be an http(s) URL, got ${url.protocol}//`);
  }

  // A query or a fragment would end up in the middle of the built URL —
  // `https://x.com/?a=1` + `/v1/emails` is not a request anyone meant to make.
  if (url.search || url.hash) {
    throw new ValidationError('baseUrl must not contain a query string or a fragment');
  }

  // `new URL('http://[::1]/')` keeps the brackets in `hostname`.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (url.protocol !== 'https:' && !isLoopback) {
    throw new ValidationError(
      `baseUrl must use https (got ${url.protocol}//${url.host}); plaintext is allowed only for localhost, 127.0.0.1 and ::1`,
    );
  }

  // Trailing slash stripped so paths can be concatenated. Concatenation rather
  // than `new URL(path, base)` because the latter discards a base path, and a
  // customer fronting the API with a proxy at /naijamail is a real deployment.
  return url.href.replace(/\/+$/, '');
}

/** Normalise the `string | string[]` the API accepts everywhere. */
export function normalizeRecipients(
  value: string | string[] | undefined,
  field: string,
): string[] {
  if (value === undefined || value === null) return [];

  const list = Array.isArray(value) ? value : [value];
  return list.map((address, index) => {
    const label = Array.isArray(value) ? `${field}[${index}]` : field;
    const item = assertString(address, label);
    if (!item.trim()) {
      throw new ValidationError(`${label} must not be empty`);
    }
    assertNoControlChars(item, label);
    return item;
  });
}

/** Validate a custom header map: names, values, forbidden names, and the count. */
export function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers);

  if (entries.length > SENDING_LIMITS.MAX_HEADERS) {
    throw new ValidationError(
      `too many custom headers: ${entries.length} (limit ${SENDING_LIMITS.MAX_HEADERS})`,
    );
  }

  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    assertNoControlChars(name, `headers key "${name}"`);
    if (!name.trim()) {
      throw new ValidationError('a custom header name must not be empty');
    }
    if (FORBIDDEN_HEADERS.has(name.trim().toLowerCase())) {
      throw new ValidationError(
        `header "${name}" cannot be overridden — it is set from the message itself`,
      );
    }
    const stringValue = assertString(value, `headers["${name}"]`);
    assertNoControlChars(stringValue, `headers["${name}"]`);
    out[name] = stringValue;
  }
  return out;
}

/**
 * Validate tags.
 *
 * The server truncates an over-long key or value; the SDK refuses it, because a
 * silently shortened analytics label produces two tags that look like one and a
 * customer chasing a reporting discrepancy for a week.
 */
export function validateTags(tags: Record<string, string>): Record<string, string> {
  const entries = Object.entries(tags);

  if (entries.length > SENDING_LIMITS.MAX_TAGS) {
    throw new ValidationError(
      `too many tags: ${entries.length} (limit ${SENDING_LIMITS.MAX_TAGS})`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const stringValue = assertString(value, `tags["${key}"]`);
    if (key.length > SENDING_LIMITS.MAX_TAG_KEY_LENGTH) {
      throw new ValidationError(
        `tag key "${key}" is longer than ${SENDING_LIMITS.MAX_TAG_KEY_LENGTH} characters`,
      );
    }
    if (stringValue.length > SENDING_LIMITS.MAX_TAG_VALUE_LENGTH) {
      throw new ValidationError(
        `tag "${key}" has a value longer than ${SENDING_LIMITS.MAX_TAG_VALUE_LENGTH} characters`,
      );
    }
    assertNoControlChars(key, `tag key "${key}"`);
    assertNoControlChars(stringValue, `tags["${key}"]`);
    out[key] = stringValue;
  }
  return out;
}

/**
 * The idempotency key travels as a request header, so it gets the same
 * treatment as any other header value.
 */
export function validateIdempotencyKey(key: string): string {
  const value = assertString(key, 'idempotencyKey');
  if (!value.trim()) {
    throw new ValidationError('idempotencyKey must not be empty');
  }
  if (value.length > SENDING_LIMITS.MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(
      `idempotencyKey is longer than ${SENDING_LIMITS.MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  assertNoControlChars(value, 'idempotencyKey');
  return value;
}
