import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A real HTTP server on 127.0.0.1, bound to port 0.
 *
 * `fetch` is never stubbed anywhere in this suite. Mocking it would test the
 * mock: the things most likely to be wrong in an HTTP client — a header that
 * undici refuses, a redirect that gets followed, a body read that races the
 * abort — only show up against a socket. Port 0 lets the kernel pick a free
 * port, so the suite runs in parallel and needs no network.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Responder = (request: RecordedRequest, response: ServerResponse) => void;

export interface MockServer {
  /** e.g. `http://127.0.0.1:53124` — loopback, so the https rule permits it. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Responders are consumed one per request; the last one repeats, which is what
 * a "always fails" server looks like.
 */
export async function startMockServer(
  responders: Responder | Responder[],
): Promise<MockServer> {
  const queue = Array.isArray(responders) ? responders : [responders];
  const requests: RecordedRequest[] = [];
  // Tracked so close() can destroy them: a responder that deliberately never
  // answers (the timeout tests) would otherwise keep server.close() pending
  // and hang the whole file.
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);

      const responder = queue[Math.min(requests.length - 1, queue.length - 1)];
      responder?.(record, res);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Respond with JSON (or a literal string body, for the non-JSON cases). */
export function reply(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Responder {
  return (_request, response) => {
    const payload =
      body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(payload);
  };
}

/** Accepts the request and never answers — for the client-side deadline tests. */
export const neverRespond: Responder = () => {
  /* deliberately empty */
};

/** Drops the connection mid-request, which is what a DNS/TCP-class failure looks like to fetch. */
export const hangUp: Responder = (_request, response) => {
  response.socket?.destroy();
};

/** The literal test key from SDK-CONTRACT.md §8. Never a real one. */
export const TEST_KEY = 'nmail_live_test0000000000000000';

export const ACCEPTED = { id: '5b1e0000-0000-4000-8000-000000000001', status: 'queued' };

export const MINIMAL_SEND = {
  from: 'Acme <hello@acme.com>',
  to: 'customer@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
} as const;
