// Tableau de bord de l'usager.
import { api, state } from '../api.js';
import { icon, esc, fmtDateTime, fmtDate, relative, toast } from '../ui.js';
import { showVoucherPass, showAppointmentPass } from '../pass.js';

export async function render(root) {
  const [me, appointments, vouchers, parcels, notifs] = await Promise.all([
    api('/api/v1/me').catch(() => null),
    api('/api/v1/appointments').catch(() => ({ appointments: [] })),
    api('/api/v1/vouchers').catch(() => ({ vouchers: [] })),
    api('/api/v1/parcels').catch(() => ({ parcels: [] })),
    api('/api/v1/me/notifications').catch(() => ({ notifications: [] })),
  ]);

  if (me) {
    state.user = me.user;
    state.summary = me.summary;
  }
  const summary = me?.summary ?? {};
  const next = (appointments.appointments ?? [])
    .filter((a) => a.status === 'BOOKED')
    .sort((a, b) => new Date(a.slotAt) - new Date(b.slotAt))[0];
  const activeVouchers = (vouchers.vouchers ?? []).filter((v) => v.active);
  const activePass = activeVouchers[0];
  const activeParcel = (parcels.parcels ?? []).find((p) => p.status !== 'DELIVERED');
  const unreadNotifs = (notifs.notifications ?? []).slice(0, 3);
  const lastResult = summary.lastResultAt ? relative(summary.lastResultAt) : null;

  root.innerHTML = `
    ${
      navigator.onLine
        ? ''
        : `<div class="banner banner--offline" style="margin-bottom:14px">${icon('wifi', 16)}<span>Hors connexion — vos pass et données déjà consultées restent accessibles.</span></div>`
    }

    <section class="hero">
      <p class="eyebrow">Espace personnel</p>
      <h1>Bonjour ${esc(state.user?.pseudonym ?? '')},<br />votre santé vous appartient.</h1>
      <p class="lede">Tout ce qui vous concerne reste ici, scellé. Personne d’autre n’y a accès.</p>
      <div class="hero__meta">
        <span class="code-chip">${esc(state.user?.sipaCode ?? '')}</span>
        <button class="btn btn--sm" style="background:rgba(245,240,230,0.14);border:1px solid rgba(245,240,230,0.3)" id="open-vault">
          ${icon('shield', 14)} ${lastResult ? `Dernier bilan ${lastResult}` : 'Ouvrir mon coffre-fort'}
        </button>
      </div>
    </section>

    ${
      summary.lastResultAlert
        ? `<div class="banner banner--alert" style="margin-top:14px">${icon('bell', 16)}
            <span><b>Une information de santé demande votre attention.</b> Ouvrez votre coffre-fort pour la lire — vous pouvez aussi parler à un conseiller, sans aucune obligation.</span></div>`
        : ''
    }

    <section class="section">
      <div class="section__head"><h2>Que souhaitez-vous faire ?</h2></div>
      <div class="grid-2">
        <a class="card" href="#/book" style="text-decoration:none">
          <div class="list__icon" style="margin-bottom:10px">${icon('calendar', 18)}</div>
          <h3 style="font-size:15.5px">Bilan 4-en-1</h3>
          <p class="small muted" style="margin:2px 0 0">Tension, glycémie, hépatite B, VIH — 20 min.</p>
        </a>
        <a class="card" href="#/map?type=PHARMACIE&reserve=1" style="text-decoration:none">
          <div class="list__icon" style="margin-bottom:10px;background:var(--terra-tint);color:var(--terra)">${icon('pin', 18)}</div>
          <h3 style="font-size:15.5px">Autotest</h3>
          <p class="small muted" style="margin:2px 0 0">Retrait anonyme en officine agréée.</p>
        </a>
        <a class="card" href="#/map" style="text-decoration:none">
          <div class="list__icon" style="margin-bottom:10px;background:var(--gold-tint);color:var(--gold)">${icon('map', 18)}</div>
          <h3 style="font-size:15.5px">Autour de moi</h3>
          <p class="small muted" style="margin:2px 0 0">Centres, pharmacies, espaces d’écoute.</p>
        </a>
        <a class="card" href="#/chat" style="text-decoration:none">
          <div class="list__icon" style="margin-bottom:10px;background:#e7eef0;color:#33565c">${icon('chat', 18)}</div>
          <h3 style="font-size:15.5px">Assistant</h3>
          <p class="small muted" style="margin:2px 0 0">Une question ? En français ou en wolof.</p>
        </a>
      </div>
    </section>

    ${
      next
        ? `<section class="section">
            <div class="section__head"><h2>Prochain rendez-vous</h2><a href="#/book?manage=1">Gérer</a></div>
            <div class="card">
              <div class="card__title">
                <div>
                  <p class="eyebrow">${next.category === 'PRENUPTIAL' ? 'Bilan prénuptial' : next.category === 'CPN_MATERNITE' ? 'Consultation prénatale' : 'Bilan intégré 4-en-1'}</p>
                  <h3>${esc(next.facility?.name ?? '')}</h3>
                  <p class="small muted" style="margin:2px 0 0">${esc(fmtDateTime(next.slotAt))}</p>
                </div>
                <span class="pill">${esc(next.passCode)}</span>
              </div>
              <div class="btn-row" style="margin-top:14px">
                <button class="btn btn--sm" id="appt-pass">${icon('qr', 14)} Afficher mon pass</button>
                <a class="btn btn--ghost btn--sm" href="#/map?focus=${encodeURIComponent(next.facility?.id ?? '')}">Itinéraire</a>
              </div>
            </div>
          </section>`
        : ''
    }

    ${
      activePass
        ? `<section class="section">
            <div class="section__head"><h2>Pass de retrait</h2><a href="#/parcels">Tous mes pass</a></div>
            <div class="card card--ink">
              <div class="card__title">
                <div>
                  <p class="eyebrow">${activePass.kind === 'ARV_PARCEL' ? 'Pli scellé' : 'Autotest VIH'}</p>
                  <h3 style="color:var(--sand)">${esc(activePass.facility?.name ?? '')}</h3>
                  <p class="small" style="color:rgba(245,240,230,0.68);margin:4px 0 0">${esc(
                    activePass.facility?.commune ?? ''
                  )} · expire ${fmtDate(activePass.expiresAt)}</p>
                </div>
                ${icon('qr', 26)}
              </div>
              <button class="btn btn--sm" style="margin-top:14px;background:var(--sand);color:var(--teal)" id="voucher-pass">
                Afficher le pass tournant
              </button>
            </div>
          </section>`
        : ''
    }

    ${
      activeParcel
        ? `<section class="section">
            <div class="section__head"><h2>Colis ARV</h2><a href="#/parcels">Suivi</a></div>
            <a class="card" href="#/parcels" style="display:block;text-decoration:none">
              <div class="row row--between">
                <div>
                  <p class="eyebrow">${esc(activeParcel.trackingCode)}</p>
                  <h3 style="font-size:16px">${esc(activeParcel.pharmacy?.name ?? '')}</h3>
                  <p class="small muted" style="margin:4px 0 0">Étiquette neutre · scellé · ${
                    activeParcel.status === 'AT_PHARMACY' ? 'prêt au retrait' : activeParcel.status === 'IN_TRANSIT' ? 'en acheminement' : 'en préparation'
                  }</p>
                </div>
                ${icon('box', 22)}
              </div>
            </a>
          </section>`
        : ''
    }

    <section class="section">
      <div class="section__head"><h2>Votre couple</h2><a href="#/couple">Gérer</a></div>
      <a class="card" href="#/couple" style="display:block;text-decoration:none">
        <div class="row" style="align-items:flex-start">
          <div class="list__icon" style="background:var(--terra-tint);color:var(--terra)">${icon('shield', 18)}</div>
          <div>
            <h3 style="font-size:16px">Deux comptes, deux coffres</h3>
            <p class="small muted" style="margin:4px 0 0">Vous pouvez réserver un bilan prénuptial à deux, sur le même créneau. Chaque partenaire ne voit que ses propres résultats.</p>
          </div>
        </div>
      </a>
    </section>

    ${
      unreadNotifs.length
        ? `<section class="section">
            <div class="section__head"><h2>Dernières informations</h2><a href="#/notifications">Tout voir</a></div>
            <div class="list">
              ${unreadNotifs
                .map(
                  (n) => `<a class="list__item" href="#/notifications">
                    <div class="list__icon">${icon('bell', 16)}</div>
                    <div class="list__body"><strong>${esc(n.title)}</strong><span>${esc(n.body.slice(0, 86))}${n.body.length > 86 ? '…' : ''}</span></div>
                    <span class="tiny muted">${relative(n.createdAt)}</span>
                  </a>`
                )
                .join('')}
            </div>
          </section>`
        : ''
    }

    <section class="section">
      <div class="card card--flat" style="background:transparent">
        <p class="eyebrow">Sutura</p>
        <p class="small muted" style="margin:0">Aucune notification ne mentionne votre état de santé. Aucun message n’est jamais adressé à votre partenaire. Vous pouvez verrouiller l’application à tout moment depuis l’icône cadenas.</p>
      </div>
    </section>`;

  root.querySelector('#open-vault').onclick = () => {
    location.hash = '#/vault';
  };
  root.querySelector('#appt-pass')?.addEventListener('click', () => showAppointmentPass(next));
  root.querySelector('#voucher-pass')?.addEventListener('click', () => showVoucherPass(activePass));
}
