// Coffre-fort sanitaire : déverrouillage PIN/biométrie, restitution pédagogique,
// attestation de passage sans résultat, fiches audio.
import { api, state, setVault, vaultToken } from '../api.js';
import { icon, esc, fmtDate, toast, modal, speak } from '../ui.js';
import { openOfflineVault } from './auth.js';

const INTERPRETATION = {
  tension: (sys, dia) => {
    if (sys == null || dia == null) return { tone: 'muted', label: 'Non mesurée', text: '' };
    if (sys < 120 && dia < 80) return { tone: 'ok', label: 'Normale', text: 'Votre tension est dans les valeurs habituellement recommandées.' };
    if (sys < 140 && dia < 90) return { tone: 'warn', label: 'À surveiller', text: 'Une tension légèrement élevée. À recontrôler dans quelques semaines, en limitant le sel.' };
    return { tone: 'alert', label: 'Élevée', text: 'Une tension élevée a été mesurée. Un avis médical est recommandé, sans urgence immédiate.' };
  },
  glycemie: (value) => {
    if (value == null) return { tone: 'muted', label: 'Non mesurée', text: '' };
    if (value < 1.1) return { tone: 'ok', label: 'Normale', text: 'Glycémie à jeun dans les valeurs usuelles.' };
    if (value < 1.26) return { tone: 'warn', label: 'Prédiabète', text: 'Une glycémie un peu haute : activité physique et alimentation moins sucrée, puis recontrôle.' };
    return { tone: 'alert', label: 'Élevée', text: 'Une glycémie élevée : une consultation pour confirmer et organiser le suivi est recommandée.' };
  },
  hepatite: (value) => {
    if (!value) return { tone: 'muted', label: 'Non réalisée', text: '' };
    return value === 'NEGATIF'
      ? { tone: 'ok', label: 'Négatif', text: 'Aucun antigène HBs détecté. La vaccination contre l’hépatite B reste le meilleur réflexe de protection.' }
      : { tone: 'alert', label: 'Positif', text: 'Antigène HBs détecté : une confirmation et un suivi hépatologique sont nécessaires. Ce n’est pas une urgence, et le suivi est accessible.' };
  },
  vih: (value) => {
    if (!value) return { tone: 'muted', label: 'Non réalisée', text: '' };
    return value === 'NEGATIF'
      ? { tone: 'ok', label: 'Négatif', text: 'Aucune infection par le VIH détectée. En cas d’exposition récente (moins de 6 semaines), un contrôle peut être proposé.' }
      : { tone: 'alert', label: 'Positif', text: 'Une sérologie positive doit être confirmée. Le traitement est gratuit au Sénégal, et I=I : sous traitement efficace, on ne transmet plus le virus.' };
  },
};

const resultSummary = (result) => {
  const v = result.values ?? {};
  const tension = INTERPRETATION.tension(v.bpSys, v.bpDia);
  const glycemie = INTERPRETATION.glycemie(v.glucose);
  const hepatite = INTERPRETATION.hepatite(v.hbsag);
  const vih = INTERPRETATION.vih(v.hiv);
  return { tension, glycemie, hepatite, vih };
};

export async function render(root) {
  let results = state.offlineVault?.results ?? null;
  let offline = Boolean(state.offlineVault);

  if (!results) {
    if (!vaultToken()) {
      paintLocked(root);
      return;
    }
    try {
      const data = await api('/api/v1/vault/results', { useVault: true });
      results = data.results;
    } catch (error) {
      if (error.details?.offline) {
        paintLocked(root, 'Connexion indisponible. Utilisez le déverrouillage hors-ligne.');
        return;
      }
      paintLocked(root, error.message);
      return;
    }
  }

  paintResults(root, results, offline);
}

