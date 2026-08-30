import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Naijamail, ValidationError } from '../src/index';
import { MINIMAL_SEND, TEST_KEY, reply, startMockServer } from './support/mock-server';

afterEach(() => {
  delete process.env['NAIJAMAIL_API_KEY'];
  delete process.env['NAIJAMAIL_BASE_URL'];
});

describe('construction', () => {
  it('takes a key as a string', () => {
    const client = new Naijamail(TEST_KEY);
    expect(client.baseUrl).toBe('https://api.naijacloud.com');
    expect(client.timeout).toBe(30_000);
    expect(client.maxRetries).toBe(2);
  });

  it('takes a key and an options object, the shape the other SDKs use', () => {
    // The regression that motivates this: as a single-argument constructor,
    // this exact call silently discarded the options in plain JavaScript, so a
    // caller aiming at a staging host would have been talking to production.
    const client = new Naijamail(TEST_KEY, {
      baseUrl: 'https://mail.example.com',
      timeout: 5_000,
      maxRetries: 0,
    });
    expect(client.baseUrl).toBe('https://mail.example.com');
    expect(client.timeout).toBe(5_000);
    expect(client.maxRetries).toBe(0);
  });

  it('validates options passed as the second argument', () => {
    expect(() => new Naijamail(TEST_KEY, { baseUrl: 'http://api.naijacloud.com' })).toThrow(
      ValidationError,
    );
    expect(() => new Naijamail(TEST_KEY, { timeout: 0 })).toThrow(ValidationError);
  });

  it('lets the key argument win over one in the options', () => {
    const client = new Naijamail(TEST_KEY, { apiKey: 'nmail_live_ignored0000000000', maxRetries: 1 });
    expect(client.maxRetries).toBe(1);
    expect(inspect(client)).not.toContain('ignored');
  });

  it('refuses two option objects rather than guessing which one loses', () => {
    expect(
      () => new Naijamail({ apiKey: TEST_KEY } as never, { timeout: 1_000 } as never),
    ).toThrow(ValidationError);
  });

  it('takes an options object', () => {
    const client = new Naijamail({
      apiKey: TEST_KEY,
      baseUrl: 'https://mail.example.com',
      timeout: 5_000,
      maxRetries: 0,
    });
    expect(client.baseUrl).toBe('https://mail.example.com');
    expect(client.timeout).toBe(5_000);
    expect(client.maxRetries).toBe(0);
  });

  it('falls back to NAIJAMAIL_API_KEY', () => {
    process.env['NAIJAMAIL_API_KEY'] = TEST_KEY;
    expect(() => new Naijamail()).not.toThrow();
  });

  it('names the environment variable when no key is configured', () => {
    expect(() => new Naijamail()).toThrow(ValidationError);
    expect(() => new Naijamail()).toThrow(/NAIJAMAIL_API_KEY/);
  });

  it('trims a key pasted with surrounding whitespace', () => {
    expect(() => new Naijamail(` ${TEST_KEY}\n`)).not.toThrow();
  });

  it.each([
    ['an empty string', ''],
    // `nc_pat_` is the pre-scopes platform token. The API refuses it on the
    // mail routes outright — it predates the Email send scope and was never
    // granted mail access — so the SDK refuses it here rather than a request
    // later.
    ['a platform token', 'nc_pat_0123456789abcdef'],
    ['the wrong environment word', 'nmail_prod_0123456789abcdef'],
    ['a test-variant workspace key, which does not exist', 'nc_test_0123456789abcdef'],
    ['a truncated paste', 'nmail_live_short'.slice(0, 14)],
    ['a key with a space in it', 'nmail_live_0123 456789'],
  ])('rejects %s at construction', (_label, key) => {
    expect(() => new Naijamail(key)).toThrow(ValidationError);
  });

  // A workspace key from Settings → API keys, carrying the Email send scope.
  it('accepts a workspace API key', () => {
    expect(() => new Naijamail('nc_live_0123456789abcdefghij')).not.toThrow();
  });

  it('never quotes the key back in the shape error', () => {
    const key = 'nmail_bogus_supersecretvalue';
    expect(() => new Naijamail(key)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecretvalue') }),
    );
  });

  it('rejects a non-positive timeout and a fractional retry count', () => {
    expect(() => new Naijamail({ apiKey: TEST_KEY, timeout: 0 })).toThrow(ValidationError);
    expect(() => new Naijamail({ apiKey: TEST_KEY, timeout: -1 })).toThrow(ValidationError);
    expect(() => new Naijamail({ apiKey: TEST_KEY, maxRetries: 1.5 })).toThrow(ValidationError);
    expect(() => new Naijamail({ apiKey: TEST_KEY, maxRetries: -1 })).toThrow(ValidationError);
  });

  it('rejects a user agent suffix containing a newline', () => {
    expect(
      () => new Naijamail({ apiKey: TEST_KEY, userAgentSuffix: 'app\r\nX-Admin: 1' }),
    ).toThrow(ValidationError);
  });
});

