// Parcours d'accès : accueil, inscription pseudonymisée, connexion, biométrie.
import { api, setSession, state, setVault, setCredential } from '../api.js';
import { icon, esc, toast, logo } from '../ui.js';
import { saveSnapshot, loadSnapshot } from '../offline.js';

const b64urlToBytes = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function saveOfflineVault(pin, results) {
  try {
    await saveSnapshot({ sipaCode: state.user?.sipaCode, pseudonym: state.user?.pseudonym }, results, pin);
  } catch {
    /* stockage local indisponible */
  }
}

export async function openOfflineVault(pin) {
  return loadSnapshot(pin);
}

export async function assertBiometric() {
  if (!state.credentialId || !window.PublicKeyCredential) return null;
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: b64urlToBytes(state.credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  return assertion ? state.credentialId : null;
}

export async function registerBiometric(pin) {
  if (!window.PublicKeyCredential) throw new Error('La biométrie n’est pas disponible sur cet appareil.');
  const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
  if (!available) throw new Error('Aucun capteur biométrique disponible.');
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'SIPA', id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: state.user?.sipaCode ?? 'usager',
        displayName: state.user?.pseudonym ?? 'Usager SIPA',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60_000,
      attestation: 'none',
    },
  });
  const id = bytesToB64url(credential.rawId);
  await api('/api/v1/auth/webauthn/register', {
    method: 'POST',
    body: { credentialId: id, pin, label: navigator.platform || 'Cet appareil' },
  });
  setCredential(id);
  return id;
}

