import { describe, expect, it } from 'vitest';
import {
  RETRY_AFTER_MAX_MS,
  RETRY_CAP_MS,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  retryDelay,
} from '../src/retry';
import { Naijamail, PermissionError, ServerError } from '../src/index';
import {
  ACCEPTED,
  MINIMAL_SEND,
  TEST_KEY,
  hangUp,
  neverRespond,
  reply,
  startMockServer,
} from './support/mock-server';

describe('retry policy', () => {
  it('retries only the statuses the contract lists', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [200, 202, 301, 400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('uses full jitter, bounded by an exponential cap', () => {
    // random() at its extremes: the whole interval is random, not a fixed
    // delay with noise added.
    expect(backoffDelay(0, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 0.999999)).toBeLessThan(500);
    expect(backoffDelay(1, () => 0.999999)).toBeLessThan(1_000);
    expect(backoffDelay(2, () => 0.999999)).toBeLessThan(2_000);
    expect(backoffDelay(20, () => 0.999999)).toBeLessThan(RETRY_CAP_MS);
  });
});

describe('Retry-After', () => {
  it('reads an integer number of seconds', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z');
    expect(parseRetryAfter('Sat, 29 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
  });

  it('treats a date in the past as "retry now"', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z');
    expect(parseRetryAfter('Sat, 29 Aug 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('ignores a header it cannot make sense of', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('overrides the computed backoff, clamped to a minute', () => {
    expect(retryDelay(0, 5_000)).toBe(5_000);
    // A proxy asking for an hour must not park the caller's request for one.
    expect(retryDelay(0, 3_600_000)).toBe(RETRY_AFTER_MAX_MS);
    expect(RETRY_AFTER_MAX_MS).toBe(60_000);
  });
});

describe('retrying real requests', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const server = await startMockServer([reply(500, {}), reply(202, ACCEPTED)]);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await expect(client.emails.send(MINIMAL_SEND)).resolves.toMatchObject({ id: ACCEPTED.id });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('gives up after three attempts by default', async () => {
    const server = await startMockServer(reply(503, { statusCode: 503, message: 'unavailable' }));
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toThrow(ServerError);
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it('makes exactly one attempt when retries are switched off', async () => {
    const server = await startMockServer(reply(500, {}));
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl, maxRetries: 0 });
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toThrow(ServerError);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('honours Retry-After given in seconds', async () => {
    const server = await startMockServer([
      reply(429, { statusCode: 429, message: 'Too many requests' }, { 'retry-after': '1' }),
      reply(202, ACCEPTED),
    ]);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      const started = Date.now();
      await client.emails.send(MINIMAL_SEND);
      const elapsed = Date.now() - started;

      expect(server.requests).toHaveLength(2);
      // Jittered backoff alone would very probably be shorter than this.
      expect(elapsed).toBeGreaterThanOrEqual(950);
    } finally {
      await server.close();
    }
  });

  it('honours Retry-After given as an HTTP date', async () => {
    const when = new Date(Date.now() + 1_200).toUTCString();
    const server = await startMockServer([
      reply(429, { statusCode: 429, message: 'Too many requests' }, { 'retry-after': when }),
      reply(202, ACCEPTED),
    ]);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      const started = Date.now();
      await client.emails.send(MINIMAL_SEND);

      expect(server.requests).toHaveLength(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      await server.close();
    }
  });

  it.each([
    [400, { statusCode: 400, message: '"to" is required' }],
    [403, { statusCode: 403, message: 'not allowed to send from "x@y.com".' }],
    [401, { statusCode: 401, message: 'invalid API key' }],
    [422, { statusCode: 422, message: 'unprocessable' }],
  ])('never retries a %i', async (status, body) => {
    const server = await startMockServer(reply(status, body));
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toThrow();
      // A 403 on an unverified domain will never succeed on a second attempt.
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('surfaces the last error, not a generic one, when retries run out', async () => {
    const server = await startMockServer(reply(403, { statusCode: 403, message: 'nope' }));
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await expect(client.emails.send(MINIMAL_SEND)).rejects.toBeInstanceOf(PermissionError);
    } finally {
      await server.close();
    }
  });

  it('retries a dropped connection', async () => {
    const server = await startMockServer([hangUp, hangUp, reply(202, ACCEPTED)]);
    try {
      const client = new Naijamail({ apiKey: TEST_KEY, baseUrl: server.baseUrl });
      await expect(client.emails.send(MINIMAL_SEND)).resolves.toMatchObject({ id: ACCEPTED.id });
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it('retries a timed-out attempt with a fresh deadline', async () => {
    const server = await startMockServer([neverRespond, reply(202, ACCEPTED)]);
    try {
      const client = new Naijamail({
        apiKey: TEST_KEY,
        baseUrl: server.baseUrl,
        timeout: 200,
        maxRetries: 1,
      });
      // The second attempt gets its own 200ms, not what was left of the first.
      await expect(client.emails.send(MINIMAL_SEND)).resolves.toMatchObject({ id: ACCEPTED.id });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});
