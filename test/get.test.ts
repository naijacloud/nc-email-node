import { describe, expect, it } from 'vitest';
import { Naijamail, NotFoundError, ValidationError } from '../src/index';
import { TEST_KEY, type MockServer, reply, startMockServer, type Responder } from './support/mock-server';

const DELIVERED = {
  id: '5b1e0000-0000-4000-8000-000000000001',
  to: 'x@y.com',
  from: 'hello@acme.com',
  subject: 'Hi',
  status: 'delivered',
  created_at: '2026-08-29T10:00:00.000Z',
  delivered_at: '2026-08-29T10:00:04.000Z',
  opened: false,
  clicked: false,
};

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

describe('emails.get', () => {
  it('maps the record into camelCase', async () => {
    await withServer(reply(200, DELIVERED), async (client, server) => {
      const email = await client.emails.get(DELIVERED.id);

      expect(email).toEqual({
        id: DELIVERED.id,
        to: 'x@y.com',
        from: 'hello@acme.com',
        subject: 'Hi',
        status: 'delivered',
        createdAt: '2026-08-29T10:00:00.000Z',
        deliveredAt: '2026-08-29T10:00:04.000Z',
        opened: false,
        clicked: false,
        sandbox: false,
      });
      expect(server.requests[0]?.method).toBe('GET');
      expect(server.requests[0]?.url).toBe(`/v1/emails/${DELIVERED.id}`);
      // No body, so no Content-Type to mislabel it with.
      expect(server.requests[0]?.headers['content-type']).toBeUndefined();
    });
  });

  it('leaves deliveredAt null until delivery, and omits failureReason until failure', async () => {
    await withServer(
      reply(200, { ...DELIVERED, status: 'queued', delivered_at: null }),
      async (client) => {
        const email = await client.emails.get(DELIVERED.id);
        expect(email.deliveredAt).toBeNull();
        expect(email.failureReason).toBeUndefined();
        expect('failureReason' in email).toBe(false);
      },
    );
  });

  it('surfaces failure_reason when the message failed', async () => {
    await withServer(
      reply(200, { ...DELIVERED, status: 'bounced', failure_reason: 'mailbox full' }),
      async (client) => {
        const email = await client.emails.get(DELIVERED.id);
        expect(email.status).toBe('bounced');
        expect(email.failureReason).toBe('mailbox full');
      },
    );
  });

  it('maps the server 400 "message not found" onto NotFoundError', async () => {
    const body = { statusCode: 400, message: 'message not found', error: 'Bad Request' };
    await withServer(reply(400, body), async (client) => {
      // A documented server quirk: the retrieve endpoint answers 400, not 404.
      const error = await client.emails.get('missing').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).statusCode).toBe(400);
    });
  });

  it('leaves any other 400 as a validation error', async () => {
    const body = { statusCode: 400, message: 'invalid input syntax for type uuid', error: 'Bad Request' };
    await withServer(reply(400, body), async (client) => {
      const error = await client.emails.get('nope').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).not.toBeInstanceOf(NotFoundError);
    });
  });

  it('encodes the id into the path instead of interpolating it', async () => {
    await withServer(reply(200, DELIVERED), async (client, server) => {
      await client.emails.get('../../v1/admin');
      // An id is a value. Unencoded it is a path-traversal primitive with a
      // live key attached.
      expect(server.requests[0]?.url).toBe('/v1/emails/..%2F..%2Fv1%2Fadmin');
    });
  });

  it('refuses an empty id and a newline in an id before any request', async () => {
    await withServer(reply(200, DELIVERED), async (client, server) => {
      await expect(client.emails.get('')).rejects.toThrow(ValidationError);
      await expect(client.emails.get('   ')).rejects.toThrow(ValidationError);
      await expect(client.emails.get('abc\r\n')).rejects.toThrow(ValidationError);
      expect(server.requests).toHaveLength(0);
    });
  });
});

describe('sandbox messages', () => {
  it('exposes the sandbox flag so a simulated bounce is not mistaken for a real one', async () => {
    await withServer(
      reply(200, { ...DELIVERED, status: 'bounced', sandbox: true }),
      async (client) => {
        const email = await client.emails.get(DELIVERED.id);
        expect(email.sandbox).toBe(true);
      },
    );
  });

  it('reads an absent flag as false', async () => {
    await withServer(reply(200, DELIVERED), async (client) => {
      expect((await client.emails.get(DELIVERED.id)).sandbox).toBe(false);
    });
  });
});
