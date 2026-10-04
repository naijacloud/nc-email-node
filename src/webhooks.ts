import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError, WebhookVerificationError } from './errors';
import type { WebhookEvent } from './types';

/**
 * Webhook signature verification (SDK-CONTRACT.md §6).
 *
 * The control plane does not emit customer-facing webhooks yet — it ingests
 * provider ones. The scheme is fixed here so both halves ship against the same
 * definition rather than one being reverse-engineered from the other later.
 *
 * Header: `NC-Signature: t=1756468800,v1=<hex sha256 hmac>`
 * Signed payload: `"<t>.<raw request body bytes>"`.
 */

/** Five minutes, the same default Stripe and Svix use. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** Seconds of clock skew tolerated either side of `t`. Default 300. */
  tolerance?: number;
}

/**
 * Verify a webhook and return its parsed event.
 *
 * `payload` must be the **raw** body — the exact bytes the request arrived
 * with. A body that has been through `JSON.parse` and back has had its key
 * order, whitespace and unicode escaping rewritten, and will never match a
 * signature computed over the original. Every framework needs telling: express
 * wants `express.raw({ type: 'application/json' })` on this route.
 *
 * @throws {WebhookVerificationError} on a bad header, a stale timestamp, or a
 * signature that does not match. The message never contains the expected
 * signature — handing an attacker the value they failed to guess turns a
 * rejected forgery into a working one.
 */
export function verifyWebhook(
  payload: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  if (typeof secret !== 'string' || !secret) {
    throw new WebhookVerificationError('a webhook signing secret is required');
  }
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) {
    throw new WebhookVerificationError('the NC-Signature header is missing');
  }

  const body = toBytes(payload);
  const tolerance = options.tolerance ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  // NaN compares false against everything, so `skew > NaN` would never fire
  // and every replayed event would pass — and `Number(process.env.X)` on an
  // unset variable is exactly how a NaN arrives.
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError('tolerance must be a finite number of seconds, 0 or more');
  }
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  // The timestamp check, not the HMAC, is what stops a replay: a signature
  // captured off the wire stays valid for ever otherwise, and an attacker who
  // can re-POST yesterday's "payment succeeded" does not need to forge
  // anything.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > tolerance) {
    throw new WebhookVerificationError(
      `webhook timestamp is ${skew}s away from now, outside the ${tolerance}s tolerance`,
    );
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');

  // Several v1 values appear while a secret is being rotated: the sender signs
  // with both the old and the new secret for the overlap, so accepting any
  // match is what lets a rotation happen without dropping events.
  const matched = signatures.some((candidate) => constantTimeEqual(candidate, expected));
  if (!matched) {
    throw new WebhookVerificationError('webhook signature does not match');
  }

  return parseEvent(body);
}

function toBytes(payload: string | Uint8Array): Buffer {
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new WebhookVerificationError(
    'the webhook payload must be the raw request body as a string or Buffer',
  );
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't' && /^\d+$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value) {
      signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === undefined || !signatures.length) {
    throw new WebhookVerificationError(
      'the NC-Signature header is malformed: expected "t=<unix seconds>,v1=<hex signature>"',
    );
  }

  return { timestamp, signatures };
}

/**
 * Never `===` on a signature.
 *
 * A short-circuiting string comparison returns faster the earlier it finds a
 * difference, which over enough requests leaks the expected value one character
 * at a time. The length check ahead of it leaks only the length, and a
 * SHA-256 hex digest is always 64 characters.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseEvent(body: Buffer): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new WebhookVerificationError('the webhook payload is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookVerificationError('the webhook payload is not a JSON object');
  }

  return parsed as WebhookEvent;
}
