// Logique métier SIPA : comptes pseudonymisés, coffre-fort scellé,
// rendez-vous, pass TOTP, colis ARV, notifications neutres.
import {
  deriveKey,
  newSalt,
  randomCode,
  randomDigits,
  randomHex,
  randomBase32,
  sealGcm,
  openGcm,
  sealWithMaster,
  openWithMaster,
  totp,
  verifyTotp,
  normalizePhone,
  phoneHash,
  maskPhone,
  TOTP_PERIOD,
} from './crypto.js';
import { getDb, audit } from './db.js';

export const PIN_ITERATIONS = 120_000;
export const DEK_ITERATIONS = 200_000;
export const AUTOTEST_LOCK_HOURS = 24;
export const NEUTRAL_TITLE = 'SIPA : nouvelle information';
export const NEUTRAL_BODY = 'Une nouvelle information est disponible dans votre espace personnel.';

export const now = () => new Date().toISOString();
export const uid = (prefix = '') => `${prefix}${randomHex(12)}`;

// ------------------------------------------------------------------ Comptes
function generateSipaCode() {
  const conn = getDb();
  for (let i = 0; i < 40; i++) {
    const code = `SIPA-${randomCode(4)}-SN`;
    if (!conn.prepare('SELECT 1 FROM users WHERE sipa_code = ?').get(code)) return code;
  }
  return `SIPA-${randomHex(3).toUpperCase()}-SN`;
}

export function findUserByPhone(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone_hash = ?').get(phoneHash(phone)) ?? null;
}

export function findUserByCode(code) {
  return getDb().prepare('SELECT * FROM users WHERE sipa_code = ?').get(String(code ?? '').toUpperCase()) ?? null;
}

export function getUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    sipaCode: user.sipa_code,
    pseudonym: user.pseudonym,
    language: user.preferred_lang,
    biometrics: Boolean(user.webauthn),
    createdAt: user.created_at,
  };
}

