# Contributing

## Setup

```sh
npm install
```

Node 18 or newer. There are no runtime dependencies and there will not be any —
see SECURITY.md.

## The loop

```sh
npm test           # vitest, once
npm run test:watch # vitest, watching
npm run typecheck  # tsc --noEmit over src and test
npm run build      # tsup: dist/index.js, dist/index.cjs, and both .d.ts files

npm run check:version  # package.json, src/version.ts and the changelog agree
npm run check:tarball  # what `npm publish` would upload; needs a build first
```

`npm test` must pass with the network unplugged. Every test runs against a real
`node:http` server bound to `127.0.0.1:0`; `fetch` is never stubbed, because
mocking it would test the mock rather than the client — a header undici refuses,
a redirect that gets followed, a body read that races an abort, none of those
appear without a socket.

## What this SDK is

An implementation of `email-sdks/spec/SDK-CONTRACT.md`. That document is the
source of truth for the wire format, the error taxonomy, the retry policy and
the security rules, and every Naijamail SDK implements exactly it — so a bug
fixed in one is a bug to fix in all, and a customer moving from Node to Go
rewrites syntax, not behaviour.

Two consequences worth stating plainly:

- **Do not add endpoints.** The API has `POST /v1/emails` and
  `GET /v1/emails/{id}`. A client method for an endpoint that does not exist
  produces a 404 the caller cannot act on.
- **Behaviour changes belong in the contract first.** If the control plane and
  the contract disagree, the control plane wins and the contract gets fixed.

## House style

Comments explain **why** — the decision, the failure it prevents, the trap it
avoids. A comment restating the code is noise, and it rots. This matches the
`nc-control-plane` repo.

Anything touching the key, the base URL, redirects, header validation or the
webhook verifier needs a test that fails without the change. Where a test exists
for a security rule, the assertion that no request was made is the point of the
test, not decoration.

## Pull requests

- One change per PR, with the contract section it implements referenced.
- `npm run typecheck && npm test && npm run build` clean.
- A changelog entry under `## [Unreleased]`.
- Never commit a real key. The literal test key is
  `nmail_live_test0000000000000000`.

## Releasing

Releases come from CI, on a tag. Nobody publishes from a laptop: there is no
npm token in this repo or on anyone's machine, and the provenance attestation
npm shows next to the package is only worth something because the build that
produced the tarball is the one anyone can read in `.github/workflows`.

In one commit on `main`:

1. Update `VERSION` in `src/version.ts` and `version` in `package.json` — they
   move together, and a mismatch ships a wrong User-Agent.
2. Move the `Unreleased` changelog entries under `## [x.y.z] - YYYY-MM-DD`, and
   update the link definitions at the foot of CHANGELOG.md.
3. `npm run check:version` — the same check CI runs, so you find a typo here
   rather than after the tag exists.

Then tag it:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`release.yml` runs the full CI matrix, re-checks that the tag, package.json and
`src/version.ts` agree, checks what the tarball would contain, publishes, and
cuts a GitHub release from that version's changelog section.

A tag whose version has a prerelease part — `v0.2.0-rc.1` — publishes under the
`next` dist-tag and is marked as a prerelease. It needs no changelog section:
`npm install @naijacloud/email` resolves `latest`, so an rc reaches only the
people who ask for it by name.

### Fixing a bad tag

Before the workflow publishes, delete the tag (`git push --delete origin
v0.2.0`) and start over. After it publishes, you cannot: npm allows unpublishing
for 72 hours and refuses afterwards. Ship the fix as the next patch version.

### One-time setup

Two settings that live outside the repo, recorded here because nothing in the
tree reveals them and a release fails confusingly without them:

- **npmjs.com → @naijacloud/email → Settings → Trusted publisher.** Repository
  `naijacloud/nc-email-node`, workflow `release.yml`, environment `npm`. This is
  what lets the workflow publish without a token; if the environment field there
  and the `environment:` in `release.yml` disagree, npm rejects the OIDC claim.
- **GitHub → Settings → Environments → `npm`.** Add required reviewers here to
  make a release wait for a human.