// --------------------------------------------------------------- Inscription
export async function onboarding(root) {
  if (state.token) {
    location.hash = '#/home';
    return;
  }
  const flow = {
    step: 'welcome',
    phone: localStorage.getItem('sipa.lastPhone') ?? '',
    ticket: null,
    pseudonym: '',
    pin: '',
    devCode: null,
  };

  const stepsBar = (active) => {
    const steps = ['Téléphone', 'Code', 'Profil', 'PIN'];
    const index = { phone: 0, otp: 1, profile: 2, pin: 3, biometrics: 4 }[active] ?? 0;
    return `<div class="row" style="gap:6px;margin-bottom:20px">${steps
      .map(
        (label, i) =>
          `<span class="tiny ${i <= index ? '' : 'muted'}" style="flex:1;border-top:2px solid ${
            i <= index ? 'var(--teal)' : 'var(--line)'
          };padding-top:6px;letter-spacing:0.08em;text-transform:uppercase">${label}</span>`
      )
      .join('')}</div>`;
  };

  const paint = () => {
    root.className = 'app app--bare';
    if (flow.step === 'welcome') {
      root.innerHTML = `
        <div class="welcome">
          <div class="welcome__art">
            <img class="welcome__logo" src="/brand/logo-mark-light.svg" alt="" width="78" height="78" />
            <b>SIPA</b>
            <small>Système intégré de prévention et d’accès</small>
          </div>
          <div>
            <p class="eyebrow">Sénégal · Dakar & Thiès</p>
            <h1 class="display">Votre santé,<br />en toute <em>discrétion</em>.</h1>
            <p class="lede" style="margin-top:10px">Bilan de santé intégré, autotests et traitements retirés en pharmacie de quartier. Sans file d’attente dédiée, sans étiquette, sans mot prononcé au comptoir.</p>
          </div>
          <div class="steps">
            <div class="step"><b>01</b><p>Un numéro de téléphone et un pseudonyme. Aucune identité civile n’est demandée.</p></div>
            <div class="step"><b>02</b><p>Un code PIN à 6 chiffres, puis Face ID ou votre empreinte si vous le souhaitez.</p></div>
            <div class="step"><b>03</b><p>Réservez un Bilan 4-en-1, un autotest ou le retrait de votre dotation en officine.</p></div>
          </div>
          <div class="stack">
            <button class="btn btn--block" id="start">Créer mon espace confidentiel</button>
            <button class="btn btn--ghost btn--block" id="login">J’ai déjà un compte</button>
            ${
              state.meta?.demo
                ? `<button class="btn--quiet" id="demo">Découvrir avec le compte de démonstration</button>`
                : ''
            }
          </div>
          <p class="tiny muted">Données pseudonymisées, chiffrées en AES-256-GCM. Conforme à la loi n° 2008-12 sur la protection des données personnelles.</p>
        </div>`;
      root.querySelector('#start').onclick = () => {
        flow.step = 'phone';
        paint();
      };
      root.querySelector('#login').onclick = () => {
        flow.step = 'login';
        paint();
      };
      root.querySelector('#demo')?.addEventListener('click', () => {
        flow.phone = state.meta.demo.user.phone;
        flow.step = 'login';
        paint();
        root.querySelector('#phone').value = flow.phone;
        root.querySelector('#pin').value = state.meta.demo.user.pin;
      });
      return;
    }

    if (flow.step === 'phone') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          ${stepsBar('phone')}
          <div>
            <p class="eyebrow">Étape 1 sur 4</p>
            <h1 class="display">Votre numéro,<br />et rien d’autre.</h1>
            <p class="lede" style="margin-top:10px">Nous vérifions votre numéro par un code à 6 chiffres. Il est chiffré et n’apparaît jamais sur les documents remis en pharmacie.</p>
          </div>
          <form id="form">
            <div class="field">
              <label for="phone">Numéro de téléphone</label>
              <input class="input" id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="+221 77 000 00 00" value="${esc(
                flow.phone
              )}" required />
              <span class="hint">Un code vous sera envoyé par WhatsApp (ou SMS en secours).</span>
            </div>
            <p class="error-text hide" id="err"></p>
            <button class="btn btn--block" id="submit">Recevoir mon code</button>
          </form>
          <button class="btn--quiet muted" id="back">← Retour</button>
        </div>`;
      root.querySelector('#phone').focus();
      root.querySelector('#back').onclick = () => {
        flow.step = 'welcome';
        paint();
      };
      root.querySelector('#form').onsubmit = async (event) => {
        event.preventDefault();
        const phone = root.querySelector('#phone').value.trim();
        const err = root.querySelector('#err');
        const button = root.querySelector('#submit');
        button.disabled = true;
        try {
          const data = await api('/api/v1/auth/otp/send', { method: 'POST', body: { phone } });
          flow.phone = phone;
          flow.devCode = data.devCode;
          localStorage.setItem('sipa.lastPhone', phone);
          flow.step = 'otp';
          paint();
        } catch (error) {
          err.textContent = error.message;
          err.classList.remove('hide');
        } finally {
          button.disabled = false;
        }
      };
      return;
    }

    if (flow.step === 'otp') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          ${stepsBar('otp')}
          <div>
            <p class="eyebrow">Étape 2 sur 4</p>
            <h1 class="display">Vérifions<br />que c’est bien vous.</h1>
            <p class="lede" style="margin-top:10px">Code envoyé au ${esc(flow.phone)}.</p>
          </div>
          <form id="form">
            <div class="field">
              <label for="code">Code à 6 chiffres</label>
              <input class="input input--pin" id="code" inputmode="numeric" maxlength="6" placeholder="••••••" required />
            </div>
            ${
              flow.devCode
                ? `<div class="banner" style="margin-bottom:14px">${icon('shield', 16)}<span>Prototype : code de vérification <b class="mono">${esc(
                    flow.devCode
                  )}</b> (l’envoi WhatsApp/SMS réel s’active avec les clés opérateur).</span></div>`
                : ''
            }
            <p class="error-text hide" id="err"></p>
            <button class="btn btn--block" id="submit">Valider</button>
          </form>
          <div class="btn-row">
            <button class="btn--quiet" id="resend">Renvoyer le code</button>
            <button class="btn--quiet muted" id="back">← Changer de numéro</button>
          </div>
        </div>`;
      root.querySelector('#code').focus();
      root.querySelector('#back').onclick = () => {
        flow.step = 'phone';
        paint();
      };
      root.querySelector('#resend').onclick = async () => {
        try {
          const data = await api('/api/v1/auth/otp/send', { method: 'POST', body: { phone: flow.phone } });
          flow.devCode = data.devCode;
          toast('Nouveau code envoyé.', 'ok');
          paint();
        } catch (error) {
          toast(error.message, 'alert');
        }
      };
      root.querySelector('#form').onsubmit = async (event) => {
        event.preventDefault();
        const code = root.querySelector('#code').value.replace(/\D/g, '');
        const err = root.querySelector('#err');
        try {
          const data = await api('/api/v1/auth/otp/verify', { method: 'POST', body: { phone: flow.phone, code } });
          if (data.isNew) {
            flow.ticket = data.ticket;
            flow.step = 'profile';
            paint();
          } else {
            setSession({ token: data.token, user: data.user });
            await finishLogin(data.token);
          }
        } catch (error) {
          err.textContent = error.message;
          err.classList.remove('hide');
        }
      };
      return;
    }

    if (flow.step === 'profile') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          ${stepsBar('profile')}
          <div>
            <p class="eyebrow">Étape 3 sur 4</p>
            <h1 class="display">Comment<br />souhaitez-vous être appelé(e) ?</h1>
            <p class="lede" style="margin-top:10px">Un pseudonyme suffit. Votre identifiant technique sera généré automatiquement (SIPA-XXXX-SN).</p>
          </div>
          <form id="form">
            <div class="field">
              <label for="pseudo">Pseudonyme</label>
              <input class="input" id="pseudo" maxlength="40" placeholder="Ex. Awa D., Ndiaye, Aïda…" value="${esc(flow.pseudonym)}" required />
              <span class="hint">Ce nom n’apparaît que dans votre espace. Aucun nom civil n’est exigé.</span>
            </div>
            <p class="error-text hide" id="err"></p>
            <button class="btn btn--block" id="submit">Continuer</button>
          </form>
        </div>`;
      root.querySelector('#pseudo').focus();
      root.querySelector('#form').onsubmit = (event) => {
        event.preventDefault();
        flow.pseudonym = root.querySelector('#pseudo').value.trim();
        if (!flow.pseudonym) {
          const err = root.querySelector('#err');
          err.textContent = 'Choisissez un pseudonyme.';
          err.classList.remove('hide');
          return;
        }
        flow.step = 'pin';
        paint();
      };
      return;
    }

    if (flow.step === 'pin') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          ${stepsBar('pin')}
          <div>
            <p class="eyebrow">Étape 4 sur 4</p>
            <h1 class="display">Votre code<br />personnel.</h1>
            <p class="lede" style="margin-top:10px">6 chiffres, connus de vous seul. Ils déverrouillent le chiffrement de vos résultats : sans ce code, personne — pas même nos équipes — ne peut les lire.</p>
          </div>
          <form id="form">
            <div class="field">
              <label for="pin1">Code PIN</label>
              <input class="input input--pin" id="pin1" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="••••••" required />
            </div>
            <div class="field">
              <label for="pin2">Confirmez le code</label>
              <input class="input input--pin" id="pin2" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="••••••" required />
            </div>
            <p class="error-text hide" id="err"></p>
            <button class="btn btn--block" id="submit">Créer mon espace</button>
          </form>
          <p class="tiny muted">Verrouillage automatique au bout de 60 secondes d’inactivité. Blocage progressif après 5 tentatives erronées.</p>
        </div>`;
      root.querySelector('#pin1').focus();
      root.querySelector('#form').onsubmit = async (event) => {
        event.preventDefault();
        const pin = root.querySelector('#pin1').value.trim();
        const confirm = root.querySelector('#pin2').value.trim();
        const err = root.querySelector('#err');
        if (!/^\d{6}$/.test(pin)) {
          err.textContent = 'Le PIN doit contenir exactement 6 chiffres.';
          err.classList.remove('hide');
          return;
        }
        if (pin !== confirm) {
          err.textContent = 'Les deux codes ne correspondent pas.';
          err.classList.remove('hide');
          return;
        }
        root.querySelector('#submit').disabled = true;
        try {
          const data = await api('/api/v1/auth/register', {
            method: 'POST',
            body: { ticket: flow.ticket, pin, pseudonym: flow.pseudonym },
          });
          setSession({ token: data.token, user: data.user });
          if (data.vault) setVault(data.vault);
          flow.pin = pin;
          flow.step = 'biometrics';
          paint();
        } catch (error) {
          err.textContent = error.message;
          err.classList.remove('hide');
          root.querySelector('#submit').disabled = false;
        }
      };
      return;
    }

    if (flow.step === 'biometrics') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          <div>
            <p class="eyebrow">Dernière étape, facultative</p>
            <h1 class="display">Ouvrir d’un<br />simple regard.</h1>
            <p class="lede" style="margin-top:10px">Activez Face ID ou votre empreinte pour déverrouiller votre coffre-fort sans saisir votre code. Le PIN reste toujours disponible.</p>
          </div>
          <div class="card card--ok">
            <p class="eyebrow">Votre espace est prêt</p>
            <p style="font-family:var(--mono);font-size:15px;margin:0">${esc(state.user?.sipaCode ?? '')}</p>
            <p class="small muted" style="margin-top:6px">Conservez cet identifiant : il permet à un soignant de retrouver votre pass, sans votre nom.</p>
          </div>
          <div class="stack">
            <button class="btn btn--block" id="bio">${icon('shield', 16)} Activer la biométrie</button>
            <button class="btn btn--ghost btn--block" id="skip">Plus tard</button>
          </div>
          <p class="tiny muted">Le déverrouillage biométrique est délégué au système de votre téléphone (WebAuthn). Aucune image de votre visage ou de votre empreinte n’est transmise.</p>
        </div>`;
      root.querySelector('#bio').onclick = async () => {
        try {
          await registerBiometric(flow.pin);
          toast('Biométrie activée', 'ok');
          afterSignup();
        } catch (error) {
          toast(error.message, 'alert');
        }
      };
      root.querySelector('#skip').onclick = afterSignup;
      return;
    }

    if (flow.step === 'login') {
      root.innerHTML = `
        <div class="welcome">
          ${logo({ small: true })}
          <div>
            <p class="eyebrow">Espace personnel</p>
            <h1 class="display">Bon retour.</h1>
            <p class="lede" style="margin-top:10px">Votre numéro et votre code à 6 chiffres. Rien de plus.</p>
          </div>
          <form id="form">
            <div class="field">
              <label for="phone">Numéro de téléphone</label>
              <input class="input" id="phone" inputmode="tel" autocomplete="tel" placeholder="+221 77 000 00 00" value="${esc(flow.phone)}" required />
            </div>
            <div class="field">
              <label for="pin">Code PIN</label>
              <input class="input input--pin" id="pin" inputmode="numeric" maxlength="6" placeholder="••••••" required />
            </div>
            <p class="error-text hide" id="err"></p>
            <button class="btn btn--block" id="submit">Ouvrir mon espace</button>
          </form>
          ${
            state.meta?.demo
              ? `<div class="banner">${icon('shield', 16)}<span>Démo : <b>${esc(state.meta.demo.user.phone)}</b> · PIN <b>${esc(
                  state.meta.demo.user.pin
                )}</b></span></div>`
              : ''
          }
          <button class="btn--quiet muted" id="back">← Retour</button>
        </div>`;
      root.querySelector('#phone').focus();
      root.querySelector('#back').onclick = () => {
        flow.step = 'welcome';
        paint();
      };
      root.querySelector('#form').onsubmit = async (event) => {
        event.preventDefault();
        const phone = root.querySelector('#phone').value.trim();
        const pin = root.querySelector('#pin').value.trim();
        const err = root.querySelector('#err');
        const button = root.querySelector('#submit');
        button.disabled = true;
        try {
          const data = await api('/api/v1/auth/pin', { method: 'POST', body: { phone, pin } });
          setSession({ token: data.token, user: data.user });
          const opened = await api('/api/v1/vault/unlock', { method: 'POST', body: { pin } });
          setVault(opened);
          state.locked = false;
          await afterLogin(pin);
        } catch (error) {
          err.textContent = error.message;
          err.classList.remove('hide');
          button.disabled = false;
        }
      };
      return;
    }
  };

  const afterSignup = () => {
    state.locked = false;
    location.hash = '#/home';
  };

  const afterLogin = async (pin) => {
    try {
      const { results } = await api('/api/v1/vault/results', { useVault: true });
      await saveOfflineVault(pin, results);
    } catch {
      /* hors-ligne */
    }
    location.hash = '#/home';
  };

  const finishLogin = async (token) => {
    try {
      await api('/api/v1/me');
    } catch {
      /* profil rechargé par le routeur */
    }
    location.hash = '#/home';
  };

  paint();
}
