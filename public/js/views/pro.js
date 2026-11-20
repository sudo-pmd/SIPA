// Portail professionnel : 4 profils RBAC, scan caméra, saisie chiffrée,
// logistique des colis scellés, console d'escalade et export anonymisé.
import { api, state, setStaff, clearStaff, openProStream } from '../api.js';
import { icon, logo, esc, toast, modal, renderQR, fmtDateTime, download } from '../ui.js';

const NAV = {
  PHARMACIE: [
    { id: 'pharmacy', label: 'Retraits & stock' },
    { id: 'parcels', label: 'Colis ARV' },
    { id: 'stats', label: 'Export district' },
  ],
  LAB: [
    { id: 'lab', label: 'Saisie Bilan 4-en-1' },
    { id: 'stats', label: 'Export district' },
  ],
  ARV_COORD: [
    { id: 'parcels', label: 'Dotations scellées' },
    { id: 'stats', label: 'Export district' },
  ],
  COUNSELOR: [
    { id: 'counselor', label: 'Escalades' },
    { id: 'stats', label: 'Export national' },
  ],
};

const PARCEL_STATUS = {
  PREPARED: { label: 'Préparé', pill: '' },
  IN_TRANSIT: { label: 'En transit', pill: 'pill--warn' },
  AT_PHARMACY: { label: 'À l’officine', pill: 'pill--terra' },
  DELIVERED: { label: 'Remis', pill: 'pill--ok' },
};

const REASONS = {
  REACTIVE_TEST: 'Accompagnement post-test',
  PTME_PREGNANCY: 'Maternité / PTME',
  COUPLE_SUPPORT: 'Soutien de couple',
  OTHER: 'Écoute et orientation',
};

export async function render(root, { parts }) {
  stopScan();
  window.__sipaProClose?.();
  window.__sipaProClose = null;

  if (!state.staffToken) return paintLogin(root);
  if (!state.staff) {
    try {
      const { staff } = await api('/api/v1/pro/me', { useStaff: true });
      state.staff = staff;
    } catch {
      clearStaff();
      return paintLogin(root);
    }
  }

  const role = state.staff.role;
  const nav = NAV[role] ?? NAV.PHARMACIE;
  const page = parts[1] && nav.some((n) => n.id === parts[1]) ? parts[1] : nav[0].id;

  root.innerHTML = `
    <div class="pro-shell">
      <aside class="pro-side">
        ${logo()}
        <div class="pro-side__role">${esc(state.staff.roleLabel)}</div>
        <div class="pro-side__name">${esc(state.staff.name)}</div>
        <div class="pro-side__facility">${esc(state.staff.facility?.name ?? '')}</div>
        <nav class="pro-nav">
          ${nav.map((item) => `<a href="#/pro/${item.id}" class="${page === item.id ? 'is-active' : ''}">${item.label}</a>`).join('')}
        </nav>
        <div class="pro-side__foot">
          <a class="btn btn--sm" href="mailto:district@sipa.sn">Contacter le district</a>
          <button class="btn btn--sm" id="pro-logout">${icon('logout', 14)} Quitter</button>
        </div>
      </aside>
      <main class="pro-main" id="pro-main"></main>
    </div>`;

  root.querySelector('#pro-logout').onclick = () => {
    stopScan();
    window.__sipaProClose?.();
    clearStaff();
    state.staff = null;
    location.hash = '#/pro';
    paintLogin(root);
  };

  const main = root.querySelector('#pro-main');
  const pages = { pharmacy: pharmacyPage, lab: labPage, parcels: coordinatorPage, counselor: counselorPage, stats: statsPage };
  await (pages[page] ?? pharmacyPage)(main, root);
}

