import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { Naijamail, ServerError, ValidationError } from '../src/index';
import {
  ACCEPTED,
  MINIMAL_SEND,
  TEST_KEY,
  type MockServer,
  reply,
  startMockServer,
  type Responder,
} from './support/mock-server';

async function withServer<T>(
  responders: Responder | Responder[],
  run: (client: Naijamail, server: MockServer) => Promise<T>,
): Promise<T> {
  const server = await startMockServer(responders);
  const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl, maxRetries: 0 });
  try {
    return await run(client, server);
  } finally {
    await server.close();
  }
}

describe('emails.send', () => {
  it('returns the queued message', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      const result = await client.emails.send(MINIMAL_SEND);

      expect(result).toEqual({ id: ACCEPTED.id, status: 'queued', rejected: [] });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('POST');
      expect(server.requests[0]?.url).toBe('/v1/emails');
    });
  });

  it('normalises a missing rejected list to an empty array', async () => {
    await withServer(reply(202, { id: 'x1', status: 'queued' }), async (client) => {
      const result = await client.emails.send(MINIMAL_SEND);
      // The wire omits `rejected` when empty; callers should never branch on that.
      expect(result.rejected).toEqual([]);
    });
  });

  it('passes a non-empty rejected list through without treating it as an error', async () => {
    const body = {
      ...ACCEPTED,
      rejected: [{ address: 'x@y.com', reason: 'suppressed' }],
    };
    await withServer(reply(202, body), async (client) => {
      const result = await client.emails.send(MINIMAL_SEND);
      expect(result.rejected).toEqual([{ address: 'x@y.com', reason: 'suppressed' }]);
      expect(result.status).toBe('queued');
    });
  });

  it('sends the documented headers', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send(MINIMAL_SEND);
      const headers = server.requests[0]?.headers ?? {};

      expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);
      expect(headers['content-type']).toBe('application/json');
      expect(headers.accept).toBe('application/json');
      expect(headers['user-agent']).toMatch(/^nc-email-node\/\d+\.\d+\.\d+ \(node\/[^)]+\)$/);
      // The key must not travel anywhere but Authorization.
      expect(headers['user-agent']).not.toContain('nmail_');
    });
  });

  it('appends a user agent suffix', async () => {
    const server = await startMockServer(reply(202, ACCEPTED));
    try {
      const client = new Naijamail({
        apiKey: TEST_KEY,
        baseUrl: server.baseUrl,
        userAgentSuffix: 'acme-billing/2.1',
      });
      await client.emails.send(MINIMAL_SEND);
      expect(server.requests[0]?.headers['user-agent']).toMatch(/ acme-billing\/2\.1$/);
    } finally {
      await server.close();
    }
  });

  it('translates camelCase options into the snake_case wire format', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send({
        from: 'Acme <hello@acme.com>',
        to: 'a@example.com',
        cc: ['b@example.com'],
        bcc: 'c@example.com',
        replyTo: ['support@acme.com'],
        subject: 'Invoice #1024',
        html: '<p>Attached.</p>',
        text: 'Attached.',
        headers: { 'X-Entity-Ref-Id': '1024' },
        tags: { campaign: 'invoices' },
      });

      const body = JSON.parse(server.requests[0]?.body ?? '{}');
      expect(body).toEqual({
        from: 'Acme <hello@acme.com>',
        to: ['a@example.com'],
        cc: ['b@example.com'],
        bcc: ['c@example.com'],
        reply_to: ['support@acme.com'],
        subject: 'Invoice #1024',
        html: '<p>Attached.</p>',
        text: 'Attached.',
        headers: { 'X-Entity-Ref-Id': '1024' },
        tags: { campaign: 'invoices' },
      });
    });
  });

  it('always sends a subject, even when the caller omits one', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send({ from: 'hello@acme.com', to: 'a@example.com' });
      expect(JSON.parse(server.requests[0]?.body ?? '{}').subject).toBe('');
    });
  });

  it('refuses an unknown option and points at the camelCase spelling', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await expect(
        // The wire spelling, which a caller will copy out of the HTTP docs.
        client.emails.send({ ...MINIMAL_SEND, reply_to: 'support@acme.com' } as never),
      ).rejects.toThrow(/replyTo/);
      expect(server.requests).toHaveLength(0);
    });
  });

  it('tolerates an explicitly undefined optional field', async () => {
    await withServer(reply(202, ACCEPTED), async (client) => {
      await expect(
        client.emails.send({ ...MINIMAL_SEND, cc: undefined, text: undefined }),
      ).resolves.toBeDefined();
    });
  });

  it('accepts a status it has never heard of', async () => {
    await withServer(reply(202, { id: 'x1', status: 'quarantined' }), async (client) => {
      const result = await client.emails.send(MINIMAL_SEND);
      // A new server status must not crash an old SDK.
      expect(result.status).toBe('quarantined');
    });
  });

  it('reports an unparseable or incomplete 202 as a server error', async () => {
    await withServer(reply(202, '<html>gateway</html>', { 'content-type': 'text/html' }), async (c) => {
      await expect(c.emails.send(MINIMAL_SEND)).rejects.toThrow(ServerError);
    });
    await withServer(reply(202, { status: 'queued' }), async (client) => {
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toThrow(/"id" is missing/);
    });
  });
});