export function createUser({ phone, pin, pseudonym }) {
  const conn = getDb();
  const normalized = normalizePhone(phone);
  const existing = findUserByPhone(normalized);
  if (existing) return { error: 'Ce numéro est déjà enregistré.' };
  if (!/^\d{6}$/.test(String(pin ?? ''))) return { error: 'Le code PIN doit contenir 6 chiffres.' };
  const displayName = String(pseudonym ?? '').trim().slice(0, 40) || 'Usager SIPA';
  const id = uid('usr_');
  const pinSalt = newSalt();
  const dekSalt = newSalt();
  const dek = Buffer.from(randomHex(32), 'hex'); // clé de données aléatoire, enveloppée par le PIN
  const kek = deriveKey(pin, dekSalt, DEK_ITERATIONS);
  const wrapped = sealGcm(kek, dek.toString('base64'));
  const phoneSealed = sealWithMaster(normalized);
  conn
    .prepare(
      `INSERT INTO users (id,sipa_code,phone_hash,phone_enc,pseudonym,pin_hash,pin_salt,dek_wrapped,dek_iv,dek_salt,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      generateSipaCode(),
      phoneHash(normalized),
      JSON.stringify(phoneSealed),
      displayName,
      deriveKey(pin, pinSalt, PIN_ITERATIONS).toString('hex'),
      pinSalt,
      wrapped.data,
      wrapped.iv,
      dekSalt,
      now()
    );
  getDb()
    .prepare('UPDATE users SET dek_server = ? WHERE id = ?')
    .run(JSON.stringify(sealWithMaster(dek.toString('base64'))), id);
  const user = getUser(id);
  audit(id, 'USER_CREATED', id, { phone: maskPhone(normalized) });
  notify(id, 'WELCOME', `Bienvenue ${displayName}`, 'Votre espace SIPA est prêt. Vos données restent strictement confidentielles.');
  return { user, dek };
}

export function userPhone(user) {
  try {
    return openWithMaster(JSON.parse(user.phone_enc));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ PIN / DEK
export function verifyPin(user, pin) {
  const conn = getDb();
  const fresh = getUser(user.id);
  if (!fresh.pin_hash) return { ok: false, error: 'Aucun code PIN configuré.' };
  if (fresh.locked_until && new Date(fresh.locked_until) > new Date()) {
    return { ok: false, lockedUntil: fresh.locked_until, error: 'Trop de tentatives. Réessayez plus tard.' };
  }
  const candidate = deriveKey(pin, fresh.pin_salt, PIN_ITERATIONS).toString('hex');
  if (candidate !== fresh.pin_hash) {
    const attempts = (fresh.failed_attempts ?? 0) + 1;
    let lockedUntil = null;
    if (attempts >= 5) {
      const seconds = Math.min(30 * 2 ** (attempts - 5), 900);
      lockedUntil = new Date(Date.now() + seconds * 1000).toISOString();
    }
    conn.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockedUntil, user.id);
    return { ok: false, attempts, lockedUntil, error: lockedUntil ? 'Trop de tentatives : accès temporairement bloqué.' : 'Code PIN incorrect.' };
  }
  conn.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  const kek = deriveKey(pin, fresh.dek_salt, DEK_ITERATIONS);
  let dek = null;
  try {
    dek = Buffer.from(openGcm(kek, fresh.dek_iv, fresh.dek_wrapped), 'base64');
  } catch {
    return { ok: false, error: 'Coffre-fort illisible.' };
  }
  return { ok: true, dek, user: fresh };
}

export function changePin(user, currentPin, nextPin) {
  const check = verifyPin(user, currentPin);
  if (!check.ok) return { error: check.error };
  if (!/^\d{6}$/.test(String(nextPin ?? ''))) return { error: 'Le nouveau PIN doit contenir 6 chiffres.' };
  const pinSalt = newSalt();
  const dekSalt = newSalt();
  const kek = deriveKey(nextPin, dekSalt, DEK_ITERATIONS);
  const wrapped = sealGcm(kek, check.dek.toString('base64'));
  getDb()
    .prepare('UPDATE users SET pin_hash=?, pin_salt=?, dek_salt=?, dek_wrapped=?, dek_iv=? WHERE id=?')
    .run(deriveKey(nextPin, pinSalt, PIN_ITERATIONS).toString('hex'), pinSalt, dekSalt, wrapped.data, wrapped.iv, user.id);
  audit(user.id, 'PIN_CHANGED', user.id);
  return { ok: true };
}

export function setWebauthn(user, credential) {
  const list = readWebauthn(user);
  if (!list.find((c) => c.id === credential.id)) list.push({ id: credential.id, createdAt: now(), label: credential.label ?? 'Appareil' });
  const fresh = getUser(user.id);
  const bio = fresh.dek_bio ?? null;
  getDb().prepare('UPDATE users SET webauthn = ?, dek_bio = ? WHERE id = ?').run(JSON.stringify(list), bio, user.id);
  audit(user.id, 'WEBAUTHN_REGISTERED', user.id);
  return list;
}

// Clé de données pour la voie biométrique : scellée par la clé maître de la
// plateforme dans le prototype (en production : enclave sécurisée de l’appareil).
export function attachBiometricDek(user, dek) {
  getDb()
    .prepare('UPDATE users SET dek_bio = ? WHERE id = ?')
    .run(JSON.stringify(sealWithMaster(dek.toString('base64'))), user.id);
}

export function biometricDek(user) {
  if (!user.dek_bio) return null;
  try {
    return Buffer.from(openWithMaster(JSON.parse(user.dek_bio)), 'base64');
  } catch {
    return null;
  }
}

// Clé de données côté plateforme (chiffrement des résultats saisis par un soignant).
export function serverDek(user) {
  if (!user.dek_server) return null;
  try {
    return Buffer.from(openWithMaster(JSON.parse(user.dek_server)), 'base64');
  } catch {
    return null;
  }
}

export function readWebauthn(user) {
  try {
    return JSON.parse(user.webauthn ?? '[]');
  } catch {
    return [];
  }
}

export function hasWebauthn(user, credentialId) {
  return readWebauthn(user).some((c) => c.id === credentialId);
}

// ------------------------------------------------------------- Coffre-fort
export function sealResults(dek, payload) {
  return sealGcm(dek, JSON.stringify(payload));
}

export function addHealthResult({ user, appointmentId, dek, payload, hasAlert }) {
  const sealed = sealResults(dek, payload);
  const id = uid('res_');
  getDb()
    .prepare(
      `INSERT INTO health_results (id,user_id,appointment_id,cipher_payload,iv,has_alert,created_at) VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, user.id, appointmentId ?? null, sealed.data, sealed.iv, hasAlert ? 1 : 0, now());
  audit(user.id, 'RESULT_STORED', id, { alert: Boolean(hasAlert) });
  return id;
}

