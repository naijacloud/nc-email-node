import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError, WebhookVerificationError, verifyWebhook } from '../src/index';

const SECRET = 'nmail_whsec_test0000000000000000';
const PAYLOAD = JSON.stringify({
  type: 'email.delivered',
  data: { id: '5b1e0000-0000-4000-8000-000000000001' },
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(payload: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function header(payload: string, secret = SECRET, timestamp = nowSeconds()): string {
  return `t=${timestamp},v1=${sign(payload, secret, timestamp)}`;
}

describe('verifyWebhook', () => {
  it('accepts a well-signed payload and returns the event', () => {
    const event = verifyWebhook(PAYLOAD, header(PAYLOAD), SECRET);
    expect(event.type).toBe('email.delivered');
    expect(event.data).toEqual({ id: '5b1e0000-0000-4000-8000-000000000001' });
  });

  it('accepts the raw body as a Buffer', () => {
    const raw = Buffer.from(PAYLOAD, 'utf8');
    expect(verifyWebhook(raw, header(PAYLOAD), SECRET).type).toBe('email.delivered');
  });

  it('accepts any of several signatures during a secret rotation', () => {
    const timestamp = nowSeconds();
    const rotating = `t=${timestamp},v1=${sign(PAYLOAD, 'nmail_whsec_old0000000000000000', timestamp)},v1=${sign(PAYLOAD, SECRET, timestamp)}`;
    expect(() => verifyWebhook(PAYLOAD, rotating, SECRET)).not.toThrow();
  });

  it('accepts an upper-case hex signature', () => {
    const timestamp = nowSeconds();
    const upper = `t=${timestamp},v1=${sign(PAYLOAD, SECRET, timestamp).toUpperCase()}`;
    expect(() => verifyWebhook(PAYLOAD, upper, SECRET)).not.toThrow();
  });

  it('rejects a signature made with the wrong secret', () => {
    const forged = header(PAYLOAD, 'nmail_whsec_wrong000000000000000');
    expect(() => verifyWebhook(PAYLOAD, forged, SECRET)).toThrow(WebhookVerificationError);
  });

  it('rejects a payload that was altered after signing', () => {
    const signature = header(PAYLOAD);
    const tampered = PAYLOAD.replace('email.delivered', 'email.bounced');
    expect(() => verifyWebhook(tampered, signature, SECRET)).toThrow(/does not match/);
  });

  it('rejects a body that was re-serialized instead of kept raw', () => {
    // Whitespace and key order are part of the signed bytes; a body that has
    // been through JSON.parse and back will never verify.
    const raw = '{ "type": "email.delivered", "data": {} }';
    const signature = header(raw);
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(() => verifyWebhook(reserialized, signature, SECRET)).toThrow(
      WebhookVerificationError,
    );
    expect(() => verifyWebhook(raw, signature, SECRET)).not.toThrow();
  });

  it('rejects a stale timestamp, which is what stops a replay', () => {
    const old = nowSeconds() - 400;
    expect(() => verifyWebhook(PAYLOAD, header(PAYLOAD, SECRET, old), SECRET)).toThrow(
      /outside the 300s tolerance/,
    );
  });

  it('rejects a timestamp too far in the future', () => {
    const ahead = nowSeconds() + 400;
    expect(() => verifyWebhook(PAYLOAD, header(PAYLOAD, SECRET, ahead), SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it('honours a custom tolerance in both directions', () => {
    const old = nowSeconds() - 400;
    expect(() =>
      verifyWebhook(PAYLOAD, header(PAYLOAD, SECRET, old), SECRET, { tolerance: 600 }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook(PAYLOAD, header(PAYLOAD), SECRET, { tolerance: 0 }),
    ).not.toThrow();
  });

  it.each([
    ['an empty header', ''],
    ['no timestamp', 'v1=abc'],
    ['no signature', `t=${nowSeconds()}`],
    ['a non-numeric timestamp', 't=yesterday,v1=abc'],
    ['unrelated junk', 'sha256=abc'],
  ])('rejects %s', (_label, value) => {
    expect(() => verifyWebhook(PAYLOAD, value, SECRET)).toThrow(WebhookVerificationError);
  });

  it('requires a secret', () => {
    expect(() => verifyWebhook(PAYLOAD, header(PAYLOAD), '')).toThrow(WebhookVerificationError);
  });

  it('never puts the expected signature in the error', () => {
    const timestamp = nowSeconds();
    const expected = sign(PAYLOAD, SECRET, timestamp);
    const error = (() => {
      try {
        verifyWebhook(PAYLOAD, `t=${timestamp},v1=${'0'.repeat(64)}`, SECRET);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).toBeInstanceOf(WebhookVerificationError);
    // Handing an attacker the value they failed to guess turns a rejected
    // forgery into a working one.
    expect(`${error?.message}${error?.stack}`).not.toContain(expected);
  });

  it('reports a well-signed body that is not a JSON object', () => {
    const raw = 'not json at all';
    expect(() => verifyWebhook(raw, header(raw), SECRET)).toThrow(/not valid JSON/);
    const array = '[1,2,3]';
    expect(() => verifyWebhook(array, header(array), SECRET)).toThrow(/not a JSON object/);
  });
});

describe('verifyWebhook tolerance', () => {
  it('refuses a NaN tolerance instead of switching replay protection off', () => {
    // Number(process.env.UNSET) is NaN, and `skew > NaN` is always false.
    const stale = header(PAYLOAD, SECRET, nowSeconds() - 86_400);
    for (const tolerance of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => verifyWebhook(PAYLOAD, stale, SECRET, { tolerance })).toThrow(ValidationError);
    }
  });

  it('still allows a strict zero tolerance', () => {
    const late = header(PAYLOAD, SECRET, nowSeconds() - 5);
    expect(() => verifyWebhook(PAYLOAD, late, SECRET, { tolerance: 0 })).toThrow(
      WebhookVerificationError,
    );
  });
});
