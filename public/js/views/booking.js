// Réservation d'un Bilan Intégré 4-en-1, gestion des rendez-vous.
import { api, state } from '../api.js';
import { icon, esc, fmtDate, fmtDateTime, toast, modal } from '../ui.js';
import { showAppointmentPass } from '../pass.js';

const CATEGORIES = [
  {
    id: 'BILAN_4EN1',
    title: 'Bilan individuel',
    text: 'Tension, glycémie, antigène HBs et sérologie VIH en une consultation de 20 minutes.',
  },
  {
    id: 'PRENUPTIAL',
    title: 'Bilan prénuptial, à deux',
    text: 'Un créneau commun, deux comptes hermétiques. Aucun résultat n’est partagé entre partenaires.',
  },
  {
    id: 'CPN_MATERNITE',
    title: 'Consultation prénatale (PTME)',
    text: 'Suivi maternité partenaire avec application du protocole de prévention mère-enfant.',
  },
];

export async function render(root, { params }) {
  if (params.get('manage') === '1') {
    await renderManage(root);
    return;
  }

  const model = {
    category: CATEGORIES.find((c) => c.id === params.get('category'))?.id ?? 'BILAN_4EN1',
    facilityId: params.get('facility') ?? null,
    slots: [],
    slotAt: null,
    facilities: [],
    loading: false,
  };

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Bilan Intégré · Xam Sa Yaram</p>
      <h1>Prendre soin de soi, simplement.</h1>
      <p class="lede">Quatre examens de santé publique, un seul rendez-vous. Aucune file d’attente dédiée, aucun étiquetage administratif.</p>
    </div>
    <div id="booking-body"></div>`;

  const body = root.querySelector('#booking-body');

  async function loadFacilities() {
    try {
      const data = await api('/api/v1/facilities?type=CENTRE_4EN1&lat=14.6928&lng=-17.4467&radius=120');
      model.facilities = data.facilities ?? [];
    } catch {
      model.facilities = [];
    }
    if (!model.facilityId && model.facilities.length) model.facilityId = model.facilities[0].id;
  }

  async function loadSlots() {
    if (!model.facilityId) return;
    try {
      const data = await api(`/api/v1/facilities/${model.facilityId}/slots`);
      model.slots = data.slots ?? [];
    } catch {
      model.slots = [];
    }
  }

  function paint() {
    const selected = model.facilities.find((f) => f.id === model.facilityId);
    const grouped = model.slots.reduce((acc, slot) => {
      const key = slot.at.slice(0, 10);
      (acc[key] ??= []).push(slot);
      return acc;
    }, {});

    body.innerHTML = `
      <section class="section" style="margin-top:0">
        <div class="section__head"><h2>1 · Motif</h2><span class="tiny muted">Obligatoire</span></div>
        <div class="stack">
          ${CATEGORIES.map(
            (c) => `<label class="radio-card ${model.category === c.id ? 'is-active' : ''}">
              <input type="radio" name="category" value="${c.id}" ${model.category === c.id ? 'checked' : ''} />
              <span><strong>${c.title}</strong><span>${c.text}</span></span>
            </label>`
          ).join('')}
        </div>
      </section>

      <section class="section">
        <div class="section__head"><h2>2 · Structure</h2><span class="tiny muted">${model.facilities.length} centres</span></div>
        <div class="list" id="facilities">
          ${
            model.facilities.length
              ? model.facilities
                  .map(
                    (f) => `<button class="list__item" data-facility="${esc(f.id)}">
                      <div class="list__icon">${icon('calendar', 16)}</div>
                      <div class="list__body"><strong>${esc(f.name)}</strong><span>${esc(f.commune)}${
                        f.distanceKm != null ? ` · ${f.distanceKm} km` : ''
                      }</span></div>
                      <span class="pill ${model.facilityId === f.id ? '' : 'pill--muted'}">${model.facilityId === f.id ? 'Choisi' : 'Choisir'}</span>
                    </button>`
                  )
                  .join('')
              : `<div class="empty"><h3>Centres indisponibles</h3><p>Vérifiez votre connexion.</p></div>`
          }
        </div>
      </section>

      <section class="section">
        <div class="section__head"><h2>3 · Créneau</h2><span class="tiny muted">20 min sur place</span></div>
        ${
          model.slots.length
            ? Object.entries(grouped)
                .map(
                  ([day, slots]) => `
                  <p class="eyebrow" style="margin:16px 0 8px">${fmtDate(`${day}T08:00:00`)}</p>
                  <div class="chips" style="flex-wrap:wrap;overflow:visible">
                    ${slots
                      .map(
                        (slot) =>
                          `<button class="chip ${model.slotAt === slot.at ? 'is-active' : ''}" data-slot="${esc(slot.at)}">${new Date(
                            slot.at
                          ).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</button>`
                      )
                      .join('')}
                  </div>`
                )
                .join('')
            : `<div class="empty"><h3>Aucun créneau affiché</h3><p>Sélectionnez une structure pour voir ses disponibilités.</p></div>`
        }
      </section>

      <div class="card card--ink" style="margin-top:20px">
        <div class="row row--between">
          <div>
            <p class="eyebrow">Votre réservation</p>
            <p class="small" style="margin:0;color:rgba(245,240,230,0.78)">
              ${model.slotAt ? esc(fmtDateTime(model.slotAt)) : 'Choisissez un créneau'}<br />
              ${selected ? esc(selected.name) : '—'}
            </p>
          </div>
          <button class="btn btn--sm" id="confirm" ${model.slotAt ? '' : 'disabled'} style="background:var(--sand);color:var(--teal)">Confirmer</button>
        </div>
        <p class="tiny" style="color:rgba(245,240,230,0.55);margin:12px 0 0">
          ${
            model.category === 'PRENUPTIAL'
              ? 'Un code RDV-CPL vous sera remis pour aligner le créneau de votre partenaire. Vos coffres-forts restent séparés.'
              : 'Le pass généré ne contient aucune information médicale.'
          }
        </p>
      </div>
      <p class="tiny muted" style="margin-top:16px">Annulation et report gratuits depuis l’application, sans appel téléphonique.</p>`;

    body.querySelectorAll('input[name="category"]').forEach((input) => {
      input.onchange = () => {
        model.category = input.value;
        paint();
      };
    });

    body.querySelectorAll('[data-facility]').forEach((node) => {
      node.onclick = async () => {
        model.facilityId = node.dataset.facility;
        model.slotAt = null;
        model.slots = [];
        paint();
        await loadSlots();
        paint();
      };
    });

    body.querySelectorAll('[data-slot]').forEach((node) => {
      node.onclick = () => {
        model.slotAt = node.dataset.slot;
        paint();
      };
    });

    body.querySelector('#confirm').onclick = async () => {
      const button = body.querySelector('#confirm');
      button.disabled = true;
      try {
        const data = await api('/api/v1/appointments', {
          method: 'POST',
          body: {
            facilityId: model.facilityId,
            category: model.category,
            slotAt: model.slotAt,
          },
        });
        await showAppointmentPass(data.appointment);
        if (model.category === 'PRENUPTIAL') {
          modal({
            title: 'Créneau prénuptial ouvert',
            subtitle: data.appointment.coupleCode,
            body: `<p class="small">Transmettez ce code à votre partenaire : <b class="mono">${esc(
              data.appointment.coupleCode
            )}</b>. Il ou elle créera son propre compte, rejoindra le même créneau, et recevra uniquement ses propres résultats.</p>
            <div class="banner" style="margin-top:12px">${icon('shield', 16)}<span>Aucun résultat n’est partagé automatiquement. Cette règle est structurelle, pas optionnelle.</span></div>`,
            actions: [{ label: 'Compris', variant: 'ghost' }],
          });
        }
        location.hash = '#/home';
      } catch (error) {
        toast(error.message, 'alert');
        button.disabled = false;
      }
    };
  }

  await loadFacilities();
  if (model.facilityId) await loadSlots();
  paint();
}

async function renderManage(root) {
  const { appointments } = await api('/api/v1/appointments');
  const sorted = appointments.sort((a, b) => new Date(b.slotAt) - new Date(a.slotAt));

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Mes rendez-vous</p>
      <h1>Gérer mes créneaux</h1>
      <p class="lede">Report et annulation immédiats, sans appel.</p>
    </div>
    <div class="stack" id="appointments">
      ${
        sorted.length
          ? sorted
              .map(
                (a) => `<div class="card" data-appt="${esc(a.id)}">
                  <div class="card__title">
                    <div>
                      <p class="eyebrow">${
                        a.category === 'PRENUPTIAL' ? 'Prénuptial' : a.category === 'CPN_MATERNITE' ? 'Prénatale' : 'Bilan 4-en-1'
                      } · ${esc(a.passCode)}</p>
                      <h3>${esc(a.facility?.name ?? '')}</h3>
                      <p class="small muted" style="margin:3px 0 0">${esc(fmtDateTime(a.slotAt))}</p>
                    </div>
                    <span class="pill ${
                      a.status === 'BOOKED' ? 'pill--ok' : a.status === 'CANCELLED' ? 'pill--muted' : ''
                    }">${a.status === 'BOOKED' ? 'Confirmé' : a.status === 'CANCELLED' ? 'Annulé' : 'Réalisé'}</span>
                  </div>
                  ${
                    a.coupleCode ? `<p class="small" style="margin-top:10px">Code couple : <b class="mono">${esc(a.coupleCode)}</b></p>` : ''
                  }
                  ${
                    a.status === 'BOOKED'
                      ? `<div class="btn-row" style="margin-top:12px">
                          <button class="btn btn--sm" data-pass="${esc(a.id)}">${icon('qr', 13)} Pass</button>
                          <button class="btn btn--ghost btn--sm" data-reschedule="${esc(a.id)}">Reporter</button>
                          <button class="btn btn--danger btn--sm" data-cancel="${esc(a.id)}">Annuler</button>
                        </div>`
                      : ''
                  }
                </div>`
              )
              .join('')
          : `<div class="empty"><h3>Aucun rendez-vous</h3><p>Réservez un Bilan 4-en-1 en quelques secondes.</p>
              <a class="btn btn--sm" href="#/book" style="margin-top:12px">Réserver</a></div>`
      }
    </div>
    <a class="btn btn--ghost btn--block" href="#/book" style="margin-top:18px">Nouveau rendez-vous</a>`;

  root.querySelectorAll('[data-pass]').forEach((node) => {
    node.onclick = () => {
      const appointment = sorted.find((a) => a.id === node.dataset.pass);
      showAppointmentPass(appointment);
    };
  });

  root.querySelectorAll('[data-cancel]').forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/api/v1/appointments/${node.dataset.cancel}/cancel`, { method: 'PATCH' });
        toast('Rendez-vous annulé', 'ok');
        renderManage(root);
      } catch (error) {
        toast(error.message, 'alert');
      }
    };
  });

  root.querySelectorAll('[data-reschedule]').forEach((node) => {
    node.onclick = async () => {
      const appointment = sorted.find((a) => a.id === node.dataset.reschedule);
      const dialog = modal({
        title: 'Reporter le rendez-vous',
        subtitle: appointment.facility?.name,
        body: `<p class="small muted">Choisissez un nouveau créneau.</p><div id="slot-list" class="chips" style="flex-wrap:wrap;margin-top:12px">Chargement…</div>`,
        actions: [{ label: 'Fermer', variant: 'ghost' }],
      });
      const { slots } = await api(`/api/v1/facilities/${appointment.facility.id}/slots`);
      const slotList = dialog.overlay.querySelector('#slot-list');
      slotList.innerHTML = slots
        .slice(0, 24)
        .map(
          (slot) =>
            `<button class="chip" data-slot="${esc(slot.at)}">${new Date(slot.at).toLocaleString('fr-FR', {
              weekday: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}</button>`
        )
        .join('');
      slotList.querySelectorAll('[data-slot]').forEach((chip) => {
        chip.onclick = async () => {
          try {
            await api(`/api/v1/appointments/${appointment.id}/reschedule`, {
              method: 'POST',
              body: { slotAt: chip.dataset.slot },
            });
            dialog.close();
            toast('Rendez-vous reporté', 'ok');
            renderManage(root);
          } catch (error) {
            toast(error.message, 'alert');
          }
        };
      });
    };
  });
}