describe('base URL', () => {
  it('refuses plaintext for a remote host', () => {
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'http://api.naijacloud.com' })).toThrow(
      ValidationError,
    );
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'http://192.168.1.10:4000' })).toThrow(
      /https/,
    );
  });

  it.each([
    'http://localhost:4000',
    'http://127.0.0.1:4000',
    'http://[::1]:4000',
    'https://api.naijacloud.com',
  ])('allows %s', (url) => {
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: url })).not.toThrow();
  });

  it('refuses a non-http scheme and a URL that will not parse', () => {
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'ftp://api.naijacloud.com' })).toThrow(
      ValidationError,
    );
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'not a url' })).toThrow(ValidationError);
  });

  it('reads NAIJAMAIL_BASE_URL and strips the trailing slash', () => {
    process.env['NAIJAMAIL_BASE_URL'] = 'https://staging.naijacloud.com/';
    expect(new Naijamail(TEST_KEY).baseUrl).toBe('https://staging.naijacloud.com');
  });
});

describe('key redaction', () => {
  const secret = 'nmail_live_needle00000000000000';
  const secretTail = 'needle00000000000000';
  const client = new Naijamail({ apiKey: secret, baseUrl: 'https://api.naijacloud.com' });

  it('keeps the key out of util.inspect, however deeply it looks', () => {
    for (const dump of [
      inspect(client),
      inspect(client, { depth: 10, showHidden: true }),
      inspect(client.emails, { depth: 10, showHidden: true }),
    ]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(secretTail);
    }
    expect(inspect(client)).toContain('nmail_live_***');
  });

  it('keeps the key out of JSON.stringify', () => {
    const json = JSON.stringify({ client, emails: client.emails });
    expect(json).not.toContain(secret);
    expect(json).not.toContain(secretTail);
    expect(json).toContain('nmail_live_***');
  });

  it('keeps the key out of string interpolation', () => {
    expect(`${String(client)}`).not.toContain(secretTail);
  });

  // The redaction has to know the second prefix too, or a workspace key falls
  // through to the bare `***` and an operator reading a dump loses the one
  // useful signal — which kind of credential this process is holding.
  it('redacts a workspace key down to its own prefix', () => {
    const workspace = new Naijamail('nc_live_needle00000000000000');
    expect(inspect(workspace)).toContain('nc_live_***');
    expect(inspect(workspace)).not.toContain('needle');
  });
});

describe('instance isolation', () => {
  it('keeps two clients with two keys apart', async () => {
    const server = await startMockServer(reply(202, { id: 'a', status: 'queued' }));
    try {
      const first = new Naijamail({
        apiKey: 'nmail_live_firstteamkey000000',
        baseUrl: server.baseUrl,
      });
      const second = new Naijamail({
        apiKey: 'nmail_live_secondteamkey00000',
        baseUrl: server.baseUrl,
        timeout: 1_000,
      });

      await first.emails.send(MINIMAL_SEND);
      await second.emails.send(MINIMAL_SEND);

      expect(server.requests[0]?.headers.authorization).toBe(
        'Bearer nmail_live_firstteamkey000000',
      );
      expect(server.requests[1]?.headers.authorization).toBe(
        'Bearer nmail_live_secondteamkey00000',
      );
      expect(first.timeout).toBe(30_000);
      expect(second.timeout).toBe(1_000);
    } finally {
      await server.close();
    }
  });
});

describe('base URL edge cases', () => {
  it('refuses a query string or fragment that would land mid-path', () => {
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'https://api.naijacloud.com/?a=1' })).toThrow(
      ValidationError,
    );
    expect(() => new Naijamail({ apiKey: TEST_KEY, baseUrl: 'https://api.naijacloud.com/#x' })).toThrow(
      ValidationError,
    );
  });

  it('keeps a path prefix, for an API fronted by a proxy', async () => {
    const server = await startMockServer(reply(202, { id: 'a', status: 'queued' }));
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: `${server.baseUrl}/naijamail/` });
      await client.emails.send(MINIMAL_SEND);
      expect(server.requests[0]?.url).toBe('/naijamail/v1/emails');
    } finally {
      await server.close();
    }
  });
});