function paintLocked(root, message = '') {
  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Coffre-fort sanitaire</p>
      <h1>Vos résultats,<br />sous scellés.</h1>
      <p class="lede">Chiffrement AES-256-GCM. La clé ne s’ouvre qu’avec votre code, ou votre empreinte si vous l’avez activée.</p>
    </div>
    <form class="card" id="unlock-form">
      <div class="field">
        <label for="pin">Code PIN à 6 chiffres</label>
        <input class="input input--pin" id="pin" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off" required />
      </div>
      ${message ? `<p class="error-text">${esc(message)}</p>` : ''}
      <button class="btn btn--block" type="submit">Déverrouiller mon coffre</button>
    </form>
    <div class="btn-row" style="margin-top:12px">
      ${
        state.credentialId
          ? `<button class="btn btn--ghost" id="bio">${icon('shield', 15)} Face ID / empreinte</button>`
          : ''
      }
      <a class="btn btn--ghost" href="#/settings">Gérer la sécurité</a>
    </div>
    <div class="section">
      <div class="card card--flat" style="background:transparent">
        <p class="eyebrow">Accès hors connexion</p>
        <p class="small muted" style="margin:0">Un instantané chiffré de vos derniers résultats est conservé sur cet appareil, protégé par votre PIN. Il reste lisible en 3G instable ou sans réseau.</p>
      </div>
    </div>`;

  root.querySelector('#unlock-form').onsubmit = async (event) => {
    event.preventDefault();
    const pin = root.querySelector('#pin').value.trim();
    if (!/^\d{6}$/.test(pin)) return toast('Saisissez 6 chiffres.', 'alert');
    try {
      let opened;
      try {
        opened = await api('/api/v1/vault/unlock', { method: 'POST', body: { pin } });
        setVault(opened);
      } catch (error) {
        if (error.details?.offline || error.status === 0) {
          const snapshot = await openOfflineVault(pin);
          state.offlineVault = snapshot;
          paintResults(root, snapshot.results, true);
          return;
        }
        throw error;
      }
      const { results } = await api('/api/v1/vault/results', { useVault: true });
      const { saveOfflineVault } = await import('./auth.js');
      await saveOfflineVault(pin, results);
      state.offlineVault = null;
      paintResults(root, results, false);
    } catch (error) {
      toast(error.message, 'alert');
    }
  };

  root.querySelector('#bio')?.addEventListener('click', async () => {
    try {
      const { assertBiometric } = await import('./auth.js');
      const credential = await assertBiometric();
      if (!credential) return;
      const opened = await api('/api/v1/vault/unlock', { method: 'POST', body: { credentialId: credential } });
      setVault(opened);
      const { results } = await api('/api/v1/vault/results', { useVault: true });
      paintResults(root, results, false);
    } catch (error) {
      toast(error.message, 'alert');
    }
  });
}

function paintResults(root, results, offline) {
  const sorted = [...results].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const latest = sorted[0];

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Coffre-fort sanitaire</p>
      <h1>Mes résultats</h1>
      <p class="lede">${sorted.length} bilan${sorted.length > 1 ? 's' : ''} enregistré${sorted.length > 1 ? 's' : ''}. Vous seul(e) pouvez les consulter.</p>
    </div>
    ${
      offline
        ? `<div class="banner banner--offline" style="margin-bottom:14px">${icon('wifi', 16)}<span>Copie hors connexion, déchiffrée sur cet appareil. Certaines données récentes peuvent manquer.</span></div>`
        : ''
    }

    ${
      latest?.hasAlert
        ? `<div class="card" style="border-color:#e5bfb2;background:var(--alert-tint);margin-bottom:16px">
            <p class="eyebrow" style="color:var(--alert)">À lire avec attention</p>
            <h3 style="font-size:17px">Un résultat nécessite une confirmation</h3>
            <p class="small" style="color:#7d3123;margin:6px 0 12px">Rien d’irréversible. Le traitement est gratuit au Sénégal, et un conseiller peut vous accompagner — sans jamais prévenir votre partenaire.</p>
            <div class="btn-row">
              <button class="btn btn--sm btn--terra" id="alert-talk">Parler à un conseiller</button>
              <a class="btn btn--ghost btn--sm" href="#/map?type=PHARMACIE&arv=1">Point relais ARV</a>
            </div>
          </div>`
        : ''
    }

    <div class="stack">
      ${
        sorted.length
          ? sorted.map(resultCard).join('')
          : `<div class="empty"><h3>Aucun résultat pour l’instant</h3><p>Après votre Bilan 4-en-1, vos quatre paramètres apparaîtront ici, chiffrés.</p>
             <a class="btn btn--sm" href="#/book" style="margin-top:12px">Réserver un bilan</a></div>`
      }
    </div>

    <section class="section">
      <div class="section__head"><h2>Attestation de passage</h2></div>
      <div class="card">
        <p class="small muted">Pour une démarche civile ou familiale, vous pouvez générer une attestation de passage au bilan préventif. Elle ne contient <b>aucun résultat médical</b>.</p>
        <button class="btn btn--ghost btn--sm" id="attestation" style="margin-top:10px">${icon('download', 14)} Générer (PDF)</button>
      </div>
    </section>

    <section class="section">
      <div class="card card--flat" style="background:transparent">
        <p class="eyebrow">Confidentialité</p>
        <p class="small muted" style="margin:0">Vos résultats sont chiffrés en AES-256-GCM avec une clé dérivée de votre PIN (PBKDF2, 200 000 itérations). La plateforme ne conserve aucune copie en clair, et aucune notification ne mentionne un résultat.</p>
      </div>
    </section>`;

  root.querySelector('#attestation')?.addEventListener('click', () => {
    const print = window.open('', '_blank');
    if (!print) return toast('Autorisez les fenêtres pour générer l’attestation.', 'alert');
    const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    print.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Attestation de passage SIPA</title>
      <style>
        body{font-family:Georgia,serif;color:#10211f;padding:56px;max-width:720px;margin:auto}
        h1{font-size:24px;letter-spacing:.06em}
        .rule{height:1px;background:#cfc5ae;margin:26px 0}
        .small{font-family:Arial,sans-serif;font-size:12px;color:#6d7c76;line-height:1.7}
        .code{font-family:monospace;font-size:16px;letter-spacing:.12em}
        .stamp{border:1px solid #123a5c;border-radius:10px;padding:14px 18px;margin-top:34px;font-family:Arial,sans-serif;font-size:12px}
      </style></head><body>
      <p class="small">RÉPUBLIQUE DU SÉNÉGAL · DISPOSITIF SIPA</p>
      <h1>Attestation de passage — Bilan préventif</h1>
      <div class="rule"></div>
      <p>Nous attestons que la personne titulaire de l’identifiant <span class="code">${esc(state.user?.sipaCode ?? '')}</span>,
      connue sous le pseudonyme <b>${esc(state.user?.pseudonym ?? '')}</b>, a effectué un bilan de santé préventif
      dans le cadre du dispositif SIPA.</p>
      <p><b>Date du passage :</b> ${latest ? fmtDate(latest.createdAt) : date}<br />
      <b>Structure :</b> ${esc(latest?.facilityName ?? 'Structure partenaire SIPA')}<br />
      <b>Nature :</b> Bilan intégré de prévention (tension, glycémie, hépatite B, VIH)</p>
      <div class="stamp">
        Aucun résultat biologique, aucun statut sérologique et aucune donnée de traitement ne figure sur ce document.
        Les résultats sont remis exclusivement à la personne titulaire, dans son coffre-fort numérique chiffré.
      </div>
      <p class="small" style="margin-top:34px">Délivré le ${date} · SIPA — Système Intégré de Prévention et d’Accès<br />
      Document généré par l’usager depuis son espace personnel. Toute reproduction non autorisée est sans valeur.</p>
      <script>window.onload=()=>window.print()</script>
      </body></html>`);
    print.document.close();
  });

  root.querySelector('#alert-talk')?.addEventListener('click', async () => {
    try {
      await api('/api/v1/chat/escalate', { method: 'POST', body: { reason: 'REACTIVE_TEST' } });
      location.hash = '#/chat';
    } catch (error) {
      toast(error.message, 'alert');
    }
  });

  root.querySelectorAll('[data-listen]').forEach((node) => {
    node.onclick = () => {
      const result = sorted.find((r) => r.id === node.dataset.listen);
      if (!result) return;
      const s = resultSummary(result);
      speak(
        `Bilan du ${fmtDate(result.createdAt)}. Tension ${result.values.bpSys} sur ${result.values.bpDia}, ${s.tension.label.toLowerCase()}. ` +
          `Glycémie ${String(result.values.glucose).replace('.', ' virgule ')}, ${s.glycemie.label.toLowerCase()}. ` +
          `Hépatite B, ${s.hepatite.label.toLowerCase()}. VIH, ${s.vih.label.toLowerCase()}. ` +
          `${result.hasAlert ? 'Un accompagnement vous est proposé, sans obligation.' : 'Continuez à prendre soin de vous.'}`
      );
    };
  });
}

function resultCard(result) {
  const s = resultSummary(result);
  const v = result.values;
  const cells = [
    { label: 'Tension', value: v.bpSys && v.bpDia ? `${v.bpSys}/${v.bpDia}` : '—', unit: 'mmHg', tone: s.tension.tone },
    { label: 'Glycémie', value: v.glucose != null ? String(v.glucose).replace('.', ',') : '—', unit: 'g/L', tone: s.glycemie.tone },
    { label: 'Hépatite B (HBs)', value: v.hbsag === 'POSITIF' ? 'Positif' : v.hbsag === 'NEGATIF' ? 'Négatif' : '—', unit: '', tone: s.hepatite.tone },
    { label: 'VIH', value: v.hiv === 'POSITIF' ? 'Positif' : v.hiv === 'NEGATIF' ? 'Négatif' : '—', unit: '', tone: s.vih.tone },
  ];
  return `
    <article class="card result-card">
      <div class="card__title">
        <div>
          <p class="eyebrow">${fmtDate(result.createdAt)} · ${esc(result.facilityName)}</p>
          <h3 style="font-size:17px">Bilan intégré 4-en-1</h3>
        </div>
        <button class="icon-btn" data-listen="${esc(result.id)}" aria-label="Écouter la fiche">${icon('speaker', 17)}</button>
      </div>
      <div class="result-grid">
        ${cells
          .map(
            (cell) => `<div class="result-cell ${cell.tone === 'alert' ? 'is-alert' : ''}">
              <span>${cell.label}</span>
              <b>${esc(cell.value)}</b> ${cell.unit ? `<small>${cell.unit}</small>` : ''}
            </div>`
          )
          .join('')}
      </div>
      <div class="result-note">
        <p style="margin:0 0 6px"><b class="small">Tension · ${s.tension.label}</b><br /><span class="small muted">${s.tension.text}</span></p>
        <p style="margin:0 0 6px"><b class="small">Glycémie · ${s.glycemie.label}</b><br /><span class="small muted">${s.glycemie.text}</span></p>
        <p style="margin:0 0 6px"><b class="small">Hépatite B · ${s.hepatite.label}</b><br /><span class="small muted">${s.hepatite.text}</span></p>
        <p style="margin:0"><b class="small">VIH · ${s.vih.label}</b><br /><span class="small muted">${s.vih.text}</span></p>
      </div>
      ${
        result.hasAlert
          ? `<div class="banner banner--alert" style="margin-top:12px">${icon('shield', 16)}<span>Traitement gratuit au Sénégal · I=I (indétectable = intransmissible). Aucune information n’est transmise à votre partenaire.</span></div>`
          : ''
      }
    </article>`;
}
