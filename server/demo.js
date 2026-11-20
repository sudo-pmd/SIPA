// Comptes et parcours de démonstration, créés au premier démarrage.
import { getDb } from './db.js';
import * as svc from './service.js';

export function seedDemo() {
  const conn = getDb();
  const flag = conn.prepare("SELECT value FROM settings WHERE key = 'demo_seeded'").get();
  if (flag) return;

  const awa = svc.createUser({ phone: '+221771234567', pin: '123456', pseudonym: 'Awa D.' });
  if (awa.error) {
    conn.prepare("INSERT INTO settings (key,value) VALUES ('demo_seeded', ?)").run(new Date().toISOString());
    return;
  }
  const user = awa.user;
  const dek = svc.serverDek(user);
  // Identifiant stable pour la démonstration et la documentation.
  conn.prepare('UPDATE users SET sipa_code = ? WHERE id = ?').run('SIPA-4K7Q-SN', user.id);
  user.sipa_code = 'SIPA-4K7Q-SN';

  const now = Date.now();
  const older = new Date(now - 96 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(now - 12 * 24 * 3600 * 1000).toISOString();

  const insertResult = (payload, alert, at) => {
    const sealed = svc.sealResults(dek, payload);
    conn
      .prepare(
        'INSERT INTO health_results (id,user_id,appointment_id,cipher_payload,iv,has_alert,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(svc.uid('res_'), user.id, null, sealed.data, sealed.iv, alert ? 1 : 0, at);
  };

  insertResult(
    {
      bpSys: 118,
      bpDia: 76,
      glucose: 0.92,
      hbsag: 'NEGATIF',
      hiv: 'NEGATIF',
      facilityId: 'f-centre-medina',
      facilityName: 'Poste de santé de la Médina',
      category: 'BILAN_4EN1',
      source: 'CENTRE',
      collectedAt: older,
    },
    false,
    older
  );
  insertResult(
    {
      bpSys: 134,
      bpDia: 86,
      glucose: 1.14,
      hbsag: 'POSITIF',
      hiv: 'NEGATIF',
      facilityId: 'f-centre-pikine',
      facilityName: 'Centre de santé de Pikine',
      category: 'BILAN_4EN1',
      source: 'CENTRE',
      collectedAt: recent,
    },
    true,
    recent
  );

  // Rendez-vous prénuptial partagé (créneaux alignés, coffres-forts séparés)
  const slot = new Date(now + 3 * 24 * 3600 * 1000);
  slot.setHours(9, 20, 0, 0);
  const coupleCode = 'RDV-CPL-482';
  const first = svc.createAppointment({
    user,
    facilityId: 'f-centre-thies',
    category: 'PRENUPTIAL',
    slotAt: slot.toISOString(),
    coupleCode,
  });

  const moussa = svc.createUser({ phone: '+221776543210', pin: '123456', pseudonym: 'Moussa N.' });
  if (!moussa.error) {
    conn.prepare('UPDATE users SET sipa_code = ? WHERE id = ?').run('SIPA-9M2T-SN', moussa.user.id);
  }
  if (!moussa.error && first.appointment) {
    svc.createAppointment({
      user: moussa.user,
      facilityId: 'f-centre-thies',
      category: 'PRENUPTIAL',
      slotAt: slot.toISOString(),
      coupleCode,
    });
    const mdek = svc.serverDek(moussa.user);
    const sealed = svc.sealResults(mdek, {
      bpSys: 121,
      bpDia: 79,
      glucose: 0.88,
      hbsag: 'NEGATIF',
      hiv: 'NEGATIF',
      facilityId: 'f-centre-thies',
      facilityName: 'Centre de santé de Thiès',
      category: 'PRENUPTIAL',
      source: 'CENTRE',
      collectedAt: recent,
    });
    conn
      .prepare(
        'INSERT INTO health_results (id,user_id,appointment_id,cipher_payload,iv,has_alert,created_at) VALUES (?,?,?,?,?,0,?)'
      )
      .run(svc.uid('res_'), moussa.user.id, null, sealed.data, sealed.iv, recent);
  }

  // Pass autotest actif + colis ARV au comptoir
  svc.createAutotestVoucher(user, 'f-pharma-corniche');

  const coordinator = conn.prepare("SELECT * FROM staff WHERE role = 'ARV_COORD'").get();
  if (coordinator) {
    const parcel = svc.createParcel({
      coordinator,
      user,
      pharmacyId: 'f-pharma-corniche',
      originCenterId: 'f-centre-pikine',
    });
    if (parcel.parcel) svc.advanceParcel(coordinator, parcel.parcel.trackingCode, 'AT_PHARMACY');
  }

  conn.prepare("INSERT INTO settings (key,value) VALUES ('demo_seeded', ?)").run(new Date().toISOString());
  console.log('[SIPA] Comptes de démonstration créés (Awa D. & Moussa N.).');
}