describe('idempotency', () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('generates a v4 key per call', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send(MINIMAL_SEND);
      expect(server.requests[0]?.headers['idempotency-key']).toMatch(uuidV4);
      // Sending it as a header only: the server gives the header precedence, so
      // a body copy would just be a second value to disagree with.
      expect(JSON.parse(server.requests[0]?.body ?? '{}')).not.toHaveProperty('idempotency_key');
    });
  });

  it('reuses one generated key across all three attempts of a single send', async () => {
    const responders = [reply(500, { statusCode: 500, message: 'boom' }), reply(503, {}), reply(202, ACCEPTED)];
    const server = await startMockServer(responders);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await client.emails.send(MINIMAL_SEND);

      expect(server.requests).toHaveLength(3);
      const keys = server.requests.map((r) => r.headers['idempotency-key']);
      // Without this, a timeout followed by a retry double-mails the customer.
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(uuidV4);
    } finally {
      await server.close();
    }
  });

  it('generates a different key for a different call', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send(MINIMAL_SEND);
      await client.emails.send(MINIMAL_SEND);
      expect(server.requests[0]?.headers['idempotency-key']).not.toBe(
        server.requests[1]?.headers['idempotency-key'],
      );
    });
  });

  it('never regenerates a caller-supplied key', async () => {
    const responders = [reply(500, {}), reply(202, ACCEPTED)];
    const server = await startMockServer(responders);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await client.emails.send({ ...MINIMAL_SEND, idempotencyKey: 'order-1024' });
      expect(server.requests.map((r) => r.headers['idempotency-key'])).toEqual([
        'order-1024',
        'order-1024',
      ]);
    } finally {
      await server.close();
    }
  });

  it('rejects an idempotency key that could break out of the header', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await expect(
        client.emails.send({ ...MINIMAL_SEND, idempotencyKey: 'a\r\nX-Admin: 1' }),
      ).rejects.toThrow(ValidationError);
      await expect(
        client.emails.send({ ...MINIMAL_SEND, idempotencyKey: 'k'.repeat(256) }),
      ).rejects.toThrow(/255/);
      expect(server.requests).toHaveLength(0);
    });
  });
});

describe('attachments', () => {
  const pdf = Buffer.from('%PDF-1.4\n');
  const expected = pdf.toString('base64');

  it('base64-encodes a Buffer, a Uint8Array and an ArrayBuffer alike', async () => {
    const bytes = new Uint8Array(pdf);
    const arrayBuffer = bytes.buffer.slice(0);

    for (const content of [pdf, bytes, arrayBuffer]) {
      await withServer(reply(202, ACCEPTED), async (client, server) => {
        await client.emails.send({
          ...MINIMAL_SEND,
          attachments: [{ filename: 'invoice.pdf', content, contentType: 'application/pdf' }],
        });
        const body = JSON.parse(server.requests[0]?.body ?? '{}');
        expect(body.attachments).toEqual([
          { filename: 'invoice.pdf', content: expected, content_type: 'application/pdf' },
        ]);
      });
    }
  });

  it('encodes only the window a typed array points at', async () => {
    // A Uint8Array can be a view onto a larger buffer; encoding the whole
    // buffer would attach the wrong bytes.
    const backing = Buffer.from('XXXXhello');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 4, 5);

    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send({
        ...MINIMAL_SEND,
        attachments: [{ filename: 'note.txt', content: view }],
      });
      const body = JSON.parse(server.requests[0]?.body ?? '{}');
      expect(Buffer.from(body.attachments[0].content, 'base64').toString()).toBe('hello');
    });
  });

  it('accepts pre-encoded base64 only when the caller says so', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await client.emails.send({
        ...MINIMAL_SEND,
        attachments: [
          // Line-wrapped base64 is legal and must survive.
          { filename: 'a.txt', content: `${expected.slice(0, 4)}\n${expected.slice(4)}`, encoding: 'base64' },
        ],
      });
      const body = JSON.parse(server.requests[0]?.body ?? '{}');
      expect(body.attachments[0].content).toBe(expected);
    });
  });

  it('never reads a file path, and says so', async () => {
    await withServer(reply(202, ACCEPTED), async (client, server) => {
      await expect(
        client.emails.send({
          ...MINIMAL_SEND,
          attachments: [{ filename: 'a.pdf', content: '/etc/passwd' } as never],
        }),
      ).rejects.toThrow(/File paths are never read/);
      expect(server.requests).toHaveLength(0);
    });
  });

  it('refuses content that is not really base64', async () => {
    await withServer(reply(202, ACCEPTED), async (client) => {
      await expect(
        client.emails.send({
          ...MINIMAL_SEND,
          attachments: [{ filename: 'a.pdf', content: '!!!garbage!!!', encoding: 'base64' }],
        }),
      ).rejects.toThrow(/not valid base64/);
    });
  });

  it('refuses content that is neither bytes nor a string', async () => {
    await withServer(reply(202, ACCEPTED), async (client) => {
      await expect(
        client.emails.send({
          ...MINIMAL_SEND,
          attachments: [{ filename: 'a.pdf', content: { path: 'a.pdf' } } as never],
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('points a caller at the camelCase attachment fields', async () => {
    await withServer(reply(202, ACCEPTED), async (client) => {
      await expect(
        client.emails.send({
          ...MINIMAL_SEND,
          attachments: [{ filename: 'a.pdf', content: pdf, content_type: 'application/pdf' } as never],
        }),
      ).rejects.toThrow(/contentType/);
    });
  });
});
