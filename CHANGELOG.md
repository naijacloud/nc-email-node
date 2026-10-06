# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-07

Conformance pass across the five Naijamail SDKs (TGL-741); behaviour now matches
SDK-CONTRACT.md exactly.

### Changed

- The 10 MiB size check measures what the server measures — UTF-8 bytes of
  `html` + `text` + decoded attachment bytes — instead of the encoded JSON body.
  Attachments of roughly 7.5–10 MiB are no longer refused locally.
- Any 4xx without its own class (405, 415, 451…) is a `ValidationError`, not the
  base `NaijamailError`.
- A string attachment `content` is taken as already base64; `encoding: 'base64'`
  is no longer required (still accepted).
- `error.body` is the parsed JSON body or `undefined`; it no longer holds the raw
  text of a non-JSON response. The raw text is on the new `error.rawBody`.
- The idempotency key limit (255) is counted in UTF-8 bytes, and a non-ASCII key
  is sent as its UTF-8 bytes instead of failing inside `fetch`.

### Added

- `NaijamailError.rawBody`: the response text exactly as received.
- An `nc_pat_…` key is refused with a message explaining it is a personal access
  token and which keys to use instead.

### Fixed

- `RateLimitError.retryAfter` is clamped to 60 seconds, like the retry loop.
- `maxRetries` above 10 is refused at construction.
- A blank `NAIJAMAIL_BASE_URL` is treated as unset instead of failing construction.
- An empty attachment is refused before the request (the API refused it).
- A webhook `t=` value must be 1–12 digits.

## [0.2.1] - 2026-10-05

No code changes since 0.2.0. The 0.2.0 tag was never published to npm, so this
is the first release to carry its changes.

## [0.2.0] - 2026-10-04

### Added

- `Email.sandbox` on a retrieved email: true for a message sent with a test key,
  which is recorded but never delivered, so a simulated bounce can be told from
  a real one.

### Fixed

- `verifyWebhook` refuses a `tolerance` that is NaN, infinite or negative.
  A NaN (for example `Number(process.env.UNSET)`) switched replay protection off.
- A 413 (request too large) is a `ValidationError`, as in the Go and PHP SDKs.
- Test keys (`nmail_test_…`) are sandboxed by the API, not refused with a 403.
  The README said otherwise.

### Changed

- Releases are published by a tagged CI run with npm trusted publishing, so
  every version from here on carries a provenance attestation linking the
  tarball to the commit and the workflow that built it. `npm audit signatures`
  verifies it. Nothing about the package's contents changes.

## [0.1.0] - 2026-08-31

First release. Implements SDK-CONTRACT.md in full.

### Added

- Accept a workspace API key (`nc_live_…`) alongside the Naijamail keys. It is
  the credential from **Settings → API keys**, and it reaches the mail API when
  it carries the **Email send** scope — so a team that already has one for
  deploys and the platform API does not need a second secret to send mail.
  Redaction knows the new prefix, so a dump still shows which kind of credential
  a process is holding. `nc_pat_…` platform tokens remain refused: they predate
  the scope and the API rejects them on the mail routes.
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

[Unreleased]: https://github.com/naijacloud/nc-email-node/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/naijacloud/nc-email-node/releases/tag/v0.3.0
[0.2.1]: https://github.com/naijacloud/nc-email-node/releases/tag/v0.2.1
[0.2.0]: https://github.com/naijacloud/nc-email-node/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@naijacloud/email/v/0.1.0
