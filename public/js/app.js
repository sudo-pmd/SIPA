// Amorçage de la PWA SIPA : routeur, verrouillage « Sutura », flux temps réel.
import { state, api, setSession, clearSession, setVault, clearStaff, openEventStream } from './api.js';
import { icon, logo, logoMark, toast, esc, modal } from './ui.js';
import * as auth from './views/auth.js';
import * as home from './views/home.js';
import * as mapView from './views/map.js';
import * as booking from './views/booking.js';
import * as vault from './views/vault.js';
import * as chat from './views/chat.js';
import * as parcels from './views/parcels.js';
import * as account from './views/account.js';
import * as pro from './views/pro.js';

const app = document.getElementById('app');
const LOCK_AFTER_MS = 60_000;
let lockTimer = null;
let unread = 0;
let closeStream = null;
let viewTransitionRunning = false;
let renderQueued = false;
let firstPaint = true;
let installPrompt = null;
let scrollHandler = null;

// ------------------------------------------------------------ Préférences UI
const prefersReducedMotion = () =>
  document.documentElement.dataset.motion === 'reduced' ||
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function setMotion(mode) {
  const reduced = mode === 'reduced';
  document.documentElement.dataset.motion = reduced ? 'reduced' : '';
  try {
    localStorage.setItem('sipa.motion', reduced ? 'reduced' : 'auto');
  } catch {
    /* stockage indisponible */
  }
  return reduced ? 'reduced' : 'auto';
}

export function motionSetting() {
  let stored = null;
  try {
    stored = localStorage.getItem('sipa.motion');
  } catch {
    stored = null;
  }
  return stored === 'reduced' ? 'reduced' : 'auto';
}

function applyMotionPreference() {
  if (motionSetting() === 'reduced') document.documentElement.dataset.motion = 'reduced';
}

applyMotionPreference();

function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash || splash.classList.contains('is-done')) return;
  splash.classList.add('is-done');
  setTimeout(() => splash.remove(), 500);
}

const NAV = [
  { route: 'home', label: 'Accueil', icon: 'home' },
  { route: 'map', label: 'Carte', icon: 'map' },
  { route: 'book', label: 'Bilan', icon: 'calendar' },
  { route: 'vault', label: 'Coffre', icon: 'shield' },
  { route: 'chat', label: 'Assistant', icon: 'chat' },
];

const ROUTES = {
  onboarding: { view: auth.onboarding, bare: true, public: true },
  home: { view: home.render },
  map: { view: mapView.render },
  book: { view: booking.render },
  vault: { view: vault.render },
  chat: { view: chat.render },
  parcels: { view: parcels.render },
  couple: { view: parcels.couple },
  notifications: { view: account.notifications },
  settings: { view: account.settings },
  pro: { view: pro.render, bare: true, pro: true },
};

export function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart ?? '');
  return { name: parts[0] || 'home', parts, params };
}

export function go(path) {
  location.hash = path.startsWith('#') ? path : `#/${path}`;
}

// ------------------------------------------------------------------- Chrome
function shellHTML(active) {
  return `
    <header class="topbar" id="topbar">
      ${logo()}
      <div class="topbar__actions">
        <span class="code-chip">${esc(state.user?.sipaCode ?? 'SIPA')}</span>
        <a class="icon-btn" href="#/notifications" aria-label="Notifications">
          ${icon('bell', 18)}${unread ? '<span class="dot"></span>' : ''}
        </a>
        <button class="icon-btn" id="lock-now" aria-label="Verrouiller l’application">${icon('lock', 18)}</button>
      </div>
    </header>
    <main id="screen" class="screen"></main>
    <nav class="dock" aria-label="Navigation principale">
      ${NAV.map(
        (item) => `<a href="#/${item.route}" class="${active === item.route ? 'is-active' : ''}">
          ${icon(item.icon, 19)}<span>${item.label}</span></a>`
      ).join('')}
    </nav>`;
}

// --------------------------------------------------------------- Verrouillage
export function lockNow(reason = 'manual') {
  if (!state.token) return;
  state.locked = true;
  clearTimeout(lockTimer);
  if (reason !== 'manual') document.body.classList.add('is-blurred');
  renderLock();
}

function scheduleLock() {
  clearTimeout(lockTimer);
  if (!state.token || state.locked) return;
  lockTimer = setTimeout(() => lockNow('inactivity'), LOCK_AFTER_MS);
}

