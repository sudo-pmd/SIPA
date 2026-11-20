// Cartographie des points d'accès : carte Leaflet/OSM, filtres, stocks, itinéraires.
import { api, state } from '../api.js';
import { icon, esc, modal, toast, ensureLib, stockPill } from '../ui.js';
import { cacheFacilities, readFacilitiesCache } from '../offline.js';
import { showVoucherPass } from '../pass.js';

const TYPES = [
  { id: '', label: 'Tout', icon: 'map' },
  { id: 'CENTRE_4EN1', label: 'Centres 4-en-1', icon: 'calendar' },
  { id: 'PHARMACIE', label: 'Pharmacies', icon: 'pin' },
  { id: 'ESPACE_ECOUTE', label: 'Espaces d’écoute', icon: 'chat' },
];

const TYPE_LABEL = {
  CENTRE_4EN1: 'Centre Bilan 4-en-1',
  PHARMACIE: 'Pharmacie agréée Sutura',
  ESPACE_ECOUTE: 'Espace d’écoute & médiation',
};

const TYPE_PIN = { CENTRE_4EN1: 'centre', PHARMACIE: 'pharmacie', ESPACE_ECOUTE: 'ecoute' };

export async function render(root, { params }) {
  const view = {
    type: params.get('type') ?? '',
    commune: params.get('commune') ?? '',
    query: '',
    coords: state.lastLocation ?? { lat: 14.6928, lng: -17.4467 },
    facilities: [],
    map: null,
    markers: [],
  };

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Autour de vous</p>
      <h1>Points d’accès</h1>
      <p class="lede">Centres de bilan, pharmacies agréées et espaces d’écoute. Les stocks d’autotests sont mis à jour par les officines.</p>
    </div>
    <div class="chips" id="filters">
      ${TYPES.map(
        (t) => `<button class="chip ${view.type === t.id ? 'is-active' : ''}" data-type="${t.id}">${icon(t.icon, 13)} ${t.label}</button>`
      ).join('')}
    </div>
    <div class="row" style="gap:8px;margin:6px 0 12px">
      <input class="input" id="search" placeholder="Pharmacie, centre, quartier" style="min-height:42px" />
      <button class="icon-btn" id="locate" title="Me localiser" style="flex:none;width:44px;height:44px">${icon('pin', 18)}</button>
    </div>
    <div class="map-wrap" id="map-wrap"><div id="map"></div></div>
    <p class="tiny muted" style="margin:8px 0 0" id="geo-note">Position approximative : Dakar. Activez la géolocalisation pour affiner.</p>
    <div class="section">
      <div class="section__head"><h2 id="count">Structures</h2><span class="tiny muted" id="sort-note">triées par distance</span></div>
      <div class="list" id="facility-list"></div>
    </div>
    <div class="section">
      <div class="card card--flat" style="background:transparent">
        <p class="eyebrow">Hors connexion</p>
        <p class="small muted" style="margin:0">Les structures de votre département sont mises en cache après la première consultation. La carte et les stocks restent consultables sans réseau.</p>
      </div>
    </div>`;

  const listNode = root.querySelector('#facility-list');
  const countNode = root.querySelector('#count');
  const geoNote = root.querySelector('#geo-note');

  async function load() {
    const qs = new URLSearchParams({
      lat: String(view.coords.lat),
      lng: String(view.coords.lng),
      radius: '120',
    });
    if (view.type) qs.set('type', view.type);
    if (view.commune) qs.set('commune', view.commune);
    if (view.query) qs.set('q', view.query);

    let facilities = [];
    try {
      const data = await api(`/api/v1/facilities?${qs.toString()}`);
      facilities = data.facilities ?? [];
      if (!view.type && !view.query && !view.commune) cacheFacilities(facilities);
    } catch {
      const cached = await readFacilitiesCache();
      facilities = cached.filter((f) => (view.type ? f.type === view.type : true));
      if (facilities.length) toast('Carte hors-ligne : données mises en cache.');
    }
    view.facilities = facilities;
    paintList();
    paintMap();
  }

  function paintList() {
    countNode.textContent = `${view.facilities.length} structure${view.facilities.length > 1 ? 's' : ''}`;
    if (!view.facilities.length) {
      listNode.innerHTML = `<div class="empty"><h3>Aucune structure trouvée</h3><p>Élargissez le filtre ou changez de commune.</p></div>`;
      return;
    }
    listNode.innerHTML = view.facilities
      .map(
        (f) => `
        <button class="list__item" data-facility="${esc(f.id)}">
          <div class="list__icon" style="background:${
            f.type === 'PHARMACIE' ? 'var(--teal-tint)' : f.type === 'CENTRE_4EN1' ? 'var(--terra-tint)' : 'var(--gold-tint)'
          };color:${f.type === 'PHARMACIE' ? 'var(--teal)' : f.type === 'CENTRE_4EN1' ? 'var(--terra)' : 'var(--gold)'}">
            ${icon(f.type === 'PHARMACIE' ? 'pin' : f.type === 'CENTRE_4EN1' ? 'calendar' : 'chat', 17)}
          </div>
          <div class="list__body">
            <strong>${esc(f.name)}</strong>
            <span>${esc(f.commune)}${f.city ? `, ${esc(f.city)}` : ''} · ${f.distanceKm != null ? `${f.distanceKm} km` : '—'}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
              ${f.type === 'PHARMACIE' ? stockPill(f.stockStatus) : ''}
              ${f.supportsArvRelay ? '<span class="pill pill--terra">Point relais ARV</span>' : ''}
            </div>
          </div>
          ${icon('chevron', 16)}
        </button>`
      )
      .join('');

    listNode.querySelectorAll('[data-facility]').forEach((node) => {
      node.onclick = () => showFacility(view.facilities.find((f) => f.id === node.dataset.facility));
    });
  }

  async function paintMap() {
    const wrap = root.querySelector('#map-wrap');
    const container = root.querySelector('#map');
    if (!navigator.onLine && !globalThis.L) {
      wrap.innerHTML = `<div class="map-fallback">${icon('wifi', 18)}<p style="margin-top:8px">Carte indisponible hors connexion. La liste ci-dessous reste complète.</p></div>`;
      return;
    }
    try {
      await ensureLib('leaflet', '/vendor/leaflet.js');
      await ensureLib('leaflet-css', '/vendor/leaflet.css', 'css');
    } catch {
      wrap.innerHTML = `<div class="map-fallback">La carte n’a pas pu être chargée. Utilisez la liste ci-dessous.</div>`;
      return;
    }
    const L = globalThis.L;
    if (!L) {
      wrap.innerHTML = `<div class="map-fallback">Carte indisponible. La liste ci-dessous reste complète.</div>`;
      return;
    }
    if (!view.map) {
      container.innerHTML = '';
      view.map = L.map(container, { zoomControl: false, attributionControl: true }).setView(
        [view.coords.lat, view.coords.lng],
        12
      );
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 18,
      }).addTo(view.map);
      L.control.zoom({ position: 'bottomright' }).addTo(view.map);
    }
    view.markers.forEach((marker) => marker.remove());
    view.markers = [];
    for (const facility of view.facilities) {
      const marker = L.marker([facility.lat, facility.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="pin pin--${TYPE_PIN[facility.type]}"><span></span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: facility.name,
      }).addTo(view.map);
      marker.on('click', () => showFacility(facility));
      view.markers.push(marker);
    }
    view.map.setView([view.coords.lat, view.coords.lng], 12);
  }

  function showFacility(facility) {
    if (!facility) return;
    const hours = Object.entries(facility.hours ?? {})
      .map(([key, value]) => {
        const labels = { mon_fri: 'Lun – Ven', sat: 'Samedi', sun: 'Dimanche' };
        return `<div class="row row--between"><span class="small muted">${labels[key] ?? key}</span><span class="small">${esc(value)}</span></div>`;
      })
      .join('');
    const canReserve = facility.type === 'PHARMACIE' && facility.stockStatus !== 'INDISPONIBLE';
    const dialog = modal({
      title: facility.name,
      subtitle: TYPE_LABEL[facility.type],
      body: `
        <div class="stack">
          <div class="row row--between"><span class="muted small">Adresse</span><strong class="small" style="text-align:right">${esc(
            facility.address
          )}</strong></div>
          <div class="row row--between"><span class="muted small">Distance</span><strong class="small">${
            facility.distanceKm != null ? `${facility.distanceKm} km` : '—'
          }</strong></div>
          ${facility.phone ? `<div class="row row--between"><span class="muted small">Téléphone</span><a class="small link" href="tel:${esc(facility.phone)}">${esc(facility.phone)}</a></div>` : ''}
          ${facility.type === 'PHARMACIE' ? `<div class="row row--between"><span class="muted small">Autotests</span>${stockPill(facility.stockStatus)}</div>` : ''}
          ${facility.supportsArvRelay ? `<div class="row row--between"><span class="muted small">Relais ARV</span><span class="pill pill--terra">Pli scellé accepté</span></div>` : ''}
          <hr class="rule" style="margin:8px 0" />
          <div>${hours}</div>
        </div>
        <div class="btn-row" style="margin-top:18px">
          ${
            canReserve
              ? `<button class="btn" id="reserve">${icon('qr', 15)} Réserver un autotest</button>`
              : facility.type === 'CENTRE_4EN1'
                ? `<a class="btn" href="#/book?facility=${encodeURIComponent(facility.id)}" data-close>Prendre rendez-vous</a>`
                : ''
          }
          <a class="btn btn--ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${facility.lat},${facility.lng}">Itinéraire</a>
        </div>
        <p class="tiny muted" style="margin-top:12px">Le code de retrait ne contient ni nom ni mention médicale. Aucun mot n’est nécessaire au comptoir.</p>`,
      actions: [{ label: 'Fermer', variant: 'ghost' }],
    });

    dialog.overlay.querySelector('#reserve')?.addEventListener('click', async () => {
      const button = dialog.overlay.querySelector('#reserve');
      button.disabled = true;
      try {
        const { voucher } = await api('/api/v1/vouchers/selftest', {
          method: 'POST',
          body: { facilityId: facility.id },
        });
        dialog.close();
        await showVoucherPass(voucher);
      } catch (error) {
        if (error.details?.voucher) {
          dialog.close();
          await showVoucherPass(error.details.voucher);
        } else {
          toast(error.message, 'alert');
          button.disabled = false;
        }
      }
    });
  }

  root.querySelectorAll('[data-type]').forEach((chip) => {
    chip.onclick = () => {
      view.type = chip.dataset.type;
      root.querySelectorAll('[data-type]').forEach((c) => c.classList.toggle('is-active', c === chip));
      load();
    };
  });

  let searchTimer;
  root.querySelector('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      view.query = event.target.value.trim();
      load();
    }, 280);
  });

  root.querySelector('#locate').onclick = () => {
    if (!navigator.geolocation) return toast('Géolocalisation indisponible.');
    geoNote.textContent = 'Recherche de votre position…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        view.coords = { lat: position.coords.latitude, lng: position.coords.longitude };
        state.lastLocation = view.coords;
        geoNote.textContent = 'Position GPS active. Distances calculées depuis votre position.';
        load();
      },
      () => {
        geoNote.textContent = 'Position refusée. Position approximative : Dakar.';
        toast('Géolocalisation refusée — position approximative conservée.');
      },
      { timeout: 8000, maximumAge: 60_000 }
    );
  };

  if (params.get('type')) view.type = params.get('type');
  await load();

  const focus = params.get('focus');
  if (focus) {
    const facility = view.facilities.find((f) => f.id === focus);
    if (facility) setTimeout(() => showFacility(facility), 350);
  }
  if (params.get('reserve') === '1') {
    const target = view.facilities.find((f) => f.type === 'PHARMACIE' && f.stockStatus !== 'INDISPONIBLE');
    if (target) setTimeout(() => showFacility(target), 500);
  }
}
