/**
 * What to do with each failure.
 *
 * Run: NAIJAMAIL_API_KEY=nmail_live_… npx tsx examples/error-handling.ts
 */
import {
  AuthenticationError,
  ConnectionError,
  Naijamail,
  NaijamailError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '@naijacloud/email';

const nm = new Naijamail(process.env.NAIJAMAIL_API_KEY);

try {
  await nm.emails.send({
    from: 'Acme <hello@acme.com>',
    to: 'customer@example.com',
    subject: 'Your receipt',
    html: '<p>Thanks for your order.</p>',
  });
} catch (error) {
  // The SDK has already retried anything worth retrying — 429, 408, 5xx and
  // connection failures, three attempts with jittered backoff — so an error
  // arriving here is one your code has to decide about.
  if (error instanceof ValidationError) {
    // Also raised locally, before any request, with statusCode 0: a bad
    // address, a CRLF in a subject, a payload over 10 MiB.
    console.error(`bad request: ${error.message}`);
  } else if (error instanceof AuthenticationError) {
    console.error('the key is missing, revoked or wrong — check NAIJAMAIL_API_KEY');
  } else if (error instanceof PermissionError) {
    // A test key on the live path, an unverified domain, or the daily quota.
    // Retrying will not help; a human has to change something.
    console.error(`not allowed: ${error.message}`);
  } else if (error instanceof NotFoundError) {
    console.error('no such message for this team');
  } else if (error instanceof RateLimitError) {
    // Retries are already exhausted at this point; queue it rather than loop.
    console.error(`rate limited; the server asked for ${error.retryAfter ?? 'some'} seconds`);
  } else if (error instanceof TimeoutError || error instanceof ConnectionError) {
    // Safe to try again later: every attempt of one send() carries the same
    // idempotency key, so a message the server already accepted is not sent twice.
    console.error(`could not reach Naijamail: ${error.message}`);
  } else if (error instanceof ServerError) {
    console.error(`Naijamail failed: ${error.message} (request ${error.requestId ?? 'unknown'})`);
  } else if (error instanceof NaijamailError) {
    // One base class, so this branch cannot be forgotten into a crash.
    console.error(`unexpected API error ${error.statusCode}: ${error.message}`);
  } else {
    throw error;
  }
}

// Retrieving an id that does not exist raises NotFoundError, even though the
// server answers 400 for it today.
try {
  await nm.emails.get('00000000-0000-4000-8000-000000000000');
} catch (error) {
  if (error instanceof NotFoundError) console.log('no such message, as expected');
  else throw error;
}