function renderLock() {
  document.querySelector('.lock')?.remove();
  if (!state.token || !state.locked || proActive()) return;
  const node = document.createElement('div');
  node.className = 'lock';
  node.innerHTML = `
    <div class="lock__mark" style="color:#fff">${logoMark(42)}</div>
    <div>
      <p class="eyebrow">Espace personnel</p>
      <h1>${esc(state.user?.pseudonym ?? 'Votre espace')}</h1>
      <p class="muted small" style="margin-top:6px">Votre coffre-fort est verrouillé.</p>
    </div>
    <form id="lock-form" class="field">
      <input class="input input--pin" id="lock-pin" inputmode="numeric" autocomplete="off"
        maxlength="6" pattern="\\d{6}" placeholder="••••••" aria-label="Code PIN à 6 chiffres" required />
    </form>
    <div class="lock__actions">
      <button class="btn btn--block" id="lock-submit">Déverrouiller</button>
      ${state.credentialId ? `<button class="btn btn--ghost btn--block" id="lock-bio">${icon('shield', 16)} Face ID / empreinte</button>` : ''}
      <button class="btn--quiet" id="lock-offline" ${navigator.onLine ? 'hidden' : ''}>Consulter hors connexion</button>
    </div>
    <p class="lock__foot">Verrouillage automatique après 60 secondes d’inactivité ou au passage en arrière-plan. Aucune notification ne mentionne votre état de santé.</p>
    <button class="btn--quiet muted" id="lock-switch">Utiliser un autre compte</button>`;
  // Hors de #app : le filtre de confidentialité ne doit jamais déplacer la feuille.
  document.body.appendChild(node);

  const input = node.querySelector('#lock-pin');
  const submit = node.querySelector('#lock-submit');
  input.focus({ preventScroll: true });

  const fail = (message) => {
    toast(message, 'alert');
    input.value = '';
    input.focus();
  };

  const unlock = async () => {
    // La saisie des 6 chiffres et la soumission du formulaire peuvent se
    // déclencher ensemble : un seul appel d'ouverture doit partir.
    if (submit.disabled) return;
    const pin = input.value.trim();
    if (!/^\d{6}$/.test(pin)) return fail('Saisissez vos 6 chiffres.');
    submit.disabled = true;
    try {
      const opened = await api('/api/v1/vault/unlock', { method: 'POST', body: { pin } });
      setVault(opened);
      await afterUnlock(pin);
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        go('/onboarding');
        return;
      }
      fail(error.message);
    } finally {
      submit.disabled = false;
    }
  };

  node.querySelector('#lock-form').addEventListener('submit', (event) => {
    event.preventDefault();
    unlock();
  });

  // Saisie des 6 chiffres : déverrouillage automatique, sans appuyer sur le bouton.
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== input.value) input.value = digits;
    if (digits.length === 6 && !submit.disabled) setTimeout(unlock, 140);
  });

  node.querySelector('#lock-bio')?.addEventListener('click', async () => {
    try {
      const credential = await auth.assertBiometric();
      if (!credential) return;
      const result = await api('/api/v1/auth/webauthn/verify', {
        method: 'POST',
        body: { credentialId: credential },
      });
      setSession({ token: result.token, user: state.user });
      if (result.vault) setVault(result.vault);
      state.locked = false;
      document.body.classList.remove('is-blurred');
      node.remove();
      toast('Coffre-fort déverrouillé', 'ok');
      scheduleLock();
      render();
    } catch (error) {
      toast(error.status === 0 ? 'Biométrie indisponible hors connexion. Utilisez votre PIN.' : error.message, 'alert');
    }
  });

  node.querySelector('#lock-offline')?.addEventListener('click', async () => {
    const pin = input.value.trim();
    if (!/^\d{6}$/.test(pin)) return fail('Saisissez vos 6 chiffres pour ouvrir le coffre hors-ligne.');
    try {
      const snapshot = await auth.openOfflineVault(pin);
      state.offlineVault = snapshot;
      state.locked = false;
      document.body.classList.remove('is-blurred');
      node.remove();
      toast('Coffre hors-ligne ouvert', 'ok');
      go('/vault');
      render();
    } catch (error) {
      fail(error.message);
    }
  });

  node.querySelector('#lock-switch').addEventListener('click', () => {
    clearSession();
    go('/onboarding');
    render();
  });
}

export async function afterUnlock(pin) {
  state.locked = false;
  document.body.classList.remove('is-blurred');
  document.querySelector('.lock')?.remove();
  try {
    const { results } = await api('/api/v1/vault/results', { useVault: true });
    state.offlineVault = null;
    if (pin) await auth.saveOfflineVault(pin, results);
  } catch {
    /* instantané facultatif */
  }
  scheduleLock();
  render();
}

// ------------------------------------------------------------------- Session
export async function refreshMe() {
  const data = await api('/api/v1/me');
  state.user = data.user;
  state.summary = data.summary;
  unread = data.summary.unread;
  return data;
}

export async function refreshUnread() {
  try {
    const { notifications } = await api('/api/v1/me/notifications');
    unread = notifications.filter((n) => !n.read).length;
    document.querySelectorAll('.topbar .dot').forEach((dot) => dot.remove());
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'dot';
      document.querySelector('.topbar a[href="#/notifications"]')?.appendChild(badge);
    }
  } catch {
    /* hors-ligne */
  }
}

function proActive() {
  const { name } = parseRoute();
  return name === 'pro';
}