// ------------------------------------------------------------------- Connexion
function paintLogin(root) {
  root.innerHTML = `
    <div class="pro-login">
      <div class="pro-login__card">
        <div style="text-align:center;margin-bottom:18px">
          ${logo()}
          <p class="eyebrow" style="margin-top:18px">Portail professionnel</p>
          <h1 style="font-size:27px">Accès réservé</h1>
          <p class="small muted" style="margin-top:6px">Pharmaciens agréés, soignants des centres 4-en-1, coordinateurs ARV et conseillers.</p>
        </div>
        <form class="card" id="pro-form">
          <div class="field">
            <label for="email">Identifiant professionnel</label>
            <input class="input" id="email" type="email" autocomplete="username" placeholder="prenom@structure.sn" required />
          </div>
          <div class="field">
            <label for="password">Mot de passe</label>
            <input class="input" id="password" type="password" autocomplete="current-password" required />
          </div>
          <p class="error-text hide" id="err"></p>
          <button class="btn btn--block" type="submit">Se connecter</button>
        </form>
        ${
          state.meta?.demo
            ? `<div class="card" style="margin-top:14px">
                <p class="eyebrow">Comptes pilotes</p>
                <div class="stack" style="margin-top:8px">
                  ${state.meta.demo.staff
                    .map(
                      (s) => `<button class="list__item" data-demo="${esc(s.email)}" style="border:1px solid var(--line);border-radius:10px">
                        <div class="list__icon">${icon('shield', 15)}</div>
                        <div class="list__body"><strong>${esc(s.role)}</strong><span>${esc(s.email)}</span></div>
                        <span class="tiny muted">Utiliser</span>
                      </button>`
                    )
                    .join('')}
                </div>
                <p class="tiny muted" style="margin-top:10px">Mot de passe commun : <span class="mono">SipaDemo2026</span></p>
              </div>`
            : ''
        }
        <p class="tiny muted" style="text-align:center;margin-top:16px"><a class="link" href="#/home">← Retour à l’espace usager</a></p>
      </div>
    </div>`;

  const form = root.querySelector('#pro-form');
  root.querySelectorAll('[data-demo]').forEach((node) => {
    node.onclick = () => {
      root.querySelector('#email').value = node.dataset.demo;
      root.querySelector('#password').value = 'SipaDemo2026';
    };
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    const err = root.querySelector('#err');
    try {
      const data = await api('/api/v1/pro/auth/login', {
        method: 'POST',
        body: { email: root.querySelector('#email').value.trim(), password: root.querySelector('#password').value },
      });
      setStaff(data);
      location.hash = '#/pro';
      render(root, { parts: ['pro'] });
    } catch (error) {
      err.textContent = error.message;
      err.classList.remove('hide');
    }
  };
}

// ---------------------------------------------------------------- Pharmacie
async function pharmacyPage(main) {
  const [overview, parcels] = await Promise.all([
    api('/api/v1/pro/pharmacy/overview', { useStaff: true }),
    api('/api/v1/pro/pharmacy/parcels', { useStaff: true }).catch(() => ({ parcels: [] })),
  ]);

  main.innerHTML = `
    <header class="pro-head">
      <div>
        <p class="eyebrow">Officine agréée Sutura</p>
        <h1>Retraits confidentiels</h1>
        <p class="lede">Vous ne voyez ni nom, ni téléphone, ni statut médical. Uniquement un pass valide et un stock.</p>
      </div>
      <a class="btn btn--ghost btn--sm" href="#/pro/stats">${icon('download', 14)} Export</a>
    </header>

    <div class="pro-cards">
      <div class="pro-card"><span class="eyebrow">Autotests disponibles</span><b>${overview.stock?.available ?? 0}</b><span class="tiny muted">réservés : ${overview.stock?.reserved ?? 0}</span></div>
      <div class="pro-card"><span class="eyebrow">Pass actifs</span><b>${overview.activePasses}</b><span class="tiny muted">en attente de retrait</span></div>
      <div class="pro-card"><span class="eyebrow">Retraits du jour</span><b>${overview.redeemedToday}</b><span class="tiny muted">autotests et plis</span></div>
    </div>

    <div class="pro-grid">
      <section class="card">
        <p class="eyebrow">Protocole Zéro Parole</p>
        <h2 style="font-size:19px;margin-bottom:4px">Scanner un pass</h2>
        <p class="small muted">Le client présente son QR code. Aucune question, aucune vérification d’identité.</p>
        <div class="scan-frame" style="margin-top:12px">
          <video id="scan-video" muted playsinline></video>
          <div class="scan-frame__reticle"></div>
          <div class="scan-frame__hint" id="scan-hint">Activez la caméra pour scanner le QR code</div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn--sm" id="start-scan">${icon('camera', 14)} Activer la caméra</button>
          <button class="btn btn--ghost btn--sm" id="stop-scan">Arrêter</button>
        </div>
        <form id="redeem-form" style="margin-top:14px">
          <div class="field">
            <label for="scan">Code du pass</label>
            <input class="input mono" id="scan" placeholder="SIPA-XXXXXXXX-123456" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="tracking">Code logistique du pli (si colis ARV)</label>
            <input class="input mono" id="tracking" placeholder="COLIS-XXXX-SN" autocomplete="off" />
          </div>
          <p class="error-text hide" id="redeem-err"></p>
          <button class="btn btn--block" type="submit">Valider le retrait</button>
        </form>
        <div id="redeem-result"></div>
      </section>

      <div class="stack">
        <section class="card">
          <p class="eyebrow">Stock d’autotests</p>
          <div class="row row--between" style="margin:8px 0 12px">
            <span class="small muted">Quantité disponible</span>
            <strong style="font-family:var(--serif);font-size:24px">${overview.stock?.available ?? 0}</strong>
          </div>
          <form id="stock-form" class="row" style="gap:8px">
            <input class="input" id="stock" type="number" min="0" max="9999" value="${overview.stock?.available ?? 0}" style="min-height:42px" />
            <button class="btn btn--sm" type="submit">Mettre à jour</button>
          </form>
          <p class="tiny muted" style="margin-top:8px">La réservation d’un autotest décrémente le stock immédiatement et le verrouille 24 h.</p>
        </section>

        <section class="card">
          <p class="eyebrow">Colis en acheminement</p>
          ${
            parcels.parcels.filter((p) => p.status === 'IN_TRANSIT').length
              ? parcels.parcels
                  .filter((p) => p.status === 'IN_TRANSIT')
                  .map(
                    (p) => `<div class="row row--between" style="padding:10px 0;border-bottom:1px solid var(--line)">
                      <div><strong class="small mono">${esc(p.trackingCode)}</strong>
                      <span class="tiny muted" style="display:block">Étiquette neutre · aucune mention médicale</span></div>
                      <button class="btn btn--sm" data-receive="${esc(p.trackingCode)}">Accuser réception</button>
                    </div>`
                  )
                  .join('')
              : `<p class="small muted" style="margin:8px 0 0">Aucun colis en transit.</p>`
          }
        </section>
      </div>
    </div>`;

  main.querySelectorAll('[data-receive]').forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/api/v1/pro/parcels/${node.dataset.receive}/status`, {
          method: 'PATCH',
          useStaff: true,
          body: { status: 'AT_PHARMACY' },
        });
        toast('Réception enregistrée — le patient est notifié de façon neutre', 'ok');
        pharmacyPage(main);
      } catch (error) {
        toast(error.message, 'alert');
      }
    };
  });

  main.querySelector('#stock-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api('/api/v1/pro/pharmacy/stock', {
        method: 'PATCH',
        useStaff: true,
        body: { available: Number(main.querySelector('#stock').value) },
      });
      toast('Stock mis à jour', 'ok');
      pharmacyPage(main);
    } catch (error) {
      toast(error.message, 'alert');
    }
  };

  main.querySelector('#start-scan').onclick = () => startScan(main);

  main.querySelector('#stop-scan').onclick = () => {
    stopScan();
    const hint = main.querySelector('#scan-hint');
    if (hint) hint.textContent = 'Caméra arrêtée';
  };

  main.querySelector('#redeem-form').onsubmit = async (event) => {
    event.preventDefault();
    const scan = main.querySelector('#scan').value.trim();
    const tracking = main.querySelector('#tracking').value.trim();
    const err = main.querySelector('#redeem-err');
    err.classList.add('hide');
    try {
      const result = await api('/api/v1/pro/pharmacy/redeem', {
        method: 'POST',
        useStaff: true,
        body: { scan, tracking: tracking || undefined },
      });
      main.querySelector('#redeem-result').innerHTML = `
        <div class="card card--ok" style="margin-top:12px">
          <p class="eyebrow">Retrait validé</p>
          <p class="small" style="margin:0">${
            result.kind === 'AUTOTEST'
              ? 'Autotest remis. Stock décrémenté. Aucune information n’est affichée ni transmise.'
              : `Pli scellé remis (${esc(result.parcel?.trackingCode ?? '')}). Le patient est notifié de façon neutre.`
          }</p>
        </div>`;
      main.querySelector('#scan').value = '';
      main.querySelector('#tracking').value = '';
      toast('Retrait enregistré', 'ok');
      setTimeout(() => pharmacyPage(main), 1600);
    } catch (error) {
      err.textContent = error.message;
      err.classList.remove('hide');
    }
  };
}

// --------------------------------------------------------------- Caméra scan
async function startScan(main) {
  const video = main.querySelector('#scan-video');
  const hint = main.querySelector('#scan-hint');
  if (!video) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    hint.textContent = 'Caméra indisponible : saisissez le code manuellement.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    window.__sipaStream = stream;
    video.srcObject = stream;
    await video.play();
    hint.textContent = 'Présentez le QR code dans le cadre';

    if (!('BarcodeDetector' in window)) {
      hint.textContent = 'Lecture automatique non prise en charge par ce navigateur — saisissez le code ci-dessous.';
      return;
    }
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let last = '';
    const timer = setInterval(async () => {
      if (!document.body.contains(video) || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue && codes[0].rawValue !== last) {
          last = codes[0].rawValue;
          const field = main.querySelector('#scan');
          if (field) field.value = codes[0].rawValue;
          hint.textContent = 'Code détecté. Vérifiez puis validez.';
          if (navigator.vibrate) navigator.vibrate(60);
          stopScan();
        }
      } catch {
        /* image non exploitable */
      }
    }, 500);
    window.__sipaScanTimer = timer;
  } catch {
    hint.textContent = 'Accès caméra refusé. Saisissez le code manuellement.';
  }
}

function stopScan() {
  clearInterval(window.__sipaScanTimer);
  window.__sipaScanTimer = null;
  window.__sipaStream?.getTracks().forEach((track) => track.stop());
  window.__sipaStream = null;
}

// ---------------------------------------------------------------------- Labo
async function labPage(main) {
  const data = await api('/api/v1/pro/lab/appointments', { useStaff: true });
  main.innerHTML = `
    <header class="pro-head">
      <div>
        <p class="eyebrow">${esc(data.facility?.name ?? '')}</p>
        <h1>Saisie du Bilan 4-en-1</h1>
        <p class="lede">Une seule consultation de 20 minutes. Les quatre paramètres sont chiffrés à l’enregistrement.</p>
      </div>
      <a class="btn btn--ghost btn--sm" href="#/pro/stats">${icon('download', 14)} Export</a>
    </header>

    <div class="pro-grid">
      <section class="card">
        <p class="eyebrow">Scanner le pass</p>
        <form id="lookup" class="row" style="gap:8px;margin-top:8px">
          <input class="input mono" id="pass-code" placeholder="PASS-XXXX" autocomplete="off" />
          <button class="btn btn--sm" type="submit">Ouvrir</button>
        </form>
        <div class="scan-frame" style="margin-top:14px">
          <video id="scan-video" muted playsinline></video>
          <div class="scan-frame__reticle"></div>
          <div class="scan-frame__hint" id="scan-hint">Caméra : scan du pass d’arrivée</div>
        </div>
        <button class="btn btn--sm" id="start-scan" style="margin-top:10px">${icon('camera', 14)} Activer la caméra</button>
        <p class="tiny muted" style="margin-top:10px">Le pass ne contient ni nom ni indication médicale. Vous saisissez les quatre constantes, puis elles partent directement dans le coffre-fort chiffré de l’usager.</p>
      </section>

      <section class="card">
        <p class="eyebrow">File d’attente du jour</p>
        <div class="table" style="margin-top:8px">
          <table class="table">
            <thead><tr><th>Pass</th><th>Créneau</th><th>Motif</th><th></th></tr></thead>
            <tbody>
              ${
                data.appointments.length
                  ? data.appointments
                      .slice(0, 12)
                      .map(
                        (a) => `<tr>
                          <td class="mono">${esc(a.passCode)}</td>
                          <td>${esc(new Date(a.slotAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
                          <td>${a.category === 'PRENUPTIAL' ? 'Prénuptial' : a.category === 'CPN_MATERNITE' ? 'Prénatal' : 'Individuel'}</td>
                          <td>${
                            a.status === 'BOOKED'
                              ? `<button class="btn btn--sm" data-entry="${esc(a.passCode)}">Saisir</button>`
                              : '<span class="pill pill--ok">Transmis</span>'
                          }</td>
                        </tr>`
                      )
                      .join('')
                  : '<tr><td colspan="4" class="muted">Aucun rendez-vous.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>`;

  main.querySelector('#start-scan').onclick = () => startScan(main);
  main.querySelectorAll('[data-entry]').forEach((node) => {
    node.onclick = () => openResultForm(node.dataset.entry, main);
  });
  main.querySelector('#lookup').onsubmit = (event) => {
    event.preventDefault();
    openResultForm(main.querySelector('#pass-code').value.trim().toUpperCase(), main);
  };
}

function openResultForm(passCode, main) {
  const dialog = modal({
    title: 'Saisie des 4 paramètres',
    subtitle: `Pass ${passCode}`,
    body: `
      <div class="form-row">
        <div class="field"><label>Tension systolique</label><input class="input" id="bpSys" type="number" min="60" max="260" placeholder="120" required /><span class="hint">mmHg</span></div>
        <div class="field"><label>Tension diastolique</label><input class="input" id="bpDia" type="number" min="30" max="160" placeholder="80" required /><span class="hint">mmHg</span></div>
      </div>
      <div class="field"><label>Glycémie capillaire</label><input class="input" id="glucose" type="number" step="0.01" min="0.2" max="6" placeholder="0.95" required /><span class="hint">g/L</span></div>
      <div class="field"><label>Antigène HBs — hépatite B</label>
        <select class="input" id="hbsag"><option value="NEGATIF">Négatif</option><option value="POSITIF">Positif</option></select>
      </div>
      <div class="field"><label>Sérologie VIH</label>
        <select class="input" id="hiv"><option value="NEGATIF">Négatif</option><option value="POSITIF">Positif</option></select>
      </div>
      <div class="banner">${icon('shield', 16)}<span>Les valeurs sont chiffrées en AES-256-GCM avant écriture. Vous ne pourrez plus les consulter après validation.</span></div>
      <p class="error-text hide" id="err"></p>`,
    actions: [{ label: 'Annuler', variant: 'ghost' }, { label: 'Transmettre', variant: 'primary', keepOpen: true }],
  });

  dialog.overlay.querySelectorAll('[data-action]')[1].addEventListener('click', async () => {
    const err = dialog.overlay.querySelector('#err');
    try {
      await api('/api/v1/pro/lab/results', {
        method: 'POST',
        useStaff: true,
        body: {
          pass: passCode,
          bpSys: Number(dialog.overlay.querySelector('#bpSys').value),
          bpDia: Number(dialog.overlay.querySelector('#bpDia').value),
          glucose: Number(dialog.overlay.querySelector('#glucose').value),
          hbsag: dialog.overlay.querySelector('#hbsag').value,
          hiv: dialog.overlay.querySelector('#hiv').value,
        },
      });
      dialog.close();
      modal({
        title: 'Résultats transmis',
        subtitle: 'Coffre-fort de l’usager',
        body: `<p class="small">Les quatre paramètres ont été chiffrés et déposés dans le coffre-fort personnel. L’usager reçoit une information neutre, sans mention médicale.</p>
          <div class="banner" style="margin-top:12px">${icon('check', 16)}<span>Aucune copie en clair n’est conservée côté structure.</span></div>`,
        actions: [{ label: 'Terminer', variant: 'ghost' }],
      });
      labPage(main);
    } catch (error) {
      err.textContent = error.message;
      err.classList.remove('hide');
    }
  });
}

// ------------------------------------------------------------- Coordination
async function coordinatorPage(main) {
  const [parcels, facilities] = await Promise.all([
    api('/api/v1/pro/pharmacy/parcels', { useStaff: true }),
    api('/api/v1/facilities?type=PHARMACIE&radius=200').catch(() => ({ facilities: [] })),
  ]);
  const relay = facilities.facilities.filter((f) => f.supportsArvRelay);

  main.innerHTML = `
    <header class="pro-head">
      <div>
        <p class="eyebrow">Centre de traitement · ${esc(state.staff.facility?.name ?? '')}</p>
        <h1>Dotations scellées</h1>
        <p class="lede">Étiquette neutre uniquement : un code logistique, aucun nom, aucun traitement visible.</p>
      </div>
      <a class="btn btn--ghost btn--sm" href="#/pro/stats">${icon('download', 14)} Export</a>
    </header>

    <section class="card" style="margin-bottom:18px">
      <p class="eyebrow">Préparer une dotation trimestrielle</p>
      <form id="parcel-form" style="margin-top:10px">
        <div class="form-row">
          <div class="field">
            <label>Identifiant usager</label>
            <input class="input mono" id="sipa-code" placeholder="SIPA-XXXX-SN" required />
          </div>
          <div class="field">
            <label>Officine destinataire</label>
            <select class="input" id="pharmacy">
              ${relay.map((f) => `<option value="${esc(f.id)}">${esc(f.name)} — ${esc(f.commune)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="btn" type="submit">Générer l’étiquette scellée</button>
      </form>
      <p class="tiny muted" style="margin-top:8px">Le colis est créé au statut « préparé ». L’officine l’accuse réception à l’arrivée ; l’usager reçoit alors une information neutre.</p>
    </section>

    <section class="card">
      <div class="row row--between" style="margin-bottom:10px">
        <p class="eyebrow">Suivi logistique</p>
        <span class="tiny muted">${parcels.parcels.length} colis</span>
      </div>
      <div style="overflow-x:auto">
        <table class="table">
          <thead><tr><th>Étiquette</th><th>Usager</th><th>Officine</th><th>Statut</th><th>Actions</th></tr></thead>
          <tbody>
            ${
              parcels.parcels.length
                ? parcels.parcels
                    .map(
                      (p) => `<tr>
                        <td class="mono">${esc(p.trackingCode)}</td>
                        <td>${esc(p.sipaCode ?? '')}</td>
                        <td>${esc(p.pharmacy?.name ?? '')}</td>
                        <td><span class="pill ${PARCEL_STATUS[p.status]?.pill ?? ''}">${PARCEL_STATUS[p.status]?.label ?? p.status}</span></td>
                        <td><div class="table__actions">
                          <button class="btn btn--ghost btn--sm" data-label="${esc(p.trackingCode)}">Étiquette</button>
                          ${p.status === 'PREPARED' ? `<button class="btn btn--sm" data-advance="${esc(p.trackingCode)}" data-next="IN_TRANSIT">Expédier</button>` : ''}
                          ${p.status === 'IN_TRANSIT' ? `<button class="btn btn--sm" data-advance="${esc(p.trackingCode)}" data-next="AT_PHARMACY">Marquer reçu</button>` : ''}
                        </div></td>
                      </tr>`
                    )
                    .join('')
                : '<tr><td colspan="5" class="muted">Aucun colis</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>`;

  main.querySelector('#parcel-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/v1/pro/parcels', {
        method: 'POST',
        useStaff: true,
        body: {
          sipaCode: main.querySelector('#sipa-code').value.trim().toUpperCase(),
          pharmacyId: main.querySelector('#pharmacy').value,
        },
      });
      showLabel(data.parcel);
      coordinatorPage(main);
    } catch (error) {
      toast(error.message, 'alert');
    }
  };

  main.querySelectorAll('[data-advance]').forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/api/v1/pro/parcels/${node.dataset.advance}/status`, {
          method: 'PATCH',
          useStaff: true,
          body: { status: node.dataset.next },
        });
        toast('Statut logistique mis à jour', 'ok');
        coordinatorPage(main);
      } catch (error) {
        toast(error.message, 'alert');
      }
    };
  });

  main.querySelectorAll('[data-label]').forEach((node) => {
    node.onclick = () => {
      const parcel = parcels.parcels.find((p) => p.trackingCode === node.dataset.label);
      showLabel(parcel);
    };
  });
}

async function showLabel(parcel) {
  const dialog = modal({
    title: 'Étiquette neutre',
    subtitle: parcel?.pharmacy?.name ?? '',
    body: `
      <div class="pass" style="border-style:dashed">
        <p class="eyebrow">Pli scellé · usage strictement personnel</p>
        <div class="qr-slot" id="label-qr"></div>
        <p class="pass__code">${esc(parcel?.trackingCode ?? '')}</p>
        <p class="tiny muted" style="margin:8px 0 0">Aucun nom, aucune pathologie, aucun traitement.<br />Remise contre pass du destinataire + code logistique.</p>
      </div>`,
    actions: [{ label: 'Fermer', variant: 'ghost' }],
  });
  await renderQR(dialog.overlay.querySelector('#label-qr'), parcel?.trackingCode ?? '', { size: 130 });
}

// ---------------------------------------------------------------- Conseiller
async function counselorPage(main) {
  const data = await api('/api/v1/pro/escalations', { useStaff: true });
  const escalationList = data.escalations;
  const selectedId = window.__sipaSelectedEscalation ?? escalationList[0]?.id ?? null;
  const selected = escalationList.find((e) => e.id === selectedId) ?? escalationList[0] ?? null;
  window.__sipaSelectedEscalation = selected?.id ?? null;

  main.innerHTML = `
    <header class="pro-head">
      <div>
        <p class="eyebrow">Console d’accompagnement</p>
        <h1>Escalades en direct</h1>
        <p class="lede">Aucune donnée médicale n’est requise pour accompagner. Vous parlez à un pseudonyme.</p>
      </div>
      <span class="pill">${escalationList.length} conversation(s)</span>
    </header>
    <div class="pro-grid" style="grid-template-columns:320px 1fr">
      <section class="stack">
        ${
          escalationList.length
            ? escalationList
                .map(
                  (e) => `<button class="escalation ${selected?.id === e.id ? 'is-active' : ''}" data-escalation="${esc(e.id)}">
                    <strong>${esc(e.pseudonym ?? '')} · ${esc(e.sipaCode ?? '')}</strong>
                    <span>${esc(REASONS[e.reason] ?? e.reason)}</span>
                    <span class="tiny muted">${esc(fmtDateTime(e.createdAt))} · ${
                      e.status === 'OPEN' ? 'en attente' : e.status === 'IN_PROGRESS' ? 'en cours' : 'clôturée'
                    }</span>
                  </button>`
                )
                .join('')
            : `<div class="empty"><h3>Aucune escalade</h3><p>Les demandes de mise en relation apparaîtront ici en temps réel.</p></div>`
        }
      </section>
      <section class="card" id="thread-card">
        ${
          selected
            ? `<div class="row row--between">
                <div><p class="eyebrow">${esc(REASONS[selected.reason] ?? '')}</p>
                <h2 style="font-size:19px">${esc(selected.pseudonym ?? '')} <span class="tiny mono muted">${esc(selected.sipaCode ?? '')}</span></h2></div>
                ${selected.status !== 'CLOSED' ? `<button class="btn btn--ghost btn--sm" id="close-escalation">Clôturer</button>` : '<span class="pill">Clôturée</span>'}
              </div>
              <div class="pro-chat" id="pro-chat" style="margin-top:14px">
                ${selected.messages
                  .map(
                    (m) => `<div class="bubble bubble--${
                      m.author === 'COUNSELOR' ? 'user' : m.author === 'USER' ? 'bot' : 'system'
                    }">${m.author === 'COUNSELOR' ? '<div class="bubble__meta">Vous</div>' : ''}${esc(m.body)}</div>`
                  )
                  .join('')}
              </div>
              ${
                selected.status !== 'CLOSED'
                  ? `<form id="pro-reply" class="row" style="gap:8px;margin-top:14px">
                      <input class="input" id="pro-message" placeholder="Répondre avec bienveillance…" maxlength="1400" />
                      <button class="btn btn--sm" type="submit">Envoyer</button>
                    </form>`
                  : ''
              }
              <p class="tiny muted" style="margin-top:10px">Le message est transmis dans la conversation de l’usager et notifié de façon neutre.</p>`
            : `<div class="empty"><h3>Sélectionnez une conversation</h3><p>Les échanges sont chiffrés en transit et rattachés à un pseudonyme.</p></div>`
        }
      </section>
    </div>`;

  main.querySelectorAll('[data-escalation]').forEach((node) => {
    node.onclick = () => {
      window.__sipaSelectedEscalation = node.dataset.escalation;
      counselorPage(main);
    };
  });

  main.querySelector('#pro-reply')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = main.querySelector('#pro-message');
    if (!input.value.trim()) return;
    try {
      await api(`/api/v1/pro/escalations/${selected.id}/message`, {
        method: 'POST',
        useStaff: true,
        body: { body: input.value.trim() },
      });
      input.value = '';
      counselorPage(main);
    } catch (error) {
      toast(error.message, 'alert');
    }
  });

  main.querySelector('#close-escalation')?.addEventListener('click', async () => {
    try {
      await api(`/api/v1/pro/escalations/${selected.id}`, {
        method: 'PATCH',
        useStaff: true,
        body: { status: 'CLOSED' },
      });
      toast('Conversation clôturée', 'ok');
      counselorPage(main);
    } catch (error) {
      toast(error.message, 'alert');
    }
  });

  window.__sipaProClose = openProStream({
    onEvent: (event) => {
      if (!document.body.contains(main)) return;
      if (['escalation:new', 'escalation:message', 'escalation:updated'].includes(event.type)) {
        counselorPage(main);
      }
    },
  });
}

