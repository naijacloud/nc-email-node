<p align="center">
  <a href="https://www.naijacloud.com">
    <img alt="Naijamail — Node.js SDK" src="https://raw.githubusercontent.com/naijacloud/nc-email-node/main/.github/assets/banner.png" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@naijacloud/email"><img alt="npm" src="https://img.shields.io/badge/npm-@naijacloud%2Femail-008751?style=flat-square&labelColor=0A0E0C"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D_18-3178C6?style=flat-square&labelColor=0A0E0C">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-46C98A?style=flat-square&labelColor=0A0E0C">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-8A988F?style=flat-square&labelColor=0A0E0C"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#the-client">The client</a> ·
  <a href="#sending">Sending</a> ·
  <a href="#errors">Errors</a> ·
  <a href="#retries-and-idempotency">Retries and idempotency</a> ·
  <a href="#webhooks">Webhooks</a> ·
  <a href="#security">Security</a>
</p>

# @naijacloud/email

The official Node.js SDK for [Naijamail](https://www.naijacloud.com), the
transactional email API of Naija Cloud.

```ts
import { Naijamail } from '@naijacloud/email';

const nm = new Naijamail(process.env.NAIJAMAIL_API_KEY);

const { id, status } = await nm.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'customer@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
});

console.log(id, status); // 5b1e0f6c-… queued
```

## Install

```sh
npm install @naijacloud/email
```

Node 18 or newer. Zero runtime dependencies — the SDK is built on global
`fetch`, `AbortSignal` and `node:crypto`, so nothing else is pulled into a
package that holds your sending credential.

Ships as both ESM and CommonJS with TypeScript types:

```js
const { Naijamail } = require('@naijacloud/email');
```

## The client

```ts
const nm = new Naijamail({
  apiKey: process.env.NAIJAMAIL_API_KEY, // or the first positional argument
  baseUrl: 'https://api.naijacloud.com', // or NAIJAMAIL_BASE_URL
  timeout: 30_000,                       // milliseconds, per attempt
  maxRetries: 2,                         // attempts after the first
  userAgentSuffix: 'acme-billing/2.1',   // appended to the User-Agent
});
```

The key can also be its own argument, which is the shape the Go, Python, PHP and
Ruby SDKs use:

```ts
const nm = new Naijamail(process.env.NAIJAMAIL_API_KEY, { timeout: 5_000 });
```

With no `apiKey` the SDK reads `NAIJAMAIL_API_KEY`. If neither is set,
construction throws — a missing key is a deployment mistake, and finding out at
startup beats finding out at 2am on the first send.

A client carries its own key, base URL and deadlines. There is no global state,
so two clients holding two teams' keys in one process cannot interfere.

## Sending

| Option | Type | Notes |
| --- | --- | --- |
| `from` | `string` | Required. `"Name <a@b.com>"` or a bare address. The domain must be verified by your team. |
| `to` | `string \| string[]` | Required, at least one. |
| `cc`, `bcc`, `replyTo` | `string \| string[]` | `replyTo` goes on the wire as `reply_to`. |
| `subject` | `string` | Defaults to `""`. |
| `html`, `text` | `string` | Send either or both. |
| `headers` | `Record<string, string>` | At most 25. `from`, `to`, `cc`, `bcc`, `subject`, `dkim-signature` and `received` are refused. |
| `attachments` | `Attachment[]` | See below. |
| `tags` | `Record<string, string>` | At most 10; keys ≤ 64 chars, values ≤ 256. |
| `idempotencyKey` | `string` | Optional; one is generated per call if you omit it. |

The SDK takes camelCase and sends the API's snake_case for you. An unrecognised
option is rejected with a pointer to the right spelling rather than dropped
silently, so a `reply_to` copied out of the HTTP docs cannot quietly send your
customers' replies to the wrong mailbox.

A `202` means the message passed authorisation, suppression and quota checks and
is queued — not that a mailbox has it.

```ts
const { id, status, rejected } = await nm.emails.send({ ... });
```

`rejected` lists recipients we refused, normally because they are on your
suppression list. It is **always an array** — the wire omits it when empty, the
SDK does not — and it is not an error: the rest of the message still went.

```ts
if (rejected.length) {
  console.warn('not sent to:', rejected.map((r) => `${r.address} (${r.reason})`));
}
```

### Attachments

Pass bytes. The SDK base64-encodes them.

```ts
import { readFile } from 'node:fs/promises';

await nm.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'customer@example.com',
  subject: 'Invoice #1024',
  html: '<p>Attached.</p>',
  attachments: [
    {
      filename: 'invoice-1024.pdf',
      content: await readFile('./invoice-1024.pdf'), // Buffer, Uint8Array or ArrayBuffer
      contentType: 'application/pdf',
    },
  ],
});
```

If you already hold base64, say so explicitly:

```ts
{ filename: 'invoice.pdf', content: base64String, encoding: 'base64' }
```

The SDK **never reads a file path**. Reading a caller-supplied path on their
behalf would make every web handler that forwards user input an arbitrary-file-read
primitive, so `content: './invoice.pdf'` is rejected, not opened.

### Retrieving a message

```ts
const email = await nm.emails.get(id);
// { id, to, from, subject, status, createdAt, deliveredAt, opened, clicked, failureReason? }
```

`to` is a single address: the server writes one record per primary recipient, so
a three-recipient send returns the id of the first and each recipient has its own
record. `deliveredAt` is `null` until delivery. `failureReason` is present only
on a failure.

`status` is one of `queued`, `sent`, `delivered`, `bounced`, `deferred`,
`complained`, `rejected`, `failed` — typed as a union that also accepts any other
string, so a status added on the server does not break type-checking or throw
inside an older SDK. `isKnownMessageStatus(status)` narrows it when you need to
switch exhaustively.

## Errors

Every failure is a `NaijamailError`, so one `catch` is enough, and each carries
`statusCode`, `error` (the server's short label), `requestId` (from
`x-request-id` — quote it in a support ticket) and `body`.

| Class | When |
| --- | --- |
| `ValidationError` | 400, 422, and anything this SDK refuses locally (`statusCode: 0`) |
| `AuthenticationError` | 401 — missing, unknown or revoked key |
| `PermissionError` | 403 — test key on the live path, unverified domain, quota |
| `NotFoundError` | 404, and the server's 400 `message not found` |
| `ConflictError` | 409 |
| `RateLimitError` | 429; carries `retryAfter` in seconds |
| `ServerError` | 5xx, an unreadable response, or an unexpected redirect |
| `ConnectionError` | DNS, TCP or TLS failure |
| `TimeoutError` | your deadline, or the server's 408 |
| `WebhookVerificationError` | a webhook that did not verify |

```ts
import { Naijamail, PermissionError, RateLimitError } from '@naijacloud/email';

try {
  await nm.emails.send({ ... });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.warn(`rate limited, retry after ${error.retryAfter}s`);
  } else if (error instanceof PermissionError) {
    console.error('verify the sending domain first:', error.message);
  } else {
    throw error;
  }
}
```

## Retries and idempotency

Three attempts by default (one try, two retries), each with its own 30s deadline.

Retried: `429`, `408`, any `5xx`, and connection or timeout failures. Never
retried: any other 4xx — a 403 on an unverified domain will not succeed on a
second attempt. Backoff is exponential with full jitter (`random(0, min(8s,
500ms × 2^attempt))`); a `Retry-After` header overrides it, clamped to 60s.

Retrying a send is only safe because of the idempotency key. If you do not
supply one, the SDK generates a UUID per `send()` call and sends it on every
attempt of that call, so a timeout followed by a retry cannot mail your customer
twice. A key you supply is used as-is and never regenerated — pass your own
order or invoice id if you want that guarantee to extend across process
restarts.

## Security

The rules this SDK enforces on your behalf, and why:

- **HTTPS only.** A `baseUrl` that is not `https` is refused at construction,
  unless the host is `localhost`, `127.0.0.1` or `::1` for local development.
- **No redirect following.** A 3xx is reported as a `ServerError`, never
  followed: a followed redirect re-sends your `Authorization` header to whatever
  host the response names.
- **The key stays in the auth header.** It is not in the User-Agent, not in
  error messages, and `console.log(client)` or `JSON.stringify(client)` shows
  `nmail_live_***`.
- **Header-injection defence.** A `\r`, `\n` or NUL in an address, subject,
  header, tag or attachment filename is rejected before any request — that is
  how a user-supplied value turns into an extra `Bcc:` line.
- **Limits checked locally**: 50 recipients across to/cc/bcc, 10 MiB encoded,
  25 headers, 10 tags. Exported as `SENDING_LIMITS`.
- **Key shape checked at construction**, so a truncated paste fails at startup.

Report a vulnerability to security@naijacloud.com — see [SECURITY.md](SECURITY.md).

## Webhooks

> **Live.** Naija Cloud delivers these events to endpoints you register, signed
> exactly as below. Two details this verifier already handles: the timestamp is
> taken per delivery *attempt*, so a retry never arrives outside the tolerance
> window; and during a secret rotation the header carries two `v1=` values for
> 24 hours, which is why any match is accepted.

`NC-Signature: t=<unix seconds>,v1=<hex hmac-sha256>` over `"<t>.<raw body>"`.

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@naijacloud/email';

const secret = process.env.NAIJAMAIL_WEBHOOK_SECRET;
if (!secret) throw new Error('set NAIJAMAIL_WEBHOOK_SECRET');

const app = express();

// The raw body is required: a body that has been through JSON.parse and back
// has had its whitespace and key order rewritten, and will never verify.
app.post('/webhooks/naijamail', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.get('NC-Signature') ?? '', secret);
    console.log(event.type, event.data);
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(400);
    throw error;
  }
});
```

Timestamps outside a 300s tolerance are rejected — that, not the HMAC, is what
stops a captured request being replayed. Pass `{ tolerance: seconds }` to change
it. Several `v1=` values are accepted so a secret can be rotated without dropping
events.

## Examples

Runnable snippets in [`examples/`](examples): a minimal send, an attachment,
error handling, and an express webhook receiver. All read the key from
`NAIJAMAIL_API_KEY`.

## Development

```sh
npm install
npm run build      # tsup, ESM + CJS + types
npm test           # vitest, against a local HTTP server; no network needed
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
