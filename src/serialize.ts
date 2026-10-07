import { Buffer } from 'node:buffer';
import { ServerError, ValidationError } from './errors';
import type {
  Attachment,
  Email,
  RejectedRecipient,
  SendEmailOptions,
  SendEmailResponse,
} from './types';
import {
  SENDING_LIMITS,
  assertNoControlChars,
  assertString,
  normalizeRecipients,
  validateHeaders,
  validateTags,
} from './validate';

/**
 * The single translation layer between this SDK's camelCase types and the
 * snake_case wire format. Both directions live here so there is one file to
 * change when the API grows a field, and no chance of the request and the
 * response disagreeing about what a field is called.
 */

/**
 * The options `send()` understands.
 *
 * An unknown key is refused rather than dropped: the common failure is a caller
 * copying `reply_to` out of the HTTP docs, and silently discarding it means a
 * customer's replies go to the wrong mailbox with nothing in any log to say why.
 */
const KNOWN_SEND_KEYS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'html',
  'text',
  'headers',
  'attachments',
  'tags',
  'idempotencyKey',
]);

/** Wire spellings a caller is likely to reach for, and what to use instead. */
const SEND_KEY_HINTS: Record<string, string> = {
  reply_to: 'replyTo',
  idempotency_key: 'idempotencyKey',
};

const KNOWN_ATTACHMENT_KEYS = new Set([
  'filename',
  'content',
  'encoding',
  'contentType',
  'contentId',
]);

const ATTACHMENT_KEY_HINTS: Record<string, string> = {
  content_type: 'contentType',
  content_id: 'contentId',
  path: 'content',
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  known: Set<string>,
  hints: Record<string, string>,
  label: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    // `{ ...base, cc: undefined }` is an ordinary way to build options; an
    // explicitly-undefined known-or-unknown key carries no data to lose.
    if (value === undefined) continue;
    if (known.has(key)) continue;

    const hint = hints[key];
    throw new ValidationError(
      hint
        ? `${label}: unknown option "${key}" — did you mean "${hint}"? This SDK takes camelCase and sends snake_case for you`
        : `${label}: unknown option "${key}"`,
    );
  }
}

/**
 * Base64-encode one attachment.
 *
 * Bytes in, base64 on the wire (§5.10) — a caller hand-encoding is a caller
 * getting the padding subtly wrong on one file in a thousand.
 */
function serializeAttachment(
  raw: Attachment,
  index: number,
): { wire: Record<string, unknown>; bytes: number } {
  const label = `attachments[${index}]`;
  const attachment = asRecord(raw, label);
  rejectUnknownKeys(attachment, KNOWN_ATTACHMENT_KEYS, ATTACHMENT_KEY_HINTS, label);

  const filename = assertString(attachment['filename'], `${label}.filename`);
  if (!filename.trim()) {
    throw new ValidationError(`${label}.filename must not be empty`);
  }
  assertNoControlChars(filename, `${label}.filename`);

  const content = attachment['content'];
  const encoding = attachment['encoding'];
  let encoded: string;
  let bytes: number;

  if (encoding !== undefined && encoding !== 'base64') {
    throw new ValidationError(`${label}.encoding must be 'base64' when set`);
  }

  if (typeof content === 'string') {
    // A text string is taken as already base64 (SDK-CONTRACT.md §5.10) and
    // validated strictly. `encoding: 'base64'` is still accepted but no longer
    // required. A *file path* fails the strict check and is never read: an SDK
    // that opens arbitrary paths on a caller's behalf is an LFI primitive in a
    // web handler.
    encoded = assertStrictBase64(content, label);
    bytes = Buffer.from(encoded, 'base64').length;
  } else if (content instanceof ArrayBuffer) {
    bytes = content.byteLength;
    encoded = Buffer.from(content).toString('base64');
  } else if (ArrayBuffer.isView(content)) {
    // byteOffset/byteLength matter: a Uint8Array can be a window onto a larger
    // buffer, and encoding the whole buffer would attach the wrong bytes.
    bytes = content.byteLength;
    encoded = Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString(
      'base64',
    );
  } else {
    throw new ValidationError(
      `${label}.content must be a Uint8Array, Buffer or ArrayBuffer, or a base64 string`,
    );
  }

  // The server refuses a zero-byte attachment (`content is empty`); say so
  // here instead of spending the round trip.
  if (bytes === 0) {
    throw new ValidationError(`${label} content is empty`);
  }

  const out: Record<string, unknown> = { filename, content: encoded };

  const contentType = attachment['contentType'];
  if (contentType !== undefined) {
    const value = assertString(contentType, `${label}.contentType`);
    assertNoControlChars(value, `${label}.contentType`);
    out['content_type'] = value;
  }

  const contentId = attachment['contentId'];
  if (contentId !== undefined) {
    const value = assertString(contentId, `${label}.contentId`);
    assertNoControlChars(value, `${label}.contentId`);
    out['content_id'] = value;
  }

  return { wire: out, bytes };
}

/**
 * Refuse anything that is not strictly base64, exactly as the server's
 * `decodeBase64Strict` does.
 *
 * `Buffer.from(x, 'base64')` cannot be trusted alone: Node discards characters
 * outside the alphabet instead of throwing, so `"!!!garbage!!!"` decodes to a
 * few plausible bytes and the customer receives a corrupt invoice with no error
 * anywhere. A rejected attachment beats a mangled one.
 */
