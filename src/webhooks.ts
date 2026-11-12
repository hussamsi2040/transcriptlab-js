import type { WebhookEvent } from './types.js';

export interface VerifyWebhookOptions {
  /** Exact raw request body — do not parse then re-stringify JSON. `Buffer` is a `Uint8Array` and works. */
  rawBody: string | Uint8Array;
  /** `X-YTGW-Signature` header value, format `t=<unix-seconds>,v1=<hex-hmac>`. */
  signature: string;
  /** The `webhook_secret` returned once in the job submission response. */
  secret: string;
  /** Max accepted age of the timestamp. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Clock override for tests. Default `Date.now()`. */
  nowMs?: number;
}

/**
 * Verify a TranscriptLab job webhook and return the parsed event.
 *
 * The signature is `HMAC-SHA256(secret, "<t>.<rawBody>")` compared in constant
 * time. Throws `Error` on a malformed header, stale timestamp, or bad
 * signature — treat any throw as a rejected delivery.
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<WebhookEvent> {
  const { rawBody, signature, secret } = options;
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowMs ?? Date.now();

  const parsed = parseSignatureHeader(signature);
  if (parsed === null) {
    throw new Error('Malformed X-YTGW-Signature header');
  }
  const { timestamp, hex } = parsed;

  const age = Math.abs(now / 1000 - timestamp);
  if (age > tolerance) {
    throw new Error(`Webhook timestamp outside ${tolerance}s tolerance`);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix, 0);
  payload.set(body, prefix.length);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));

  const actual = hexToBytes(hex);
  if (!constantTimeEqual(actual, expected)) {
    throw new Error('Invalid webhook signature');
  }

  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  return JSON.parse(text) as WebhookEvent;
}

function parseSignatureHeader(header: string): { timestamp: number; hex: string } | null {
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = value;
    if (key === 'v1') v1 = value;
  }
  if (t === undefined || v1 === undefined) return null;
  const timestamp = Number(t);
  if (!Number.isFinite(timestamp) || !/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { timestamp, hex: v1 };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time equality over equal-length-or-not byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}
