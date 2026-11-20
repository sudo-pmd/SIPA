// Notifications strictement neutres et réglages de sécurité.
import { api, state, clearSession } from '../api.js';
import { icon, esc, relative, toast, modal } from '../ui.js';
import { registerBiometric } from './auth.js';
import { hasSnapshot, clearSnapshot } from '../offline.js';

// Préférence de mouvement (transitions d'écran et animations).
function readMotion() {
  try {
    return localStorage.getItem('sipa.motion') === 'reduced' ? 'reduced' : 'auto';
  } catch {
    return 'auto';
  }
}

function writeMotion(mode) {
  document.documentElement.dataset.motion = mode === 'reduced' ? 'reduced' : '';
  try {
    localStorage.setItem('sipa.motion', mode);
  } catch {
    /* stockage indisponible */
  }
}

const KIND_ICON = {
  WELCOME: 'shield',
  APPOINTMENT: 'calendar',
  VOUCHER: 'qr',
  PARCEL: 'box',
  RESULTS: 'shield',
  COUNSELOR: 'chat',
  ESCALATION: 'chat',
  SUPPORT: 'chat',
  SELFTEST_REMINDER: 'bell',
};

export async function notifications(root) {
  const { notifications: list } = await api('/api/v1/me/notifications');

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Informations</p>
      <h1>Votre espace,<br />sans jamais vous exposer.</h1>
      <p class="lede">Aucun libellé ne mentionne un dépistage, un résultat ou un traitement. Les rappels sont volontairement neutres.</p>
    </div>
    <div class="row row--between" style="margin-bottom:12px">
      <span class="tiny muted">${list.length} information${list.length > 1 ? 's' : ''}</span>
      <button class="btn--quiet" id="read-all">Tout marquer comme lu</button>
    </div>
    <div class="list">
      ${
        list.length
          ? list
              .map(
                (n) => `<div class="list__item" style="align-items:flex-start">
                  <div class="list__icon">${icon(KIND_ICON[n.kind] ?? 'bell', 16)}</div>
                  <div class="list__body">
                    <strong>${esc(n.title)}${n.read ? '' : ' <span class="pill pill--terra" style="margin-left:6px">Nouveau</span>'}</strong>
                    <span style="margin-top:3px">${esc(n.body)}</span>
                    <span class="tiny muted" style="margin-top:6px">${relative(n.createdAt)}</span>
                  </div>
                </div>`
              )
              .join('')
          : `<div class="empty"><h3>Aucune information</h3><p>Vous serez averti(e) ici, toujours de façon neutre.</p></div>`
      }
    </div>`;

  root.querySelector('#read-all').onclick = async () => {
    try {
      await api('/api/v1/me/notifications/read', { method: 'POST' });
      toast('Informations marquées comme lues', 'ok');
      notifications(root);
    } catch (error) {
      toast(error.message, 'alert');
    }
  };

  api('/api/v1/me/notifications/read', { method: 'POST' }).catch(() => {});
}

export async function settings(root) {
  const me = await api('/api/v1/me').catch(() => null);
  if (me) state.user = me.user;
  const cached = await hasSnapshot();

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Réglages</p>
      <h1>Sécurité & préférences</h1>
    </div>

    <section class="section" style="margin-top:0">
      <div class="card">
        <div class="row row--between">
          <div>
            <p class="eyebrow">Identifiant anonyme</p>
            <p class="mono" style="font-size:16px;margin:0">${esc(state.user?.sipaCode ?? '')}</p>
          </div>
          <span class="pill pill--ok">Vérifié</span>
        </div>
        <hr class="rule" style="margin:14px 0" />
        <div class="row row--between"><span class="small muted">Pseudonyme</span><strong class="small">${esc(
          state.user?.pseudonym ?? ''
        )}</strong></div>
        <div class="row row--between" style="margin-top:8px"><span class="small muted">Téléphone</span><strong class="small mono">${esc(
          me?.phoneMasked ?? '—'
        )}</strong></div>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2>Sécurité</h2></div>
      <div class="list">
        <button class="list__item" id="change-pin">
          <div class="list__icon">${icon('lock', 16)}</div>
          <div class="list__body"><strong>Changer mon code PIN</strong><span>Ré-enveloppe la clé de chiffrement du coffre-fort</span></div>
          ${icon('chevron', 16)}
        </button>
        <button class="list__item" id="biometrics">
          <div class="list__icon">${icon('shield', 16)}</div>
          <div class="list__body"><strong>Biométrie (Face ID / empreinte)</strong><span>${
            state.credentialId ? 'Activée sur cet appareil' : 'Activer le déverrouillage biométrique'
          }</span></div>
          ${icon('chevron', 16)}
        </button>
        <button class="list__item" id="lock-now">
          <div class="list__icon">${icon('lock', 16)}</div>
          <div class="list__body"><strong>Verrouiller maintenant</strong><span>Verrouillage aussi automatique après 60 s</span></div>
        </button>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2>Préférences</h2></div>
      <div class="card">
        <p class="eyebrow">Langue des fiches</p>
        <div class="chips" style="margin-top:8px">
          <button class="chip ${state.user?.language !== 'wo' ? 'is-active' : ''}" data-lang="fr">Français</button>
          <button class="chip ${state.user?.language === 'wo' ? 'is-active' : ''}" data-lang="wo">Wolof</button>
        </div>
        <p class="tiny muted" style="margin-top:8px">Les pastilles audio restent disponibles en français sur tous les appareils ; les fichiers wolof enregistrés sont prévus pour le pilote.</p>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2>Apparence</h2></div>
      <div class="card">
        <div class="row row--between">
          <div>
            <p class="eyebrow">Transitions & animations</p>
            <p class="small muted" style="margin:4px 0 0">Réduisez les effets si vous êtes sensible au mouvement.</p>
          </div>
          ${icon('sparkle', 18)}
        </div>
        <div class="chips" style="margin-top:12px" id="motion-chips">
          <button class="chip ${readMotion() === 'auto' ? 'is-active' : ''}" data-motion="auto">Animations</button>
          <button class="chip ${readMotion() === 'reduced' ? 'is-active' : ''}" data-motion="reduced">Réduites</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2>Données locales</h2></div>
      <div class="card">
        <p class="small muted">Coffre hors-ligne sur cet appareil : <b>${cached ? 'présent' : 'absent'}</b>. Il est chiffré par votre PIN.</p>
        <button class="btn btn--danger btn--sm" id="clear-cache" style="margin-top:10px">Effacer le coffre hors-ligne</button>
      </div>
    </section>

    <section class="section">
      <div class="list">
        <button class="list__item" id="install-app">
          <div class="list__icon" style="background:var(--accent-tint);color:#a76a12">${icon('install', 16)}</div>
          <div class="list__body"><strong>${
            window.SIPA?.isStandalone?.() ? 'Application installée' : 'Installer l’application'
          }</strong><span>${
            window.SIPA?.isStandalone?.()
              ? 'Ouverture plein écran, accès hors connexion'
              : 'Ajouter SIPA à votre écran d’accueil'
          }</span></div>
          ${icon('chevron', 16)}
        </button>
        <a class="list__item" href="#/pro">
          <div class="list__icon">${icon('shield', 16)}</div>
          <div class="list__body"><strong>Portail professionnel</strong><span>Pharmaciens, soignants, conseillers</span></div>
          ${icon('chevron', 16)}
        </a>
        <button class="list__item" id="logout">
          <div class="list__icon" style="background:var(--alert-tint);color:var(--alert)">${icon('logout', 16)}</div>
          <div class="list__body"><strong>Fermer ma session</strong><span>Le coffre-fort se reverrouille immédiatement</span></div>
        </button>
      </div>
    </section>

    <p class="tiny muted" style="text-align:center;margin-top:24px">
      SIPA · prototype viable 1.0 · ${esc(state.meta?.region ?? 'Sénégal')}<br />
      Chiffrement ${esc(state.meta?.vaultAlgorithm ?? 'AES-256-GCM')} · PIN ${esc(state.meta?.pinKdf ?? 'PBKDF2')}
    </p>`;

  root.querySelector('#change-pin').onclick = () => {
    const dialog = modal({
      title: 'Changer mon code PIN',
      subtitle: 'Sécurité du coffre-fort',
      body: `
        <div class="field"><label>PIN actuel</label><input class="input input--pin" id="current" inputmode="numeric" maxlength="6" /></div>
        <div class="field"><label>Nouveau PIN</label><input class="input input--pin" id="next" inputmode="numeric" maxlength="6" /></div>
        <div class="field"><label>Confirmer</label><input class="input input--pin" id="confirm" inputmode="numeric" maxlength="6" /></div>
        <p class="small muted">Vos résultats sont ré-enveloppés avec la clé du nouveau PIN. Aucun résultat n’est déchiffré côté serveur à cette étape.</p>`,
      actions: [{ label: 'Annuler', variant: 'ghost' }, { label: 'Enregistrer', variant: 'primary', keepOpen: true }],
    });
    dialog.overlay.querySelectorAll('[data-action]')[1].addEventListener('click', async () => {
      const current = dialog.overlay.querySelector('#current').value.trim();
      const next = dialog.overlay.querySelector('#next').value.trim();
      const confirm = dialog.overlay.querySelector('#confirm').value.trim();
      if (next !== confirm) return toast('Les deux codes ne correspondent pas.', 'alert');
      try {
        await api('/api/v1/auth/pin/change', { method: 'POST', body: { currentPin: current, nextPin: next } });
        dialog.close();
        toast('Code PIN modifié', 'ok');
        clearSession();
        location.hash = '#/onboarding';
      } catch (error) {
        toast(error.message, 'alert');
      }
    });
  };

  root.querySelector('#biometrics').onclick = async () => {
    const dialog = modal({
      title: 'Activer la biométrie',
      subtitle: 'WebAuthn · clé conservée par votre appareil',
      body: `<p class="small">Confirmez votre code PIN : il autorise l’enrôlement de ce téléphone.</p>
        <div class="field" style="margin-top:12px"><label>Code PIN</label>
        <input class="input input--pin" id="pin" inputmode="numeric" maxlength="6" /></div>`,
      actions: [{ label: 'Annuler', variant: 'ghost' }, { label: 'Activer', variant: 'primary', keepOpen: true }],
    });
    dialog.overlay.querySelectorAll('[data-action]')[1].addEventListener('click', async () => {
      const pin = dialog.overlay.querySelector('#pin').value.trim();
      try {
        await registerBiometric(pin);
        dialog.close();
        toast('Biométrie activée', 'ok');
        settings(root);
      } catch (error) {
        toast(error.message, 'alert');
      }
    });
  };

  root.querySelector('#lock-now').onclick = () => {
    state.locked = true;
    document.getElementById('lock-now')?.click();
  };

  root.querySelectorAll('[data-lang]').forEach((node) => {
    node.onclick = async () => {
      try {
        await api('/api/v1/me', { method: 'PATCH', body: { language: node.dataset.lang } });
        if (state.user) state.user.language = node.dataset.lang;
        toast(node.dataset.lang === 'wo' ? 'Préférence enregistrée : wolof' : 'Préférence enregistrée : français', 'ok');
        settings(root);
      } catch (error) {
        toast(error.message, 'alert');
      }
    };
  });

  root.querySelectorAll('[data-motion]').forEach((button) => {
    button.onclick = () => {
      const mode = writeMotion(button.dataset.motion);
      root.querySelectorAll('[data-motion]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      toast(mode === 'reduced' ? 'Animations réduites' : 'Animations activées', 'ok');
    };
  });

  root.querySelector('#install-app').onclick = async () => {
    if (window.SIPA?.isStandalone?.()) {
      toast('SIPA est déjà installée sur cet appareil.', 'ok');
      return;
    }
    if (window.SIPA?.canInstall?.()) {
      const accepted = await window.SIPA.install();
      toast(accepted ? 'Installation lancée' : 'Installation annulée', accepted ? 'ok' : 'info');
      return;
    }
    modal({
      title: 'Installer SIPA',
      subtitle: 'Application web progressive',
      body: `<p class="small">SIPA fonctionne comme une application : icône sur l’écran d’accueil, ouverture plein écran et accès au coffre hors connexion.</p>
        <div class="stack" style="margin-top:14px">
          <div class="card card--flat"><p class="eyebrow">iPhone & iPad · Safari</p><p class="small muted" style="margin:6px 0 0">Bouton Partager, puis « Sur l’écran d’accueil ».</p></div>
          <div class="card card--flat"><p class="eyebrow">Android · Chrome</p><p class="small muted" style="margin:6px 0 0">Menu ⋮, puis « Installer l’application » ou « Ajouter à l’écran d’accueil ».</p></div>
          <div class="card card--flat"><p class="eyebrow">Ordinateur</p><p class="small muted" style="margin:6px 0 0">Icône d’installation dans la barre d’adresse du navigateur.</p></div>
        </div>`.trim(),
      actions: [{ label: 'Compris', variant: 'primary' }],
    });
  };

  root.querySelector('#clear-cache').onclick = async () => {
    await clearSnapshot();
    toast('Coffre hors-ligne effacé', 'ok');
    settings(root);
  };

  root.querySelector('#logout').onclick = () => {
    clearSession();
    state.locked = true;
    location.hash = '#/onboarding';
    location.reload();
  };
}