export function listHealthResults(user, dek) {
  const rows = getDb()
    .prepare('SELECT * FROM health_results WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id);
  const facilities = facilityMap();
  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(openGcm(dek, row.iv, row.cipher_payload));
      return [
        {
          id: row.id,
          createdAt: row.created_at,
          hasAlert: Boolean(row.has_alert),
          facilityName: payload.facilityName ?? facilities.get(payload.facilityId)?.name ?? 'Structure partenaire',
          facilityId: payload.facilityId ?? null,
          category: payload.category ?? 'BILAN_4EN1',
          values: {
            bpSys: payload.bpSys ?? null,
            bpDia: payload.bpDia ?? null,
            glucose: payload.glucose ?? null,
            hbsag: payload.hbsag ?? null,
            hiv: payload.hiv ?? null,
          },
          source: payload.source ?? 'CENTRE',
        },
      ];
    } catch {
      return [];
    }
  });
}

export function facilityMap() {
  const map = new Map();
  for (const f of getDb().prepare('SELECT * FROM facilities').all()) map.set(f.id, serializeFacility(f));
  return map;
}

// ------------------------------------------------------------- Structures
export function serializeFacility(row, stock, distanceKm) {
  const stockRow = stock ?? (row.type === 'PHARMACIE'
    ? getDb().prepare('SELECT * FROM pharmacy_stocks WHERE facility_id = ?').get(row.id)
    : null);
  let stockStatus = null;
  if (row.type === 'PHARMACIE') {
    const available = stockRow?.available_qty ?? 0;
    stockStatus = available <= 0 ? 'INDISPONIBLE' : available <= 5 ? 'STOCK_LIMITE' : 'DISPONIBLE';
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lng: row.lng,
    commune: row.commune,
    city: row.city,
    address: row.address,
    phone: row.phone,
    hours: JSON.parse(row.opening_hours ?? '{}'),
    supportsArvRelay: Boolean(row.supports_arv_relay),
    stock: stockRow ? { available: stockRow.available_qty, reserved: stockRow.reserved_qty } : null,
    stockStatus,
    distanceKm: distanceKm ?? null,
  };
}

export function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export function nearbyFacilities({ lat, lng, radius = 60, type, commune, q }) {
  const conn = getDb();
  const rows = conn.prepare('SELECT * FROM facilities WHERE is_active = 1').all();
  const stocks = new Map(conn.prepare('SELECT * FROM pharmacy_stocks').all().map((s) => [s.facility_id, s]));
  const origin = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const needle = String(q ?? '').toLowerCase();
  return rows
    .filter((row) => (type ? row.type === type : true))
    .filter((row) => (commune && commune !== 'Toutes les communes' ? row.commune === commune : true))
    .filter((row) => (needle ? `${row.name} ${row.commune} ${row.city} ${row.address}`.toLowerCase().includes(needle) : true))
    .map((row) => serializeFacility(row, stocks.get(row.id), origin ? haversineKm(origin, row) : null))
    .filter((f) => (origin && Number.isFinite(radius) ? f.distanceKm <= radius : true))
    .sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return a.name.localeCompare(b.name);
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

export function getFacility(id) {
  const row = getDb().prepare('SELECT * FROM facilities WHERE id = ?').get(id);
  if (!row) return null;
  return serializeFacility(row);
}

export function updateStock(facilityId, { available, delta }) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM pharmacy_stocks WHERE facility_id = ?').get(facilityId);
  if (!row) return null;
  let next = row.available_qty;
  if (Number.isFinite(available)) next = Math.max(0, Math.trunc(available));
  else if (Number.isFinite(delta)) next = Math.max(0, row.available_qty + Math.trunc(delta));
  conn.prepare('UPDATE pharmacy_stocks SET available_qty = ?, updated_at = ? WHERE facility_id = ?').run(next, now(), facilityId);
  audit(facilityId, 'STOCK_UPDATED', facilityId, { available: next });
  return next;
}

