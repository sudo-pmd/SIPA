// Stockage : SQLite embarquée (node:sqlite), sans dépendance native.
// Les données de santé ne sont jamais stockées en clair : cipher_payload / iv.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { FACILITIES, STAFF } from './seed-data.js';
import { sha256hex, randomHex } from './crypto.js';

const DATA_DIR = path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.SIPA_DB ?? path.join(DATA_DIR, 'sipa.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  sipa_code        TEXT UNIQUE NOT NULL,
  phone_hash       TEXT UNIQUE NOT NULL,
  phone_enc        TEXT NOT NULL,
  pseudonym        TEXT NOT NULL,
  pin_hash         TEXT,
  pin_salt         TEXT,
  dek_wrapped      TEXT,
  dek_iv           TEXT,
  dek_salt         TEXT,
  dek_server       TEXT,
  dek_bio          TEXT,
  webauthn         TEXT,
  preferred_lang   TEXT DEFAULT 'fr',
  failed_attempts  INTEGER DEFAULT 0,
  locked_until     TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facilities (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('CENTRE_4EN1','PHARMACIE','ESPACE_ECOUTE')),
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  commune          TEXT NOT NULL,
  city             TEXT NOT NULL,
  address          TEXT NOT NULL,
  opening_hours    TEXT NOT NULL,
  phone            TEXT,
  supports_arv_relay INTEGER DEFAULT 0,
  is_active        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pharmacy_stocks (
  facility_id      TEXT PRIMARY KEY REFERENCES facilities(id),
  available_qty    INTEGER NOT NULL CHECK (available_qty >= 0),
  reserved_qty     INTEGER NOT NULL CHECK (reserved_qty >= 0),
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  facility_id      TEXT NOT NULL REFERENCES facilities(id),
  pass_code        TEXT UNIQUE NOT NULL,
  couple_link_code TEXT,
  category         TEXT NOT NULL CHECK (category IN ('BILAN_4EN1','PRENUPTIAL','CPN_MATERNITE')),
  slot_at          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','COMPLETED','CANCELLED')),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_slot ON appointments(facility_id, slot_at);

CREATE TABLE IF NOT EXISTS health_results (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  appointment_id   TEXT,
  cipher_payload   TEXT NOT NULL,
  iv               TEXT NOT NULL,
  has_alert        INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers_qr (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  facility_id      TEXT NOT NULL REFERENCES facilities(id),
  kind             TEXT NOT NULL CHECK (kind IN ('AUTOTEST','ARV_PARCEL')),
  parcel_id        TEXT,
  totp_secret      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  used_at          TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arv_parcels (
  id               TEXT PRIMARY KEY,
  tracking_code    TEXT UNIQUE NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  origin_center_id TEXT NOT NULL REFERENCES facilities(id),
  pharmacy_id      TEXT NOT NULL REFERENCES facilities(id),
  status           TEXT NOT NULL DEFAULT 'PREPARED'
                     CHECK (status IN ('PREPARED','IN_TRANSIT','AT_PHARMACY','DELIVERED')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_escalations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  counselor_id     TEXT,
  reason           TEXT NOT NULL
                     CHECK (reason IN ('REACTIVE_TEST','PTME_PREGNANCY','COUPLE_SUPPORT','OTHER')),
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED')),
  created_at       TEXT NOT NULL,
  closed_at        TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  escalation_id    TEXT,
  author           TEXT NOT NULL CHECK (author IN ('USER','BOT','COUNSELOR','SYSTEM')),
  body             TEXT NOT NULL,
  channel          TEXT DEFAULT 'PWA',
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  read_at          TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS selftest_reports (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  voucher_id       TEXT,
  result           TEXT NOT NULL CHECK (result IN ('NEGATIF','POSITIF','NON_FAIT')),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id               TEXT PRIMARY KEY,
  email            TEXT UNIQUE NOT NULL,
  password_hash    TEXT NOT NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL
                     CHECK (role IN ('PHARMACIE','LAB','ARV_COORD','COUNSELOR')),
  facility_id      TEXT NOT NULL REFERENCES facilities(id),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id               TEXT PRIMARY KEY,
  actor            TEXT,
  action           TEXT NOT NULL,
  target           TEXT,
  detail           TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key              TEXT PRIMARY KEY,
  value            TEXT
);
`;

let db;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  seedStatic(db);
  return db;
}

function seedStatic(conn) {
  const count = conn.prepare('SELECT COUNT(*) AS n FROM facilities').get().n;
  if (count > 0) return;
  const now = new Date().toISOString();
  const insertFacility = conn.prepare(
    `INSERT INTO facilities (id,name,type,lat,lng,commune,city,address,opening_hours,phone,supports_arv_relay,is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`
  );
  const insertStock = conn.prepare(
    `INSERT INTO pharmacy_stocks (facility_id,available_qty,reserved_qty,updated_at) VALUES (?,?,0,?)`
  );
  for (const f of FACILITIES) {
    insertFacility.run(
      f.id,
      f.name,
      f.type,
      f.lat,
      f.lng,
      f.commune,
      f.city,
      f.address,
      JSON.stringify(f.hours),
      f.phone ?? null,
      f.supports_arv_relay ? 1 : 0
    );
    if (f.type === 'PHARMACIE') insertStock.run(f.id, f.stock ?? 0, now);
  }
  const insertStaff = conn.prepare(
    `INSERT INTO staff (id,email,password_hash,name,role,facility_id,created_at) VALUES (?,?,?,?,?,?,?)`
  );
  for (const s of STAFF) {
    const salt = randomHex(8);
    insertStaff.run(
      `staff-${s.email.split('@')[0]}`,
      s.email,
      `${salt}:${sha256hex(salt + s.password)}`,
      s.name,
      s.role,
      s.facility_id,
      now
    );
  }
}

export function audit(actor, action, target = null, detail = null) {
  const conn = getDb();
  conn
    .prepare('INSERT INTO audit_log (id,actor,action,target,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomHex(12), actor, action, target, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}
