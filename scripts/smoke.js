// Test de bout en bout des parcours critiques du prototype (API réelle).
// Usage : node scripts/smoke.js [baseUrl]
const BASE = process.argv[2] ?? process.env.SIPA_URL ?? 'http://127.0.0.1:8787';

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label} ${detail ? `→ ${detail}` : ''}`);
  }
}

async function api(method, path, { token, vault, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(vault ? { 'x-vault-unlock-token': vault } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

async function login(phone, pin) {
  const res = await api('POST', '/api/v1/auth/pin', { body: { phone, pin } });
  return res;
}

const section = (title) => console.log(`\n${title}`);

async function main() {
  console.log(`SIPA — test de bout en bout sur ${BASE}`);

  section('1. Accès & coffre-fort « Sutura »');
  const bad = await login('+221771234567', '000000');
  ok('PIN erroné refusé', bad.status === 423, `HTTP ${bad.status}`);

  const awa = await login('+221771234567', '123456');
  ok('Connexion PIN de l’usager de démonstration', awa.status === 200 && awa.data.token, JSON.stringify(awa.data).slice(0, 120));
  const token = awa.data.token;
  ok('Identifiant anonyme SIPA-XXXX-SN', /^SIPA-[A-Z0-9]{4}-SN$/.test(awa.data.user?.sipaCode ?? ''), awa.data.user?.sipaCode);

  const vaultLocked = await api('GET', '/api/v1/vault/results', { token });
  ok('Coffre-fort verrouillé sans jeton de déverrouillage', vaultLocked.status === 401);

  const unlock = await api('POST', '/api/v1/vault/unlock', { token, body: { pin: '123456' } });
  ok('Déverrouillage du coffre par PIN', unlock.status === 200 && unlock.data.token);
  const results = await api('GET', '/api/v1/vault/results', { token, vault: unlock.data.token });
  ok('Résultats déchiffrés (AES-256-GCM)', results.status === 200 && results.data.results?.length >= 2, `${results.data.results?.length} résultat(s)`);
  ok('Alerte biologique signalée', results.data.results?.some((r) => r.hasAlert));

  section('2. Cartographie & stocks');
  const facilities = await api('GET', '/api/v1/facilities?lat=14.6928&lng=-17.4467&radius=80');
  ok('Structures géolocalisées et triées par distance', facilities.data.facilities?.length > 5 && facilities.data.facilities[0].distanceKm >= 0);
  const pharmacies = await api('GET', '/api/v1/facilities?lat=14.6928&lng=-17.4467&type=PHARMACIE');
  ok('Filtre pharmacies agréées', pharmacies.data.facilities?.every((f) => f.type === 'PHARMACIE'));
  ok('Statut de stock calculé', pharmacies.data.facilities?.every((f) => ['DISPONIBLE', 'STOCK_LIMITE', 'INDISPONIBLE'].includes(f.stockStatus)));

  section('3. Bilan 4-en-1');
  const slots = await api('GET', '/api/v1/facilities/f-centre-medina/slots');
  ok('Créneaux disponibles générés', slots.data.slots?.length > 0, `${slots.data.slots?.length} créneaux`);
  const booking = await api('POST', '/api/v1/appointments', {
    token,
    body: { facilityId: 'f-centre-medina', category: 'BILAN_4EN1', slotAt: slots.data.slots[0].at },
  });
  ok('Réservation avec pass numérique', booking.status === 200 && booking.data.appointment?.passCode?.startsWith('PASS-'), JSON.stringify(booking.data).slice(0, 140));

  const couple = await api('POST', '/api/v1/appointments/couple', { body: { code: 'RDV-CPL-482' }, token: (await login('+221771234567', '123456')).data.token });
  ok('Code couple refusé à son propre titulaire', couple.status === 400);

  section('4. Double circuit officinal');
  const vouchers = await api('GET', '/api/v1/vouchers', { token });
  const autotest = vouchers.data.vouchers?.find((v) => v.kind === 'AUTOTEST' && v.active);
  ok('Pass autotest actif avec code tournant', Boolean(autotest?.code) && Boolean(autotest?.totpSecret));

  const pharmaLogin = await api('POST', '/api/v1/pro/auth/login', {
    body: { email: 'pharmacie@sipa.sn', password: 'SipaDemo2026' },
  });
  ok('Connexion pharmacien', pharmaLogin.status === 200 && pharmaLogin.data.staff?.role === 'PHARMACIE');
  const pharmaToken = pharmaLogin.data.token;

  const scan = `${autotest.codePrefix}-${autotest.code}`;
  const redeem = await api('POST', '/api/v1/pro/pharmacy/redeem', { token: pharmaToken, body: { scan } });
  ok('Retrait autotest validé par QR/TOTP', redeem.status === 200 && redeem.data.kind === 'AUTOTEST', JSON.stringify(redeem.data).slice(0, 120));

  const replay = await api('POST', '/api/v1/pro/pharmacy/redeem', { token: pharmaToken, body: { scan } });
  ok('Rejeu du même pass refusé', replay.status === 400);

  const badScan = await api('POST', '/api/v1/pro/pharmacy/redeem', { token: pharmaToken, body: { scan: `${autotest.codePrefix}-000000` } });
  ok('Code tournant invalide refusé', badScan.status === 400);

  section('5. Colis ARV scellés');
  const coordLogin = await api('POST', '/api/v1/pro/auth/login', { body: { email: 'coordination@sipa.sn', password: 'SipaDemo2026' } });
  const parcel = await api('POST', '/api/v1/pro/parcels', {
    token: coordLogin.data.token,
    body: { sipaCode: 'SIPA-4K7Q-SN', pharmacyId: 'f-pharma-pikine' },
  });
  ok('Dotation scellée créée (code COLIS-XXXX-SN)', parcel.status === 200 && /^COLIS-[A-Z0-9]{4}-SN$/.test(parcel.data.parcel?.trackingCode ?? ''), JSON.stringify(parcel.data).slice(0, 140));
  const tracking = parcel.data.parcel?.trackingCode;
  ok('Aucune mention médicale sur l’étiquette', Object.keys(parcel.data.parcel ?? {}).every((k) => !/vih|arv|traitement/i.test(k)));

  await api('PATCH', `/api/v1/pro/parcels/${tracking}/status`, { token: coordLogin.data.token, body: { status: 'IN_TRANSIT' } });
  const arrived = await api('PATCH', `/api/v1/pro/parcels/${tracking}/status`, { token: coordLogin.data.token, body: { status: 'AT_PHARMACY' } });
  ok('Réception officine + pass généré', arrived.data.parcel?.status === 'AT_PHARMACY');

  const parcVoucher = (await api('GET', '/api/v1/vouchers', { token })).data.vouchers.find((v) => v.kind === 'ARV_PARCEL' && v.active);
  ok('Pass de retrait colis disponible', Boolean(parcVoucher));

  const pharma2 = await api('POST', '/api/v1/pro/auth/login', { body: { email: 'officine2@sipa.sn', password: 'SipaDemo2026' } });
  const noTracking = await api('POST', '/api/v1/pro/pharmacy/redeem', {
    token: pharma2.data.token,
    body: { scan: `${parcVoucher.codePrefix}-${parcVoucher.code}` },
  });
  ok('Double validation exigée (QR + code logistique)', noTracking.status === 400);
  const delivered = await api('POST', '/api/v1/pro/pharmacy/redeem', {
    token: pharma2.data.token,
    body: { scan: `${parcVoucher.codePrefix}-${parcVoucher.code}`, tracking },
  });
  ok('Colis remis après double validation', delivered.status === 200 && delivered.data.parcel?.status === 'DELIVERED');

  section('6. Saisie soignant & restitution chiffrée');
  const lab = await api('POST', '/api/v1/pro/auth/login', { body: { email: 'labo@sipa.sn', password: 'SipaDemo2026' } });
  const labToken = lab.data.token;
  const passCode = booking.data.appointment.passCode;
  const submit = await api('POST', '/api/v1/pro/lab/results', {
    token: labToken,
    body: { pass: passCode, bpSys: 126, bpDia: 82, glucose: 1.02, hbsag: 'NEGATIF', hiv: 'NEGATIF' },
  });
  ok('Saisie des 4 paramètres acceptée', submit.status === 200 && submit.data.delivered, JSON.stringify(submit.data).slice(0, 120));
  const after = await api('GET', '/api/v1/vault/results', { token, vault: unlock.data.token });
  ok('Nouveau résultat présent dans le coffre', after.data.results?.length === results.data.results.length + 1);
  ok('Aucune donnée médicale en clair côté soignant', !JSON.stringify(submit.data).includes('126'));

  section('7. Assistant conversationnel & escalade');
  const chat = await api('POST', '/api/v1/chat/message', {
    token,
    body: { text: 'Quelles pharmacies proches ont des autotests ?', lat: 14.6928, lng: -17.4467 },
  });
  ok('Recherche en langage naturel → officines en stock', chat.data.reply?.cards?.length > 0, JSON.stringify(chat.data).slice(0, 120));

  const positive = await api('POST', '/api/v1/chat/message', { token, body: { text: 'Mon test est positif, je ne sais pas quoi faire' } });
  ok('Protocole post-test : I=I et gratuité', /I=I/.test(positive.data.reply?.text ?? '') && /gratuit/i.test(positive.data.reply?.text ?? ''));
  ok('Garantie explicite : partenaire jamais notifié', /jamais envoyé à votre partenaire|jamais transmise/.test(positive.data.reply?.text ?? ''));

  const pregnancy = await api('POST', '/api/v1/chat/message', { token, body: { text: 'Je suis enceinte' } });
  ok('Passerelle PTME proposée', pregnancy.data.reply?.intent === 'PTME' && pregnancy.data.reply?.options?.some((o) => o.cta === 'ACTIVATE_MATERNITY'));

  const escalate = await api('POST', '/api/v1/chat/escalate', { token, body: { reason: 'REACTIVE_TEST' } });
  ok('Escalade créée', escalate.status === 200 && escalate.data.escalation?.status === 'OPEN');

  const counselor = await api('POST', '/api/v1/pro/auth/login', { body: { email: 'conseiller@sipa.sn', password: 'SipaDemo2026' } });
  const list = await api('GET', '/api/v1/pro/escalations', { token: counselor.data.token });
  ok('File d’escalade visible par le conseiller', list.data.escalations?.length >= 1);
  const reply = await api('POST', `/api/v1/pro/escalations/${escalate.data.escalation.id}/message`, {
    token: counselor.data.token,
    body: { body: 'Bonjour, je suis Mariama, conseillère. Nous allons avancer ensemble.' },
  });
  ok('Réponse conseiller envoyée', reply.status === 200);
  const thread = await api('GET', '/api/v1/chat/escalation', { token });
  ok('Message reçu côté usager', thread.data.escalation?.messages?.some((m) => m.author === 'COUNSELOR' && /Mariama/.test(m.body)));
  ok('Conversation marquée en cours', thread.data.escalation?.status === 'IN_PROGRESS');

  section('8. Cloisonnement des coffres-forts');
  const moussa = await login('+221776543210', '123456');
  const moussaUnlock = await api('POST', '/api/v1/vault/unlock', { token: moussa.data.token, body: { pin: '123456' } });
  const moussaResults = await api('GET', '/api/v1/vault/results', { token: moussa.data.token, vault: moussaUnlock.data.token });
  const moussaIds = new Set(moussaResults.data.results.map((r) => r.id));
  ok('Partenaires du même créneau : aucun résultat partagé', after.data.results.every((r) => !moussaIds.has(r.id)));
  const cross = await api('GET', '/api/v1/vault/results', { token: moussa.data.token, vault: unlock.data.token });
  ok('Jeton de coffre d’un tiers rejeté', cross.status === 401 || cross.status === 403);

  section('9. Notifications neutres & export');
  const notifs = await api('GET', '/api/v1/me/notifications', { token });
  ok('Aucune mention médicale dans les notifications', notifs.data.notifications?.every((n) => !/vih|positif|hépatite|arv/i.test(n.body)));
  const userParcels = await api('GET', '/api/v1/parcels', { token });
  ok('Suivi du colis livré', userParcels.data.parcels?.some((p) => p.status === 'DELIVERED'));
  const stats = await fetch(`${BASE}/api/v1/pro/stats.csv`, { headers: { authorization: `Bearer ${pharmaToken}` } });
  const csv = await stats.text();
  ok('Export CSV anonymisé', stats.headers.get('content-type')?.includes('csv') && csv.includes('indicateur') && !csv.includes('SIPA-'));
  ok('CSP et en-têtes de sécurité', (await fetch(`${BASE}/api/v1/health`)).headers.get('x-content-type-options') === 'nosniff');

  section('10. Webhook WhatsApp');
  const verification = await fetch(`${BASE}/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=sipa-verify&hub.challenge=12345`);
  ok('Vérification du webhook', (await verification.text()) === '12345');
  const hook = await api('POST', '/api/v1/webhooks/whatsapp', {
    body: { entry: [{ changes: [{ value: { messages: [{ from: '221771234567', type: 'text', text: { body: 'bilan 4-en-1' } }] } }] }] },
  });
  ok('Message WhatsApp traité', hook.status === 200);

  console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} vérifications réussies.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Erreur du test :', error);
  process.exit(1);
});