// --------------------------------------------------------------------- Stats
async function statsPage(main) {
  const month = new Date().toISOString().slice(0, 7);
  main.innerHTML = `
    <header class="pro-head">
      <div>
        <p class="eyebrow">Reporting district</p>
        <h1>Statistiques anonymisées</h1>
        <p class="lede">Comptages agrégés uniquement. Aucun identifiant, aucune donnée individuelle dans l’export.</p>
      </div>
    </header>
    <div class="pro-grid">
      <section class="card">
        <p class="eyebrow">Export CSV mensuel</p>
        <label class="field" style="margin-top:10px">
          <span class="tiny muted">Mois</span>
          <input class="input" type="month" id="month" value="${month}" />
        </label>
        <button class="btn" id="download">${icon('download', 15)} Télécharger l’export</button>
        <p class="tiny muted" style="margin-top:10px">Format : indicateur, périmètre, mois, valeur. Destiné au district sanitaire et à l’officine.</p>
      </section>
      <section class="card">
        <p class="eyebrow">Votre périmètre</p>
        <p class="small">${esc(state.staff.roleLabel)} · ${esc(state.staff.facility?.name ?? 'National')}</p>
        <hr class="rule" />
        <p class="small muted" style="margin:0">Les exports ne contiennent jamais de code SIPA, de numéro de téléphone, ni de résultat biologique individuel.</p>
      </section>
    </div>`;

  main.querySelector('#download').onclick = async () => {
    const value = main.querySelector('#month').value || month;
    try {
      const res = await fetch(`/api/v1/pro/stats.csv?month=${encodeURIComponent(value)}`, {
        headers: { authorization: `Bearer ${state.staffToken}` },
      });
      if (!res.ok) throw new Error('Export indisponible.');
      const text = await res.text();
      download(`sipa-stats-${value}.csv`, text);
      toast('Export téléchargé', 'ok');
    } catch (error) {
      toast(error.message, 'alert');
    }
  };
}
