// Primitives cryptographiques du prototype SIPA.
// AES-256-GCM pour les données de santé, PBKDF2 pour le PIN, TOTP (RFC 6238)
// pour les pass tournants, JWT HS256 pour les sessions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET_FILE = path.join(DATA_DIR, '.secret');
let SECRET;
if (fs.existsSync(SECRET_FILE)) {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  SECRET = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

export const MASTER_KEY = crypto.createHash('sha256').update(SECRET).digest();

export function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomDigits(length = 6) {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10).toString();
  return out;
}

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ23456789';
export function randomCode(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return out;
}

// ---------------------------------------------------------------- JWT (HS256)
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, ttlSeconds = 3600) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

// -------------------------------------------------------------- Dérivation PIN
export function deriveKey(password, saltB64, iterations, length = 32) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(saltB64, 'base64'), iterations, length, 'sha256');
}

export function newSalt() {
  return crypto.randomBytes(16).toString('base64');
}

// --------------------------------------------------------- AES-256-GCM scellé
export function sealGcm(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), data: Buffer.concat([enc, tag]).toString('base64') };
}

export function openGcm(key, ivB64, dataB64) {
  const raw = Buffer.from(dataB64, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const enc = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function sealWithMaster(value) {
  return sealGcm(MASTER_KEY, JSON.stringify(value));
}

export function openWithMaster(sealed) {
  return JSON.parse(openGcm(MASTER_KEY, sealed.iv, sealed.data));
}

// ------------------------------------------------------------------- Base32 / TOTP
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomBase32(length = 32) {
  let out = '';
  for (let i = 0; i < length; i++) out += B32[crypto.randomInt(0, 32)];
  return out;
}

export function base32Decode(input) {
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
  return Buffer.from(bytes);
}

export const TOTP_PERIOD = 60;

export function totp(secretB32, { period = TOTP_PERIOD, digits = 6, at = Date.now() } = {}) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(at / (period * 1000));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    10 ** digits;
  return String(code).padStart(digits, '0');
}

export function verifyTotp(secretB32, code, { period = TOTP_PERIOD, window = 1 } = {}) {
  const clean = String(code ?? '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  for (let i = -window; i <= window; i++) {
    if (totp(secretB32, { period, at: Date.now() + i * period * 1000 }) === clean) return true;
  }
  return false;
}

export function secondsToNextStep(period = TOTP_PERIOD) {
  return period - (Math.floor(Date.now() / 1000) % period);
}

// ------------------------------------------------------------------- Téléphone
export function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith('7')) digits = `221${digits}`;
  return `+${digits}`;
}

export function isValidPhone(raw) {
  const phone = normalizePhone(raw);
  return /^\+\d{9,15}$/.test(phone);
}

export function phoneHash(raw) {
  return hmacHex(MASTER_KEY, normalizePhone(raw));
}

export function maskPhone(raw) {
  const phone = normalizePhone(raw);
  return `${phone.slice(0, 4)} •• •• ${phone.slice(-2)}`;
}
