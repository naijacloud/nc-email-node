/**
 * Receiving webhooks in express.
 *
 * Note: Naija Cloud does not emit customer-facing webhooks yet. The signature
 * scheme is fixed and this verifier implements it, but do not build a
 * production flow on it until the feature is announced.
 *
 * Run: npm i express tsx
 *      NAIJAMAIL_WEBHOOK_SECRET=nmail_whsec_… npx tsx examples/webhook-express.ts
 */
import express from 'express';
import { WebhookVerificationError, verifyWebhook } from '@naijacloud/email';

const secret = process.env.NAIJAMAIL_WEBHOOK_SECRET;
if (!secret) throw new Error('set NAIJAMAIL_WEBHOOK_SECRET');

const app = express();

app.post(
  '/webhooks/naijamail',
  // express.raw, not express.json. The signature covers the exact bytes that
  // arrived; a body that has been through JSON.parse and back has had its
  // whitespace, key order and unicode escaping rewritten and will never verify.
  // Mount this before any global json() middleware.
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      const event = verifyWebhook(req.body, req.get('NC-Signature') ?? '', secret);

      // Verified: this really came from Naija Cloud and is not a replay.
      console.log(`${event.type}`, event.data);

      // Answer immediately and do the work elsewhere. A slow handler looks like
      // a failed delivery to the sender and earns a redelivery you did not want.
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        // A bad signature or a stale timestamp. Do not echo the reason back —
        // a prober should learn nothing from the response.
        console.warn(`rejected webhook: ${error.message}`);
        res.sendStatus(400);
        return;
      }
      throw error;
    }
  },
);

app.listen(3000, () => console.log('listening on http://localhost:3000'));
