// API REST SIPA v1 — routes, RBAC et protocoles chiffrés.
import { getDb, audit } from './db.js';
import {
  signJwt,
  verifyJwt,
  randomHex,
  randomDigits,
  normalizePhone,
  isValidPhone,
  maskPhone,
  phoneHash,
  sha256hex,
  verifyTotp,
} from './crypto.js';
import * as svc from './service.js';
import { buildReply, whatsappText } from './chat.js';

export class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const routes = [];
const R = (method, pattern, handler) => routes.push({ method, pattern, handler });

const vaultSessions = new Map();
const otpStore = new Map();
const rateLimit = new Map();

function rateLimited(key, max, windowMs) {
  const nowMs = Date.now();
  const entry = rateLimit.get(key) ?? { count: 0, reset: nowMs + windowMs };
  if (nowMs > entry.reset) {
    entry.count = 0;
    entry.reset = nowMs + windowMs;
  }
  entry.count += 1;
  rateLimit.set(key, entry);
  return entry.count > max;
}

function q(ctx, name, fallback = undefined) {
  const value = ctx.query.get(name);
  return value == null || value === '' ? fallback : value;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function user(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Session requise.');
  return ctx.user;
}

function staff(ctx, roles = null) {
  if (!ctx.staff) throw new ApiError(401, 'Authentification professionnelle requise.');
  if (roles && !roles.includes(ctx.staff.role)) throw new ApiError(403, 'Profil non autorisé pour cette action.');
  return ctx.staff;
}

function vault(ctx) {
  const token = ctx.req.headers['x-vault-unlock-token'];
  const payload = verifyJwt(typeof token === 'string' ? token : '');
  if (!payload || payload.typ !== 'vault') throw new ApiError(401, 'Coffre-fort verrouillé : déverrouillez avec votre PIN.');
  const session = vaultSessions.get(payload.sid);
  if (!session || session.exp < Date.now()) throw new ApiError(401, 'Session de coffre-fort expirée.');
  if (!ctx.user || session.userId !== ctx.user.id) throw new ApiError(403, 'Coffre-fort d’un autre usager.');
  session.exp = Date.now() + 10 * 60 * 1000;
  return { dek: session.dek, sid: payload.sid };
}

function issueUserToken(u) {
  return signJwt({ sub: u.id, typ: 'user' }, 60 * 60 * 12);
}

function openVault(u, dek) {
  const sid = randomHex(16);
  vaultSessions.set(sid, { userId: u.id, dek, exp: Date.now() + 10 * 60 * 1000 });
  return { token: signJwt({ sub: u.id, sid, typ: 'vault' }, 600), expiresIn: 600 };
}

const PROFILES = {
  PHARMACIE: { label: 'Pharmacien d’officine', facility: true },
  LAB: { label: 'Infirmier / Biologiste', facility: true },
  ARV_COORD: { label: 'Coordinateur centre ARV', facility: true },
  COUNSELOR: { label: 'Conseiller psychosocial', facility: false },
};

// ============================================================ Authentification
R('POST', '/api/v1/auth/otp/send', (ctx) => {
  const phone = normalizePhone(ctx.body.phone);
  if (!isValidPhone(phone)) throw new ApiError(400, 'Numéro de téléphone invalide.');
  if (rateLimited(`otp:${phone}`, 6, 10 * 60 * 1000)) throw new ApiError(429, 'Trop de demandes de code. Réessayez dans quelques minutes.');
  const code = randomDigits(6);
  otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
  console.log(`[SIPA][OTP] ${maskPhone(phone)} → ${code}`);
  return {
    ok: true,
    channel: 'WHATSAPP',
    phone: maskPhone(phone),
    expiresIn: 300,
    devCode: process.env.SIPA_HIDE_OTP === '1' ? undefined : code,
  };
});

R('POST', '/api/v1/auth/otp/verify', (ctx) => {
  const phone = normalizePhone(ctx.body.phone);
  const entry = otpStore.get(phone);
  if (!entry) throw new ApiError(400, 'Aucun code en attente pour ce numéro.');
  if (entry.expires < Date.now()) {
    otpStore.delete(phone);
    throw new ApiError(400, 'Code expiré. Demandez un nouveau code.');
  }
  entry.attempts += 1;
  if (entry.attempts > 5) throw new ApiError(429, 'Trop de tentatives sur ce code.');
  if (String(ctx.body.code).replace(/\D/g, '') !== entry.code) throw new ApiError(400, 'Code incorrect.');
  otpStore.delete(phone);

  const existing = svc.findUserByPhone(phone);
  if (existing) {
    return { token: issueUserToken(existing), user: svc.publicUser(existing), isNew: false };
  }
  const ticket = signJwt({ typ: 'signup', phone }, 900);
  return { isNew: true, ticket, phone: maskPhone(phone) };
});

R('POST', '/api/v1/auth/register', (ctx) => {
  const payload = verifyJwt(ctx.body.ticket);
  if (!payload || payload.typ !== 'signup') throw new ApiError(400, 'Session d’inscription expirée.');
  const result = svc.createUser({ phone: payload.phone, pin: ctx.body.pin, pseudonym: ctx.body.pseudonym });
  if (result.error) throw new ApiError(400, result.error);
  return {
    token: issueUserToken(result.user),
    user: svc.publicUser(result.user),
    vault: openVault(result.user, result.dek),
  };
});

R('POST', '/api/v1/auth/pin', (ctx) => {
  const u = svc.findUserByPhone(ctx.body.phone);
  if (!u) throw new ApiError(404, 'Aucun compte associé à ce numéro.');
  const check = svc.verifyPin(u, String(ctx.body.pin ?? ''));
  if (!check.ok) throw new ApiError(423, check.error, { lockedUntil: check.lockedUntil, attempts: check.attempts });
  return { token: issueUserToken(check.user), user: svc.publicUser(check.user) };
});

R('POST', '/api/v1/auth/webauthn/register', (ctx) => {
  const u = user(ctx);
  const pin = String(ctx.body.pin ?? '');
  const check = svc.verifyPin(u, pin);
  if (!check.ok) throw new ApiError(423, check.error);
  if (!ctx.body.credentialId) throw new ApiError(400, 'Justificatif biométrique manquant.');
  svc.setWebauthn(u, { id: ctx.body.credentialId, label: ctx.body.label });
  svc.attachBiometricDek(u, check.dek);
  return { ok: true, biometrics: true };
});

R('POST', '/api/v1/auth/webauthn/verify', (ctx) => {
  const u = user(ctx);
  if (!svc.hasWebauthn(u, ctx.body.credentialId)) throw new ApiError(400, 'Appareil biométrique non reconnu.');
  return { token: issueUserToken(u), vault: svc.biometricDek(u) ? openVault(u, svc.biometricDek(u)) : null };
});

R('POST', '/api/v1/auth/pin/change', (ctx) => {
  const u = user(ctx);
  const result = svc.changePin(u, String(ctx.body.currentPin ?? ''), String(ctx.body.nextPin ?? ''));
  if (result.error) throw new ApiError(400, result.error);
  vaultSessions.clear();
  return { ok: true };
});

// ==================================================================== Profil
R('GET', '/api/v1/me', (ctx) => {
  const u = user(ctx);
  const lastResult = getDb()
    .prepare('SELECT created_at, has_alert FROM health_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(u.id);
  return {
    user: svc.publicUser(u),
    phoneMasked: svc.userPhone(u) ? maskPhone(svc.userPhone(u)) : null,
    summary: {
      appointments: svc.listAppointments(u).filter((a) => a.status === 'BOOKED').length,
      vouchers: svc.listVouchers(u).filter((v) => v.active).length,
      parcels: svc.listUserParcels(u).filter((p) => p.status !== 'DELIVERED').length,
      unread: svc.listNotifications(u).filter((n) => !n.read).length,
      lastResultAt: lastResult?.created_at ?? null,
      lastResultAlert: Boolean(lastResult?.has_alert),
    },
  };
});

R('PATCH', '/api/v1/me', (ctx) => {
  const u = user(ctx);
  const lang = ['fr', 'wo'].includes(ctx.body.language) ? ctx.body.language : null;
  if (!lang) throw new ApiError(400, 'Langue non prise en charge.');
  getDb().prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(lang, u.id);
  return { ok: true };
});

R('GET', '/api/v1/me/notifications', (ctx) => {
  const u = user(ctx);
  svc.dueReminders(u);
  return { notifications: svc.listNotifications(u) };
});

R('POST', '/api/v1/me/notifications/read', (ctx) => {
  svc.markNotificationsRead(user(ctx));
  return { ok: true };
});

// ================================================================= Structures
R('GET', '/api/v1/facilities', (ctx) => {
  const facilities = svc.nearbyFacilities({
    lat: num(q(ctx, 'lat')),
    lng: num(q(ctx, 'lng')),
    radius: num(q(ctx, 'radius')) ?? 60,
    type: q(ctx, 'type'),
    commune: q(ctx, 'commune'),
    q: q(ctx, 'q'),
  });
  return { facilities };
});

R('GET', '/api/v1/facilities/:id', (ctx) => {
  const facility = svc.getFacility(ctx.params.id);
  if (!facility) throw new ApiError(404, 'Structure introuvable.');
  return { facility };
});

R('GET', '/api/v1/facilities/:id/slots', (ctx) => {
  if (!svc.getFacility(ctx.params.id)) throw new ApiError(404, 'Structure introuvable.');
  return { slots: svc.generateSlots(ctx.params.id, 7) };
});

// =============================================================== Rendez-vous
R('GET', '/api/v1/appointments', (ctx) => ({ appointments: svc.listAppointments(user(ctx)) }));

R('POST', '/api/v1/appointments', (ctx) => {
  const u = user(ctx);
  if (rateLimited(`apt:${u.id}`, 20, 60 * 60 * 1000)) throw new ApiError(429, 'Trop de réservations successives.');
  const result = svc.createAppointment({
    user: u,
    facilityId: ctx.body.facilityId,
    category: ctx.body.category,
    slotAt: ctx.body.slotAt,
    coupleCode: ctx.body.coupleCode,
  });
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('PATCH', '/api/v1/appointments/:id/cancel', (ctx) => {
  const result = svc.cancelAppointment(user(ctx), ctx.params.id);
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('POST', '/api/v1/appointments/:id/reschedule', (ctx) => {
  const result = svc.rescheduleAppointment(user(ctx), ctx.params.id, ctx.body.slotAt);
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

// Réservation prénuptiale à deux : alignement du créneau, coffres-forts séparés.
R('POST', '/api/v1/appointments/couple', (ctx) => {
  const u = user(ctx);
  const code = String(ctx.body.code ?? '').trim().toUpperCase();
  if (!/^RDV-CPL-\d{3}$/.test(code)) throw new ApiError(400, 'Code de liaison invalide (format RDV-CPL-123).');
  const conn = getDb();
  const partner = conn
    .prepare("SELECT * FROM appointments WHERE couple_link_code = ? AND status = 'BOOKED' ORDER BY created_at LIMIT 1")
    .get(code);
  if (!partner) throw new ApiError(404, 'Aucun créneau ouvert avec ce code.');
  if (partner.user_id === u.id) throw new ApiError(400, 'Vous êtes déjà inscrit(e) sur ce créneau.');
  const already = conn
    .prepare("SELECT 1 FROM appointments WHERE couple_link_code = ? AND user_id = ?")
    .get(code, u.id);
  if (already) throw new ApiError(400, 'Vous avez déjà rejoint ce créneau.');
  const result = svc.createAppointment({
    user: u,
    facilityId: partner.facility_id,
    category: 'PRENUPTIAL',
    slotAt: partner.slot_at,
    coupleCode: code,
  });
  if (result.error) throw new ApiError(400, result.error);
  return {
    ...result,
    isolation: 'Chaque partenaire dispose d’un coffre-fort hermétique. Aucun résultat n’est partagé.',
  };
});

// ============================================================ Double circuit
R('POST', '/api/v1/vouchers/selftest', (ctx) => {
  const u = user(ctx);
  const result = svc.createAutotestVoucher(u, ctx.body.facilityId);
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('GET', '/api/v1/vouchers', (ctx) => ({ vouchers: svc.listVouchers(user(ctx)) }));

R('GET', '/api/v1/vouchers/:id', (ctx) => {
  const voucher = svc.getVoucher(user(ctx), ctx.params.id);
  if (!voucher) throw new ApiError(404, 'Pass introuvable.');
  return { voucher };
});

R('GET', '/api/v1/parcels', (ctx) => ({ parcels: svc.listUserParcels(user(ctx)) }));

// ================================================================ Coffre-fort
R('POST', '/api/v1/vault/unlock', (ctx) => {
  const u = user(ctx);
  if (rateLimited(`vault:${u.id}`, 30, 10 * 60 * 1000)) throw new ApiError(429, 'Trop de tentatives de déverrouillage.');
  if (ctx.body.credentialId) {
    if (!svc.hasWebauthn(u, ctx.body.credentialId)) throw new ApiError(400, 'Appareil biométrique non reconnu.');
    const dek = svc.biometricDek(u);
    if (!dek) throw new ApiError(400, 'Biométrie non configurée sur ce compte.');
    return openVault(u, dek);
  }
  const check = svc.verifyPin(u, String(ctx.body.pin ?? ''));
  if (!check.ok) throw new ApiError(423, check.error, { lockedUntil: check.lockedUntil });
  return openVault(u, check.dek);
});

R('GET', '/api/v1/vault/results', (ctx) => {
  user(ctx);
  const { dek } = vault(ctx);
  return { results: svc.listHealthResults(ctx.user, dek) };
});

R('POST', '/api/v1/vault/selftest-report', (ctx) => {
  const u = user(ctx);
  const result = svc.reportSelftest(u, { result: ctx.body.result, voucherId: ctx.body.voucherId });
  if (result.error) throw new ApiError(400, result.error);
  if (result.support) {
    svc.notify(u.id, 'SUPPORT', 'Un accompagnement vous attend', 'Une conseillère peut vous parler dès maintenant, sans aucune obligation.');
  }
  return result;
});

// ================================================================ Assistant
function storeMessage(userId, author, body, escalationId = null, channel = 'PWA') {
  const id = randomHex(12);
  getDb()
    .prepare('INSERT INTO chat_messages (id,user_id,escalation_id,author,body,channel,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, userId, escalationId, author, body, channel, svc.now());
  return { id, author, body, escalationId, createdAt: svc.now(), channel };
}

R('POST', '/api/v1/chat/message', (ctx) => {
  const u = user(ctx);
  if (rateLimited(`chat:${u.id}`, 60, 60 * 1000)) throw new ApiError(429, 'Trop de messages. Patientez un instant.');
  const text = String(ctx.body.text ?? '').slice(0, 1000).trim();
  if (!text) throw new ApiError(400, 'Message vide.');
  storeMessage(u.id, 'USER', text);
  const reply = buildReply({ user: u, text, lat: num(ctx.body.lat), lng: num(ctx.body.lng), channel: 'PWA' });
  storeMessage(u.id, 'BOT', reply.text);
  return { reply };
});

R('GET', '/api/v1/chat/history', (ctx) => {
  const conn = getDb();
  const messages = conn
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 60')
    .all(ctx.user.id)
    .reverse()
    .map((m) => ({ id: m.id, author: m.author, body: m.body, createdAt: m.created_at, channel: m.channel }));
  const escalation = conn
    .prepare("SELECT * FROM chat_escalations WHERE user_id = ? AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1")
    .get(ctx.user.id);
  return { messages, escalation: escalation ? serializeEscalation(escalation) : null };
});

const ESCALATION_LABELS = {
  REACTIVE_TEST: 'Accompagnement post-test',
  PTME_PREGNANCY: 'Parcours maternité / PTME',
  COUPLE_SUPPORT: 'Soutien de couple',
  OTHER: 'Écoute et orientation',
};

function serializeEscalation(row) {
  if (!row) return null;
  const u = svc.getUser(row.user_id);
  const conn = getDb();
  const messages = conn
    .prepare('SELECT * FROM chat_messages WHERE escalation_id = ? ORDER BY created_at ASC')
    .all(row.id)
    .map((m) => ({ id: m.id, author: m.author, body: m.body, createdAt: m.created_at }));
  return {
    id: row.id,
    reason: row.reason,
    reasonLabel: ESCALATION_LABELS[row.reason] ?? row.reason,
    status: row.status,
    createdAt: row.created_at,
    sipaCode: u?.sipa_code ?? null,
    pseudonym: u?.pseudonym ?? null,
    messages,
  };
}

R('POST', '/api/v1/chat/escalate', (ctx) => {
  const u = user(ctx);
  const reasons = ['REACTIVE_TEST', 'PTME_PREGNANCY', 'COUPLE_SUPPORT', 'OTHER'];
  const reason = reasons.includes(ctx.body.reason) ? ctx.body.reason : 'OTHER';
  const conn = getDb();
  const open = conn
    .prepare("SELECT * FROM chat_escalations WHERE user_id = ? AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1")
    .get(u.id);
  if (open) return { escalation: serializeEscalation(open), reused: true };
  const id = randomHex(12);
  conn
    .prepare('INSERT INTO chat_escalations (id,user_id,reason,status,created_at) VALUES (?,?,?,?,?)')
    .run(id, u.id, reason, 'OPEN', svc.now());
  storeMessage(
    u.id,
    'SYSTEM',
    `Mise en relation demandée — ${ESCALATION_LABELS[reason]}. Un conseiller vous répond dans cette conversation.`,
    id
  );
  const row = conn.prepare('SELECT * FROM chat_escalations WHERE id = ?').get(id);
  globalThis.__sipaEvents?.emit?.('counselors', { type: 'escalation:new', escalation: serializeEscalation(row) });
  svc.notify(u.id, 'ESCALATION', 'Un conseiller vous répond', 'Votre demande de mise en relation est prise en charge. Restez dans la conversation.');
  return { escalation: serializeEscalation(row) };
});

R('GET', '/api/v1/chat/escalation', (ctx) => {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM chat_escalations WHERE user_id = ? AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1")
    .get(ctx.user.id);
  return { escalation: serializeEscalation(row) };
});

R('POST', '/api/v1/chat/escalation/message', (ctx) => {
  const u = user(ctx);
  const conn = getDb();
  const escalation = conn
    .prepare("SELECT * FROM chat_escalations WHERE user_id = ? AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1")
    .get(u.id);
  if (!escalation) throw new ApiError(404, 'Aucune conversation conseiller en cours.');
  const body = String(ctx.body.body ?? '').slice(0, 1500).trim();
  if (!body) throw new ApiError(400, 'Message vide.');
  const message = storeMessage(u.id, 'USER', body, escalation.id);
  globalThis.__sipaEvents?.emit?.(`escalation:${escalation.id}`, { type: 'message', message });
  globalThis.__sipaEvents?.emit?.('counselors', { type: 'escalation:message', escalationId: escalation.id, message });
  return { message };
});

// ===================================================================== Pro
R('POST', '/api/v1/pro/auth/login', (ctx) => {
  const conn = getDb();
  const email = String(ctx.body.email ?? '').trim().toLowerCase();
  if (rateLimited(`pro:${email}`, 10, 10 * 60 * 1000)) throw new ApiError(429, 'Trop de tentatives.');
  const row = conn.prepare('SELECT * FROM staff WHERE email = ?').get(email);
  if (!row) throw new ApiError(401, 'Identifiants professionnels invalides.');
  const [salt, hash] = row.password_hash.split(':');
  if (sha256hex(salt + String(ctx.body.password ?? '')) !== hash) throw new ApiError(401, 'Identifiants professionnels invalides.');
  const token = signJwt({ sub: row.id, typ: 'staff', role: row.role, facilityId: row.facility_id }, 60 * 60 * 8);
  audit(row.id, 'PRO_LOGIN', row.id, { role: row.role });
  return {
    token,
    staff: {
      id: row.id,
      name: row.name,
      role: row.role,
      roleLabel: PROFILES[row.role]?.label ?? row.role,
      email: row.email,
      facility: svc.getFacility(row.facility_id),
    },
  };
});

R('POST', '/api/v1/pro/pharmacy/redeem', (ctx) => {
  const st = staff(ctx, ['PHARMACIE']);
  const result = svc.redeemVoucher(st, ctx.body.scan, { tracking: ctx.body.tracking });
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('PATCH', '/api/v1/pro/pharmacy/stock', (ctx) => {
  const st = staff(ctx, ['PHARMACIE']);
  const next = svc.updateStock(st.facility_id, { available: num(ctx.body.available), delta: num(ctx.body.delta) });
  if (next == null) throw new ApiError(400, 'Stock introuvable.');
  return { available: next };
});

R('GET', '/api/v1/pro/pharmacy/overview', (ctx) => {
  const st = staff(ctx, ['PHARMACIE']);
  const conn = getDb();
  const facility = svc.getFacility(st.facility_id);
  const today = new Date().toISOString().slice(0, 10);
  return {
    facility,
    stock: facility.stock,
    redeemedToday: conn
      .prepare(
        `SELECT COUNT(*) AS n FROM vouchers_qr WHERE facility_id = ? AND used_at IS NOT NULL AND substr(used_at,1,10) = ?`
      )
      .get(st.facility_id, today).n,
    activePasses: conn
      .prepare('SELECT COUNT(*) AS n FROM vouchers_qr WHERE facility_id = ? AND used_at IS NULL AND expires_at > ?')
      .get(st.facility_id, svc.now()).n,
  };
});

R('GET', '/api/v1/pro/pharmacy/parcels', (ctx) => {
  const st = staff(ctx, ['PHARMACIE', 'ARV_COORD']);
  return { parcels: svc.listParcelsForStaff(st) };
});

R('POST', '/api/v1/pro/parcels', (ctx) => {
  const st = staff(ctx, ['ARV_COORD']);
  const target = svc.findUserByCode(ctx.body.sipaCode);
  if (!target) throw new ApiError(404, 'Aucun usager avec ce code SIPA.');
  const result = svc.createParcel({
    coordinator: st,
    user: target,
    pharmacyId: ctx.body.pharmacyId,
    originCenterId: st.facility_id,
  });
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('PATCH', '/api/v1/pro/parcels/:tracking/status', (ctx) => {
  const st = staff(ctx, ['PHARMACIE', 'ARV_COORD']);
  const result = svc.advanceParcel(st, ctx.params.tracking, ctx.body.status);
  if (result.error) throw new ApiError(400, result.error);
  return result;
});

R('GET', '/api/v1/pro/lab/appointments', (ctx) => {
  const st = staff(ctx, ['LAB']);
  const rows = getDb()
    .prepare(
      `SELECT a.*, u.sipa_code, u.pseudonym FROM appointments a JOIN users u ON u.id = a.user_id
       WHERE a.facility_id = ? AND a.status IN ('BOOKED','COMPLETED') ORDER BY a.slot_at DESC LIMIT 40`
    )
    .all(st.facility_id);
  return {
    facility: svc.getFacility(st.facility_id),
    appointments: rows.map((row) => ({
      id: row.id,
      passCode: row.pass_code,
      category: row.category,
      slotAt: row.slot_at,
      status: row.status,
      sipaCode: row.sipa_code,
      pseudonym: row.pseudonym,
    })),
  };
});

R('POST', '/api/v1/pro/lab/results', (ctx) => {
  const st = staff(ctx, ['LAB']);
  const conn = getDb();
  const passCode = String(ctx.body.pass ?? '').trim().toUpperCase();
  const appointment = conn.prepare('SELECT * FROM appointments WHERE pass_code = ?').get(passCode);
  if (!appointment) throw new ApiError(404, 'Pass introuvable.');
  if (appointment.facility_id !== st.facility_id) throw new ApiError(403, 'Ce pass concerne une autre structure.');

  const bpSys = num(ctx.body.bpSys);
  const bpDia = num(ctx.body.bpDia);
  const glucose = num(ctx.body.glucose);
  const hbsag = String(ctx.body.hbsag ?? '').toUpperCase();
  const hiv = String(ctx.body.hiv ?? '').toUpperCase();
  if (!bpSys || !bpDia || bpSys < 60 || bpSys > 260 || bpDia < 30 || bpDia > 160) throw new ApiError(400, 'Tension artérielle hors plage.');
  if (glucose == null || glucose < 0.2 || glucose > 6) throw new ApiError(400, 'Glycémie hors plage (g/L).');
  if (!['NEGATIF', 'POSITIF'].includes(hbsag)) throw new ApiError(400, 'Antigène HBs invalide.');
  if (!['NEGATIF', 'POSITIF'].includes(hiv)) throw new ApiError(400, 'Sérologie VIH invalide.');

  const target = svc.getUser(appointment.user_id);
  const dek = svc.serverDek(target);
  if (!dek) throw new ApiError(500, 'Coffre-fort indisponible.');
  const facility = svc.getFacility(appointment.facility_id);
  svc.addHealthResult({
    user: target,
    appointmentId: appointment.id,
    dek,
    payload: {
      bpSys,
      bpDia,
      glucose,
      hbsag,
      hiv,
      category: appointment.category,
      facilityId: appointment.facility_id,
      facilityName: facility?.name,
      source: 'CENTRE',
      collectedAt: svc.now(),
    },
    hasAlert: hbsag === 'POSITIF' || hiv === 'POSITIF',
  });
  conn.prepare("UPDATE appointments SET status = 'COMPLETED' WHERE id = ?").run(appointment.id);
  svc.notify(
    target.id,
    'RESULTS',
    'SIPA : nouvelle information',
    'Une nouvelle information est disponible dans votre espace personnel. Vous seul(e) pouvez y accéder.'
  );
  return { ok: true, delivered: true };
});

// Escalades & console conseiller
R('GET', '/api/v1/pro/escalations', (ctx) => {
  staff(ctx, ['COUNSELOR']);
  const rows = getDb()
    .prepare("SELECT * FROM chat_escalations WHERE status <> 'CLOSED' ORDER BY created_at DESC")
    .all();
  return { escalations: rows.map(serializeEscalation) };
});

R('GET', '/api/v1/pro/escalations/:id', (ctx) => {
  staff(ctx, ['COUNSELOR']);
  const row = getDb().prepare('SELECT * FROM chat_escalations WHERE id = ?').get(ctx.params.id);
  if (!row) throw new ApiError(404, 'Escalade introuvable.');
  return { escalation: serializeEscalation(row) };
});

R('POST', '/api/v1/pro/escalations/:id/message', (ctx) => {
  const st = staff(ctx, ['COUNSELOR']);
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM chat_escalations WHERE id = ?').get(ctx.params.id);
  if (!row) throw new ApiError(404, 'Escalade introuvable.');
  const body = String(ctx.body.body ?? '').slice(0, 1500).trim();
  if (!body) throw new ApiError(400, 'Message vide.');
  if (row.status === 'OPEN') conn.prepare("UPDATE chat_escalations SET status = 'IN_PROGRESS', counselor_id = ? WHERE id = ?").run(st.id, row.id);
  const message = storeMessage(row.user_id, 'COUNSELOR', body, row.id);
  globalThis.__sipaEvents?.emit?.(`escalation:${row.id}`, { type: 'message', message });
  globalThis.__sipaEvents?.emit?.('counselors', { type: 'escalation:message', escalationId: row.id, message });
  svc.notify(row.user_id, 'COUNSELOR', 'Nouveau message de votre conseiller', 'Une réponse vous attend dans la conversation d’accompagnement.');
  return { message };
});

R('PATCH', '/api/v1/pro/escalations/:id', (ctx) => {
  staff(ctx, ['COUNSELOR']);
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM chat_escalations WHERE id = ?').get(ctx.params.id);
  if (!row) throw new ApiError(404, 'Escalade introuvable.');
  const status = ['OPEN', 'IN_PROGRESS', 'CLOSED'].includes(ctx.body.status) ? ctx.body.status : null;
  if (!status) throw new ApiError(400, 'Statut invalide.');
  conn
    .prepare('UPDATE chat_escalations SET status = ?, closed_at = ? WHERE id = ?')
    .run(status, status === 'CLOSED' ? svc.now() : null, row.id);
  if (status === 'CLOSED') {
    storeMessage(row.user_id, 'SYSTEM', 'La conversation d’accompagnement est clôturée. Vous pouvez en ouvrir une nouvelle à tout moment.', row.id);
  }
  globalThis.__sipaEvents?.emit?.('counselors', { type: 'escalation:updated', escalationId: row.id, status });
  return { ok: true };
});

R('GET', '/api/v1/pro/me', (ctx) => {
  const st = staff(ctx);
  return {
    staff: {
      id: st.id,
      name: st.name,
      role: st.role,
      roleLabel: PROFILES[st.role]?.label ?? st.role,
      email: st.email,
      facility: svc.getFacility(st.facility_id),
    },
  };
});

// Statistiques anonymisées (export CSV district / officine)
R('GET', '/api/v1/pro/stats.csv', (ctx) => {
  const st = staff(ctx);
  const conn = getDb();
  const month = /^\d{4}-\d{2}$/.test(String(q(ctx, 'month', ''))) ? q(ctx, 'month') : new Date().toISOString().slice(0, 7);
  const rows = [['indicateur', 'perimetre', 'mois', 'valeur']];
  const add = (label, scope, value) => rows.push([label, scope, month, String(value)]);
  const facility = svc.getFacility(st.facility_id)?.name ?? 'National';

  if (st.role === 'PHARMACIE') {
    add('Autotests remis', facility, conn.prepare("SELECT COUNT(*) n FROM vouchers_qr WHERE facility_id = ? AND kind='AUTOTEST' AND used_at LIKE ?").get(st.facility_id, `${month}%`).n);
    add('Colis ARV remis', facility, conn.prepare("SELECT COUNT(*) n FROM arv_parcels WHERE pharmacy_id = ? AND status='DELIVERED' AND updated_at LIKE ?").get(st.facility_id, `${month}%`).n);
    add('Stock autotests disponible', facility, conn.prepare('SELECT available_qty q FROM pharmacy_stocks WHERE facility_id = ?').get(st.facility_id)?.q ?? 0);
  } else if (st.role === 'LAB') {
    add('Bilans 4-en-1 réalisés', facility, conn.prepare("SELECT COUNT(*) n FROM appointments WHERE facility_id = ? AND status='COMPLETED' AND created_at LIKE ?").get(st.facility_id, `${month}%`).n);
    add('Résultats avec alerte biologique', facility, conn.prepare("SELECT COUNT(*) n FROM health_results r JOIN users u ON u.id=r.user_id WHERE r.has_alert=1 AND r.created_at LIKE ?").get(`${month}%`).n);
    add('Rendez-vous à venir', facility, conn.prepare("SELECT COUNT(*) n FROM appointments WHERE facility_id = ? AND status='BOOKED'").get(st.facility_id).n);
  } else if (st.role === 'ARV_COORD') {
    for (const status of ['PREPARED', 'IN_TRANSIT', 'AT_PHARMACY', 'DELIVERED']) {
      add(`Colis ${status}`, facility, conn.prepare('SELECT COUNT(*) n FROM arv_parcels WHERE status = ?').get(status).n);
    }
  } else {
    add('Escalades ouvertes', 'National', conn.prepare("SELECT COUNT(*) n FROM chat_escalations WHERE status <> 'CLOSED'").get().n);
    add('Escalades clôturées', 'National', conn.prepare("SELECT COUNT(*) n FROM chat_escalations WHERE status='CLOSED'").get().n);
    add('Conversations assistées', 'National', conn.prepare("SELECT COUNT(DISTINCT user_id) n FROM chat_messages WHERE author='BOT'").get().n);
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return { __csv: csv, filename: `sipa-stats-${st.role.toLowerCase()}-${month}.csv` };
});

// =================================================================== Webhook
const sentWhatsApp = [];

async function sendWhatsApp(phone, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  sentWhatsApp.push({ phone: maskPhone(phone), text, at: svc.now(), delivered: Boolean(token && phoneId) });
  if (!token || !phoneId) {
    console.log(`[SIPA][WhatsApp:simulé] ${maskPhone(phone)} → ${text.slice(0, 90)}…`);
    return;
  }
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.replace('+', ''),
        type: 'text',
        text: { body: text },
      }),
    });
  } catch (error) {
    console.error('[SIPA][WhatsApp] échec d’envoi', error.message);
  }
}

R('GET', '/api/v1/webhooks/whatsapp', (ctx) => {
  const mode = q(ctx, 'hub.mode');
  const token = q(ctx, 'hub.verify_token');
  if (mode === 'subscribe' && token === (process.env.WHATSAPP_VERIFY_TOKEN ?? 'sipa-verify')) {
    return { __text: q(ctx, 'hub.challenge', ''), status: 200 };
  }
  throw new ApiError(403, 'Vérification du webhook refusée.');
});

R('POST', '/api/v1/webhooks/whatsapp', (ctx) => {
  const value = ctx.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const text = message?.text?.body ?? (message?.audio ? 'note vocale' : '');
  if (from && text) {
    const phone = normalizePhone(from);
    const u = svc.findUserByPhone(phone);
    if (!u) {
      sendWhatsApp(phone, 'Bienvenue sur SIPA. Créez votre espace confidentiel en 2 minutes, puis revenez ici : ' + (process.env.APP_ORIGIN ?? 'http://localhost:8787'));
    } else {
      const reply = buildReply({ user: u, text, channel: 'WHATSAPP' });
      storeMessage(u.id, 'USER', text, null, 'WHATSAPP');
      storeMessage(u.id, 'BOT', reply.text, null, 'WHATSAPP');
      sendWhatsApp(phone, whatsappText(reply));
    }
  }
  return { ok: true };
});

// ===================================================================== Méta
R('GET', '/api/v1/meta', () => ({
  app: 'SIPA',
  version: '1.0.0-prototype',
  region: 'Sénégal — Dakar & Thiès',
  vaultAlgorithm: 'AES-256-GCM',
  pinKdf: 'PBKDF2-SHA256 (120 000 itérations)',
  totpPeriod: 60,
  demo: process.env.SIPA_DEMO === '0' ? null : {
    user: { phone: '+221 77 123 45 67', pin: '123456', sipaCode: 'SIPA-4K7Q-SN' },
    staff: [
      { role: 'PHARMACIE', email: 'pharmacie@sipa.sn', password: 'SipaDemo2026' },
      { role: 'LAB', email: 'labo@sipa.sn', password: 'SipaDemo2026' },
      { role: 'ARV_COORD', email: 'coordination@sipa.sn', password: 'SipaDemo2026' },
      { role: 'COUNSELOR', email: 'conseiller@sipa.sn', password: 'SipaDemo2026' },
    ],
  },
}));

// ================================================================= Routage
export function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeParts = route.pattern.split('/').filter(Boolean);
    if (routeParts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i++) {
      const rp = routeParts[i];
      if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
      else if (rp !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function listRoutes() {
  return routes.map((r) => `${r.method} ${r.pattern}`);
}

export { sendWhatsApp, sentWhatsApp };
