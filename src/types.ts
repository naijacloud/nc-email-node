/**
 * The public types of the SDK.
 *
 * The wire format is snake_case (SDK-CONTRACT.md §2); this SDK speaks camelCase
 * and translates at the edge, because a Node caller mixing `replyTo` with
 * `reply_to` in one object literal is a bug waiting to happen. The translation
 * lives in one place — `serializeSendOptions` and the response mappers — so
 * there is exactly one file to change when the wire format grows a field.
 */

/**
 * The statuses the API documents today.
 *
 * Roughly a progression, but not a state machine: a message can go `delivered`
 * then `complained`, and providers deliver events out of order.
 */
export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'deferred',
  'complained',
  'rejected',
  'failed',
] as const;

/** One of the eight statuses this SDK version knows about. */
export type KnownMessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * A message status.
 *
 * The `(string & {})` arm is deliberate and load-bearing: it keeps
 * autocompletion for the eight known values while still accepting one the
 * server invents later. A closed union here would mean a new server status
 * breaking type-checking for every customer who had not upgraded, and — worse —
 * would tempt a runtime `assert` that throws on an unrecognised value. An old
 * SDK must degrade to "I do not know this status", never to an exception.
 */
export type MessageStatus = KnownMessageStatus | (string & {});

/** Narrows a status to the set this SDK version documents. */
export function isKnownMessageStatus(value: string): value is KnownMessageStatus {
  return (MESSAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * A file to attach.
 *
 * `content` is bytes, and the SDK base64-encodes them (§5.10). The
 * pre-encoded arm exists for callers who already hold base64 (a data URL, a row
 * from a database) and must opt in explicitly with `encoding: 'base64'` — an
 * unannotated string is refused, because the common way to get this wrong is to
 * pass a *file path* and expect the SDK to read it. It never will: an SDK that
 * opens arbitrary paths on a caller's behalf is an LFI primitive sitting inside
 * a web handler.
 */
export type Attachment =
  | {
      filename: string;
      /** Raw bytes. `Buffer` is a `Uint8Array`, so it is accepted as-is. */
      content: Uint8Array | ArrayBuffer;
      encoding?: undefined;
      contentType?: string;
      /** Set to reference the attachment inline from HTML via `cid:`. */
      contentId?: string;
    }
  | {
      filename: string;
      /** Already base64. Validated strictly before it goes on the wire. */
      content: string;
      encoding: 'base64';
      contentType?: string;
      contentId?: string;
    };

/** One address, or several. Both shapes are accepted everywhere. */
export type Recipients = string | string[];

export interface SendEmailOptions {
  /** `"Name <a@b.com>"` or a bare address. The domain must be verified by your team. */
  from: string;
  to: Recipients;
  cc?: Recipients;
  bcc?: Recipients;
  /** Sent as `reply_to`. */
  replyTo?: Recipients;
  /** Defaults to `""`, which is what the server would default it to anyway. */
  subject?: string;
  html?: string;
  text?: string;
  /** Custom headers, at most 25. `from`/`to`/`cc`/`bcc`/`subject`/`dkim-signature`/`received` are refused. */
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Analytics labels: at most 10, keys ≤ 64 chars, values ≤ 256. */
  tags?: Record<string, string>;
  /**
   * Dedup key. Omit it and the SDK generates one per call and reuses it across
   * that call's retries — which is the only reason retrying a send is safe.
   */
  idempotencyKey?: string;
}

/** A recipient the server refused before sending — today, always a suppression-list hit. */
export interface RejectedRecipient {
  address: string;
  /** Currently always `"suppressed"`. */
  reason: string;
}

export interface SendEmailResponse {
  /** Our message id, stable across a delivery-backend change. */
  id: string;
  status: MessageStatus;
  /**
   * Recipients we refused. The wire omits this when empty; the SDK always gives
   * you an array, so `response.rejected.length` never needs a null check. A
   * non-empty value is not an error — the rest of the message still went.
   */
  rejected: RejectedRecipient[];
}

export interface Email {
  id: string;
  /** A single address: the server writes one record per primary recipient. */
  to: string;
  from: string;
  subject: string;
  status: MessageStatus;
  /** ISO 8601, as sent. Left as a string so no timezone is invented on the way through. */
  createdAt: string;
  /** ISO 8601, or `null` until the message is delivered. */
  deliveredAt: string | null;
  opened: boolean;
  clicked: boolean;
  /** Present only when the message failed. */
  failureReason?: string;
}

export interface NaijamailOptions {
  /** Falls back to `NAIJAMAIL_API_KEY`. */
  apiKey?: string;
  /** Falls back to `NAIJAMAIL_BASE_URL`, then `https://api.naijacloud.com`. Must be https unless it is loopback. */
  baseUrl?: string;
  /** Milliseconds, per attempt (not per call). Default 30000. */
  timeout?: number;
  /** Retries after the first attempt. Default 2, so 3 attempts in total. */
  maxRetries?: number;
  /** Appended to the User-Agent. Never put anything secret here. */
  userAgentSuffix?: string;
}

/**
 * A verified webhook event.
 *
 * Loosely typed on purpose: the control plane does not emit these yet
 * (SDK-CONTRACT.md §6), so pinning a `data` shape now would be inventing an API.
 * The signature scheme is fixed; the payload is passed through untouched.
 */
export interface WebhookEvent {
  /** e.g. `"email.delivered"`. */
  type: string;
  /** The event payload. */
  data: Record<string, unknown>;
  /** Anything else the control plane adds later, passed through as-is. */
  [extra: string]: unknown;
}
