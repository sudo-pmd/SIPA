// Pass de retrait, colis ARV scellés et parcours couple.
import { api, state } from '../api.js';
import { icon, esc, fmtDate, fmtDateTime, relative, toast, modal, speak } from '../ui.js';
import { showVoucherPass } from '../pass.js';
import { totp, secondsLeft } from '../totp.js';

const PARCEL_STEPS = [
  { id: 'PREPARED', label: 'Dotation préparée au centre' },
  { id: 'IN_TRANSIT', label: 'En acheminement vers l’officine' },
  { id: 'AT_PHARMACY', label: 'Arrivé dans votre pharmacie' },
  { id: 'DELIVERED', label: 'Remis, en main propre' },
];

export async function render(root) {
  const [vouchers, parcels] = await Promise.all([
    api('/api/v1/vouchers').catch(() => ({ vouchers: [] })),
    api('/api/v1/parcels').catch(() => ({ parcels: [] })),
  ]);

  const active = vouchers.vouchers.filter((v) => v.active);
  const history = vouchers.vouchers.filter((v) => !v.active);

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Retraits confidentiels</p>
      <h1>Mes pass & colis</h1>
      <p class="lede">Le code tourne toutes les 60 secondes : une capture d’écran ne peut pas être réutilisée.</p>
    </div>

    <section class="section" style="margin-top:0">
      <div class="section__head"><h2>Pass actifs</h2><a href="#/map?type=PHARMACIE">Réserver</a></div>
      ${
        active.length
          ? `<div class="stack">${active
              .map(
                (v) => `<div class="card">
                  <div class="card__title">
                    <div>
                      <p class="eyebrow">${v.kind === 'ARV_PARCEL' ? 'Pli scellé ARV' : 'Autotest VIH'}</p>
                      <h3>${esc(v.facility?.name ?? '')}</h3>
                      <p class="small muted" style="margin:3px 0 0">${esc(v.facility?.commune ?? '')} · valable jusqu’au ${fmtDate(
                        v.expiresAt
                      )}</p>
                    </div>
                    ${icon('qr', 24)}
                  </div>
                  <div class="row row--between" style="margin-top:14px">
                    <span class="tiny mono muted" data-live-code="${esc(v.id)}">SIPA-••••-••••••</span>
                    <button class="btn btn--sm" data-pass="${esc(v.id)}">Afficher</button>
                  </div>
                </div>`
              )
              .join('')}</div>`
          : `<div class="empty"><h3>Aucun pass actif</h3><p>Un autotest peut être réservé dans une officine agréée, sans un mot au comptoir.</p>
              <a class="btn btn--sm" href="#/map?type=PHARMACIE&reserve=1" style="margin-top:12px">Trouver une pharmacie</a></div>`
      }
    </section>

    <section class="section">
      <div class="section__head"><h2>Colis ARV</h2><span class="tiny muted">Étiquette neutre</span></div>
      ${
        parcels.parcels.length
          ? `<div class="stack">${parcels.parcels
              .map((p) => {
                const index = PARCEL_STEPS.findIndex((s) => s.id === p.status);
                return `<div class="card">
                  <div class="card__title">
                    <div>
                      <p class="eyebrow mono">${esc(p.trackingCode)}</p>
                      <h3>${esc(p.pharmacy?.name ?? '')}</h3>
                      <p class="small muted" style="margin:3px 0 0">Départ : ${esc(p.originCenter?.name ?? '')}</p>
                    </div>
                    <span class="pill ${p.status === 'DELIVERED' ? 'pill--ok' : p.status === 'AT_PHARMACY' ? 'pill--warn' : ''}">${
                      PARCEL_STEPS[index]?.label.split(' ')[0] ?? p.status
                    }</span>
                  </div>
                  <div class="timeline" style="margin-top:16px">
                    ${PARCEL_STEPS.map(
                      (step, i) => `<div class="timeline__step ${i < index ? 'is-done' : ''} ${i === index ? 'is-current' : ''}">
                        <div class="timeline__dot">${i < index ? '✓' : i + 1}</div>
                        <div><strong class="small">${step.label}</strong>
                        <span class="tiny muted" style="display:block">${
                          i === index ? `Mis à jour ${relative(p.updatedAt)}` : ''
                        }</span></div>
                      </div>`
                    ).join('')}
                  </div>
                  ${
                    p.status === 'AT_PHARMACY'
                      ? `<p class="small" style="margin:4px 0 0">Présentez votre pass et le code logistique du pli. Retrait en moins de 30 secondes, sans explication.</p>`
                      : ''
                  }
                </div>`;
              })
              .join('')}</div>`
          : `<div class="empty"><h3>Aucun colis en cours</h3><p>Votre centre de référence prépare votre dotation trimestrielle et l’achemine vers l’officine de votre choix.</p></div>`
      }
    </section>

    <section class="section">
      <div class="card">
        <p class="eyebrow">Suivi volontaire</p>
        <h3 style="font-size:16px">Enregistrer un résultat d’autotest</h3>
        <p class="small muted" style="margin:6px 0 12px">Uniquement si vous le souhaitez. Un résultat positif ouvre un accompagnement, jamais une notification à un tiers.</p>
        <div class="btn-row">
          <button class="btn btn--ghost btn--sm" data-report="NEGATIF">Négatif</button>
          <button class="btn btn--ghost btn--sm" data-report="POSITIF">Positif</button>
          <button class="btn btn--quiet" data-report="NON_FAIT">Je préfère ne pas répondre</button>
        </div>
      </div>
    </section>

    ${
      history.length
        ? `<section class="section">
            <div class="section__head"><h2>Historique</h2></div>
            <div class="list">
              ${history
                .slice(0, 6)
                .map(
                  (v) => `<div class="list__item">
                    <div class="list__icon">${icon('check', 15)}</div>
                    <div class="list__body"><strong>${v.kind === 'ARV_PARCEL' ? 'Pli remis' : 'Autotest retiré'}</strong>
                    <span>${esc(v.facility?.name ?? '')} · ${fmtDate(v.usedAt ?? v.expiresAt)}</span></div>
                  </div>`
                )
                .join('')}
            </div>
          </section>`
        : ''
    }`;

  root.querySelectorAll('[data-pass]').forEach((node) => {
    node.onclick = () => {
      const voucher = active.find((v) => v.id === node.dataset.pass);
      if (voucher) showVoucherPass(voucher);
    };
  });

  // Aperçu vivant du code dans la liste (sans ouvrir le pass).
  const updateCodes = async () => {
    for (const node of root.querySelectorAll('[data-live-code]')) {
      const voucher = active.find((v) => v.id === node.dataset.liveCode);
      if (!voucher?.totpSecret) continue;
      try {
        const code = await totp(voucher.totpSecret);
        node.textContent = `${voucher.codePrefix}-${code}`;
      } catch {
        node.textContent = voucher.codePrefix;
      }
    }
  };
  updateCodes();
  const interval = setInterval(() => {
    if (!document.body.contains(root)) {
      clearInterval(interval);
      return;
    }
    updateCodes();
  }, 1000);

  root.querySelectorAll('[data-report]').forEach((node) => {
    node.onclick = async () => {
      const result = node.dataset.report;
      try {
        const data = await api('/api/v1/vault/selftest-report', { method: 'POST', body: { result } });
        modal({
          title: result === 'POSITIF' ? 'Vous n’êtes pas seul(e)' : 'Suivi enregistré',
          subtitle: 'Confidentiel',
          body: `<p class="small">${esc(data.message ?? 'Merci.')}</p>
            ${
              result === 'POSITIF'
                ? `<div class="banner" style="margin-top:12px">${icon('shield', 16)}<span>Le traitement ARV est gratuit au Sénégal. I=I : indétectable = intransmissible.</span></div>
                   <button class="btn btn--block" style="margin-top:14px" id="talk">Parler à un conseiller</button>`
                : ''
            }`,
          actions: [{ label: 'Fermer', variant: 'ghost' }],
        });
        document.querySelector('#talk')?.addEventListener('click', async () => {
          await api('/api/v1/chat/escalate', { method: 'POST', body: { reason: 'REACTIVE_TEST' } });
          location.hash = '#/chat';
        });
      } catch (error) {
        toast(error.message, 'alert');
      }
    };
  });
}

// ------------------------------------------------------------------- Couple
export async function couple(root) {
  const { appointments } = await api('/api/v1/appointments');
  const shared = appointments.find((a) => a.coupleCode && a.status === 'BOOKED');

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Parcours prénuptial</p>
      <h1>Réserver ensemble,<br />rester chacun chez soi.</h1>
      <p class="lede">Deux partenaires, un même créneau, deux coffres-forts strictement hermétiques. Aucune fonction de l’application ne permet de consulter les résultats de l’autre.</p>
    </div>

    <div class="card card--ink">
      <p class="eyebrow">Le principe</p>
      <p class="small" style="margin:0;color:rgba(245,240,230,0.8)">
        Le code de liaison ne sert qu’à aligner l’heure du rendez-vous. Il ne donne accès à aucun résultat, aucun statut, aucune donnée médicale.
      </p>
    </div>

    ${
      shared
        ? `<section class="section">
            <div class="section__head"><h2>Votre créneau partagé</h2></div>
            <div class="card">
              <p class="eyebrow">Code de liaison</p>
              <p class="mono" style="font-size:22px;letter-spacing:0.12em;margin:4px 0 10px">${esc(shared.coupleCode)}</p>
              <p class="small muted">${esc(shared.facility?.name ?? '')} · ${esc(fmtDateTime(shared.slotAt))}</p>
              <div class="btn-row" style="margin-top:14px">
                <button class="btn btn--sm" id="copy-code">Transmettre le code</button>
                <a class="btn btn--ghost btn--sm" href="#/book?manage=1">Gérer</a>
              </div>
            </div>
          </section>`
        : ''
    }

    <section class="section">
      <div class="section__head"><h2>Rejoindre un créneau</h2></div>
      <form id="join-form" class="card">
        <div class="field" style="margin-bottom:12px">
          <label for="code">Code de liaison reçu</label>
          <input class="input mono" id="code" placeholder="RDV-CPL-000" autocomplete="off" maxlength="12" />
          <span class="hint">Votre partenaire vous l’a transmis. Vous réservez votre propre compte, au même horaire.</span>
        </div>
        <button class="btn btn--block" type="submit">Rejoindre le créneau</button>
      </form>
    </section>

    <section class="section">
      <div class="section__head"><h2>Ouvrir un créneau à deux</h2></div>
      <div class="card">
        <p class="small muted">Réservez un bilan prénuptial : un code RDV-CPL est généré automatiquement pour votre partenaire.</p>
        <a class="btn btn--block" href="#/book?category=PRENUPTIAL" style="margin-top:12px">Réserver un bilan prénuptial</a>
      </div>
    </section>

    <section class="section">
      <div class="card card--flat" style="background:transparent">
        <p class="eyebrow">Et si un résultat est positif ?</p>
        <p class="small muted">L’assistant propose un accompagnement individuel, sans jamais prévenir le partenaire. La médiation de couple se fait uniquement à la demande expresse de la personne concernée.</p>
      </div>
    </section>`;

  root.querySelector('#copy-code')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shared.coupleCode);
      toast('Code copié', 'ok');
    } catch {
      toast(shared.coupleCode);
    }
  });

  root.querySelector('#join-form').onsubmit = async (event) => {
    event.preventDefault();
    const code = root.querySelector('#code').value.trim().toUpperCase();
    try {
      const data = await api('/api/v1/appointments/couple', { method: 'POST', body: { code } });
      modal({
        title: 'Créneau rejoint',
        subtitle: data.appointment?.facility?.name,
        body: `<p class="small">${esc(fmtDateTime(data.appointment?.slotAt ?? new Date().toISOString()))}</p>
          <div class="banner" style="margin-top:12px">${icon('shield', 16)}<span>${esc(data.isolation)}</span></div>`,
        actions: [{ label: 'Fermer', variant: 'ghost' }],
      });
      render(root);
    } catch (error) {
      toast(error.message, 'alert');
    }
  };
}