// ------------------------------------------------------------ Rendez-vous
export function slotLabel(iso) {
  return new Date(iso).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function generateSlots(facilityId, days = 7) {
  const conn = getDb();
  const taken = new Set(
    conn
      .prepare("SELECT slot_at FROM appointments WHERE facility_id = ? AND status = 'BOOKED'")
      .all(facilityId)
      .map((r) => r.slot_at)
  );
  const slots = [];
  const start = new Date();
  for (let d = 0; d < days; d++) {
    const day = new Date(start);
    day.setDate(start.getDate() + d);
    if (day.getDay() === 0) continue;
    for (let minutes = 8 * 60; minutes <= 16 * 60 + 40; minutes += 20) {
      const slot = new Date(day);
      slot.setHours(0, minutes, 0, 0);
      if (slot.getTime() < Date.now() + 45 * 60 * 1000) continue;
      const iso = slot.toISOString();
      if (taken.has(iso)) continue;
      slots.push({ at: iso, label: slotLabel(iso) });
      if (slots.length >= 48) return slots;
    }
  }
  return slots;
}

export function createAppointment({ user, facilityId, category, slotAt, coupleCode }) {
  const conn = getDb();
  const facility = getFacility(facilityId);
  if (!facility) return { error: 'Structure introuvable.' };
  if (!['BILAN_4EN1', 'PRENUPTIAL', 'CPN_MATERNITE'].includes(category)) return { error: 'Motif invalide.' };
  const taken = conn
    .prepare("SELECT 1 FROM appointments WHERE facility_id = ? AND slot_at = ? AND status = 'BOOKED'")
    .get(facilityId, slotAt);
  if (taken) return { error: 'Ce créneau vient d’être réservé. Choisissez-en un autre.' };
  const id = uid('apt_');
  const passCode = `PASS-${randomCode(4)}`;
  const link = category === 'PRENUPTIAL' ? coupleCode || `RDV-CPL-${randomDigits(3)}` : null;
  conn
    .prepare(
      `INSERT INTO appointments (id,user_id,facility_id,pass_code,couple_link_code,category,slot_at,status,created_at)
       VALUES (?,?,?,?,?,?,?, 'BOOKED', ?)`
    )
    .run(id, user.id, facilityId, passCode, link, category, slotAt, now());
  notify(
    user.id,
    'APPOINTMENT',
    'Rendez-vous confirmé',
    `Votre rendez-vous du ${slotLabel(slotAt)} est confirmé. Présentez votre pass à l’accueil.`,
    { appointmentId: id }
  );
  audit(user.id, 'APPOINTMENT_BOOKED', id, { facilityId, category });
  return { appointment: getAppointment(id) };
}

export function serializeAppointment(row) {
  if (!row) return null;
  const facility = getFacility(row.facility_id);
  return {
    id: row.id,
    passCode: row.pass_code,
    coupleCode: row.couple_link_code,
    category: row.category,
    slotAt: row.slot_at,
    status: row.status,
    createdAt: row.created_at,
    facility: facility
      ? { id: facility.id, name: facility.name, address: facility.address, commune: facility.commune, lat: facility.lat, lng: facility.lng }
      : null,
  };
}

export function getAppointment(id) {
  return serializeAppointment(getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(id));
}

export function listAppointments(user) {
  return getDb()
    .prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY slot_at DESC')
    .all(user.id)
    .map(serializeAppointment);
}

export function cancelAppointment(user, id) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!row) return { error: 'Rendez-vous introuvable.' };
  if (row.status !== 'BOOKED') return { error: 'Ce rendez-vous ne peut plus être annulé.' };
  conn.prepare("UPDATE appointments SET status = 'CANCELLED' WHERE id = ?").run(id);
  notify(user.id, 'APPOINTMENT', 'Rendez-vous annulé', 'Votre rendez-vous a bien été annulé. Vous pouvez en reprendre un à tout moment.');
  return { ok: true };
}

