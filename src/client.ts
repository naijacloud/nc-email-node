import { ValidationError } from './errors';
import { Transport } from './http';
import { Emails } from './resources/emails';
import type { NaijamailOptions } from './types';
import { assertNoControlChars, redactKey, resolveApiKey, resolveBaseUrl } from './validate';
import { VERSION } from './version';

/** Per attempt, not per call — a retry gets its own full deadline. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Retries after the first attempt, so 3 attempts in total. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * The Naijamail client.
 *
 * Everything a request needs — key, base URL, deadlines — lives on the
 * instance. There is no module-level configuration anywhere in this package
 * (§5.12), so two clients holding two different teams' keys in one process
 * cannot leak into each other, which is the normal shape of a multi-tenant
 * worker and the shape most likely to send a message from the wrong account.
 */
export class Naijamail {
  /** Send and retrieve messages. */
  readonly emails: Emails;

  readonly baseUrl: string;
  /** Milliseconds allowed per attempt. */
  readonly timeout: number;
  readonly maxRetries: number;

  /** The only representation of the key this object will ever hand out. */
  readonly #redactedKey: string;

  /**
   * Both call shapes are supported, and the two-argument one is not optional
   * politeness: every other Naijamail SDK takes the key and the options
   * separately (`New(key, opts...)`, `Naijamail(api_key, base_url=…)`), so a
   * developer moving between them writes `new Naijamail(key, { baseUrl })` by
   * reflex. Accepting only the single-argument form made that call silently
   * drop the options in plain JavaScript — the caller's staging `baseUrl` would
   * be discarded and the SDK would talk to production instead. TypeScript would
   * have flagged the extra argument; nothing would have flagged it at runtime.
   */
  constructor(apiKeyOrOptions?: string | NaijamailOptions, options?: NaijamailOptions) {
    if (
      typeof apiKeyOrOptions === 'object' &&
      apiKeyOrOptions !== null &&
      options !== undefined
    ) {
      // Two option objects means one of them is being ignored, and guessing
      // which is worse than saying so.
      throw new ValidationError(
        'pass either an options object or an API key followed by options, not two option objects',
      );
    }

    const config: NaijamailOptions =
      typeof apiKeyOrOptions === 'string' || apiKeyOrOptions === undefined
        ? { ...(options ?? {}), apiKey: apiKeyOrOptions ?? options?.apiKey }
        : apiKeyOrOptions;

    if (config === null || typeof config !== 'object') {
      throw new ValidationError(
        'the Naijamail constructor takes an API key string or an options object',
      );
    }

    const apiKey = resolveApiKey(config.apiKey);
    this.#redactedKey = redactKey(apiKey);
    this.baseUrl = resolveBaseUrl(config.baseUrl);
    this.timeout = validateTimeout(config.timeout);
    this.maxRetries = validateMaxRetries(config.maxRetries);

    this.emails = new Emails(
      new Transport({
        apiKey,
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        maxRetries: this.maxRetries,
        userAgent: buildUserAgent(config.userAgentSuffix),
      }),
    );
  }

  /**
   * `console.log(client)` and `util.inspect(client)` reach this, and a client is
   * exactly the sort of object that ends up in a debug log or an error
   * tracker's context. Nothing but the redacted prefix may come out (§5.3).
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Naijamail { baseUrl: '${this.baseUrl}', apiKey: '${this.#redactedKey}', timeout: ${this.timeout}, maxRetries: ${this.maxRetries} }`;
  }

  /** Same reasoning for anything that serializes its context as JSON. */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#redactedKey,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
    };
  }
}

function validateTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError('timeout must be a positive number of milliseconds');
  }
  return value;
}

function validateMaxRetries(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETRIES;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError('maxRetries must be a non-negative integer');
  }
  return value;
}

/**
 * `nc-email-node/<version> (node/<version>)`, plus whatever the caller appends.
 *
 * The suffix is checked for CR/LF like any other header value, and is the one
 * place a caller might be tempted to put something identifying — the README
 * says not to, and the key is never interpolated here regardless.
 */
function buildUserAgent(suffix?: string): string {
  const base = `nc-email-node/${VERSION} (node/${process.version.replace(/^v/, '')})`;
  if (suffix === undefined) return base;

  if (typeof suffix !== 'string') {
    throw new ValidationError('userAgentSuffix must be a string');
  }
  assertNoControlChars(suffix, 'userAgentSuffix');

  const trimmed = suffix.trim();
  return trimmed ? `${base} ${trimmed}` : base;
}
