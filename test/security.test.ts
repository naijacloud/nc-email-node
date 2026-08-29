import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { Naijamail, SENDING_LIMITS, ValidationError } from '../src/index';
import type { SendEmailOptions } from '../src/index';
import { ACCEPTED, MINIMAL_SEND, TEST_KEY, reply, startMockServer } from './support/mock-server';

/**
 * Every case here must fail *before* a request is made — the assertion on
 * `server.requests` is the point of the test, not decoration. A local error at
 * the call site is worth far more to the caller than a 400 from a machine they
 * cannot see.
 */
async function expectRefusedLocally(
  options: SendEmailOptions,
  matcher: RegExp = /./,
): Promise<void> {
  const server = await startMockServer(reply(202, ACCEPTED));
  const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
  try {
    await expect(client.emails.send(options)).rejects.toThrow(ValidationError);
    await expect(client.emails.send(options)).rejects.toThrow(matcher);
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}

describe('header injection', () => {
  const injection = 'x\r\nBcc: attacker@evil.com';

  it.each([
    ['from', { ...MINIMAL_SEND, from: injection }],
    ['to', { ...MINIMAL_SEND, to: injection }],
    ['an address inside a to array', { ...MINIMAL_SEND, to: ['ok@example.com', injection] }],
    ['cc', { ...MINIMAL_SEND, cc: injection }],
    ['bcc', { ...MINIMAL_SEND, bcc: [injection] }],
    ['replyTo', { ...MINIMAL_SEND, replyTo: injection }],
    ['subject', { ...MINIMAL_SEND, subject: 'Hi\nBcc: attacker@evil.com' }],
    ['a header name', { ...MINIMAL_SEND, headers: { 'X-A\r\nBcc': 'v' } }],
    ['a header value', { ...MINIMAL_SEND, headers: { 'X-A': 'v\r\nBcc: attacker@evil.com' } }],
    ['a tag key', { ...MINIMAL_SEND, tags: { 'a\nb': 'v' } }],
    ['a tag value', { ...MINIMAL_SEND, tags: { a: 'v\nw' } }],
  ] as const)('refuses a CRLF in %s', async (_label, options) => {
    await expectRefusedLocally(options as SendEmailOptions, /carriage return|line feed|NUL/);
  });

  it('refuses a NUL byte', async () => {
    await expectRefusedLocally({ ...MINIMAL_SEND, subject: 'Hi\0there' });
  });

  it('refuses a CRLF in an attachment filename, content type or content id', async () => {
    const content = Buffer.from('hello');
    await expectRefusedLocally({
      ...MINIMAL_SEND,
      attachments: [{ filename: 'a\r\nContent-Type: text/html', content }],
    });
    await expectRefusedLocally({
      ...MINIMAL_SEND,
      attachments: [{ filename: 'a.txt', content, contentType: 'text/plain\r\nX: y' }],
    });
    await expectRefusedLocally({
      ...MINIMAL_SEND,
      attachments: [{ filename: 'a.txt', content, contentId: 'cid\r\nX: y' }],
    });
  });

  it('refuses an empty address or filename', async () => {
    await expectRefusedLocally({ ...MINIMAL_SEND, to: ['   '] });
    await expectRefusedLocally({ ...MINIMAL_SEND, from: '  ' });
    await expectRefusedLocally({
      ...MINIMAL_SEND,
      attachments: [{ filename: '', content: Buffer.from('x') }],
    });
  });
});

describe('forbidden headers', () => {
  it.each(['from', 'To', 'CC', 'bcc', 'Subject', 'DKIM-Signature', 'received'])(
    'refuses %s whatever its case',
    async (name) => {
      await expectRefusedLocally(
        { ...MINIMAL_SEND, headers: { [name]: 'anything' } },
        /cannot be overridden/,
      );
    },
  );

  it('still allows an ordinary custom header', async () => {
    const server = await startMockServer(reply(202, ACCEPTED));
    const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
    try {
      await client.emails.send({ ...MINIMAL_SEND, headers: { 'X-Entity-Ref-Id': '1024' } });
      expect(JSON.parse(server.requests[0]?.body ?? '{}').headers).toEqual({
        'X-Entity-Ref-Id': '1024',
      });
    } finally {
      await server.close();
    }
  });
});

describe('client-side limits', () => {
  const address = (n: number) => `user${n}@example.com`;

  it('refuses more than 50 recipients across to, cc and bcc', async () => {
    const to = Array.from({ length: 40 }, (_, i) => address(i));
    const cc = Array.from({ length: 11 }, (_, i) => address(100 + i));
    await expectRefusedLocally({ ...MINIMAL_SEND, to, cc }, /too many recipients: 51/);
  });

  it('allows exactly 50', async () => {
    const server = await startMockServer(reply(202, ACCEPTED));
    const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
    try {
      const to = Array.from({ length: SENDING_LIMITS.MAX_RECIPIENTS }, (_, i) => address(i));
      await expect(client.emails.send({ ...MINIMAL_SEND, to })).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('refuses more than 25 custom headers', async () => {
    const headers = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`X-H-${i}`, 'v']),
    );
    await expectRefusedLocally({ ...MINIMAL_SEND, headers }, /too many custom headers: 26/);
  });

  it('refuses more than 10 tags', async () => {
    const tags = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, 'v']));
    await expectRefusedLocally({ ...MINIMAL_SEND, tags }, /too many tags: 11/);
  });

  it('refuses an over-long tag key or value rather than truncating it', async () => {
    // The server truncates; a silently shortened label produces two tags that
    // look like one in a report.
    await expectRefusedLocally({ ...MINIMAL_SEND, tags: { ['k'.repeat(65)]: 'v' } }, /64/);
    await expectRefusedLocally({ ...MINIMAL_SEND, tags: { k: 'v'.repeat(257) } }, /256/);
  });

  it('refuses a payload over 10 MiB without spending the upload', async () => {
    // 8 MiB of bytes is about 10.7 MiB once base64-encoded.
    const content = Buffer.alloc(8 * 1024 * 1024, 7);
    await expectRefusedLocally(
      { ...MINIMAL_SEND, attachments: [{ filename: 'big.bin', content }] },
      /over the 10485760-byte limit/,
    );
  });
});

describe('the key on the wire', () => {
  it('appears in the Authorization header and nowhere else', async () => {
    const secret = 'nmail_live_needle00000000000000';
    const server = await startMockServer(reply(202, ACCEPTED));
    const client = new Naijamail({
      apiKey: secret,
      baseUrl: server.baseUrl,
      userAgentSuffix: 'acme/1.0',
    });
    try {
      await client.emails.send({ ...MINIMAL_SEND, tags: { campaign: 'receipts' } });

      const request = server.requests[0];
      const carrying = Object.entries(request?.headers ?? {}).filter(([, value]) =>
        String(value).includes('needle00000000000000'),
      );
      expect(carrying.map(([name]) => name)).toEqual(['authorization']);
      expect(request?.url).not.toContain('nmail_');
      expect(request?.body).not.toContain('nmail_');
    } finally {
      await server.close();
    }
  });
});
