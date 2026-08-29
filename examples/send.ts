/**
 * The minimal send.
 *
 * Run: NAIJAMAIL_API_KEY=nmail_live_… npx tsx examples/send.ts
 */
import { Naijamail } from '@naijacloud/email';

const nm = new Naijamail(process.env.NAIJAMAIL_API_KEY);

const { id, status, rejected } = await nm.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'customer@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
});

console.log(`queued ${id} (${status})`);

// Always an array, so there is nothing to null-check. A non-empty one is not a
// failure: those addresses are on the suppression list, the rest still went.
if (rejected.length) {
  for (const recipient of rejected) {
    console.warn(`not sent to ${recipient.address}: ${recipient.reason}`);
  }
}

// The id is ours and stays stable across a delivery-backend change, so it is
// safe to store next to your own order or invoice record.
const email = await nm.emails.get(id);
console.log(`${email.to} is ${email.status}, created ${email.createdAt}`);
