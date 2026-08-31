# Security Policy

## Reporting a vulnerability

Email **security@naijacloud.com**. Do not open a public issue, a discussion or a
pull request for a security problem: this package holds live sending
credentials, and a public report is a working exploit handed to everyone using
it before a fix exists.

Include what you need to make the problem reproducible — version, Node version,
a minimal snippet, and what you expected instead. If you have a proof of
concept, send it; if it involves a key, redact it.

We acknowledge reports within two working days and will tell you our assessment
and a fix timeline. We will credit you in the changelog unless you would rather
we did not.

## Supported versions

The latest minor release receives security fixes. Before 1.0.0 that is the
latest release, full stop.

## What this SDK guarantees

These are enforced in code and covered by tests, and a regression in any of them
is a security bug worth reporting:

- The API key is sent only in the `Authorization` header. It never appears in
  the User-Agent, in an error message or stack, or in `util.inspect`,
  `console.log` or `JSON.stringify` output for a client.
- A base URL that is not `https` is refused unless the host is `localhost`,
  `127.0.0.1` or `::1`.
- Redirects are never followed; a 3xx is reported as an error. A followed
  redirect would re-send the `Authorization` header to another host.
- CR, LF and NUL are rejected in addresses, subjects, custom headers, tags,
  attachment filenames and the idempotency key, before any request is made.
- `from`, `to`, `cc`, `bcc`, `subject`, `dkim-signature` and `received` cannot be
  set as custom headers.
- Webhook signatures are compared in constant time, and a stale timestamp is
  rejected. Errors never disclose the expected signature.
- File paths are never read on the caller's behalf.
- No runtime dependencies. Every one would be supply-chain risk taken on your
  behalf by a package that holds your sending credential.
- Every version on npm is published by a tagged GitHub Actions run, with a
  provenance attestation tying the tarball to the commit and workflow that built
  it. No maintainer holds a publish token, so there is no token to steal. Check
  it yourself with `npm audit signatures` after installing, or read the
  Provenance panel on the npm page.

## What it cannot do for you

- Keep your key out of your own logs. Do not log request options you built, and
  do not put a key in `userAgentSuffix`.
- Protect a key committed to a repository. If one leaks, revoke it in the Naija
  Cloud dashboard first and investigate second.
- Verify webhooks from a re-serialized body. Give `verifyWebhook` the raw bytes.