function handleStream() {
  closeStream?.();
  closeStream = openEventStream({
    onEvent: (event) => {
      if (event.type === 'notification') {
        unread += 1;
        refreshUnread();
        toast(event.notification.title, 'info');
        window.dispatchEvent(new CustomEvent('sipa:notification', { detail: event.notification }));
      }
      if (event.type === 'message') {
        window.dispatchEvent(new CustomEvent('sipa:message', { detail: event.message }));
        if (parseRoute().name !== 'chat') toast('Nouveau message de votre conseiller');
      }
    },
  });
}

async function boot() {
  try {
    state.meta = await api('/api/v1/meta');
  } catch {
    state.meta = null;
  }

  if (state.token) {
    try {
      await refreshMe();
      state.locked = true;
    } catch (error) {
      if (error.status === 401) clearSession();
    }
  }
  if (state.staffToken) {
    try {
      const { staff } = await api('/api/v1/pro/me', { useStaff: true });
      state.staff = staff;
    } catch {
      clearStaff();
    }
  }

  window.addEventListener('hashchange', () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    render();
  });

  // Installation de la PWA : invite native capturée pour les réglages.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    window.dispatchEvent(new Event('sipa:installable'));
  });
  window.addEventListener('online', () => render());
  window.addEventListener('offline', () => render());

  ['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
    window.addEventListener(
      evt,
      (event) => {
        if (state.locked) return;
        scheduleLock();
        if (event.target.closest?.('#lock-now') === null) document.body.classList.remove('is-blurred');
      },
      { passive: true }
    )
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      document.body.classList.add('is-blurred');
      if (state.token && !state.locked && !proActive()) {
        state.locked = true;
        clearTimeout(lockTimer);
      }
    } else {
      document.body.classList.remove('is-blurred');
      if (state.locked && state.token) renderLock();
    }
  });

  document.addEventListener('click', (event) => {
    const lockBtn = event.target.closest('#lock-now, [data-lock-now]');
    if (lockBtn) {
      event.preventDefault();
      lockNow('manual');
    }
  });

  if (state.token) handleStream();
  try {
    await render();
  } finally {
    hideSplash();
  }
  // Filet de sécurité si un écran reste bloqué en chargement.
  setTimeout(hideSplash, 2500);
}

async function paintCurrentRoute() {
  const { name, parts, params } = parseRoute();
  const def = ROUTES[name] ?? ROUTES.home;

  // Portail professionnel : mise en page dédiée, hors navigation usager.
  if (def.pro) {
    document.body.classList.remove('is-blurred');
    app.className = 'app pro';
    await def.view(app, { parts, params });
    return;
  }

  if (!state.token && !def.public) {
    location.hash = '#/onboarding';
    return;
  }

  if (def.bare) {
    app.className = 'app app--bare';
    await def.view(app, { params, parts });
    return;
  }

  app.className = 'app';
  app.innerHTML = shellHTML(name);
  const screen = app.querySelector('#screen');
  try {
    await def.view(screen, { params, parts });
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      location.hash = '#/onboarding';
      return;
    }
    screen.innerHTML = `<div class="empty"><h3>Impossible d’afficher cet écran</h3>
      <p>${esc(error.message)}</p><button class="btn btn--ghost" onclick="location.reload()">Réessayer</button></div>`;
  }

  const topbar = document.getElementById('topbar');
  if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
  scrollHandler = () => topbar?.classList.toggle('is-scrolled', window.scrollY > 6);
  window.addEventListener('scroll', scrollHandler, { passive: true });

  if (state.locked) renderLock();
  scheduleLock();
  refreshUnread();
}

// Une seule peinture à la fois. Une requête arrivée pendant une transition
// (redirection de route, événement temps réel) est rejouée juste après.
function flushRenderQueue() {
  if (!renderQueued) return;
  renderQueued = false;
  render();
}

// Transitions entre pages : View Transitions API quand elle est disponible,
// repli silencieux sur l'animation CSS d'écran sinon.
export async function render() {
  if (viewTransitionRunning) {
    renderQueued = true;
    return;
  }

  const useTransition =
    !firstPaint && document.startViewTransition && !prefersReducedMotion() && !state.locked;
  firstPaint = false;

  if (!useTransition) {
    try {
      await paintCurrentRoute();
    } finally {
      flushRenderQueue();
    }
    return;
  }

  viewTransitionRunning = true;
  let started = false;
  try {
    const transition = document.startViewTransition(async () => {
      started = true;
      await paintCurrentRoute();
    });
    await transition.finished.catch(() => {});
  } catch {
    if (!started) await paintCurrentRoute();
  } finally {
    viewTransitionRunning = false;
    flushRenderQueue();
  }
}

// Exposé pour les vues (formulaires, navigation programmatique).
window.SIPA = {
  go,
  render,
  state,
  toast,
  modal,
  icon,
  logoMark,
  setMotion,
  motionSetting,
  canInstall: () => Boolean(installPrompt),
  isStandalone: () =>
    window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true,
  async install() {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    installPrompt = null;
    return choice.outcome === 'accepted';
  },
};

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
