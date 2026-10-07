import { createHmac, timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Shared secret header (dashboard passcode, mid-call tool secret). Unset secret = locked.
export const secretOk = (given, expected) => !!expected && !!given && same(given, expected);

// Vaani: X-VaaniYantra-Signature: sha256=<hex HMAC-SHA256 of the raw body>
export const vaaniSignatureOk = (raw, header, secret) =>
  !!secret && !!header && same(header, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
