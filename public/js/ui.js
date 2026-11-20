// Composants d'interface partagés (aucune dépendance de build).
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
  map: '<path d="M9 3 3 5.5v16L9 19l6 2.5 6-2.5v-16L15 5.5 9 3Z"/><path d="M9 3v16M15 5.5v16"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  shield: '<path d="M12 3 4.5 6v6.2c0 4.4 3 7.5 7.5 9.3 4.5-1.8 7.5-4.9 7.5-9.3V6L12 3Z"/><path d="M9 12.2l2.2 2.2L15.4 10"/>',
  chat: '<path d="M4 5.5h16v10H9l-5 4v-14Z"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  qr: '<rect x="3.5" y="3.5" width="7" height="7"/><rect x="13.5" y="3.5" width="7" height="7"/><rect x="3.5" y="13.5" width="7" height="7"/><path d="M14 14h3v3h-3zM20 20h.5M13.5 20h2M20 13.5v2"/>',
  speaker: '<path d="M4 9.5h3L12 5v14l-5-4.5H4Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  camera: '<path d="M3.5 8.5h3l1.5-2h8l1.5 2h3v11h-17Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  download: '<path d="M12 3v12"/><path d="M7 10.5l5 5 5-5"/><path d="M4 20h16"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M15 8l4 4-4 4M9 12h10"/>',
  wifi: '<path d="M4 9a13 13 0 0 1 16 0M7 12.5a8 8 0 0 1 10 0M10 16a3 3 0 0 1 4 0"/><circle cx="12" cy="19" r="0.8"/>',
};

export function icon(name, size = 20) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

export function logo({ small = false } = {}) {
  return `<a class="brand ${small ? 'brand--sm' : ''}" href="#/home" aria-label="SIPA, accueil">
    <span class="brand__mark">S</span>
    <span class="brand__text"><b>SIPA</b><i>Sutura</i></span>
  </a>`;
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.innerHTML = `<span>${esc(message)}</span>`;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 320);
  }, kind === 'alert' ? 6000 : 3600);
}

export function modal({ title, subtitle = '', body = '', actions = [], dismissable = true, className = '' }) {
  const host = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal__head">
        <div>
          ${subtitle ? `<p class="eyebrow">${esc(subtitle)}</p>` : ''}
          <h2 class="modal__title">${esc(title)}</h2>
        </div>
        ${dismissable ? '<button class="icon-btn" data-close aria-label="Fermer">✕</button>' : ''}
      </header>
      <div class="modal__body">${body}</div>
      ${actions.length ? `<footer class="modal__foot">${actions
        .map(
          (a, i) =>
            `<button class="btn ${a.variant ?? 'ghost'}" data-action="${i}">${esc(a.label)}</button>`
        )
        .join('')}</footer>` : ''}
    </div>`;
  host.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  const close = () => {
    overlay.classList.remove('is-open');
    setTimeout(() => overlay.remove(), 220);
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && dismissable) close();
    if (event.target.closest('[data-close]')) close();
    const action = event.target.closest('[data-action]');
    if (action) {
      const index = Number(action.dataset.action);
      const handler = actions[index]?.onClick;
      if (handler) handler({ close, overlay });
      else if (!actions[index]?.keepOpen) close();
    }
  });
  return { close, overlay, body: overlay.querySelector('.modal__body') };
}

let libPromises = {};
export function ensureLib(name, src, type = 'script') {
  if (name === 'leaflet' && globalThis.L) return Promise.resolve();
  if (name === 'qrcode' && globalThis.qrcode) return Promise.resolve();
  if (libPromises[name]) return libPromises[name];
  libPromises[name] = new Promise((resolve, reject) => {
    const node = document.createElement(type === 'css' ? 'link' : 'script');
    if (type === 'css') {
      node.rel = 'stylesheet';
      node.href = src;
    } else {
      node.src = src;
      node.defer = true;
    }
    node.onload = () => resolve();
    node.onerror = () => {
      libPromises[name] = null;
      reject(new Error(`Ressource indisponible : ${name}`));
    };
    document.head.appendChild(node);
  });
  return libPromises[name];
}

export async function renderQR(target, text, { size = 190, dark = '#0e2b29', light = '#fffdf8' } = {}) {
  if (!target) return false;
  try {
    await ensureLib('qrcode', '/vendor/qrcode.js');
    const qr = globalThis.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true, darkColor: dark, lightColor: light });
    target.classList.add('qr');
    target.classList.remove('qr--fallback');
    const svg = target.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Pass numérique SIPA');
    }
    return true;
  } catch {
    target.classList.add('qr', 'qr--fallback');
    target.innerHTML = `<span class="qr__fallback">${esc(text)}</span>`;
    return false;
  }
}

export const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}h${mm}`;
}

export function fmtShort(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getHours()).padStart(2, '0')}h${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

export function relative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return fmtDate(iso);
}

export function stockPill(status) {
  if (status === 'DISPONIBLE') return '<span class="pill pill--ok">Autotests en stock</span>';
  if (status === 'STOCK_LIMITE') return '<span class="pill pill--warn">Stock limité</span>';
  return '<span class="pill pill--muted">Indisponible</span>';
}

export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function speak(text, lang = 'fr-FR') {
  if (!('speechSynthesis' in window)) {
    toast('Synthèse vocale indisponible sur cet appareil.');
    return false;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.94;
  window.speechSynthesis.speak(utterance);
  return true;
}

export function navigate(path) {
  location.hash = path.startsWith('#') ? path : `#/${path}`;
}

export function savecroll(selector) {
  const node = document.querySelector(selector);
  return node ? node.scrollTop : 0;
}
