# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-29

First release. Implements SDK-CONTRACT.md in full.

### Added

- `Naijamail` client with `emails.send()` and `emails.get()` — the two endpoints
  the API has.
- Configuration by constructor or environment (`NAIJAMAIL_API_KEY`,
  `NAIJAMAIL_BASE_URL`), with per-attempt timeout, retry count and a User-Agent
  suffix.
- One error hierarchy under `NaijamailError`, carrying `statusCode`, `error`,
  `requestId` and `body`. The server's 400 `message not found` is mapped to
  `NotFoundError`.
- Automatic retries on 429, 408, 5xx, connection and timeout failures, with
  exponential backoff and full jitter, honouring `Retry-After` (seconds or an
  HTTP date) up to 60s.
- An idempotency key generated per `send()` call and reused across that call's
  retries, so a retry after a timeout cannot double-mail a customer.
- `verifyWebhook()` for the `NC-Signature` scheme, with a replay window and
  constant-time comparison. Naija Cloud emits these events; the scheme is
  shared with every other Naijamail SDK, so all of them verify identically.
- Attachments from `Uint8Array`, `Buffer` or `ArrayBuffer`, base64-encoded by the
  SDK. File paths are never read.
- Security rules enforced locally: https-only base URLs outside loopback, no
  redirect following, key redaction in `inspect`/`toJSON`, header-injection
  rejection, forbidden custom headers, and the documented sending limits.
- Dual ESM and CommonJS builds with TypeScript types, and no runtime
  dependencies.

[Unreleased]: https://github.com/naijacloud/nc-email-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/naijacloud/nc-email-node/releases/tag/v0.1.0
