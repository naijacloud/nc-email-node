import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors';
import type { Transport } from '../http';
import {
  serializeSendOptions,
  toEmail,
  toSendEmailResponse,
} from '../serialize';
import type { Email, SendEmailOptions, SendEmailResponse } from '../types';
import { assertNoControlChars, validateIdempotencyKey } from '../validate';

/**
 * The `emails` resource — the whole API surface.
 *
 * Two methods, because the server has two endpoints. No domains, api-keys,
 * batch, contacts or audiences: inventing a client method for an endpoint that
 * does not exist produces a 404 the caller cannot act on and a support ticket
 * about a feature we never shipped.
 */
export class Emails {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * Queue a message.
   *
   * A `202` means the message passed authorisation, suppression and quota
   * checks and is queued — not that a mailbox has it. Poll `get()` or wait for
   * a webhook for that.
   */
  async send(options: SendEmailOptions): Promise<SendEmailResponse> {
    const body = serializeSendOptions(options);
    const json = JSON.stringify(body);

    // Generated once per call and reused across every attempt of that call.
    // This single line is what makes §4's retry policy safe: without it, a send
    // that timed out after the server had already accepted it would be sent
    // again on the retry, and the customer would receive the mail twice. A
    // caller-supplied key always wins and is never regenerated. An empty string
    // counts as "none supplied" and gets a generated key, as in every SDK.
    const idempotencyKey = options.idempotencyKey
      ? validateIdempotencyKey(options.idempotencyKey)
      : randomUUID();

    // Header only: the server gives the header precedence over the body field,
    // so sending both would leave two values to disagree about.
    const raw = await this.#transport.request({
      method: 'POST',
      path: '/v1/emails',
      body: json,
      idempotencyKey,
    });

    return toSendEmailResponse(raw);
  }

  /** Fetch one message's current state. Scoped to the team the key belongs to. */
  async get(id: string): Promise<Email> {
    if (typeof id !== 'string' || !id.trim()) {
      throw new ValidationError('an email id is required');
    }
    assertNoControlChars(id, 'id');

    // Encoded, not interpolated. An id is a value, and a value that reaches a
    // URL path unencoded is a path-traversal primitive — `../../admin` in a
    // variable a web handler took from a query string should produce a 404,
    // not a request to a different endpoint with a live key attached.
    const raw = await this.#transport.request({
      method: 'GET',
      path: `/v1/emails/${encodeURIComponent(id.trim())}`,
    });

    return toEmail(raw);
  }

  /** The transport carries the key; keep it out of any dump of this object. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Emails { baseUrl: '${this.#transport.baseUrl}' }`;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.#transport.baseUrl };
  }
}
