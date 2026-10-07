import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NaijamailError,
  Naijamail,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../src/index';
import {
  MINIMAL_SEND,
  TEST_KEY,
  neverRespond,
  reply,
  startMockServer,
} from './support/mock-server';

async function sendAndCatch(
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<NaijamailError> {
  const server = await startMockServer(reply(status, body, headers));
  const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl, maxRetries: 0 });
  try {
    await client.emails.send(MINIMAL_SEND);
    throw new Error(`expected ${status} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(NaijamailError);
    return error as NaijamailError;
  } finally {
    await server.close();
  }
}

const envelope = (statusCode: number, message: unknown, label?: string) => ({
  statusCode,
  message,
  ...(label ? { error: label } : {}),
});

describe('status to error type', () => {
  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, NotFoundError],
    [408, TimeoutError],
    [409, ConflictError],
    // The body parser refusing an oversized request: the caller's input.
    [413, ValidationError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ServerError],
    [502, ServerError],
    [503, ServerError],
  ] as const)('maps %i', async (status, type) => {
    const error = await sendAndCatch(status, envelope(status, 'nope'));
    expect(error).toBeInstanceOf(type);
    expect(error.statusCode).toBe(status);
    expect(error.message).toBe('nope');
  });

  it.each([405, 415, 451])('maps an unlisted 4xx (%i) to ValidationError, as every SDK does', async (status) => {
    const error = await sendAndCatch(status, envelope(status, 'no'));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(status);
  });

  it('does not retry an unlisted 4xx', async () => {
    const server = await startMockServer(reply(405, envelope(405, 'no')));
    const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
    try {
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toThrow(ValidationError);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('gives every error class its own name', async () => {
    const error = await sendAndCatch(403, envelope(403, 'nope', 'Forbidden'));
    expect(error.name).toBe('PermissionError');
    expect(error.error).toBe('Forbidden');
  });
});

describe('error envelope', () => {
  it('joins an array of messages', async () => {
    const error = await sendAndCatch(400, envelope(400, ['"to" is required', 'from is invalid']));
    expect(error.message).toBe('"to" is required; from is invalid');
  });

  it('falls back to the status line when the body is not JSON', async () => {
    const error = await sendAndCatch(502, '<html><body>Bad Gateway</body></html>', {
      'content-type': 'text/html',
    });
    expect(error).toBeInstanceOf(ServerError);
    expect(error.message).toMatch(/^HTTP 502/);
    // Raw text always; no parsed body when it was not JSON.
    expect(error.rawBody).toBe('<html><body>Bad Gateway</body></html>');
    expect(error.body).toBeUndefined();
  });

  it('survives a completely empty body', async () => {
    const error = await sendAndCatch(500, undefined);
    expect(error.message).toMatch(/^HTTP 500/);
  });

  it('carries the request id from the response header', async () => {
    const error = await sendAndCatch(403, envelope(403, 'nope'), {
      'x-request-id': 'req_01J8Z2',
    });
    expect(error.requestId).toBe('req_01J8Z2');
  });

  it('exposes the parsed body for debugging', async () => {
    const body = envelope(403, 'not allowed to send from "x@y.com". Verify the domain first.', 'Forbidden');
    const error = await sendAndCatch(403, body);
    expect(error.body).toEqual(body);
    expect(error.rawBody).toBe(JSON.stringify(body));
  });

  it('reports the Retry-After seconds on a rate limit', async () => {
    const error = await sendAndCatch(429, envelope(429, 'Too many requests'), {
      'retry-after': '42',
    });
    expect((error as RateLimitError).retryAfter).toBe(42);
  });

  it('clamps the reported Retry-After to the same 60 seconds the retry loop honours', async () => {
    const error = await sendAndCatch(429, envelope(429, 'Too many requests'), {
      'retry-after': '3600',
    });
    expect((error as RateLimitError).retryAfter).toBe(60);
  });

  it('never leaks the key into an error', async () => {
    const secret = 'nmail_live_needle00000000000000';
    const server = await startMockServer(reply(401, envelope(401, 'invalid API key')));
    const client = new Naijamail({ apiKey: secret, baseUrl: server.baseUrl, maxRetries: 0 });
    try {
      const error = (await client.emails.send(MINIMAL_SEND).catch((e: unknown) => e)) as Error;
      expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(
        'needle00000000000000',
      );
    } finally {
      await server.close();
    }
  });
});

describe('redirects', () => {
  it('refuses a 3xx instead of following it', async () => {
    const server = await startMockServer(
      reply(302, undefined, { location: 'https://evil.example.com/v1/emails' }),
    );
    const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
    try {
      const error = await client.emails.send(MINIMAL_SEND).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).message).toMatch(/unexpected redirect/);
      expect((error as ServerError).statusCode).toBe(302);
      // Following it would re-send the Authorization header to another host,
      // and retrying it would only produce the same redirect.
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('transport failures', () => {
  it('raises ConnectionError when nothing is listening', async () => {
    const server = await startMockServer(reply(202, {}));
    const baseUrl = server.baseUrl;
    await server.close();

    const client = new Naijamail({ apiKey: TEST_KEY, baseUrl, maxRetries: 0 });
    const error = await client.emails.send(MINIMAL_SEND).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).statusCode).toBe(0);
  });

  it('raises TimeoutError when the server never answers', async () => {
    const server = await startMockServer(neverRespond);
    const client = new Naijamail({
      apiKey: TEST_KEY,
      baseUrl: server.baseUrl,
      timeout: 150,
      maxRetries: 0,
    });
    try {
      const error = await client.emails.send(MINIMAL_SEND).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).message).toMatch(/timed out after 150ms/);
    } finally {
      await server.close();
    }
  });
});
