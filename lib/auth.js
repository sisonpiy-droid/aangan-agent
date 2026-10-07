import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Shared secret (dashboard passcode header, Vaani webhook URL key, mid-call tool header). Unset secret = locked.
export const secretOk = (given, expected) => !!expected && !!given && same(given, expected);