function assertStrictBase64(value: string, label: string): string {
  // Base64 may legally carry whitespace from line wrapping; strip it first.
  const compact = value.replace(/\s/g, '');

  if (!compact.length) {
    throw new ValidationError(`${label} content is empty`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new ValidationError(
      `${label} content is not valid base64 — pass raw bytes (Buffer/Uint8Array/ArrayBuffer) or a base64 string. File paths are never read by this SDK`,
    );
  }
  return compact;
}

/** Build the JSON body for `POST /v1/emails`, validating everything on the way. */
export function serializeSendOptions(options: SendEmailOptions): Record<string, unknown> {
  const source = asRecord(options, 'send options');
  rejectUnknownKeys(source, KNOWN_SEND_KEYS, SEND_KEY_HINTS, 'send');

  const from = assertString(source['from'], 'from');
  if (!from.trim()) {
    throw new ValidationError('"from" is required');
  }
  assertNoControlChars(from, 'from');

  const to = normalizeRecipients(options.to, 'to');
  if (!to.length) {
    throw new ValidationError('"to" is required');
  }
  const cc = normalizeRecipients(options.cc, 'cc');
  const bcc = normalizeRecipients(options.bcc, 'bcc');
  const replyTo = normalizeRecipients(options.replyTo, 'replyTo');

  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount > SENDING_LIMITS.MAX_RECIPIENTS) {
    throw new ValidationError(
      `too many recipients: ${recipientCount} across to, cc and bcc (limit ${SENDING_LIMITS.MAX_RECIPIENTS})`,
    );
  }

  // Sent unconditionally: the server defaults it to "" anyway, and a message
  // whose subject silently vanished is harder to spot than an empty one.
  const subject = options.subject === undefined ? '' : assertString(options.subject, 'subject');
  assertNoControlChars(subject, 'subject');

  const body: Record<string, unknown> = { from, to, subject };

  if (cc.length) body['cc'] = cc;
  if (bcc.length) body['bcc'] = bcc;
  if (replyTo.length) body['reply_to'] = replyTo;

  if (options.html !== undefined) body['html'] = assertString(options.html, 'html');
  if (options.text !== undefined) body['text'] = assertString(options.text, 'text');

  if (options.headers !== undefined) {
    body['headers'] = validateHeaders(asRecord(options.headers, 'headers') as Record<string, string>);
  }
  if (options.tags !== undefined) {
    body['tags'] = validateTags(asRecord(options.tags, 'tags') as Record<string, string>);
  }

  let attachmentBytes = 0;
  if (options.attachments !== undefined) {
    if (!Array.isArray(options.attachments)) {
      throw new ValidationError('attachments must be an array');
    }
    const serialized = options.attachments.map(serializeAttachment);
    body['attachments'] = serialized.map((a) => a.wire);
    attachmentBytes = serialized.reduce((sum, a) => sum + a.bytes, 0);
  }

  assertMessageSize(
    Buffer.byteLength(typeof body['html'] === 'string' ? body['html'] : '', 'utf8') +
      Buffer.byteLength(typeof body['text'] === 'string' ? body['text'] : '', 'utf8') +
      attachmentBytes,
  );

  return body;
}

/**
 * Refuse an over-large message locally.
 *
 * Uploading 12 MiB to be told 400 wastes the caller's bandwidth and, on a
 * mobile or Nigerian-ISP connection, a noticeable amount of their time and
 * money. Measured exactly as the server measures it (SDK-CONTRACT.md §5.7):
 * UTF-8 bytes of html and text plus the *decoded* attachment bytes. Measuring
 * the encoded JSON instead refused 7.5–10 MiB attachments the server takes.
 */
export function assertMessageSize(bytes: number): void {
  if (bytes > SENDING_LIMITS.MAX_BYTES) {
    throw new ValidationError(
      `the message is ${bytes} bytes (html + text + attachments), over the ${SENDING_LIMITS.MAX_BYTES}-byte limit`,
    );
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value) {
    throw new ServerError(`malformed response: "${key}" is missing`, { body: raw });
  }
  return value;
}

function mapRejected(value: unknown): RejectedRecipient[] {
  // Absent when empty on the wire; always an array here, so callers never
  // branch on its presence — and never mistake it for an error signal.
  if (!Array.isArray(value)) return [];

  return value.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return {
      address: typeof item['address'] === 'string' ? item['address'] : '',
      reason: typeof item['reason'] === 'string' ? item['reason'] : '',
    };
  });
}

export function toSendEmailResponse(raw: unknown): SendEmailResponse {
  const source = raw as Record<string, unknown>;
  if (!source || typeof source !== 'object') {
    throw new ServerError('malformed response: expected a JSON object', { body: raw });
  }

  return {
    id: requireString(source, 'id'),
    status: requireString(source, 'status'),
    rejected: mapRejected(source['rejected']),
  };
}

export function toEmail(raw: unknown): Email {
  const source = raw as Record<string, unknown>;
  if (!source || typeof source !== 'object') {
    throw new ServerError('malformed response: expected a JSON object', { body: raw });
  }

  const deliveredAt = source['delivered_at'];
  const failureReason = source['failure_reason'];

  const email: Email = {
    id: requireString(source, 'id'),
    to: typeof source['to'] === 'string' ? source['to'] : '',
    from: typeof source['from'] === 'string' ? source['from'] : '',
    subject: typeof source['subject'] === 'string' ? source['subject'] : '',
    status: requireString(source, 'status'),
    createdAt: typeof source['created_at'] === 'string' ? source['created_at'] : '',
    deliveredAt: typeof deliveredAt === 'string' ? deliveredAt : null,
    opened: source['opened'] === true,
    clicked: source['clicked'] === true,
    sandbox: source['sandbox'] === true,
  };

  // Present only on failure, so it stays absent rather than becoming an empty
  // string a caller would have to test for.
  if (typeof failureReason === 'string') {
    email.failureReason = failureReason;
  }

  return email;
}