export function rescheduleAppointment(user, id, slotAt) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!row) return { error: 'Rendez-vous introuvable.' };
  const taken = conn
    .prepare("SELECT 1 FROM appointments WHERE facility_id = ? AND slot_at = ? AND status = 'BOOKED' AND id <> ?")
    .get(row.facility_id, slotAt, id);
  if (taken) return { error: 'Créneau indisponible.' };
  conn.prepare('UPDATE appointments SET slot_at = ? WHERE id = ?').run(slotAt, id);
  notify(user.id, 'APPOINTMENT', 'Rendez-vous déplacé', `Nouveau créneau : ${slotLabel(slotAt)}.`);
  return { appointment: getAppointment(id) };
}

// -------------------------------------------------------------- Vouchers
export function createAutotestVoucher(user, facilityId) {
  const conn = getDb();
  const facility = getFacility(facilityId);
  if (!facility || facility.type !== 'PHARMACIE') return { error: 'Pharmacie agréée introuvable.' };
  const stock = conn.prepare('SELECT * FROM pharmacy_stocks WHERE facility_id = ?').get(facilityId);
  if (!stock || stock.available_qty <= 0) return { error: 'Aucun autotest disponible dans cette officine.' };
  const existing = conn
    .prepare("SELECT * FROM vouchers_qr WHERE user_id = ? AND kind = 'AUTOTEST' AND used_at IS NULL AND expires_at > ?")
    .get(user.id, now());
  if (existing) return { error: 'Vous avez déjà un pass autotest actif.', voucher: serializeVoucher(existing) };

  conn
    .prepare(
      'UPDATE pharmacy_stocks SET available_qty = available_qty - 1, reserved_qty = reserved_qty + 1, updated_at = ? WHERE facility_id = ?'
    )
    .run(now(), facilityId);
  const id = uid('vch_');
  const secret = randomBase32(32);
  const expiresAt = new Date(Date.now() + AUTOTEST_LOCK_HOURS * 3600 * 1000).toISOString();
  conn
    .prepare(
      `INSERT INTO vouchers_qr (id,user_id,facility_id,kind,totp_secret,expires_at,created_at) VALUES (?,?,?, 'AUTOTEST', ?,?,?)`
    )
    .run(id, user.id, facilityId, secret, expiresAt, now());
  notify(
    user.id,
    'VOUCHER',
    'Pass de retrait prêt',
    `Votre pass est valable 24 h à ${facility.name}. Présentez-le au comptoir, sans rien dire.`
  );
  audit(user.id, 'AUTOTEST_RESERVED', id, { facilityId });
  return { voucher: serializeVoucher(conn.prepare('SELECT * FROM vouchers_qr WHERE id = ?').get(id)) };
}

