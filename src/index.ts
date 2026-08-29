/**
 * @naijacloud/email — the official Node.js SDK for Naijamail.
 *
 * The whole public surface is re-exported here; nothing outside this file is a
 * supported import path, so internals can be reorganised without a breaking
 * change for anyone.
 */

export { Naijamail } from './client';
export { Emails } from './resources/emails';
export { verifyWebhook, DEFAULT_WEBHOOK_TOLERANCE_SECONDS } from './webhooks';
export type { VerifyWebhookOptions } from './webhooks';

export {
  NaijamailError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  ConnectionError,
  TimeoutError,
  WebhookVerificationError,
} from './errors';
export type { NaijamailErrorOptions } from './errors';

export { MESSAGE_STATUSES, isKnownMessageStatus } from './types';
export type {
  Attachment,
  Email,
  KnownMessageStatus,
  MessageStatus,
  NaijamailOptions,
  Recipients,
  RejectedRecipient,
  SendEmailOptions,
  SendEmailResponse,
  WebhookEvent,
} from './types';

export { SENDING_LIMITS } from './validate';
export { VERSION } from './version';
