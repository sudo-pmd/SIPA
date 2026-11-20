// TOTP côté navigateur (RFC 6238, pas de 60 s) — permet d'afficher un pass
// tournant même sans connexion.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | B32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

const subtle = () => globalThis.crypto?.subtle;

async function hmacSha1(keyBytes, messageBytes) {
  const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await subtle().sign('HMAC', key, messageBytes);
  return new Uint8Array(sig);
}

export async function totp(secret, { period = 60, digits = 6, at = Date.now() } = {}) {
  if (!subtle()) return '------';
  const counter = Math.floor(at / (period * 1000));
  const msg = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const hash = await hmacSha1(base32Decode(secret), msg);
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    (((hash[offset] & 0x7f) << 24) |
      (hash[offset + 1] << 16) |
      (hash[offset + 2] << 8) |
      hash[offset + 3]) %
    10 ** digits;
  return String(code).padStart(digits, '0');
}

export function secondsLeft(period = 60) {
  return period - (Math.floor(Date.now() / 1000) % period);
}