export function serializeVoucher(row, { withSecret = false } = {}) {
  const facility = getFacility(row.facility_id);
  const epoch = Math.floor(Date.now() / (TOTP_PERIOD * 1000));
  return {
    id: row.id,
    kind: row.kind,
    facility: facility ? { id: facility.id, name: facility.name, address: facility.address, commune: facility.commune } : null,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    active: !row.used_at && new Date(row.expires_at) > new Date(),
    parcelId: row.parcel_id,
    codePrefix: `SIPA-${row.id.slice(4, 12).toUpperCase()}`,
    step: epoch,
    secondsLeft: TOTP_PERIOD - (Math.floor(Date.now() / 1000) % TOTP_PERIOD),
    ...(withSecret ? { totpSecret: row.totp_secret, code: totp(row.totp_secret) } : {}),
  };
}

export function listVouchers(user) {
  return getDb()
    .prepare('SELECT * FROM vouchers_qr WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
    .map((row) => serializeVoucher(row, { withSecret: true }));
}

export function getVoucher(user, id) {
  const row = getDb().prepare('SELECT * FROM vouchers_qr WHERE id = ? AND user_id = ?').get(id, user.id);
  return row ? serializeVoucher(row, { withSecret: true }) : null;
}

export function parsePass(scan) {
  const raw = String(scan ?? '').trim();
  const match = raw.match(/SIPA-([0-9a-fA-F]{8})-(\d{6})/);
  if (match) return { prefix: match[1].toLowerCase(), code: match[2] };
  const loose = raw.match(/(\d{6})$/);
  const prefixMatch = raw.match(/SIPA-([0-9a-fA-F]{8})/i);
  if (prefixMatch) return { prefix: prefixMatch[1].toLowerCase(), code: loose ? loose[1] : null };
  return { prefix: null, code: null };
}

export function redeemVoucher(staff, scan, extra = {}) {
  const conn = getDb();
  const { prefix, code } = parsePass(scan);
  if (!prefix || !code) return { error: 'Pass illisible. Saisissez le code complet SIPA-XXXXXXXX-123456.' };
  const rows = conn.prepare('SELECT * FROM vouchers_qr').all();
  const row = rows.find((v) => v.id.slice(4, 12).toLowerCase() === prefix);
  if (!row) return { error: 'Pass inconnu.' };
  if (row.used_at) return { error: 'Ce pass a déjà été utilisé.' };
  if (new Date(row.expires_at) < new Date()) return { error: 'Ce pass a expiré.' };
  if (staff.role === 'PHARMACIE' && row.facility_id !== staff.facility_id) {
    return { error: 'Ce pass concerne une autre officine.' };
  }
  if (!verifyTotp(row.totp_secret, code)) return { error: 'Code tournant invalide ou expiré. Demandez un nouveau code.' };

  let parcel = null;
  if (row.kind === 'ARV_PARCEL') {
    parcel = conn.prepare('SELECT * FROM arv_parcels WHERE id = ?').get(row.parcel_id);
    if (!parcel) return { error: 'Colis introuvable.' };
    const tracking = String(extra.tracking ?? '').trim().toUpperCase();
    if (tracking !== parcel.tracking_code) {
      return { error: 'Double validation requise : saisissez le code logistique imprimé sur le pli scellé.' };
    }
    conn.prepare("UPDATE arv_parcels SET status = 'DELIVERED', updated_at = ? WHERE id = ?").run(now(), parcel.id);
  } else {
    conn
      .prepare(
        'UPDATE pharmacy_stocks SET reserved_qty = MAX(0, reserved_qty - 1), updated_at = ? WHERE facility_id = ?'
      )
      .run(now(), row.facility_id);
  }
  conn.prepare('UPDATE vouchers_qr SET used_at = ? WHERE id = ?').run(now(), row.id);
  notify(
    row.user_id,
    'VOUCHER',
    'Retrait enregistré',
    row.kind === 'AUTOTEST'
      ? 'Votre autotest a été retiré. Un rappel discret vous sera envoyé dans 2 jours.'
      : `Votre colis ${parcel.tracking_code} a été remis. Pensez à votre prochain renouvellement.`
  );
  audit(staff.id, 'VOUCHER_REDEEMED', row.id, { kind: row.kind, facilityId: staff.facility_id });
  return {
    ok: true,
    kind: row.kind,
    voucherId: row.id,
    parcel: parcel ? { trackingCode: parcel.tracking_code, status: 'DELIVERED' } : null,
  };
}

export function createParcel({ coordinator, user, pharmacyId, originCenterId }) {
  const conn = getDb();
  const pharmacy = getFacility(pharmacyId);
  if (!pharmacy || pharmacy.type !== 'PHARMACIE') return { error: 'Pharmacie destinataire invalide.' };
  if (!pharmacy.supportsArvRelay) return { error: 'Cette officine n’est pas point relais ARV.' };
  const origin = getFacility(originCenterId ?? coordinator.facility_id);
  const id = uid('prc_');
  let tracking = `COLIS-${randomCode(4)}-SN`;
  while (conn.prepare('SELECT 1 FROM arv_parcels WHERE tracking_code = ?').get(tracking)) tracking = `COLIS-${randomCode(4)}-SN`;
  conn
    .prepare(
      `INSERT INTO arv_parcels (id,tracking_code,user_id,origin_center_id,pharmacy_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?, 'PREPARED', ?, ?)`
    )
    .run(id, tracking, user.id, origin?.id ?? coordinator.facility_id, pharmacyId, now(), now());
  audit(coordinator.id, 'PARCEL_CREATED', tracking, { pharmacyId });
  return { parcel: serializeParcel(conn.prepare('SELECT * FROM arv_parcels WHERE id = ?').get(id)) };
}

export function serializeParcel(row) {
  if (!row) return null;
  const user = getUser(row.user_id);
  const pharmacy = getFacility(row.pharmacy_id);
  const origin = getFacility(row.origin_center_id);
  return {
    id: row.id,
    trackingCode: row.tracking_code,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sipaCode: user?.sipa_code ?? null,
    pseudonym: user?.pseudonym ?? null,
    pharmacy: pharmacy ? { id: pharmacy.id, name: pharmacy.name, commune: pharmacy.commune, address: pharmacy.address } : null,
    originCenter: origin ? { id: origin.id, name: origin.name } : null,
  };
}

export function listUserParcels(user) {
  return getDb()
    .prepare('SELECT * FROM arv_parcels WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
    .map(serializeParcel);
}

export function listParcelsForStaff(staff) {
  const conn = getDb();
  let rows;
  if (staff.role === 'ARV_COORD') rows = conn.prepare('SELECT * FROM arv_parcels ORDER BY created_at DESC').all();
  else rows = conn.prepare('SELECT * FROM arv_parcels WHERE pharmacy_id = ? ORDER BY created_at DESC').all(staff.facility_id);
  return rows.map(serializeParcel);
}

export function advanceParcel(staff, trackingCode, nextStatus) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM arv_parcels WHERE tracking_code = ?').get(String(trackingCode).toUpperCase());
  if (!row) return { error: 'Colis introuvable.' };
  const flow = ['PREPARED', 'IN_TRANSIT', 'AT_PHARMACY', 'DELIVERED'];
  if (!flow.includes(nextStatus)) return { error: 'Statut invalide.' };
  if (staff.role === 'PHARMACIE' && row.pharmacy_id !== staff.facility_id) return { error: 'Colis destiné à une autre officine.' };
  if (staff.role === 'PHARMACIE' && nextStatus === 'DELIVERED') return { error: 'La remise se fait par scan du pass du patient.' };
  const currentIndex = flow.indexOf(row.status);
  const targetIndex = flow.indexOf(nextStatus);
  if (targetIndex < currentIndex) return { error: 'Transition logistique impossible.' };
  conn.prepare('UPDATE arv_parcels SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now(), row.id);

  if (nextStatus === 'AT_PHARMACY') {
    const existing = conn
      .prepare("SELECT 1 FROM vouchers_qr WHERE parcel_id = ? AND used_at IS NULL")
      .get(row.id);
    if (!existing) {
      const voucherId = uid('vch_');
      conn
        .prepare(
          `INSERT INTO vouchers_qr (id,user_id,facility_id,kind,parcel_id,totp_secret,expires_at,created_at)
           VALUES (?,?,?, 'ARV_PARCEL', ?,?,?,?)`
        )
        .run(
          voucherId,
          row.user_id,
          row.pharmacy_id,
          row.id,
          randomBase32(32),
          new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          now()
        );
    }
    notify(
      row.user_id,
      'PARCEL',
      NEUTRAL_TITLE,
      'Votre pli est arrivé dans votre officine de quartier. Présentez votre pass de retrait quand vous le souhaitez.'
    );
  } else if (nextStatus === 'IN_TRANSIT') {
    notify(row.user_id, 'PARCEL', NEUTRAL_TITLE, 'Votre pli est en cours d’acheminement vers votre officine.');
  }
  audit(staff.id, 'PARCEL_STATUS', row.tracking_code, { status: nextStatus });
  return { parcel: serializeParcel(conn.prepare('SELECT * FROM arv_parcels WHERE id = ?').get(row.id)) };
}

// ---------------------------------------------------------- Auto-rapport J+2
export function reportSelftest(user, { result, voucherId }) {
  const conn = getDb();
  const allowed = ['NEGATIF', 'POSITIF', 'NON_FAIT'];
  if (!allowed.includes(result)) return { error: 'Résultat invalide.' };
  conn
    .prepare('INSERT INTO selftest_reports (id,user_id,voucher_id,result,created_at) VALUES (?,?,?,?,?)')
    .run(uid('str_'), user.id, voucherId ?? null, result, now());
  audit(user.id, 'SELFTEST_REPORTED', voucherId ?? null, { result });
  if (result === 'POSITIF') {
    return {
      ok: true,
      support: true,
      message:
        'Merci pour votre confiance. Un autotest positif doit être confirmé. Le traitement est gratuit au Sénégal et I=I : sous traitement efficace, on ne transmet plus le virus. Aucune information ne sera jamais transmise à votre partenaire.',
    };
  }
  return { ok: true, message: 'Merci, votre suivi est enregistré. Prenez soin de vous.' };
}

// ------------------------------------------------------------ Notifications
export function notify(userId, kind, title, body) {
  const conn = getDb();
  const id = uid('ntf_');
  conn
    .prepare('INSERT INTO notifications (id,user_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, kind, title, body, now());
  const payload = { id, kind, title, body, createdAt: now() };
  globalThis.__sipaEvents?.emit?.(`user:${userId}`, { type: 'notification', notification: payload });
  return payload;
}

export function listNotifications(user) {
  return getDb()
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(user.id)
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read: Boolean(n.read_at), createdAt: n.created_at }));
}

export function markNotificationsRead(user) {
  getDb().prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
  return { ok: true };
}

// Rappels discrets : autotest retiré il y a ≥ 2 jours sans auto-rapport.
export function dueReminders(user) {
  const conn = getDb();
  const rows = conn
    .prepare(
      `SELECT * FROM vouchers_qr WHERE user_id = ? AND kind = 'AUTOTEST' AND used_at IS NOT NULL
       AND julianday('now') - julianday(used_at) >= 2`
    )
    .all(user.id);
  for (const voucher of rows) {
    const done = conn.prepare('SELECT 1 FROM selftest_reports WHERE voucher_id = ?').get(voucher.id);
    const prompted = conn
      .prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'SELFTEST_REMINDER' AND body LIKE ?")
      .get(user.id, `%${voucher.id.slice(4, 12)}%`);
    if (!done && !prompted) {
      conn
        .prepare('INSERT INTO notifications (id,user_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)')
        .run(
          uid('ntf_'),
          user.id,
          'SELFTEST_REMINDER',
          NEUTRAL_TITLE,
          `Votre suivi personnel ${voucher.id.slice(4, 12)} est disponible. Enregistrez votre résultat quand vous le souhaitez, en toute confidentialité.`,
          now()
        );
    }
  }
}
